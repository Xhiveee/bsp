/**
 * Javadoc search over the official search indexes (type-search-index.js / member-search-index.js) that every modern
 * javadoc site publishes: Paper (per version), Spigot and Bukkit (latest only), Adventure.
 */
import type { Services } from "../services.js";
import { Notes } from "../sources/index.js";
import { compareMcVersions } from "../util/mcversion.js";

export interface JavadocSet {
  id: string;
  title: string;
  base: string;
  version: string;
}
interface Entry {
  p: string;
  c?: string;
  l: string;
  u?: string;
}
export interface JavadocHit {
  set: JavadocSet;
  kind: "type" | "member";
  name: string;
  url: string;
  score: number;
}

const TTL = 7 * 24 * 3600_000;

function parseIndex(js: string | undefined): Entry[] | undefined {
  if (!js) return undefined;
  const i = js.indexOf("[");
  const j = js.lastIndexOf("]");
  if (i < 0 || j < i) return undefined;
  try {
    return (JSON.parse(js.slice(i, j + 1)) as Entry[]).filter((e) => e.p && e.l && e.p !== "<Unnamed>");
  } catch {
    return undefined;
  }
}

const cache = new Map<string, Promise<{ types: Entry[]; members: Entry[] } | undefined>>();
async function load(services: Services, base: string, notes: Notes) {
  let p = cache.get(base);
  if (!p) {
    p = (async () => {
      const [t, m] = await Promise.all([services.versions.text(`${base}type-search-index.js`, notes, TTL).catch(() => undefined), services.versions.text(`${base}member-search-index.js`, notes, TTL).catch(() => undefined)]);
      const types = parseIndex(t);
      if (!types) return undefined;
      return { types, members: parseIndex(m) ?? [] };
    })();
    cache.set(base, p);
  }
  return p;
}

/** Paper javadoc for a version: exact, else the newest patch of the same minor that has javadoc, else the newest. */
async function paperSet(services: Services, mc: string | undefined, notes: Notes): Promise<{ set: JavadocSet; note?: string } | undefined> {
  const versions = (await services.versions.paperVersions(notes).catch(() => [] as string[])).filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v)).sort((a, b) => compareMcVersions(b, a));
  const minor = mc?.split(".").slice(0, 2).join(".");
  const cands = mc ? [mc, ...versions.filter((v) => v !== mc && (v === minor || v.startsWith(`${minor}.`)) && compareMcVersions(v, mc) <= 0)] : [];
  cands.push(...versions.slice(0, 2));
  for (const v of [...new Set(cands)].slice(0, 4)) {
    const base = `https://jd.papermc.io/paper/${v}/`;
    if (await load(services, base, notes)) return { set: { id: "paper", title: "Paper javadoc", base, version: v }, note: mc && v !== mc ? `Paper javadoc for ${mc} unavailable; used ${v}.` : undefined };
  }
  return undefined;
}

export async function javadocSets(services: Services, platform: string | undefined, mc: string | undefined, notes: Notes, msgs: string[]): Promise<JavadocSet[]> {
  const out: JavadocSet[] = [];
  if (!platform || platform === "paper") {
    const p = await paperSet(services, mc, notes);
    if (p) out.push(p.set);
    if (p?.note) msgs.push(p.note);
  }
  if (platform === "spigot" || platform === "bukkit" || (!platform && !out.length)) {
    const id = platform === "bukkit" ? "bukkit" : "spigot";
    out.push({ id, title: `${id === "spigot" ? "Spigot" : "Bukkit"} javadoc`, base: `https://hub.spigotmc.org/javadocs/${id}/`, version: "latest" });
    if (mc) msgs.push(`${id === "spigot" ? "Spigot" : "Bukkit"} javadoc is published for the latest version only; check @since/@Deprecated against ${mc}.`);
  }
  out.push({ id: "adventure", title: "Adventure javadoc", base: "https://jd.advntr.dev/api/latest/", version: "latest" });
  return out;
}

const words = (s: string) => s.split(/(?<=[a-z0-9])(?=[A-Z])|[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());

/** Rank types and members by name against the query (identifiers, camel-case words, Class#member). */
export async function searchJavadoc(services: Services, sets: JavadocSet[], query: string, limit: number, notes: Notes): Promise<JavadocHit[]> {
  const q = query.trim();
  const [qc, qm] = q.includes("#") ? (q.split("#", 2) as [string, string]) : [undefined, undefined];
  const qw = [...new Set(words(q))].filter((w) => w.length > 1);
  const exact = q.replace(/\(.*$/, "").toLowerCase();
  const hits: JavadocHit[] = [];
  for (const set of sets) {
    const idx = await load(services, set.base, notes);
    if (!idx) {
      notes.warn(`${set.title} index unavailable (${set.base}).`);
      continue;
    }
    const score = (name: string, owner?: string) => {
      const n = name.replace(/\(.*$/, "").toLowerCase();
      const full = owner ? `${owner}#${n}`.toLowerCase() : n;
      if (qm && qc) {
        if (!owner || owner.toLowerCase().split(".").pop() !== qc.toLowerCase().split(".").pop()) return 0;
        return n === qm.replace(/\(.*$/, "").toLowerCase() ? 12 : n.includes(qm.toLowerCase()) ? 6 : 0;
      }
      if (n === exact || full === exact) return 10;
      const nw = new Set([...words(name.replace(/\(.*$/, "")), ...(owner ? words(owner) : [])]);
      const m = qw.filter((w) => nw.has(w) || n.includes(w)).length;
      if (!m) return 0;
      return (m / qw.length) * 6 - name.length / 200;
    };
    const base = (p: string) => `${set.base}${p.replace(/\./g, "/")}/`;
    for (const t of idx.types) {
      const s = score(t.l);
      if (s > 2) hits.push({ set, kind: "type", name: `${t.p}.${t.l}`, url: `${base(t.p)}${t.l}.html`, score: s + 0.5 });
    }
    for (const m of idx.members) {
      if (!m.c) continue;
      const s = score(m.l, m.c);
      if (s > 2.5) hits.push({ set, kind: "member", name: `${m.p}.${m.c}#${m.l}`, url: `${base(m.p)}${m.c}.html#${encodeURI(m.u ?? m.l)}`, score: s });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
