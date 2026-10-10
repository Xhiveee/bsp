/** Spigot BuildTools data: version index, per-version refs, BuildData info.json and CraftBukkit pom relocations. */
import { XMLParser } from "fast-xml-parser";

/** Version ids from https://hub.spigotmc.org/versions/ (an HTML directory listing of <id>.json files). */
export function parseSpigotIndex(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href="([^"/]+)\.json"/g)) if (/^\d+(\.\d+)+(-[\w.]+)?$/.test(m[1]!)) out.add(m[1]!);
  return [...out];
}

export interface SpigotVersionJson {
  name: string;
  refs: { BuildData?: string; Bukkit?: string; CraftBukkit?: string; Spigot?: string };
  toolsVersion?: number;
  /** [min, max] class-file majors BuildTools accepts (52 = Java 8). */
  javaVersions?: [number, number];
}
export function parseSpigotVersion(json: string): SpigotVersionJson {
  const j = JSON.parse(json) as SpigotVersionJson;
  if (!j.refs) throw new Error("Not a Spigot version file (no refs)");
  return j;
}

export interface BuildDataInfo {
  minecraftVersion: string;
  serverUrl?: string;
  mappingsUrl?: string;
  classMappings?: string;
  memberMappings?: string;
  packageMappings?: string;
  accessTransforms?: string;
  toolsVersion?: number;
}
export function parseBuildDataInfo(json: string): BuildDataInfo {
  const j = JSON.parse(json) as BuildDataInfo;
  if (!j.minecraftVersion) throw new Error("Not a BuildData info.json");
  return j;
}

export interface Relocation {
  pattern: string;
  shadedPattern: string;
  rawString: boolean;
  excludes: string[];
}
export interface CraftBukkitPom {
  /** e.g. "1_20_R3" (undefined when CraftBukkit is not relocated). */
  packageVersion?: string;
  relocations: Relocation[];
}

/** minecraft_version property and shade relocations (CraftBukkit / NMS) from CraftBukkit's pom.xml. */
export function parseCraftBukkitPom(xml: string): CraftBukkitPom {
  const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (n) => ["relocation", "exclude", "plugin", "execution"].includes(n) }).parse(xml);
  const pv = doc?.project?.properties?.minecraft_version as string | undefined;
  const rel: Relocation[] = [];
  const visit = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(visit);
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === "relocation" && Array.isArray(v)) {
        for (const r of v as Record<string, unknown>[]) {
          const pattern = String(r.pattern ?? "");
          const shaded = String(r.shadedPattern ?? "");
          if (!/craftbukkit|net[./]minecraft|com[./]mojang[./]math/.test(pattern) || /\.libs\./.test(shaded)) continue;
          const ex = (r.excludes as { exclude?: string[] } | undefined)?.exclude ?? [];
          rel.push({ pattern, shadedPattern: pv ? shaded.replace(/\$\{minecraft_version\}/g, pv) : shaded, rawString: String(r.rawString) === "true", excludes: ex.map(String) });
        }
      } else visit(v);
    }
  };
  visit(doc?.project?.build);
  return { packageVersion: pv ? String(pv) : undefined, relocations: rel };
}

/** Apply shade relocations to an internal class name (a/b/C), as maven-shade does for CraftBukkit. */
export function relocate(internal: string, rels: Relocation[]): string {
  for (const r of rels) {
    if (r.rawString) {
      const re = new RegExp(`^${r.pattern}$`);
      if (re.test(internal)) return internal.replace(re, r.shadedPattern);
      continue;
    }
    const from = r.pattern.replace(/\./g, "/");
    if (internal !== from && !internal.startsWith(`${from}/`)) continue;
    const dotted = internal.replace(/\//g, ".");
    if (r.excludes.some((e) => new RegExp(`^${e.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`).test(dotted))) continue;
    return r.shadedPattern.replace(/\./g, "/") + internal.slice(from.length);
  }
  return internal;
}
