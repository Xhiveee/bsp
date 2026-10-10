/**
 * Server-code indexes per (Minecraft version, source, names). Sources:
 *  - paper:   the Paper server jar from PaperMC's downloads service (Fill). Paperclip jars are patched with
 *             `-Dpaperclip.patchonly=true` (applies patches and exits; the server is never started). Contains NMS
 *             (Paper-patched), CraftBukkit and the Paper API. Names: Mojang ("server:mojang" download or 1.20.5+) or Spigot.
 *  - spigot:  a local BuildTools output (~/.m2 org.spigotmc:spigot[:remapped-mojang], BSP_BUILDTOOLS_DIRS) — never downloaded.
 *  - vanilla: Mojang's server jar remapped to Mojang (ProGuard, 1.14.4+) or Spigot names (BuildData csrg + CraftBukkit
 *             relocations), merged with the platform API jar. No CraftBukkit.
 *  - jar:     any server jar the user points to (bundler / paperclip / plain).
 */
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../exec/run.js";
import { readProjectInfo, type ProjectInfo } from "../project/info.js";
import type { MappingNs, Platform } from "../profiles/schema.js";
import { lookupProfile, versionFacts, type Services } from "../services.js";
import { ENDPOINTS } from "../sources/endpoints.js";
import { Notes } from "../sources/index.js";
import { relocate } from "../sources/spigot.js";
import { downloadFile } from "../util/download.js";
import { completeWithObf, emptySet, fillFieldDescs, MappingTable, parseProguard, parseSpigotMappings, writeTinyV2, type MappingSet } from "./mappings.js";
import { indexJar, McIndex, vineflowerDecompile, vineflowerDecompileMany, type IndexMeta } from "./store.js";
import { toolJar, toolJava } from "./tooljars.js";

export type IndexSource = "auto" | "paper" | "spigot" | "vanilla";

export interface IndexSpec {
  mcVersion?: string;
  platform?: Platform;
  mappings?: MappingNs;
  source?: IndexSource;
  /** A server jar to index (BuildTools output, Paper jar, …). */
  serverJar?: string;
  projectDir?: string;
}

export interface OpenedIndex {
  index: McIndex;
  notes: string[];
  project?: ProjectInfo;
}

/** Classes worth indexing: server code + platform API, not shaded third-party libraries. */
export const KEEP_CLASS = /^(net\/minecraft\/|com\/mojang\/(math|brigadier)\/|org\/bukkit\/|org\/spigotmc\/|io\/papermc\/|com\/destroystokyo\/|ca\/spottedleaf\/|net\/kyori\/adventure\/|net\/md_5\/bungee\/api\/chat\/|[^/]+\.class$)/;
const API_LIB = /(^|\/)(paper-api|spigot-api|bukkit|adventure-api|adventure-key|brigadier)-[^/]*\.jar$/;

