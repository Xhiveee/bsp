/**
 * Collect a plugin's references to server internals (NMS + CraftBukkit):
 *  - bytecode: constant-pool class/field/method refs of compiled classes, plus string constants naming server classes
 *  - source:   imports, class-name string literals (Class.forName, "net.minecraft.server." + version + ".X"),
 *              reflective member lookups (X.class.getDeclaredMethod("m"), forName("…").getField("f"), var.getMethod("m"))
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ClassReader } from "../index/classfile.js";

export type RefKind = "class" | "method" | "field";
export type RefOrigin = "bytecode" | "import" | "reflection";

export interface NmsRef {
  kind: RefKind;
  /** Internal name (slashes). */
  owner: string;
  name?: string;
  /** Exact descriptor (bytecode) — undefined for reflective lookups by name. */
  desc?: string;
  origin: RefOrigin;
  /** Where: com.x.Foo (bytecode) or src/…/Foo.java:12. */
  where: string;
  /** Reflective getDeclaredX: only members declared by the owner itself count. */
  declared?: boolean;
  /** Inside a try block whose catch swallows the failure (probe / optional feature): problems are warnings. */
  guarded?: boolean;
  /** Alternatives (version branches): the group is fine when any member resolves. */
  alt?: string;
  /** Resolved by a third-party library at runtime (best-effort name): problems are warnings. */
  soft?: boolean;
}

export const SERVER_INTERNAL = /^(net\/minecraft\/|org\/bukkit\/craftbukkit\/|com\/mojang\/math\/)/;
const DOTTED_INTERNAL = /^(?:net\.minecraft\.|org\.bukkit\.craftbukkit\.)[\w.$]+$/;
export const VERSION_SEG = /^(net\/minecraft\/server|org\/bukkit\/craftbukkit)\/(v\d+_\d+_R\d+)\//;

