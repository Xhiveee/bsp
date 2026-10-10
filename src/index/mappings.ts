/**
 * Mapping formats normalised to one in-memory model keyed by the obfuscated ("official") names:
 *  - Mojang ProGuard (server_mappings)              mojang ← obf
 *  - Spigot BuildData csrg (cl + members) + package.srg + CraftBukkit pom relocations   obf → spigot
 */
import { javaToDesc, mapDesc } from "./classfile.js";

export interface MappingSet {
  /** Namespace names in column order; column 0 is always "obf". */
  namespaces: string[];
  /** obf internal class name → names per namespace (index aligned with namespaces). */
  classes: Map<string, string[]>;
  /** key `obfOwner\tobfName\tobfDesc` (desc may be "" for tsrg fields) → names. */
  fields: Map<string, string[]>;
  methods: Map<string, string[]>;
}

export const key = (owner: string, name: string, desc: string) => `${owner}\t${name}\t${desc}`;

export function emptySet(namespaces: string[]): MappingSet {
  return { namespaces, classes: new Map(), fields: new Map(), methods: new Map() };
}

/** Parse Mojang ProGuard mappings (may be called repeatedly to merge client + server). */
export function parseProguard(text: string, into: MappingSet = emptySet(["obf", "mojang"])): MappingSet {
  type Pending = { owner: string; obf: string; named: string; namedDesc: string; isMethod: boolean };
  const pending: Pending[] = [];
  const namedToObf = new Map<string, string>();
  for (const [obf, names] of into.classes) namedToObf.set(names[1]!, obf);
  let owner: string | undefined;
  for (const raw of text.split("\n")) {
    if (!raw || raw.startsWith("#")) continue;
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith(" ")) {
      const m = /^(\S+) -> (\S+):$/.exec(line);
      if (!m) continue;
      const named = m[1]!.replace(/\./g, "/");
      owner = m[2]!.replace(/\./g, "/");
      into.classes.set(owner, ["obf", named].map((_, i) => (i === 0 ? owner! : named)));
      namedToObf.set(named, owner);
      continue;
    }
    if (!owner) continue;
    const t = line.trim();
    const mm = /^(?:\d+:\d+:)?(\S+) ([^\s(]+)\(([^)]*)\)(?::\d+(?::\d+)?)? -> (\S+)$/.exec(t);
    if (mm) {
      const desc = `(${mm[3] ? mm[3].split(",").map(javaToDesc).join("") : ""})${javaToDesc(mm[1]!)}`;
      pending.push({ owner, obf: mm[4]!, named: mm[2]!, namedDesc: desc, isMethod: true });
      continue;
    }
    const fm = /^(\S+) (\S+) -> (\S+)$/.exec(t);
    if (fm) pending.push({ owner, obf: fm[3]!, named: fm[2]!, namedDesc: javaToDesc(fm[1]!), isMethod: false });
  }
  const toObf = (c: string) => namedToObf.get(c);
  for (const p of pending) {
    const obfDesc = mapDesc(p.namedDesc, toObf);
    (p.isMethod ? into.methods : into.fields).set(key(p.owner, p.obf, obfDesc), [p.obf, p.named]);
  }
  return into;
}

/**
 * Spigot BuildData mappings → obf→spigot set. cl.csrg: `obf spigot`; members.csrg (pre-1.18): `owner obf spigot` (field)
 * or `owner obf desc spigot` (method) with owner/desc in Spigot names. package.srg (`./ net/minecraft/server/`) moves
 * default-package classes; `relocate` applies CraftBukkit's shade relocations (pre-1.17: flat net/minecraft/server/v1_X_RY).
 */
/**
 * Spigot names from BuildData (cl/members csrg + package.srg) and CraftBukkit's relocations. With `allClasses` (the
 * obf jar's class names) every class gets a name, as SpecialSource + shade give them: inner classes follow their outer
 * class, unmapped classes get the package mapping, and the relocation applies to the whole jar.
 */
