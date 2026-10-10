import { z } from "zod";
import path from "node:path";
import type { McIndex } from "../index/store.js";
import { checkRefs, type Problem } from "../nms/check.js";
import { collectBytecode, collectSource, type NmsRef } from "../nms/refs.js";
import { readProjectInfo, type ProjectInfo } from "../project/info.js";
import type { MappingNs, Platform } from "../profiles/schema.js";
import { lookupProfile, versionFacts, type Services } from "../services.js";
import { compareMcVersions } from "../util/mcversion.js";
import { fail, okText } from "./result.js";
import { nmsValidateInput } from "./schemas.js";

type A = z.infer<z.ZodObject<typeof nmsValidateInput>>;

interface ModuleReport {
  label: string;
  lines: string[];
  problems: number;
}

export async function nmsValidate(services: Services, a: A) {
  const root = await readProjectInfo(a.projectDir);
  const mods: ProjectInfo[] = [];
  if (root.mcVersion) mods.push(root);
  for (const m of root.modules) {
    try {
      const info = await readProjectInfo(m);
      if (info.mcVersion) mods.push(info);
    } catch {
      /* module without a platform dependency */
    }
  }
  if (!mods.length) return fail(`No module of ${root.dir} depends on Paper/Spigot/Bukkit.`);
  const reports: ModuleReport[] = [];
  for (const info of mods) reports.push(await validateModule(services, info, a, root.dir));
  const total = reports.reduce((s, r) => s + r.problems, 0);
  const lines = reports.length === 1 ? reports[0]!.lines : reports.flatMap((r) => [`[${r.label}]`, ...r.lines]);
  return okText([`${total ? `${total} problem(s)` : "No problems"} in ${reports.length} module(s).`, ...lines].join("\n"));
}

async function validateModule(services: Services, info: ProjectInfo, a: A, rootDir: string): Promise<ModuleReport> {
  const label = path.relative(rootDir, info.dir) || path.basename(info.dir);
  const inc = new Set(a.include ?? ["bytecode", "source"]);
  const out: string[] = [];
  const refs: NmsRef[] = [];
  let bcFiles = 0;
  let srcFiles = 0;
  if (inc.has("bytecode")) {
    const bc = await collectBytecode(info.classesDirs);
    bcFiles = bc.files;
    refs.push(...bc.refs);
    if (inc.has("source") || bc.files === 0) {
      const src = await collectSource(info.javaSourceRoots, info.dir);
      srcFiles = src.files;
      // with bytecode, sources only add what bytecode can't show: reflection by name, and imports when not compiled
      refs.push(...src.refs.filter((r) => r.origin === "reflection" || bc.files === 0));
      if (bc.files && src.newest > bc.newest) out.push("note: sources are newer than compiled classes — build first for exact member checks.");
    }
    if (!bc.files) out.push(`note: not compiled (${info.build === "maven" ? "target/classes" : "build/classes"} missing): only imports and reflection strings checked; run build for member-level checks.`);
  } else {
    const src = await collectSource(info.javaSourceRoots, info.dir);
    srcFiles = src.files;
    refs.push(...src.refs);
  }
  const target = a.targetVersion ?? info.mcVersion;
  const platform: Platform = a.targetPlatform ?? info.platform;
  const apiNote = apiVersionCheck(info, target);
  if (apiNote) out.push(apiNote);
  if (!refs.length) {
    out.push(`${label}: no NMS/CraftBukkit references (${bcFiles} class files, ${srcFiles} sources) — nothing version-specific to check.`);
    return { label, lines: out, problems: apiNote?.startsWith("error") ? 1 : 0 };
  }
  // Names: compiled/imported refs are in dev names; reflection strings are resolved at runtime → runtime names.
  const facts = await versionFacts(services, target);
  let runtimeNs: MappingNs = facts.obfuscated === false ? "mojang" : "spigot";
  try {
    runtimeNs = (await lookupProfile(services, platform === "bukkit" ? "spigot" : platform, target)).profile.nms.runtimeMappings;
  } catch {
    /* keep default */
  }
  const useJar = a.serverJar ?? (a.targetVersion ? undefined : info.serverJar);
  let devNs: MappingNs | undefined = a.mappings ?? info.devMappings;
  // compiled against a server file: dev names are whatever that jar uses
  const devJar = a.serverJar ?? info.serverJar;
  if (!devNs && devJar) devNs = await services.indexes.open({ mcVersion: a.serverJar ? target : info.mcVersion, platform, serverJar: devJar }).then((o) => o.index.meta.namespace as MappingNs, () => undefined);
  devNs ??= facts.obfuscated === false ? "mojang" : "spigot";
  if (info.nms === "server-file" && devNs !== runtimeNs && refs.some((r) => r.origin !== "reflection"))
    out.push(`warning: compiled against ${devNs} names, but ${platform} ${target} runs ${runtimeNs} names — remap the jar (SpecialSource/paperweight reobf) before shipping.`);
  const groups: [MappingNs, NmsRef[]][] = [];
  const dev = refs.filter((r) => r.origin !== "reflection" || devNs === runtimeNs);
  const rt = refs.filter((r) => r.origin === "reflection" && devNs !== runtimeNs);
  if (dev.length) groups.push([devNs, dev]);
  if (rt.length) groups.push([runtimeNs, rt]);
  const problems: Problem[] = [];
  let checked = 0;
  let unverifiable = 0;
  let skippedCb = 0;
  for (const [ns, list] of groups) {
    let index: McIndex;
    let notes: string[];
    try {
      ({ index, notes } = await services.indexes.open({ mcVersion: target, platform, mappings: ns, serverJar: useJar }));
    } catch (e) {
      out.push(`error: cannot load ${platform} ${target} (${ns} names): ${(e as Error).message}`);
      continue;
    }
    const translateClass = await translator(services, target, ns, list);
    const r = checkRefs(index, list, { translateClass });
    out.push(`${label}: ${info.platform} ${info.mcVersion}${info.nms !== "none" ? ` (${info.nms})` : ""} vs ${index.meta.label}, ${index.meta.namespace} names${ns === runtimeNs && ns !== devNs ? " (reflection: runtime names)" : ""}.`);
    for (const n of notes) out.push(`note: ${n}`);
    problems.push(...r.problems);
    checked += r.checked;
    unverifiable += r.unverifiable;
    skippedCb += r.skippedCraftBukkit;
  }
  problems.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "error" ? -1 : 1));
  const limit = a.limit ?? 40;
  for (const p of problems.slice(0, limit)) out.push(`${p.severity}: ${p.text} | ${p.where[0]}${p.where.length > 1 ? ` (+${p.where.length - 1})` : ""}`);
  if (problems.length > limit) out.push(`… ${problems.length - limit} more (limit=)`);
  out.push(`${checked} refs checked (${bcFiles} class files, ${srcFiles} sources)${unverifiable ? `, ${unverifiable} unverifiable (inherited from non-server types)` : ""}${skippedCb ? `, ${skippedCb} CraftBukkit refs unchecked (index has no CraftBukkit)` : ""}.`);
  if (devNs !== runtimeNs && !rt.length && refs.some((r) => r.origin === "reflection")) out.push("note: reflection strings are not remapped by reobf/SpecialSource — they must use runtime names.");
  return { label, lines: out, problems: problems.length + (apiNote?.startsWith("error") ? 1 : 0) };
}

