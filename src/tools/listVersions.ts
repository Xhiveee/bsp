import { z } from "zod";
import { matchVersion } from "../index/service.js";
import type { Services } from "../services.js";
import { versionFacts } from "../services.js";
import { ENDPOINTS } from "../sources/endpoints.js";
import { Notes } from "../sources/index.js";
import { compareMcVersions, isReleaseVersion, parseMcVersion } from "../util/mcversion.js";
import { okText } from "./result.js";
import { listVersionsInput } from "./schemas.js";

type A = z.infer<z.ZodObject<typeof listVersionsInput>>;
const MIN = "1.13";
const javaOfMajor = (m: number) => m - 44;

export async function listVersions(services: Services, a: A) {
  const notes = new Notes();
  const v = services.versions;
  if (a.mcVersion) return okText(await details(services, a.mcVersion, notes));
  const [manifest, paper, spigot, spigotApi, paperApi] = await Promise.all([
    v.mojangManifest(notes),
    v.paperVersions(notes).catch(() => [] as string[]),
    v.spigotVersions(notes).catch(() => [] as string[]),
    v.mavenVersions(ENDPOINTS.spigotApiMetadata, notes).catch(() => [] as string[]),
    v.mavenVersions(ENDPOINTS.paperApiMetadata, notes).catch(() => [] as string[]),
  ]);
  const ids = manifest.versions
    .filter((x) => (a.includeSnapshots ? !!parseMcVersion(x.id) : x.type === "release"))
    .map((x) => x.id)
    .filter((id) => parseMcVersion(id) && compareMcVersions(id, MIN) >= 0);
  const paperSet = new Set(paper);
  const spigotSet = new Set(spigot);
  const api = (id: string) => spigotApi.includes(`${id}-R0.1-SNAPSHOT`);
  const papi = (id: string) => paperApi.some((x) => x === `${id}-R0.1-SNAPSHOT` || x.startsWith(`${id}.build.`));
  const limit = a.limit ?? 40;
  const rows = ids.slice(0, limit).map((id) => {
    const p = paperSet.has(id) ? "paper" : "-";
    const s = spigotSet.has(id) ? "spigot" : "-";
    return `${id.padEnd(8)} ${p.padEnd(6)} ${s.padEnd(7)} ${api(id) ? "spigot-api" : "-"}${papi(id) ? " paper-api" : ""}${isReleaseVersion(id) ? "" : " (pre-release)"}`;
  });
  return okText(
    [
      `${ids.length} Minecraft versions ≥ ${MIN} (newest first${ids.length > limit ? `, showing ${limit}` : ""}). Columns: Paper build exists (Fill), Spigot BuildTools rev exists, API artifacts. Details + Java: list_versions mcVersion=<v>.`,
      ...rows,
      ...notes.warnings.map((w) => `note: ${w}`),
    ].join("\n"),
  );
}

async function details(services: Services, mc: string, notes: Notes): Promise<string> {
  const v = services.versions;
  const out: string[] = [];
  const facts = await versionFacts(services, mc, notes);
  out.push(`Minecraft ${mc}: Java ${facts.javaMajor ?? "?"} (Mojang)${facts.obfuscated === false ? ", unobfuscated" : facts.obfuscated ? ", obfuscated" : ""}${facts.mojangMappings ? ", Mojang mappings published" : facts.obfuscated ? ", no Mojang mappings (Spigot names only)" : ""}.`);
  const [pv, pb, paperApi, legacyPaperApi, devBundle, sv, cb, spigotApi, bukkit] = await Promise.all([
    v.paperVersion(mc, notes).catch(() => undefined),
    v.paperLatestBuild(mc, notes).catch(() => undefined),
    v.mavenVersions(ENDPOINTS.paperApiMetadata, notes).catch(() => [] as string[]),
    v.mavenVersions(ENDPOINTS.legacyPaperApiMetadata, notes).catch(() => [] as string[]),
    v.mavenVersions(ENDPOINTS.devBundleMetadata, notes).catch(() => [] as string[]),
    v.spigotVersion(mc, notes).catch(() => undefined),
    v.craftBukkit(mc, notes).catch(() => undefined),
    v.mavenVersions(ENDPOINTS.spigotApiMetadata, notes).catch(() => [] as string[]),
    v.mavenVersions(ENDPOINTS.bukkitMetadata, notes).catch(() => [] as string[]),
  ]);
  const pat = ["{mc}-R0.1-SNAPSHOT", "{mc}.build.*"];
  if (pb) {
    out.push(`Paper: build ${pb.id}${pb.channel ? ` (${pb.channel})` : ""}${pb.time ? ` ${pb.time.slice(0, 10)}` : ""}; downloads ${Object.keys(pb.downloads).join(", ")}${pv?.support ? `; support ${pv.support}${pv.supportEnd ? ` until ${pv.supportEnd}` : ""}` : ""}${pv?.javaMin ? `; Java ≥ ${pv.javaMin}` : ""}.`);
  } else out.push("Paper: no builds.");
  const papi = matchVersion(paperApi, pat, mc) ?? matchVersion(legacyPaperApi, pat, mc);
  const db = matchVersion(devBundle, pat, mc);
  out.push(`  paper-api: ${papi ? `${paperApi.includes(papi) ? "io.papermc.paper" : "com.destroystokyo.paper"}:paper-api:${papi}` : "not published"}; dev-bundle (paperweight-userdev): ${db ? `io.papermc.paper:dev-bundle:${db}` : "none"}.`);
  if (sv) {
    const jv = sv.javaVersions ? ` (BuildTools runs on Java ${javaOfMajor(sv.javaVersions[0])}–${javaOfMajor(sv.javaVersions[1])})` : "";
    out.push(`Spigot: BuildTools --rev ${mc}${jv}; CraftBukkit package ${cb ? (cb.packageVersion ? `org.bukkit.craftbukkit.v${cb.packageVersion}` : "org.bukkit.craftbukkit (not relocated)") : "?"}${cb?.relocations.some((r) => r.rawString && /net\/minecraft/.test(r.pattern)) ? `, NMS flattened to net.minecraft.server.v${cb.packageVersion}` : ""}.`);
  } else out.push("Spigot: no BuildTools revision.");
  const sapi = matchVersion(spigotApi, ["{mc}-R0.1-SNAPSHOT"], mc);
  const bk = matchVersion(bukkit, ["{mc}-R0.1-SNAPSHOT"], mc);
  out.push(`  spigot-api: ${sapi ? `org.spigotmc:spigot-api:${sapi}` : "not published"}${bk ? `; org.bukkit:bukkit:${bk}` : ""}. org.spigotmc:spigot (NMS) only via BuildTools (local ~/.m2).`);
  out.push(`Next: get_profile mcVersion=${mc} platform=paper|spigot.`);
  return [...out, ...notes.warnings.map((w) => `note: ${w}`)].join("\n");
}