const elementType = (n: string) => n.replace(/^\[+/, "").replace(/^L(.*);$/, "$1");

/** Server classes mentioned in a descriptor. */
export function descClasses(desc: string): string[] {
  return [...desc.matchAll(/L([^;]+);/g)].map((m) => m[1]!).filter((c) => SERVER_INTERNAL.test(c));
}

/** References of one compiled class. */
export function bytecodeRefs(buf: Buffer): NmsRef[] {
  const r = new ClassReader(buf);
  const where = r.info.name.replace(/\//g, ".");
  const out: NmsRef[] = [];
  const cls = (owner: string) => out.push({ kind: "class", owner, origin: "bytecode", where });
  r.pool.forEach((c, i) => {
    if (!c) return;
    if (c.tag === 7) {
      const n = elementType(r.utf8(c.index));
      if (SERVER_INTERNAL.test(n)) cls(n);
    } else if (c.tag === 9 || c.tag === 10 || c.tag === 11) {
      const ref = r.ref(i);
      const owner = elementType(ref.owner);
      if (SERVER_INTERNAL.test(owner) && !ref.owner.startsWith("[")) out.push({ kind: c.tag === 9 ? "field" : "method", owner, name: ref.name, desc: ref.desc, origin: "bytecode", where });
      for (const d of descClasses(ref.desc)) cls(d);
    } else if (c.tag === 8) {
      const s = r.utf8(c.index);
      if (DOTTED_INTERNAL.test(s) && /\.[A-Z]/.test(s)) out.push({ kind: "class", owner: s.replace(/\./g, "/"), origin: "reflection", where });
      // invokedynamic string-concat recipe: "net.minecraft.server.\u0001.EntityPlayer" (version inserted at runtime)
      const rm = /^(net\.minecraft\.server\.|org\.bukkit\.craftbukkit\.)\u0001\.([\w.$]+)$/.exec(s);
      if (rm && /(^|\.)[A-Z]/.test(rm[2]!)) out.push({ kind: "class", owner: `${rm[1]!.replace(/\./g, "/")}{v}/${toInternal(rm[2]!)}`, origin: "reflection", where });
    }
  });
  // signatures of the plugin's own members (overrides / fields of NMS types)
  for (const m of [...r.info.fields, ...r.info.methods]) for (const d of descClasses(m.desc)) cls(d);
  if (r.info.superName && SERVER_INTERNAL.test(r.info.superName)) cls(r.info.superName);
  for (const itf of r.info.interfaces) if (SERVER_INTERNAL.test(itf)) cls(itf);
  return out;
}

/** Blank comments and keep line numbers. */
function blankComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"\\])\/\/[^\n]*/g, "$1");
}

const lineAt = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

/** References in one Java source file. */
export function sourceRefs(text: string, file: string): NmsRef[] {
  const src = blankComments(text);
  const out: NmsRef[] = [];
  const at = (i: number) => `${file}:${lineAt(src, i)}`;
  const imports = new Map<string, string>(); // simple → internal
  for (const m of src.matchAll(/^\s*import\s+(static\s+)?((?:net\.minecraft|org\.bukkit\.craftbukkit)\.[\w.]+?)(\.\*)?\s*;/gm)) {
    if (m[3]) continue; // wildcard: package only
    let fq = m[2]!;
    if (m[1]) fq = fq.slice(0, fq.lastIndexOf(".")); // static import: owner class
    const internal = toInternal(fq);
    imports.set(internal.slice(internal.lastIndexOf("/") + 1).replace(/.*\$/, ""), internal);
    out.push({ kind: "class", owner: internal, origin: "import", where: at(m.index!) });
  }
  // string literals naming a server class
  const vars = new Map<string, string>(); // variable → internal class name
  for (const m of src.matchAll(/"((?:net\.minecraft|org\.bukkit\.craftbukkit)\.[\w.$]+)"/g)) {
    if (!/\.[A-Z][\w$]*$/.test(m[1]!)) continue; // a package prefix, handled below
    out.push({ kind: "class", owner: toInternal(m[1]!), origin: "reflection", where: at(m.index!) });
  }
  // "net.minecraft.server." + version + ".EntityPlayer"  /  "org.bukkit.craftbukkit." + v + ".entity.CraftPlayer"
  for (const m of src.matchAll(/"(net\.minecraft\.server\.|org\.bukkit\.craftbukkit\.)"\s*\+\s*[\w.()]+\s*\+\s*"\.?([\w.$]+)"/g)) {
    out.push({ kind: "class", owner: `${m[1]!.replace(/\./g, "/")}{v}/${m[2]!.replace(/\./g, "/")}`, origin: "reflection", where: at(m.index!) });
  }
  // Class<?> c = Class.forName("…") / = X.class
  for (const m of src.matchAll(/\b(\w+)\s*=\s*(?:Class\s*\.\s*forName\s*\(\s*"([\w.$]+)"|([A-Z]\w*)\s*\.\s*class\b)/g)) {
    const cls = m[2] ? toInternal(m[2]) : imports.get(m[3]!);
    if (cls && SERVER_INTERNAL.test(cls)) vars.set(m[1]!, cls);
  }
  // reflective member lookups
  for (const m of src.matchAll(/(?:Class\s*\.\s*forName\s*\(\s*"([\w.$]+)"\s*\)|\b([A-Z]\w*)\s*\.\s*class|\b([a-z]\w*))\s*\.\s*get(Declared)?(Method|Field)\s*\(\s*"([\w$]+)"/g)) {
    const owner = m[1] ? toInternal(m[1]) : m[2] ? imports.get(m[2]) : vars.get(m[3]!);
    if (!owner || !SERVER_INTERNAL.test(owner)) continue;
    out.push({ kind: m[5] === "Method" ? "method" : "field", owner, name: m[6], origin: "reflection", where: at(m.index!), ...(m[4] ? { declared: true } : {}) });
  }
  return out;
}

/** a.b.C or a.b.C$D or a.b.C.D (inner, by capitalisation) → a/b/C$D. */
export function toInternal(dotted: string): string {
  const parts = dotted.split(".");
  const firstUpper = parts.findIndex((p) => /^[A-Z]/.test(p));
  if (firstUpper < 0) return parts.join("/");
  return `${parts.slice(0, firstUpper + 1).join("/")}${parts.length > firstUpper + 1 ? `$${parts.slice(firstUpper + 1).join("$")}` : ""}`;
}

async function walk(dir: string, ext: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

export async function collectBytecode(classesDirs: string[]): Promise<{ refs: NmsRef[]; files: number; newest: number }> {
  const refs: NmsRef[] = [];
  let files = 0;
  let newest = 0;
  const { stat } = await import("node:fs/promises");
  for (const d of classesDirs) {
    for (const f of await walk(d, ".class")) {
      files++;
      newest = Math.max(newest, (await stat(f)).mtimeMs);
      try {
        refs.push(...bytecodeRefs(await readFile(f)));
      } catch {
        /* not a class file */
      }
    }
  }
  return { refs, files, newest };
}

export async function collectSource(roots: string[], base: string): Promise<{ refs: NmsRef[]; files: number; newest: number; dynamic: string[]; unparsed: string[] }> {
  const refs: NmsRef[] = [];
  let newest = 0;
  const { stat } = await import("node:fs/promises");
  const files: { text: string; file: string }[] = [];
  for (const r of roots) {
    for (const f of await walk(r, ".java")) {
      newest = Math.max(newest, (await stat(f)).mtimeMs);
      files.push({ text: await readFile(f, "utf8"), file: path.relative(base, f).replace(/\\/g, "/") });
    }
  }
  const { analyzeReflection } = await import("./reflect.js");
  const rf = analyzeReflection(files);
  const failed = new Set(rf.failed);
  for (const f of files) {
    // imports always; regex reflection scan only where the Java parser gave up
    refs.push(...sourceRefs(f.text, f.file).filter((x) => x.origin === "import" || failed.has(f.file)));
  }
  refs.push(...rf.refs);
  groupAlternatives(refs);
  return { refs, files: files.length, newest, dynamic: rf.dynamic, unparsed: rf.failed };
}

/** Version branches in one file (same class / member under different packages): alternatives of each other. */
export function groupAlternatives(refs: NmsRef[]): void {
  const groups = new Map<string, NmsRef[]>();
  for (const r of refs) {
    if (r.origin !== "reflection" || r.alt) continue;
    const file = r.where.replace(/:\d+$/, "");
    const simple = r.owner.slice(r.owner.lastIndexOf("/") + 1);
    const key = `${file}|${r.kind}|${simple}|${r.name ?? ""}`;
    const l = groups.get(key) ?? [];
    l.push(r);
    groups.set(key, l);
  }
  for (const [key, l] of groups) if (new Set(l.map((r) => r.owner)).size > 1) for (const r of l) r.alt = key;
}
