import AdmZip from "adm-zip";
import { chmodSync, existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { diagnose } from "../diagnostics/parse.js";
import { runProcess } from "../exec/run.js";
import { discoverJdks, pickJdk, type JdkInfo } from "../jdk/discover.js";
import { readProjectInfo, type ProjectInfo } from "../project/info.js";
import { lookupProfile, type Services } from "../services.js";
import { ENDPOINTS } from "../sources/endpoints.js";
import { downloadFile } from "../util/download.js";
import { findingLine } from "./crash.js";
import { clip, fail, okText } from "./result.js";
import { buildInput } from "./schemas.js";

type A = z.infer<z.ZodObject<typeof buildInput>>;

const KEEP = [
  /\.(java|kt):(\d+:|\[\d+,\d+\])/,
  /^\* What went wrong:|^FAILURE:|^BUILD (FAILED|SUCCESSFUL|SUCCESS|FAILURE)/,
  /\[ERROR\]|Could not (resolve|find|GET|transfer)|status code \d{3}|could not be resolved/,
  /JVM runtime version|Unsupported class file|class file version|languageVersion=|Gradle requires JVM|release version|target release/,
  /Exception|Error:|Caused by:/,
];

/** Newest Java a Gradle version can run on (Gradle's compatibility matrix). */
export function gradleMaxJvm(v: string): number {
  const [maj = 0, min = 0] = v.split(".").map(Number);
  if (maj >= 10) return 99;
  const n = maj * 100 + min;
  const table: [number, number][] = [[903, 25], [901, 25], [814, 24], [810, 23], [808, 22], [805, 21], [803, 20], [706, 19], [705, 18], [703, 17], [700, 16], [607, 15], [603, 14], [0, 11]];
  return table.find(([g]) => n >= g)![1];
}

export async function wrapperGradleVersion(root: string): Promise<string | undefined> {
  try {
    const t = await readFile(path.join(root, "gradle", "wrapper", "gradle-wrapper.properties"), "utf8");
    return /gradle-(\d+(?:\.\d+)+(?:-rc-\d+)?)-(?:bin|all)\.zip/.exec(t)?.[1];
  } catch {
    return undefined;
  }
}

async function requiredJvm(services: Services, info: ProjectInfo, gradle?: string): Promise<{ jvm: number; max?: number; why: string }> {
  let jvm = 17;
  let why = "default";
  if (info.mcVersion) {
    try {
      const { profile } = await lookupProfile(services, info.platform, info.mcVersion);
      jvm = profile.java;
      why = `${info.platform} ${info.mcVersion} targets Java ${jvm}`;
    } catch (e) {
      why = `profile lookup failed (${(e as Error).message.split("\n")[0]})`;
    }
  }
  // paperweight-userdev 2.x runs on Java 21+
  if (info.nms === "paperweight" && jvm < 21) {
    jvm = 21;
    why += "; paperweight-userdev needs JDK 21 to run (compiles for the target via toolchain)";
  }
  const max = gradle ? gradleMaxJvm(gradle) : undefined;
  if (max && jvm > max) return { jvm: max, max, why: `${why}; capped at ${max} (newest Gradle ${gradle} runs on)` };
  return { jvm, max, why };
}

/** mvnw, mvn on PATH, or Apache Maven downloaded from Maven Central into the cache. */
async function mavenCommand(services: Services, root: string): Promise<{ cmd: string; note?: string }> {
  const win = process.platform === "win32";
  const wrapper = path.join(root, win ? "mvnw.cmd" : "mvnw");
  if (existsSync(wrapper)) return { cmd: wrapper };
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const c = path.join(dir, win ? "mvn.cmd" : "mvn");
    if (dir && existsSync(c)) return { cmd: c };
  }
  const v = await services.versions.latestMaven(ENDPOINTS.mavenDistMetadata, { prefix: "3." });
  if (!v) throw new Error("No Maven found (mvnw/mvn) and its version list could not be read.");
  const home = path.join(services.config.cacheDir, "tools", `apache-maven-${v}`);
  const bin = path.join(home, "bin", win ? "mvn.cmd" : "mvn");
  if (!existsSync(bin)) {
    const zip = await downloadFile(ENDPOINTS.mavenDist(v), path.join(services.config.cacheDir, "downloads", `apache-maven-${v}-bin.zip`), { userAgent: services.config.userAgent, offline: services.config.offline });
    const tmp = `${home}.tmp`;
    await rm(tmp, { recursive: true, force: true });
    new AdmZip(zip).extractAllTo(tmp, true);
    await rename(path.join(tmp, `apache-maven-${v}`), home);
    await rm(tmp, { recursive: true, force: true });
    if (!win) chmodSync(bin, 0o755);
  }
  return { cmd: bin, note: `Maven ${v} (no mvnw/mvn found; official binary from Maven Central, cached)` };
}