/** Which names a jar uses, from the classes it contains (works for any version). */
export function detectNamespace(names: Iterable<string>): { ns: MappingNs; craftBukkitPackage?: string } {
  let ns: MappingNs | undefined;
  let cb: string | undefined;
  let obfCount = 0;
  for (const n of names) {
    if (n === "net/minecraft/server/level/ServerPlayer.class" || n === "net/minecraft/world/entity/Entity.class") ns ??= "mojang";
    else if (n === "net/minecraft/server/level/EntityPlayer.class" || /^net\/minecraft\/server\/v\d+_\d+_R\d+\//.test(n)) ns = "spigot";
    else if (/^[a-z]{1,3}\.class$/.test(n)) obfCount++;
    const m = /^org\/bukkit\/craftbukkit\/(v\d+_\d+_R\d+\/)?CraftServer\.class$/.exec(n);
    if (m) cb = m[1] ? m[1].slice(0, -1) : "";
  }
  return { ns: ns ?? (obfCount > 50 ? "obf" : "mojang"), craftBukkitPackage: cb };
}

export class IndexService {
  private loaded = new Map<string, McIndex>();
  private building = new Map<string, Promise<McIndex>>();
  private tables = new Map<string, Promise<{ table: MappingTable; notes: string[] }>>();

  constructor(private readonly services: Services) {}

  private get root(): string {
    return path.join(this.services.config.cacheDir, "index");
  }

  private dl(url: string, dest: string, sum: { sha1?: string; sha256?: string } = {}) {
    return downloadFile(url, dest, { userAgent: this.services.config.userAgent, offline: this.services.config.offline, ...sum });
  }

  private async once(key: string, build: () => Promise<McIndex>): Promise<McIndex> {
    const hit = this.loaded.get(key);
    if (hit) return hit;
    let p = this.building.get(key);
    if (!p) {
      p = build().finally(() => this.building.delete(key));
      this.building.set(key, p);
    }
    const idx = await p;
    this.loaded.set(key, idx);
    while (this.loaded.size > 3) this.loaded.delete(this.loaded.keys().next().value!);
    return idx;
  }

  /** Default names for a version: Mojang where it exists (1.14.4+), otherwise Spigot's. */
  async defaultNamespace(mc: string): Promise<MappingNs> {
    const f = await versionFacts(this.services, mc);
    if (f.obfuscated === false || f.mojangMappings) return "mojang";
    return "spigot";
  }

  async open(spec: IndexSpec, onProgress?: (msg: string) => void): Promise<OpenedIndex> {
    const notes: string[] = [];
    const project = spec.projectDir ? await readProjectInfo(spec.projectDir) : undefined;
    const mc = spec.mcVersion ?? project?.mcVersion;
    if (!mc) throw new Error("Give mcVersion or projectDir.");
    if (project && spec.mcVersion && spec.mcVersion !== project.mcVersion) notes.push(`mcVersion ${spec.mcVersion} differs from the project's ${project.mcVersion}; using ${spec.mcVersion}.`);
    const platform: Platform = spec.platform ?? project?.platform ?? "paper";
    let ns = spec.mappings ?? project?.devMappings;
    if (!ns && project) {
      try {
        ns = (await lookupProfile(this.services, platform, mc)).profile.nms.devMappings;
      } catch {
        /* fall through */
      }
    }
    ns ??= await this.defaultNamespace(mc);
    const source = spec.source ?? "auto";
    const jarPath = spec.serverJar ?? (source === "auto" ? project?.serverJar : undefined);

    if (jarPath) {
      const index = await this.openJar(path.resolve(jarPath), mc, onProgress);
      return { index, notes: [...notes, ...index.meta.notes], project };
    }
    if (source === "spigot" || (source === "auto" && platform !== "paper")) {
      const local = this.localSpigotJar(mc, ns);
      if (local) {
        const index = await this.openJar(local, mc, onProgress, "spigot");
        if (index.meta.namespace !== ns) notes.push(`Local BuildTools jar uses ${index.meta.namespace} names (asked: ${ns}).`);
        return { index, notes: [...notes, `Spigot ${mc} from local BuildTools output ${local}.`, ...index.meta.notes], project };
      }
      if (source === "spigot") throw new Error(`No BuildTools output for Spigot ${mc} found (looked in ${path.join(this.services.config.mavenLocal, "org", "spigotmc", "spigot")} and BSP_BUILDTOOLS_DIRS). Run \`java -jar BuildTools.jar --rev ${mc}${ns === "mojang" ? " --remapped" : ""}\`, pass serverJar=, or use source=paper / vanilla.`);
      if (platform === "spigot") notes.push(`No local Spigot (BuildTools) jar for ${mc}: using Mojang's server + spigot-api — CraftBukkit is not included (source=paper has Paper's CraftBukkit).`);
    }
    if (source === "paper" || (source === "auto" && platform === "paper")) {
      try {
        const index = await this.openPaper(mc, ns, onProgress);
        if (index.meta.namespace !== ns) {
          if (source === "paper") notes.push(`Paper ${mc} offers only ${index.meta.namespace} names (asked: ${ns}).`);
          else throw new Error(`Paper ${mc} ships ${index.meta.namespace} names, not ${ns}`);
        }
        return { index, notes: [...notes, ...index.meta.notes], project };
      } catch (e) {
        if (source === "paper") throw e;
        notes.push(`Paper jar unavailable (${(e as Error).message.split("\n")[0]}); using Mojang's server + API jar instead (no CraftBukkit).`);
      }
    }
    const key = `vanilla:${platform === "paper" ? "paper" : "spigot"}:${mc}:${ns}`;
    const index = await this.once(key, async () => (await McIndex.load(path.join(this.root, "vanilla", mc, `${ns}-${platform === "paper" ? "paper" : "spigot"}`))) ?? this.buildVanilla(mc, ns, platform, onProgress));
    return { index, notes: [...notes, ...index.meta.notes], project };
  }

  // ---------------- jars ----------------

  private localSpigotJar(mc: string, ns: MappingNs): string | undefined {
    const v = `${mc}-R0.1-SNAPSHOT`;
    const dir = path.join(this.services.config.mavenLocal, "org", "spigotmc", "spigot", v);
    const cands = ns === "mojang" ? [`spigot-${v}-remapped-mojang.jar`, `spigot-${v}.jar`] : [`spigot-${v}.jar`, `spigot-${v}-remapped-obf.jar`];
    for (const c of cands) if (existsSync(path.join(dir, c))) return path.join(dir, c);
    for (const d of this.services.config.buildToolsDirs) {
      for (const c of [`spigot-${mc}.jar`, ...cands]) if (existsSync(path.join(d, c))) return path.join(d, c);
    }
    return undefined;
  }

  /** True when the jar is a Paperclip launcher that supports patch-only mode. */
  private paperclip(zip: AdmZip): "patchable" | "no-patchonly" | undefined {
    const isClip = zip.getEntry("META-INF/patches.list") || zip.getEntries().some((e) => /(^|\/)paperclip\/.*\.class$/i.test(e.entryName));
    if (!isClip) return undefined;
    for (const e of zip.getEntries()) if (/paperclip\/.*\.class$/i.test(e.entryName) && e.getData().includes("paperclip.patchonly")) return "patchable";
    return "no-patchonly";
  }

  /** Server classes + API jars from any server jar (bundler, paperclip, or plain). */
  private async unpackServerJar(file: string, work: string, onProgress?: (m: string) => void): Promise<string[]> {
    const zip = new AdmZip(file);
    const clip = this.paperclip(zip);
    if (clip === "no-patchonly") throw new Error(`${path.basename(file)} is a Paperclip launcher without patch-only mode; BSP will not start a server to patch it. Give the patched jar (cache/patched_*.jar) instead.`);
    if (clip === "patchable") {
      const out = path.join(work, "paperclip");
      await mkdir(out, { recursive: true });
      onProgress?.(`Patching ${path.basename(file)} (paperclip.patchonly: applies patches and exits, no server start)…`);
      const java = await toolJava();
      const r = await runProcess({ command: java, args: ["-Dpaperclip.patchonly=true", "-jar", file], cwd: out, timeoutMs: 900_000, logFile: path.join(work, "paperclip.log") });
      if (r.exitCode !== 0) throw new Error(`Paperclip patching failed (exit ${r.exitCode}): ${r.tail.slice(-6).join(" | ")}`);
      const jars: string[] = [];
      const walk = (d: string) => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".jar")) jars.push(p);
        }
      };
      walk(path.join(out, "versions"));
      walk(path.join(out, "cache")); // pre-1.18: cache/patched_<mc>.jar
      const server = jars.filter((j) => /versions|patched_/.test(j) && !/mojang_[\d.]+\.jar$/.test(path.basename(j)));
      const libs: string[] = [];
      const walkLibs = (d: string) => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walkLibs(p);
          else if (API_LIB.test(p.replace(/\\/g, "/"))) libs.push(p);
        }
      };
      walkLibs(path.join(out, "libraries"));
      if (!server.length) throw new Error(`Paperclip produced no patched jar (log: ${path.join(work, "paperclip.log")}).`);
      return [...server, ...libs];
    }
    const nested = zip.getEntries().filter((e) => /^META-INF\/versions\/.+\.jar$/.test(e.entryName));
    if (nested.length) {
      // bundler (1.18+): server jar(s) in META-INF/versions, libraries (incl. the API) in META-INF/libraries
      const out: string[] = [];
      await mkdir(work, { recursive: true });
      for (const e of [...nested, ...zip.getEntries().filter((x) => /^META-INF\/libraries\/.+\.jar$/.test(x.entryName) && API_LIB.test(x.entryName))]) {
        const f = path.join(work, "unbundled", e.entryName.replace(/^META-INF\//, ""));
        await mkdir(path.dirname(f), { recursive: true });
        await writeFile(f, e.getData());
        out.push(f);
      }
      return out;
    }
    return [file];
  }

  /** Merge class files of several jars (first wins), keeping only server/API packages. */
  private mergeClasses(jars: string[], out: string, filter = KEEP_CLASS): void {
    const merged = new AdmZip();
    const seen = new Set<string>();
    for (const j of jars) {
      for (const e of new AdmZip(j).getEntries()) {
        if (e.isDirectory || !e.entryName.endsWith(".class") || e.entryName.startsWith("META-INF/") || seen.has(e.entryName) || !filter.test(e.entryName)) continue;
        seen.add(e.entryName);
        merged.addFile(e.entryName, e.getData());
      }
    }
    merged.writeZip(out);
  }

  private async indexMerged(dir: string, jars: string[], meta: Omit<IndexMeta, "formatVersion" | "jar" | "builtAt" | "classCount" | "namespace" | "craftBukkitPackage">, nsHint?: MappingNs): Promise<McIndex> {
    await mkdir(dir, { recursive: true });
    const jar = path.join(dir, "server-merged.jar");
    this.mergeClasses(jars, `${jar}.tmp`);
    await rename(`${jar}.tmp`, jar);
    const names = new AdmZip(jar).getEntries().map((e) => e.entryName);
    const det = detectNamespace(names);
    const classes = indexJar(jar);
    return McIndex.save(dir, { formatVersion: 1, jar, builtAt: new Date().toISOString(), classCount: classes.length, namespace: nsHint ?? det.ns, craftBukkitPackage: det.craftBukkitPackage, ...meta }, classes);
  }

  async openJar(file: string, mc: string, onProgress?: (m: string) => void, kind: IndexMeta["kind"] = "jar"): Promise<McIndex> {
    if (!existsSync(file)) throw new Error(`Server jar not found: ${file}`);
    const st = statSync(file);
    const hash = createHash("sha1").update(`${file}:${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 16);
    const dir = path.join(this.root, "jar", hash);
    return this.once(`jar:${hash}`, async () => {
      const hit = await McIndex.load(dir);
      if (hit) return hit;
      const jars = await this.unpackServerJar(file, path.join(dir, "work"), onProgress);
      onProgress?.(`Indexing ${path.basename(file)}…`);
      return this.indexMerged(dir, jars, { kind, mcVersion: mc, label: `${kind === "spigot" ? "Spigot (BuildTools)" : "server jar"} ${path.basename(file)}`, notes: [] });
    });
  }

  async openPaper(mc: string, ns: MappingNs, onProgress?: (m: string) => void): Promise<McIndex> {
    const notes = new Notes();
    const build = await this.services.versions.paperLatestBuild(mc, notes);
    if (!build) throw new Error(`PaperMC has no builds for ${mc}.`);
    const keys = Object.keys(build.downloads);
    const key = ns === "mojang" ? (keys.includes("server:mojang") ? "server:mojang" : "server:default") : "server:default";
    const d = build.downloads[key];
    if (!d) throw new Error(`Paper ${mc} build ${build.id} has no ${key} download (has: ${keys.join(", ")}).`);
    const dir = path.join(this.root, "paper", mc, `${build.id}-${key.replace(/\W/g, "_")}`);
    return this.once(`paper:${mc}:${build.id}:${key}`, async () => {
      const hit = await McIndex.load(dir);
      if (hit) return hit;
      onProgress?.(`Downloading ${d.name}…`);
      const file = await this.dl(d.url, path.join(this.services.config.cacheDir, "downloads", "paper", d.name), { sha256: d.sha256 });
      const jars = await this.unpackServerJar(file, path.join(dir, "work"), onProgress);
      onProgress?.("Indexing Paper server classes…");
      return this.indexMerged(dir, jars, { kind: "paper", mcVersion: mc, label: `Paper ${mc} build ${build.id}`, notes: [] });
    });
  }

  // ---------------- vanilla + mappings ----------------

  /** Mojang's server jar (bundled inner jar on 1.18+), filtered to Minecraft classes. */
  private async vanillaServerJar(mc: string, onProgress?: (m: string) => void): Promise<string> {
    const details = await this.services.versions.mojangVersion(mc);
    if (!details) throw new Error(`Minecraft ${mc} is not in Mojang's version manifest.`);
    const s = details.downloads.server;
    if (!s) throw new Error(`Mojang lists no server download for ${mc}.`);
    const dir = path.join(this.root, "vanilla", mc);
    const out = path.join(dir, "server-classes.jar");
    if (existsSync(out)) return out;
    onProgress?.(`Downloading Minecraft ${mc} server jar…`);
    const jar = await this.dl(s.url, path.join(dir, "server.jar"), { sha1: s.sha1 });
    let zip = new AdmZip(jar);
    const nested = zip.getEntries().find((e) => /^META-INF\/versions\/[^/]+\/server-[^/]+\.jar$/.test(e.entryName));
    if (nested) zip = new AdmZip(nested.getData());
    const merged = new AdmZip();
    for (const e of zip.getEntries()) if (e.entryName.endsWith(".class") && /^(net\/minecraft\/|com\/mojang\/math\/|[^/]+\.class$)/.test(e.entryName)) merged.addFile(e.entryName, e.getData());
    await mkdir(dir, { recursive: true });
    merged.writeZip(`${out}.tmp`);
    await rename(`${out}.tmp`, out);
    return out;
  }

  /** Mojang ProGuard server mappings (obf → mojang). */
  async mojangSet(mc: string): Promise<MappingSet | undefined> {
    const d = (await this.services.versions.mojangVersion(mc))?.downloads.server_mappings;
    if (!d) return undefined;
    const f = await this.dl(d.url, path.join(this.root, "vanilla", mc, "server_mappings.txt"), { sha1: d.sha1 });
    return parseProguard(await readFile(f, "utf8"), emptySet(["obf", "mojang"]));
  }

  /** Spigot names (obf → spigot) from BuildData at the BuildTools commit, with CraftBukkit's NMS relocations. */
  async spigotSet(mc: string): Promise<{ set: MappingSet; commit: string; relocated?: string } | undefined> {
    const v = this.services.versions;
    const bd = await v.buildData(mc);
    if (!bd?.info.classMappings) return undefined;
    const [cl, members, pkg, cb] = await Promise.all([
      v.buildDataFile(bd.commit, bd.info.classMappings),
      bd.info.memberMappings ? v.buildDataFile(bd.commit, bd.info.memberMappings) : undefined,
      bd.info.packageMappings ? v.buildDataFile(bd.commit, bd.info.packageMappings) : undefined,
      v.craftBukkit(mc),
    ]);
    if (!cl) return undefined;
    const nmsRel = (cb?.relocations ?? []).filter((r) => /net[./]minecraft|com[./]mojang/.test(r.pattern));
    const set = parseSpigotMappings(cl, members, pkg, (n) => relocate(n, nmsRel));
    return { set, commit: bd.commit, relocated: cb?.packageVersion };
  }

  private async buildVanilla(mc: string, ns: MappingNs, platform: Platform, onProgress?: (m: string) => void): Promise<McIndex> {
    const notes: string[] = [];
    const serverJar = await this.vanillaServerJar(mc, onProgress);
    const facts = await versionFacts(this.services, mc);
    const dir = path.join(this.root, "vanilla", mc, `${ns}-${platform === "paper" ? "paper" : "spigot"}`);
    await mkdir(dir, { recursive: true });
    let named = serverJar;
    if (facts.obfuscated !== false && ns !== "obf") {
      let set: MappingSet | undefined;
      if (ns === "mojang") {
        set = await this.mojangSet(mc);
        if (!set) throw new Error(`Mojang published no mappings for ${mc} (they start with 1.14.4). Use mappings=spigot.`);
      } else {
        const sp = await this.spigotSet(mc);
        if (!sp) throw new Error(`No Spigot BuildData class mappings for ${mc}.`);
        set = sp.set;
        const obfIdx = indexJar(serverJar);
        const fdesc = new Map(obfIdx.flatMap((c) => c.f.map(([n, d]) => [`${c.n}\t${n}`, d] as const)));
        fillFieldDescs(set, (o, n) => fdesc.get(`${o}\t${n}`));
        notes.push(`Spigot names from BuildData ${sp.commit.slice(0, 10)}${sp.relocated ? ` (NMS relocated to v${sp.relocated})` : ""}; most members stay obfuscated, as on a real Spigot server.`);
      }
      const tiny = path.join(dir, "mappings.tiny");
      await writeFile(tiny, writeTinyV2(set, 1));
      named = path.join(dir, "named.jar");
      onProgress?.(`Remapping Minecraft ${mc} server to ${ns} names…`);
      const r = await runProcess({
        command: await toolJava(),
        args: ["-Xmx2G", "-jar", await toolJar(this.services, "tiny-remapper"), serverJar, `${named}.tmp.jar`, tiny, "official", "named", "--ignoreConflicts", "--renameInvalidLocals", "--rebuildSourceFilenames"],
        cwd: dir,
        timeoutMs: 900_000,
        logFile: path.join(dir, "remap.log"),
      });
      if (r.exitCode !== 0 || !existsSync(`${named}.tmp.jar`)) throw new Error(`tiny-remapper failed (exit ${r.exitCode}): ${r.tail.slice(-6).join("\n")}`);
      await rename(`${named}.tmp.jar`, named);
    } else if (facts.obfuscated === false) notes.push(`Minecraft ${mc} ships unobfuscated (Mojang names, no remapping).`);
    const api = await this.apiJar(mc, platform).catch((e: Error) => {
      notes.push(`API jar not added: ${e.message}`);
      return undefined;
    });
    if (api) notes.push(`API: ${path.basename(api)}.`);
    notes.push("Vanilla server classes: no CraftBukkit and no Paper/Spigot patches (use source=paper, or a BuildTools jar via serverJar).");
    onProgress?.("Indexing…");
    return this.indexMerged(dir, [named, ...(api ? [api] : [])], { kind: "vanilla", mcVersion: mc, label: `Mojang ${mc} server + ${platform === "paper" ? "paper-api" : "spigot-api"}`, notes }, ns);
  }

  /** The platform API jar for a version (paper-api or spigot-api), from the official Maven repos. */
  async apiJar(mc: string, platform: Platform): Promise<string> {
    const { profile } = await lookupProfile(this.services, platform === "paper" ? "paper" : "spigot", mc);
    const ga = `${profile.api.group}:${profile.api.artifact}`;
    const versions = await this.services.versions.mavenVersions(profile.api.metadataUrl);
    const version = matchVersion(versions, profile.api.versions, mc);
    if (!version) throw new Error(`${ga} has no build for ${mc}`);
    const file = await this.services.versions.jarFileName(profile.api.repository, ga, version);
    return this.dl(ENDPOINTS.artifact(profile.api.repository, ga, version, file), path.join(this.services.config.cacheDir, "downloads", "api", file));
  }

  // ---------------- sources & translation ----------------

  async source(index: McIndex, className: string) {
    return index.source(className, async (outer) => vineflowerDecompile(await toolJava(), await toolJar(this.services, "vineflower"), index, outer));
  }

  async decompileMany(index: McIndex, outers: string[]): Promise<Map<string, string>> {
    const m = await vineflowerDecompileMany(await toolJava(), await toolJar(this.services, "vineflower"), index, outers);
    for (const [o, t] of m) await index.storeSource(o, t);
    return m;
  }

  /** Joined table obf ↔ mojang ↔ spigot (whatever exists for the version). */
  async table(mc: string): Promise<{ table: MappingTable; notes: string[] }> {
    let p = this.tables.get(mc);
    if (!p) {
      p = (async () => {
        const notes: string[] = [];
        const sets: MappingSet[] = [];
        let moj: MappingSet | undefined;
        try {
          moj = await this.mojangSet(mc);
          if (moj) sets.push(moj);
          else notes.push(`Mojang mappings: not published for ${mc}.`);
        } catch (e) {
          notes.push(`Mojang mappings could not be loaded: ${(e as Error).message}`);
        }
        try {
          const sp = await this.spigotSet(mc);
          if (sp) {
            if (moj) {
              const fd = new Map([...moj.fields.keys()].map((k) => { const [o, n, d] = k.split("\t"); return [`${o}\t${n}`, d!] as const; }));
              fillFieldDescs(sp.set, (o, n) => fd.get(`${o}\t${n}`));
              completeWithObf(sp.set, moj);
            }
            sets.push(sp.set);
            notes.push(`Spigot: BuildData ${sp.commit.slice(0, 10)}${sp.relocated ? `, NMS/CraftBukkit package v${sp.relocated}` : ""}.`);
          } else notes.push(`Spigot mappings: none for ${mc} (unobfuscated or not built by BuildTools).`);
        } catch (e) {
          notes.push(`Spigot mappings could not be loaded: ${(e as Error).message}`);
        }
        return { table: new MappingTable(sets), notes };
      })();
      this.tables.set(mc, p);
      p.catch(() => this.tables.delete(mc));
    }
    return p;
  }
}

/** First version matching the patterns ("{mc}" substituted, "*" = any run), newest build when several match. */
export function matchVersion(available: string[], patterns: string[], mc: string): string | undefined {
  for (const pat of patterns) {
    const re = new RegExp(`^${pat.replace(/\{mc\}/g, mc).replace(/[.+?^$()[\]{}|\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    const hits = available.filter((v) => re.test(v));
    if (hits.length) return hits.sort((a, b) => buildNo(b) - buildNo(a))[0];
  }
  return undefined;
}
const buildNo = (v: string) => Number(/build\.(\d+)/.exec(v)?.[1] ?? 0);

