/**
 * Spigot's official BuildTools, run on explicit request only (opt-in `buildtools: true`).
 * BuildTools decompiles/patches/compiles Spigot from SpigotMC's sources and installs it into the local Maven
 * repository; it never starts a Minecraft server and never touches a EULA. Output is cached per version.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runProcess } from "../exec/run.js";
import { discoverJdks, type JdkInfo } from "../jdk/discover.js";
import type { Services } from "../services.js";
import { ENDPOINTS } from "../sources/endpoints.js";
import { downloadFile } from "../util/download.js";

const WEEK = 7 * 24 * 3600_000;

/** Folder names BuildTools (and the Java/Maven/git chain it drives) is known to choke on. */
export function buildToolsPathProblem(dir: string): string | undefined {
  if (/!/.test(dir)) return `"!" in ${dir} breaks Java jar URLs`;
  if (/\s/.test(dir)) return `spaces in ${dir} break BuildTools' git/Maven steps`;
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(dir)) return `non-ASCII characters in ${dir} break BuildTools on Windows`;
  return undefined;
}

/** JDK for BuildTools: within Spigot's declared class-file range [min,max] (major = class version − 44), newest first. */
export function pickBuildToolsJdk(jdks: JdkInfo[], range?: [number, number]): JdkInfo | undefined {
  const lo = range ? range[0] - 44 : 8;
  const hi = range ? range[1] - 44 : 99;
  return jdks.filter((j) => j.isJdk && j.major >= lo && j.major <= hi).sort((a, b) => b.major - a.major)[0];
}

export function buildToolsArgs(jar: string, mc: string, outDir: string, remapped: boolean): string[] {
  return ["-jar", jar, "--rev", mc, "--output-dir", outDir, "--nogui", ...(remapped ? ["--remapped"] : [])];
}

/** spigot jars BuildTools leaves behind for a version (output dir, then its work tree). */
export function buildToolsOutputs(root: string, mc: string): string[] {
  const out: string[] = [];
  const cands = [path.join(root, "out", mc), path.join(root, "work", "Spigot", "Spigot-Server", "target")];
  for (const d of cands) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.startsWith(`spigot-${mc}`) && f.endsWith(".jar") && !/-(sources|javadoc|tests)\.jar$/.test(f)) out.push(path.join(d, f));
  }
  return out;
}

const running = new Map<string, Promise<string>>();

/** Run BuildTools for `mc` (once at a time per version); resolves to the log file. */
export function runBuildTools(services: Services, mc: string, opts: { remapped: boolean; onProgress?: (m: string) => void }): Promise<string> {
  const key = `${mc}:${opts.remapped}`;
  let p = running.get(key);
  if (!p) {
    p = doRun(services, mc, opts).finally(() => running.delete(key));
    running.set(key, p);
  }
  return p;
}

async function doRun(services: Services, mc: string, opts: { remapped: boolean; onProgress?: (m: string) => void }): Promise<string> {
  if (services.config.offline) throw new Error("BuildTools needs the network (BSP_OFFLINE is set).");
  const root = path.join(services.config.cacheDir, "buildtools");
  const bad = buildToolsPathProblem(root);
  if (bad) throw new Error(`Cannot run BuildTools here: ${bad}. Set BSP_CACHE_DIR to a plain path (e.g. C:\\bsp-cache).`);
  if (process.platform !== "win32") {
    // on Windows BuildTools fetches PortableGit itself
    await promisify(execFile)("git", ["--version"]).catch(() => {
      throw new Error("BuildTools needs git on PATH (install git, then retry).");
    });
  }
  const sv = await services.versions.spigotVersion(mc);
  if (!sv) throw new Error(`SpigotMC has no BuildTools build for ${mc}.`);
  const jdk = pickBuildToolsJdk(await discoverJdks(), sv.javaVersions);
  const want = sv.javaVersions ? `Java ${sv.javaVersions[0] - 44}–${sv.javaVersions[1] - 44}` : "Java 8+";
  if (!jdk) throw new Error(`BuildTools for ${mc} needs ${want}; no such JDK found. Install one or add it to BSP_JDKS.`);
  const jar = await downloadFile(ENDPOINTS.buildToolsJar, path.join(root, "BuildTools.jar"), { userAgent: services.config.userAgent, maxAgeMs: WEEK });
  const work = path.join(root, "work");
  await mkdir(work, { recursive: true });
  const logFile = path.join(root, "logs", `${mc}${opts.remapped ? "-remapped" : ""}.log`);
  opts.onProgress?.(`Running BuildTools ${mc} on JDK ${jdk.major} (5–15 min; log ${logFile})…`);
  const java = path.join(jdk.home, "bin", process.platform === "win32" ? "java.exe" : "java");
  const r = await runProcess({
    command: java,
    args: ["-Xmx2G", ...buildToolsArgs(jar, mc, path.join(root, "out", mc), opts.remapped)],
    cwd: work,
    env: { ...process.env, JAVA_HOME: jdk.home },
    timeoutMs: 60 * 60_000,
    logFile,
    tailLines: 30,
  });
  if (r.exitCode !== 0) throw new Error(`BuildTools ${mc} failed (exit ${r.exitCode}${r.timedOut ? ", timed out" : ""}); log: ${logFile}\n${r.tail.slice(-8).join("\n")}`);
  return logFile;
}