export async function build(services: Services, a: A) {
  const info = await readProjectInfo(a.projectDir).catch((e: Error) => e);
  if (info instanceof Error) return fail(info.message);
  const root = info.build === "gradle" ? info.rootDir : info.dir;
  const notes: string[] = [];
  let cmd: string;
  let args: string[];
  let gradleVersion: string | undefined;
  if (info.build === "gradle") {
    cmd = path.join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
    if (!existsSync(cmd)) return fail(`No Gradle wrapper in ${root}. Add one (gradle wrapper --gradle-version <get_profile's Gradle>) and retry.`);
    gradleVersion = await wrapperGradleVersion(root);
    const sub = info.dir !== root ? `:${path.relative(root, info.dir).split(path.sep).join(":")}` : "";
    args = [...(a.tasks?.length ? a.tasks : ["build"]).map((t) => (sub && !t.startsWith(":") && !t.startsWith("-") ? `${sub}:${t}` : t)), "--console=plain"];
  } else {
    try {
      const m = await mavenCommand(services, root);
      cmd = m.cmd;
      if (m.note) notes.push(m.note);
    } catch (e) {
      return fail((e as Error).message);
    }
    args = [...(a.tasks?.length ? a.tasks : ["package"]), "-B", "-ntp"];
  }
  const req = await requiredJvm(services, info, gradleVersion);
  const all = await discoverJdks();
  let jdk: JdkInfo;
  if (a.javaHome) jdk = all.find((j) => path.resolve(j.home) === path.resolve(a.javaHome!)) ?? { home: a.javaHome, major: 0, version: "?", isJdk: true, source: "javaHome" };
  else {
    const choice = pickJdk(all, req.jvm, req.why, req.max);
    if (!choice.jdk) return fail(choice.missing!);
    jdk = choice.jdk;
  }
  if (info.build === "gradle") {
    const paths = all.filter((j) => j.isJdk).map((j) => j.home).join(",");
    if (paths) args.push(`-Porg.gradle.java.installations.paths=${paths}`);
  }
  args.push(...(a.args ?? []));
  const logFile = path.join(root, ".bsp", "logs", `build-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  await mkdir(path.dirname(logFile), { recursive: true });
  const r = await runProcess({
    command: cmd,
    args,
    cwd: root,
    env: { ...process.env, JAVA_HOME: jdk.home, PATH: `${path.join(jdk.home, "bin")}${path.delimiter}${process.env.PATH ?? ""}` },
    timeoutMs: (a.timeoutSec ?? 1200) * 1000,
    logFile,
    tailLines: 60,
    keepPatterns: KEEP,
    maxKept: 300,
  });
  const text = statSync(logFile).size < 8_000_000 ? await readFile(logFile, "utf8") : [...r.kept, ...r.tail].join("\n");
  const d = diagnose(text);
  const failed = r.exitCode !== 0 || r.timedOut;
  const status = r.timedOut ? "timed out (killed)" : failed ? `failed (exit ${r.exitCode ?? r.signal})` : "succeeded";
  const errs = d.findings.filter((f) => f.severity === "error");
  const shown = [...errs, ...d.findings.filter((f) => f.severity !== "error" && f.kind !== "compile_warning")].slice(0, 15);
  const artifacts = failed ? [] : await builtJars(info);
  const out = [
    `${info.build === "gradle" ? `Gradle${gradleVersion ? ` ${gradleVersion}` : ""}` : "Maven"} ${args.filter((x) => !x.startsWith("-")).join(" ")} ${status} in ${Math.round(r.durationMs / 100) / 10}s, JDK ${jdk.major || "?"} (${req.why}).`,
    ...(d.findings.length ? [d.summary] : []),
    ...shown.map(findingLine),
    ...(d.findings.length > shown.length ? [`… ${d.findings.length - shown.length} more: analyze_crash path=${logFile}`] : []),
    ...(failed && !errs.length ? ["tail:", ...r.tail.slice(-25).map((l) => clip(l, 200))] : []),
    ...(artifacts.length ? [`jars: ${artifacts.join(", ")}`] : []),
    ...notes.map((n) => `note: ${n}`),
    `log: ${logFile}`,
  ];
  return { ...okText(out.join("\n")), isError: failed };
}

async function builtJars(info: ProjectInfo): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const dirs = [path.join(info.dir, info.build === "maven" ? "target" : path.join("build", "libs"))];
  const out: string[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of await readdir(d)) if (f.endsWith(".jar")) out.push(path.relative(info.dir, path.join(d, f)));
  }
  return out;
}