export function apiVersionCheck(info: ProjectInfo, target: string): string | undefined {
  const av = info.pluginYml?.apiVersion;
  if (!av) return info.pluginYml && compareMcVersions(target, "1.13") >= 0 ? "warn: plugin.yml has no api-version → loaded as a legacy plugin (Material conversion, slower start)." : undefined;
  if (!/^\d+\.\d+(\.\d+)?$/.test(av)) return `error: api-version '${av}' is not a version.`;
  if (av.split(".").length === 3 && compareMcVersions(target, "1.20.5") < 0) return `error: api-version '${av}' with patch is only accepted from 1.20.5; use '${av.split(".").slice(0, 2).join(".")}'.`;
  if (compareMcVersions(av, target) > 0 && av.split(".").slice(0, 2).join(".") !== target.split(".").slice(0, 2).join(".")) return `error: api-version ${av} is newer than the server ${target} → "Unsupported API version".`;
  if (compareMcVersions(av, target) > 0 && av.split(".").length === 3) return `error: api-version ${av} is newer than the server ${target} → "Unsupported API version".`;
  return undefined;
}

/** For classes missing in the index: try the other namespace via the version's mapping table. */
async function translator(services: Services, mc: string, ns: MappingNs, refs: NmsRef[]): Promise<((internal: string) => string[]) | undefined> {
  if (!refs.some((r) => r.owner.startsWith("net/minecraft/"))) return undefined;
  let table: Awaited<ReturnType<Services["indexes"]["table"]>>["table"] | undefined;
  try {
    table = (await services.indexes.table(mc)).table;
  } catch {
    return undefined;
  }
  const other = (["mojang", "spigot"] as const).filter((x) => x !== ns && table!.namespaces.includes(x));
  if (!table.namespaces.includes(ns)) return undefined;
  return (internal) => {
    const q = internal;
    for (const o of other) {
      const hits = table!.find(q, o, "class", 3).map((t) => t.names[ns]).filter((x): x is string => !!x);
      if (hits.length) return hits;
      const s = q.slice(q.lastIndexOf("/") + 1);
      const hs = table!.find(s, o, "class", 3).map((t) => t.names[ns]).filter((x): x is string => !!x);
      if (hs.length) return hs;
    }
    return [];
  };
}