export function parseSpigotMappings(cl: string, members: string | undefined, packages: string | undefined, relocate: (n: string) => string = (n) => n, allClasses?: Iterable<string>): MappingSet {
  const set = emptySet(["obf", "spigot"]);
  const pkg: [string, string][] = [];
  for (const line of (packages ?? "").split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)$/.exec(line.trim());
    if (m && !line.startsWith("#")) pkg.push([m[1] === "./" ? "" : m[1]!, m[2]!]);
  }
  const applyPkg = (n: string) => {
    for (const [from, to] of pkg) {
      if (from === "" && !n.includes("/")) return to + n;
      if (from && n.startsWith(from)) return to + n.slice(from.length);
    }
    return n;
  };
  const toSpigot = new Map<string, string>(); // obf → final spigot
  const unrelocated = new Map<string, string>(); // csrg spigot name → obf
  for (const line of cl.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const [obf, named] = line.trim().split(/\s+/);
    if (!obf || !named) continue;
    const fin = relocate(applyPkg(named));
    toSpigot.set(obf, fin);
    unrelocated.set(named, obf);
    set.classes.set(obf, [obf, fin]);
  }
  if (allClasses) {
    const named = (obf: string): string => {
      const hit = toSpigot.get(obf);
      if (hit) return hit;
      const i = obf.lastIndexOf("$");
      const fin = i > 0 ? `${named(obf.slice(0, i))}${obf.slice(i)}` : relocate(applyPkg(obf));
      toSpigot.set(obf, fin);
      return fin;
    };
    const used = new Set([...set.classes.values()].map((v) => v[1]!));
    for (const c of allClasses) if (!set.classes.has(c)) {
      const fin = named(c);
      // first wins on collisions (e.g. net/minecraft/data/Main vs server/Main: Spigot ships no data generator)
      if (fin !== c && !used.has(fin)) set.classes.set(c, [c, fin]), used.add(fin);
    }
  }
  const ownerObf = (n: string) => unrelocated.get(n) ?? n;
  for (const line of (members ?? "").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const c = line.trim().split(/\s+/);
    if (c.length === 3) set.fields.set(key(ownerObf(c[0]!), c[1]!, ""), [c[1]!, c[2]!]);
    else if (c.length === 4) set.methods.set(key(ownerObf(c[0]!), c[1]!, mapDesc(c[2]!, (x) => unrelocated.get(x))), [c[1]!, c[3]!]);
  }
  return set;
}

/** Give "" field descriptors a real one (tiny needs them; avoids duplicates when joined with Mojang's set). */
export function fillFieldDescs(set: MappingSet, descOf: (owner: string, name: string) => string | undefined): void {
  for (const [k, names] of [...set.fields]) {
    const [owner, name, desc] = k.split("\t") as [string, string, string];
    if (desc) continue;
    const d = descOf(owner, name);
    if (!d) continue;
    set.fields.delete(k);
    set.fields.set(key(owner, name, d), names);
  }
}

/** Members known in `from` (any namespace) but absent from `set` keep their obf name in `set` (Spigot leaves most members obfuscated). */
export function completeWithObf(set: MappingSet, from: MappingSet): void {
  for (const [map, src] of [[set.fields, from.fields], [set.methods, from.methods]] as const) {
    for (const k of src.keys()) if (!map.has(k)) { const n = k.split("\t")[1]!; map.set(k, set.namespaces.map(() => n)); }
  }
}

/** Write tiny v2 with namespaces obf → target (used to drive tiny-remapper with Mojang mappings). */
export function writeTinyV2(set: MappingSet, target: number, fromName = "official", toName = "named"): string {
  const out: string[] = [`tiny\t2\t0\t${fromName}\t${toName}`];
  const byOwner = new Map<string, string[]>();
  const addMember = (kind: "f" | "m", map: Map<string, string[]>) => {
    for (const [k, names] of map) {
      const [owner, name, desc] = k.split("\t");
      if (!desc) continue; // tiny requires descriptors
      const l = byOwner.get(owner!) ?? [];
      l.push(`\t${kind}\t${desc}\t${name}\t${names[target]}`);
      byOwner.set(owner!, l);
    }
  };
  addMember("f", set.fields);
  addMember("m", set.methods);
  for (const [obf, names] of set.classes) {
    out.push(`c\t${obf}\t${names[target]}`);
    for (const m of byOwner.get(obf) ?? []) out.push(m);
  }
  return out.join("\n") + "\n";
}

/** A joined view across several mapping sets for translate_mapping. */
export interface Translation {
  kind: "class" | "field" | "method";
  /** Names per namespace; members are given as `Owner#name` plus a descriptor in `desc[ns]`. */
  names: Record<string, string>;
  owner?: Record<string, string>;
  desc?: Record<string, string>;
}

export class MappingTable {
  readonly namespaces: string[];
  private classByNs = new Map<string, Map<string, string>>(); // ns → (name → obf)

  constructor(private readonly sets: MappingSet[]) {
    this.namespaces = ["obf", ...new Set(sets.flatMap((s) => s.namespaces.slice(1)))];
  }

  private classNames(obf: string): Record<string, string> {
    const r: Record<string, string> = { obf };
    for (const s of this.sets) {
      const n = s.classes.get(obf);
      if (n) s.namespaces.forEach((ns, i) => (r[ns] = n[i]!));
    }
    return r;
  }

