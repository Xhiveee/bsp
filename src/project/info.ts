/**
 * Plugin project detection from its own build files: Maven (pom.xml) or Gradle (build.gradle[.kts], gradle.properties,
 * libs.versions.toml), plus plugin.yml / paper-plugin.yml. Nothing BSP-specific has to be added to a project.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import YAML from "yaml";
import type { MappingNs, Platform } from "../profiles/schema.js";

export type NmsKind = "paperweight" | "spigot-remapped" | "spigot" | "server-file" | "none";

export interface ProjectInfo {
  dir: string;
  build: "maven" | "gradle";
  /** Build root (Gradle settings / Maven aggregator); equals dir for single-module builds. */
  rootDir: string;
  platform: Platform;
  mcVersion: string;
  /** Exact dependency version string (1.20.4-R0.1-SNAPSHOT, 26.3.build.169-beta). */
  apiVersionString?: string;
  /** Names the code is written in, when the build says so explicitly (paperweight / remapped-mojang). */
  devMappings?: MappingNs;
  nms: NmsKind;
  /** Server jar referenced as a file/system dependency. */
  serverJar?: string;
  pluginYml?: { file: string; name?: string; main?: string; apiVersion?: string; depend?: string[]; softdepend?: string[] };
  javaSourceRoots: string[];
  /** Compiled classes (target/classes, build/classes/java/main), when built. */
  classesDirs: string[];
  /** Modules of a multi-module build (each detected separately by nms_validate). */
  modules: string[];
  detectedFrom: string[];
}

export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

export async function readText(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

/** Minecraft version from a platform artifact version: 1.20.4-R0.1-SNAPSHOT → 1.20.4, 26.3.build.169-beta → 26.3. */
export function mcFromArtifactVersion(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^(\d+\.\d+(?:\.\d+)?)(?=[-.]R\d|\.build|-pre|-rc|-SNAPSHOT|-experimental|$)/.exec(v.trim());
  return m?.[1];
}

interface Dep {
  group: string;
  artifact: string;
  version?: string;
  classifier?: string;
  systemPath?: string;
  via: string;
}

const PLATFORM_ARTIFACTS: { ga: RegExp; platform: Platform; nms?: NmsKind }[] = [
  { ga: /^io\.papermc\.paper:dev-bundle$/, platform: "paper", nms: "paperweight" },
  { ga: /^(io\.papermc\.paper|com\.destroystokyo\.paper):paper(-api)?$/, platform: "paper" },
  { ga: /^io\.papermc\.paper:paper-server$/, platform: "paper", nms: "server-file" },
  { ga: /^org\.spigotmc:spigot$/, platform: "spigot", nms: "spigot" },
  { ga: /^org\.spigotmc:spigot-api$/, platform: "spigot" },
  { ga: /^org\.bukkit:(bukkit|craftbukkit)$/, platform: "bukkit" },
];

// ---------------------------------------------------------------- Maven

const stripXmlComments = (x: string) => x.replace(/<!--[\s\S]*?-->/g, "");

function pomDeps(xml: string, extraProps: Record<string, string> = {}): { deps: Dep[]; modules: string[]; props: Record<string, string> } {
  const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (n) => ["dependency", "module", "plugin", "execution"].includes(n) }).parse(xml)?.project ?? {};
  const props: Record<string, string> = { ...extraProps };
  for (const [k, v] of Object.entries((doc.properties as Record<string, unknown>) ?? {})) props[k] = String(v);
  if (doc.version) props["project.version"] = String(doc.version);
  const sub = (s: unknown) => (s === undefined ? undefined : String(s).replace(/\$\{([^}]+)\}/g, (all, k: string) => props[k] ?? all));
  const deps: Dep[] = [];
  const add = (list: unknown, via: string) => {
    for (const d of (list as Record<string, unknown>[] | undefined) ?? []) {
      deps.push({ group: sub(d.groupId)!, artifact: sub(d.artifactId)!, version: sub(d.version), classifier: sub(d.classifier), systemPath: sub(d.systemPath), via });
    }
  };
  add(doc.dependencies?.dependency, "pom.xml");
  add(doc.dependencyManagement?.dependencies?.dependency, "pom.xml dependencyManagement");
  // remapped-mojang via specialsource remappedDependencies
  for (const p of (doc.build?.plugins?.plugin as Record<string, unknown>[] | undefined) ?? []) {
    if (p.artifactId !== "specialsource-maven-plugin") continue;
    deps.push({ group: "net.md-5", artifact: "specialsource-maven-plugin", version: sub(p.version), via: "pom.xml build plugin" });
  }
  return { deps, modules: ((doc.modules?.module as unknown[]) ?? []).map(String), props };
}

// ---------------------------------------------------------------- Gradle

function gradleDeps(build: string, props: Record<string, string>, catalog: Record<string, string>): Dep[] {
  const src = stripComments(build);
  const sub = (s: string) =>
    s
      .replace(/\$\{?(?:project\.)?(?:property\(["'])?([\w.]+)(?:["']\))?\}?/g, (all, k: string) => props[k] ?? all)
      .replace(/\$\{?libs\.versions\.([\w.]+)\.get\(\)\}?/g, (all, k: string) => catalog[`v:${k.replace(/\./g, "-")}`] ?? all);
  const deps: Dep[] = [];
  for (const m of src.matchAll(/paperDevBundle\s*\(?\s*["']([^"']+)["']/g)) deps.push({ group: "io.papermc.paper", artifact: "dev-bundle", version: sub(m[1]!), via: "paperweight.paperDevBundle" });
  for (const m of src.matchAll(/["']((?:io\.papermc\.paper|com\.destroystokyo\.paper|org\.spigotmc|org\.bukkit):[\w.-]+:[^"'\s]+)["']/g)) {
    const [group, artifact, version, classifier] = sub(m[1]!).split(":");
    deps.push({ group: group!, artifact: artifact!, version, classifier, via: "build.gradle dependency" });
  }
  // version catalog accessors: libs.paper.api → [libraries] paper-api = { module = "...", version.ref = ... }
  for (const m of src.matchAll(/\blibs\.([\w.]+)/g)) {
    const lib = catalog[`l:${m[1]!.replace(/\./g, "-")}`];
    if (lib) {
      const [group, artifact, version, classifier] = lib.split(":");
      deps.push({ group: group!, artifact: artifact!, version, classifier, via: "libs.versions.toml" });
    }
  }
  for (const m of src.matchAll(/files\s*\(\s*["']([^"']+\.jar)["']/g)) deps.push({ group: "file", artifact: path.basename(m[1]!), systemPath: sub(m[1]!), via: "files(...)" });
  return deps;
}

/** Flattened libs.versions.toml: "v:<alias>" → version, "l:<alias>" → group:artifact:version. */
function parseCatalog(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const sec = /^\[(\w+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!;
      continue;
    }
    const kv = /^([\w.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const alias = kv[1]!.replace(/[._]/g, "-");
    const val = kv[2]!;
    if (section === "versions") out[`v:${alias}`] = val.replace(/^["']|["']$/g, "");
    if (section === "libraries") {
      const str = /^["']([^"']+)["']$/.exec(val)?.[1];
      if (str) out[`l:${alias}`] = str;
      else {
        const module = /module\s*=\s*["']([^"']+)["']/.exec(val)?.[1] ?? [/group\s*=\s*["']([^"']+)["']/.exec(val)?.[1], /name\s*=\s*["']([^"']+)["']/.exec(val)?.[1]].filter(Boolean).join(":");
        const ref = /version\.ref\s*=\s*["']([^"']+)["']/.exec(val)?.[1];
        const ver = /version\s*=\s*["']([^"']+)["']/.exec(val)?.[1] ?? (ref ? out[`v:${ref.replace(/[._]/g, "-")}`] : undefined);
        if (module) out[`l:${alias}`] = ver ? `${module}:${ver}` : module;
      }
    }
  }
  return out;
}

function gradleIncludes(settings: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(settings).matchAll(/\binclude\b\s*\(?((?:\s*['"][^'"]+['"]\s*,?)+)\)?/g)) for (const q of m[1]!.matchAll(/['"]([^'"]+)['"]/g)) out.push(q[1]!.replace(/^:/, "").replace(/:/g, "/"));
  return [...new Set(out)];
}

// ---------------------------------------------------------------- shared

async function findPluginYml(dir: string): Promise<ProjectInfo["pluginYml"]> {
  for (const name of ["paper-plugin.yml", "plugin.yml"]) {
    for (const rel of [path.join("src", "main", "resources", name), name]) {
      const f = path.join(dir, rel);
      const t = await readText(f);
      if (t === undefined) continue;
      try {
        const y = (YAML.parse(t) ?? {}) as Record<string, unknown>;
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : undefined);
        const deps = y.dependencies as Record<string, unknown> | undefined; // paper-plugin.yml: dependencies.server.<name>
        const paperDeps = deps && typeof deps === "object" && !Array.isArray(deps) ? Object.keys((deps.server as object) ?? {}) : undefined;
        return { file: f, name: y.name as string | undefined, main: y.main as string | undefined, apiVersion: y["api-version"] !== undefined ? String(y["api-version"]) : undefined, depend: list(y.depend) ?? paperDeps, softdepend: list(y.softdepend) };
      } catch {
        return { file: f };
      }
    }
  }
  return undefined;
}

async function existingDirs(base: string, rels: string[]): Promise<string[]> {
  return rels.map((r) => path.join(base, r)).filter((d) => existsSync(d));
}

/** Pick the platform dependency that decides version + NMS access (NMS deps beat API deps). */
function pick(deps: Dep[]): { dep: Dep; platform: Platform; nms: NmsKind } | undefined {
  const scored: { dep: Dep; platform: Platform; nms: NmsKind; score: number }[] = [];
  for (const d of deps) {
    const rule = PLATFORM_ARTIFACTS.find((r) => r.ga.test(`${d.group}:${d.artifact}`));
    if (!rule || !mcFromArtifactVersion(d.version)) continue;
    let nms: NmsKind = rule.nms ?? "none";
    if (nms === "spigot" && d.classifier === "remapped-mojang") nms = "spigot-remapped";
    scored.push({ dep: d, platform: rule.platform, nms, score: nms !== "none" ? 2 : 1 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

export async function readProjectInfo(dirIn: string): Promise<ProjectInfo> {
  const dir = path.resolve(dirIn);
  if (!existsSync(dir)) throw new Error(`Project directory not found: ${dir}`);
  const detectedFrom: string[] = [];
  let deps: Dep[] = [];
  let build: ProjectInfo["build"];
  let modules: string[] = [];
  let rootDir = dir;
  const pom = await readText(path.join(dir, "pom.xml"));
  const gradleFile = ["build.gradle.kts", "build.gradle"].find((f) => existsSync(path.join(dir, f)));
  if (pom) {
    build = "maven";
    // parent POM chain (<parent><relativePath>, default ../pom.xml): properties, dependencies and
    // dependencyManagement are inherited
    const chain: { dir: string; xml: string }[] = [];
    for (let cur = { dir, xml: pom }, i = 0; i < 4; i++) {
      const rel = /<parent>[\s\S]*?<\/parent>/.exec(stripXmlComments(cur.xml))?.[0];
      if (!rel) break;
      const rp = /<relativePath>([^<]*)<\/relativePath>/.exec(rel)?.[1]?.trim() ?? "../pom.xml";
      if (!rp) break;
      const file = rp.endsWith(".xml") ? path.resolve(cur.dir, rp) : path.resolve(cur.dir, rp, "pom.xml");
      const xml = await readText(file);
      if (!xml) break;
      chain.push({ dir: path.dirname(file), xml });
      cur = { dir: path.dirname(file), xml };
    }
    let props: Record<string, string> = {};
    const inherited: Dep[] = [];
    for (const par of chain.reverse()) {
      const pp = pomDeps(par.xml, props);
      props = pp.props;
      inherited.unshift(...pp.deps.map((d) => ({ ...d, via: `${d.via} (parent ${path.relative(dir, par.dir) || "."})` })));
    }
    const top = chain[0];
    if (top && pomDeps(top.xml).modules.some((m) => path.resolve(top.dir, m) === dir)) rootDir = top.dir;
    const p = pomDeps(pom, props);
    deps = [...p.deps, ...inherited];
    // versionless dependencies take their version from dependencyManagement
    for (const d of deps) if (!d.version) d.version = deps.find((x) => x.version && x.group === d.group && x.artifact === d.artifact)?.version;
    modules = p.modules.map((m) => path.resolve(dir, m)).filter((m) => existsSync(m));
  } else if (gradleFile || existsSync(path.join(dir, "settings.gradle")) || existsSync(path.join(dir, "settings.gradle.kts"))) {
    build = "gradle";
    // Gradle root: this dir or up to 2 levels up (settings.gradle)
    for (let up = dir, i = 0; i < 3; i++, up = path.dirname(up)) {
      if (existsSync(path.join(up, "settings.gradle")) || existsSync(path.join(up, "settings.gradle.kts"))) {
        rootDir = up;
        break;
      }
    }
    const props = { ...parseProperties((await readText(path.join(rootDir, "gradle.properties"))) ?? ""), ...parseProperties((await readText(path.join(dir, "gradle.properties"))) ?? "") };
    const catalog = parseCatalog(await readText(path.join(rootDir, "gradle", "libs.versions.toml")));
    deps = gradleFile ? gradleDeps((await readText(path.join(dir, gradleFile)))!, props, catalog) : [];
    if (rootDir === dir) {
      const settings = (await readText(path.join(dir, "settings.gradle.kts"))) ?? (await readText(path.join(dir, "settings.gradle"))) ?? "";
      modules = gradleIncludes(settings).map((m) => path.join(dir, m)).filter((m) => existsSync(m));
    }
  } else {
    throw new Error(`No pom.xml or build.gradle(.kts) in ${dir}.`);
  }
  const chosen = pick(deps);
  const pluginYml = await findPluginYml(dir);
  let mcVersion = chosen ? mcFromArtifactVersion(chosen.dep.version) : undefined;
  if (chosen) detectedFrom.push(`${chosen.dep.group}:${chosen.dep.artifact}:${chosen.dep.version}${chosen.dep.classifier ? `:${chosen.dep.classifier}` : ""} (${chosen.dep.via})`);
  if (!mcVersion && pluginYml?.apiVersion) {
    mcVersion = pluginYml.apiVersion;
    detectedFrom.push(`api-version ${pluginYml.apiVersion} (${path.basename(pluginYml.file)}) — no platform dependency found`);
  }
  // module-only roots (aggregators) are fine: nms_validate walks their modules
  if (!mcVersion && !modules.length) throw new Error(`Could not determine the Minecraft version of ${dir}: no paper-api / spigot(-api) / bukkit / dev-bundle dependency with a literal version, and no api-version in plugin.yml.`);
  const fileDeps = deps.filter((d) => d.systemPath && /\.jar$/.test(d.systemPath));
  const fileDep = fileDeps.find((d) => /paper|spigot|craftbukkit|server|patched/i.test(path.basename(d.systemPath!))) ?? fileDeps[0];
  const serverJar = fileDep?.systemPath ? path.resolve(dir, fileDep.systemPath.replace(/\$\{(project\.basedir|basedir)\}/g, dir)) : undefined;
  let nms: NmsKind = chosen?.nms ?? "none";
  if (nms === "none" && serverJar) nms = "server-file";
  const platform: Platform = chosen?.platform ?? (pluginYml?.file.endsWith("paper-plugin.yml") ? "paper" : "spigot");
  const devMappings: MappingNs | undefined = nms === "paperweight" || nms === "spigot-remapped" ? "mojang" : undefined;
  if (devMappings) detectedFrom.push(`${devMappings} names in dev (${nms})`);
  return {
    dir,
    build,
    rootDir,
    platform,
    mcVersion: mcVersion ?? "",
    apiVersionString: chosen?.dep.version,
    devMappings,
    nms,
    serverJar,
    pluginYml,
    javaSourceRoots: await existingDirs(dir, ["src/main/java", "src/main/kotlin"]),
    classesDirs: await existingDirs(dir, build === "maven" ? ["target/classes"] : ["build/classes/java/main", "build/classes/kotlin/main"]),
    modules,
    detectedFrom,
  };
}

/** All .java files under the given roots. */
export async function javaFiles(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".java")) out.push(p);
    }
  };
  for (const r of roots) if (existsSync(r)) await walk(r);
  return out.sort();
}