  private obfClass(ns: string, name: string): string | undefined {
    if (ns === "obf") return name;
    let idx = this.classByNs.get(ns);
    if (!idx) {
      idx = new Map();
      for (const s of this.sets) {
        const i = s.namespaces.indexOf(ns);
        if (i > 0) for (const [obf, n] of s.classes) idx.set(n[i]!, obf);
      }
      this.classByNs.set(ns, idx);
    }
    return idx.get(name);
  }

  private descIn(ns: string, obfDesc: string): string {
    return mapDesc(obfDesc, (c) => this.classNames(c)[ns]);
  }

  /**
   * Find entries whose name in namespace `from` matches. Accepts `pkg/Cls`, `pkg.Cls`, simple class names,
   * `Owner#member`, `Owner.member`, or a bare member name (e.g. m_1234_, method_5678, field_1234).
   */
  find(query: string, from: string, kind?: "class" | "field" | "method", limit = 25): Translation[] {
    const out: Translation[] = [];
    let q = query.trim();
    let ownerQ: string | undefined;
    let descQ: string | undefined;
    const paren = q.indexOf("(");
    if (paren > 0) {
      descQ = q.slice(paren);
      q = q.slice(0, paren);
    }
    const hash = q.lastIndexOf("#");
    if (hash > 0) {
      ownerQ = q.slice(0, hash).replace(/\./g, "/");
      q = q.slice(hash + 1);
    }
    const qSlash = q.replace(/\./g, "/");
    const classMatch = (name: string, query: string) =>
      name === query || name.endsWith(`/${query}`) || name.replace(/\$/g, "/").endsWith(`/${query.replace(/\$/g, "/")}`);

    if (!kind || kind === "class") {
      if (!ownerQ) {
        for (const s of this.sets) {
          const i = s.namespaces.indexOf(from);
          if (i < 0) continue;
          for (const [obf, n] of s.classes) {
            if (classMatch(n[i]!, qSlash) && !out.some((o) => o.names.obf === obf)) out.push({ kind: "class", names: this.classNames(obf) });
            if (out.length >= limit) return out;
          }
        }
      }
    }
    if (kind === "class") return out;
    // owner filter in obf space
    const ownerObfs = ownerQ ? this.ownerCandidates(ownerQ, from) : undefined;
    for (const [k, map] of [["field", "fields"], ["method", "methods"]] as const) {
      if (kind && kind !== k) continue;
      const seen = new Set<string>();
      for (const s of this.sets) {
        const i = s.namespaces.indexOf(from);
        if (i < 0) continue;
        for (const [mk, n] of s[map]) {
          if (n[i] !== q) continue;
          const [owner, obfName, obfDesc] = mk.split("\t") as [string, string, string];
          if (ownerObfs && !ownerObfs.has(owner)) continue;
          if (descQ && obfDesc && this.descIn(from, obfDesc) !== descQ) continue;
          const id = `${owner}\t${obfName}\t${obfDesc}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(this.member(k, owner, obfName, obfDesc));
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  private ownerCandidates(ownerQ: string, from: string): Set<string> {
    const res = new Set<string>();
    const direct = this.obfClass(from, ownerQ);
    if (direct) res.add(direct);
    else {
      for (const s of this.sets) {
        const i = s.namespaces.indexOf(from);
        if (i < 0) continue;
        for (const [obf, n] of s.classes) if (n[i] === ownerQ || n[i]!.endsWith(`/${ownerQ}`) || n[i]!.endsWith(`$${ownerQ}`)) res.add(obf);
      }
    }
    return res;
  }

  private member(kind: "field" | "method", owner: string, obfName: string, obfDesc: string): Translation {
    const names: Record<string, string> = { obf: obfName };
    const desc: Record<string, string> = {};
    for (const s of this.sets) {
      const map = kind === "field" ? s.fields : s.methods;
      let n = map.get(key(owner, obfName, obfDesc));
      if (!n && kind === "field") n = map.get(key(owner, obfName, "")) ?? [...map.entries()].find(([k]) => k.startsWith(`${owner}\t${obfName}\t`))?.[1];
      if (!n && kind === "field" && !obfDesc) n = undefined;
      if (n) s.namespaces.forEach((ns, i) => (names[ns] = n![i]!));
    }
    const ownerNames = this.classNames(owner);
    if (obfDesc) for (const ns of this.namespaces) desc[ns] = this.descIn(ns, obfDesc);
    return { kind, names, owner: ownerNames, desc: obfDesc ? desc : undefined };
  }
}
