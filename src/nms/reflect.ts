/**
 * Reflection analysis of plugin sources with a real Java parser (java-parser, the Chevrotain parser behind
 * prettier-plugin-java) for structure, plus a small abstract interpreter over expressions:
 *  - strings: literals, + concatenation, StringBuilder, String.format/valueOf/join, split/substring/replace…
 *  - the server version: Bukkit.getServer().getClass().getPackage().getName() → "org.bukkit.craftbukkit.{v}",
 *    so the usual .split("\\.")[3] / .substring(…) / .replace(…) idioms yield "{v}" by plain string semantics
 *  - constants (static final fields, also across files), fields set in initializers/constructors, locals
 *  - Class.forName, X.class, getMethod/getDeclaredMethod/getField/getDeclaredField,
 *    MethodHandles.Lookup find{Virtual,Static,Special,Getter,Setter,StaticGetter,StaticSetter,VarHandle}
 *  - wrapper methods (getNMSClass("EntityPlayer") style): each method is summarised with its String parameters
 *    as placeholders; call sites substitute their arguments
 *  - well-known libraries (XSeries ReflectionUtils, ProtocolLib MinecraftReflection, TinyProtocol) as best effort.
 * Names that stay unknown are reported as "dynamic" (info), never as errors.
 */
import { createRequire } from "node:module";
import type { NmsRef } from "./refs.js";
import { toInternal } from "./refs.js";

interface Tok {
  image: string;
  startOffset: number;
  startLine?: number;
}
interface Node {
  name: string;
  children: Record<string, (Node | Tok)[]>;
}
type El = Node | Tok;
const isTok = (x: El): x is Tok => (x as Tok).image !== undefined;

let parser: { parse(src: string): Node } | undefined;
const jp = () => (parser ??= createRequire(import.meta.url)("java-parser") as { parse(src: string): Node });

function toks(n: El, out: Tok[] = []): Tok[] {
  if (isTok(n)) out.push(n);
  else for (const k of Object.keys(n.children)) for (const c of n.children[k]!) toks(c, out);
  return out;
}
const sortedToks = (n: El) => toks(n).sort((a, b) => a.startOffset - b.startOffset);
function find(n: Node, names: Set<string>, stop: Set<string>, out: Node[] = []): Node[] {
  for (const k of Object.keys(n.children)) {
    for (const c of n.children[k]!) {
      if (isTok(c)) continue;
      if (names.has(c.name)) out.push(c);
      if (!stop.has(c.name) && !names.has(c.name)) find(c, names, stop, out);
    }
  }
  return out;
}

// ---------------- values ----------------
/** Unknown part of a string. */
export const Q = "\u0001";
type V =
  | { k: "str"; s: string }
  | { k: "num"; n: number }
  | { k: "cls"; name: string; alts?: string[] }
  | { k: "arr"; items: V[] }
  | { k: "sb"; s: string }
  | { k: "pkg"; name: string }
  | { k: "server" }
  | { k: "lookup" }
  | { k: "path"; parts: string[] }
  | { k: "unk" };
const UNK: V = { k: "unk" };
const str = (s: string): V => ({ k: "str", s });
function sOf(v: V): string {
  switch (v.k) {
    case "str":
    case "sb":
      return v.s;
    case "num":
      return String(v.n);
    case "path":
      return Q;
    default:
      return Q;
  }
}
const SERVER_DOTTED = /^(net\.minecraft\.|org\.bukkit\.craftbukkit\.)/;
const CB_PKG = "org.bukkit.craftbukkit.{v}";

function unquote(lit: string): string {
  if (lit.startsWith('"""')) return lit.slice(3, -3).replace(/^[^\n]*\n/, "");
  return lit.slice(1, -1).replace(/\\(u+[0-9a-fA-F]{4}|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (e[0] === "u") return String.fromCharCode(parseInt(e.replace(/^u+/, ""), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", s: " " } as Record<string, string>)[e] ?? e;
  });
}
/** Java regex → JS RegExp (good enough for split/replaceAll separators). */
function jre(s: string): RegExp | undefined {
  try {
    return new RegExp(s.replace(/\\Q(.*?)\\E/g, (_, q: string) => q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "g");
  } catch {
    return undefined;
  }
}

// ---------------- model ----------------
interface Method {
  name: string;
  params: { type: string; name: string }[];
  body: Tok[];
  cls: ClassModel;
}
interface ClassModel {
  name: string;
  file: string;
  imports: Map<string, string>;
  fieldInits: Map<string, Tok[]>;
  methods: Method[];
  inits: Tok[][];
}
interface Summary {
  ret: V;
  /** Class.forName templates inside (with {pN} placeholders). */
  forNames: string[];
}
export interface ReflectResult {
  refs: NmsRef[];
  dynamic: string[];
}

/** Known reflection helpers of popular libraries (used when the project does not define the method). */
function libCall(name: string, args: V[]): V | undefined {
  const a = args.map(sOf);
  const nms = (x: string) => (x.includes(".") && !/^[A-Z]/.test(x) ? `net.minecraft.${x}` : `net.minecraft.server.{v}.${x}`);
  switch (name) {
    case "getNMSClass":
    case "getNmsClass":
    case "getMinecraftClass":
      if (!a.length) return undefined;
      if (a.length === 2 && !/^[A-Z]/.test(a[0]!)) return { k: "cls", name: `net.minecraft.${a[0]}.${a[1]}`, alts: [`net.minecraft.server.{v}.${a[1]}`] };
      return { k: "cls", name: nms(a[0]!), alts: a.slice(1).map(nms) };
    case "getCraftClass":
    case "getCraftBukkitClass":
    case "getOBCClass":
    case "getCBClass":
      return a.length ? { k: "cls", name: `${CB_PKG}.${a[0]}` } : undefined;
    case "getUntypedClass":
      return a.length ? { k: "cls", name: a[0]!.replace("{nms}", "net.minecraft.server.{v}").replace("{obc}", CB_PKG).replace("{nm}", "net.minecraft") } : undefined;
  }
  return undefined;
}

class Analyzer {
  readonly classes: ClassModel[] = [];
  private byName = new Map<string, ClassModel[]>();
  private fieldMemo = new Map<string, V>();
  private fieldAssigned = new Map<string, V>();
  private summaries = new Map<Method, Summary>();
  private summarizing = new Set<Method>();
  refs: NmsRef[] = [];
  dynamic: string[] = [];
  private seen = new Set<string>();

  add(text: string, file: string): boolean {
    let cst: Node;
    try {
      cst = jp().parse(text);
    } catch {
      return false;
    }
    const imports = new Map<string, string>();
    for (const imp of find(cst, new Set(["importDeclaration"]), new Set(["typeDeclaration"]))) {
      const t = sortedToks(imp).map((x) => x.image).join("");
      const m = /^import(?:static)?([\w.$]+?)(\.\*)?;$/.exec(t);
      if (m && !m[2]) imports.set(m[1]!.slice(m[1]!.lastIndexOf(".") + 1), m[1]!);
    }
    const CLASSES = new Set(["normalClassDeclaration", "enumDeclaration", "recordDeclaration"]);
    for (const c of find(cst, CLASSES, new Set())) {
      const nameTok = (c.children.typeIdentifier?.[0] as Node | undefined);
      const name = nameTok ? sortedToks(nameTok)[0]!.image : "?";
      const cm: ClassModel = { name, file, imports, fieldInits: new Map(), methods: [], inits: [] };
      const members = find(c, new Set(["fieldDeclaration", "methodDeclaration", "constructorDeclaration", "staticInitializer", "instanceInitializer"]), CLASSES);
      for (const m of members) {
        const ts = sortedToks(m);
        if (m.name === "fieldDeclaration") {
          // [mods] Type a = init, b = init;
          let depth = 0;
          let start = -1;
          for (let i = 0; i < ts.length; i++) {
            const im = ts[i]!.image;
            if ("([{<".includes(im)) depth++;
            else if (")]}>".includes(im)) depth--;
            else if (im === "=" && depth === 0) {
              start = i;
              const fname = ts[i - 1]!.image;
              let j = i + 1;
              let d2 = 0;
              for (; j < ts.length; j++) {
                const x = ts[j]!.image;
                if ("([{".includes(x)) d2++;
                else if (")]}".includes(x)) d2--;
                else if ((x === "," || x === ";") && d2 === 0) break;
              }
              cm.fieldInits.set(fname, ts.slice(i + 1, j));
              i = j;
            }
          }
          void start;
        } else if (m.name === "methodDeclaration" || m.name === "constructorDeclaration") {
          const open = ts.findIndex((t) => t.image === "{");
          if (open < 0) continue; // abstract / interface method
          const header = ts.slice(0, open);
          const lp = header.findIndex((t) => t.image === "(");
          const mname = lp > 0 ? header[lp - 1]!.image : "?";
          const params: { type: string; name: string }[] = [];
          const decl = find(m, new Set(["formalParameter"]), new Set(["methodBody", "constructorBody"]));
          for (const p of decl) {
            const pt = sortedToks(p).filter((t) => !t.image.startsWith("@") && t.image !== "final");
            const pn = pt[pt.length - 1]?.image ?? "?";
            params.push({ type: pt.slice(0, -1).map((t) => t.image).join(""), name: pn });
          }
          cm.methods.push({ name: m.name === "constructorDeclaration" ? "<init>" : mname, params, body: ts.slice(open + 1, -1), cls: cm });
        } else {
          const open = ts.findIndex((t) => t.image === "{");
          cm.inits.push(ts.slice(open + 1, -1));
        }
      }
      this.classes.push(cm);
      const l = this.byName.get(name) ?? [];
      l.push(cm);
      this.byName.set(name, l);
    }
    return true;
  }

  // -------- fields --------
  field(cm: ClassModel, name: string): V | undefined {
    const key = `${cm.file}:${cm.name}.${name}`;
    if (this.fieldMemo.has(key)) return this.fieldMemo.get(key);
    const init = cm.fieldInits.get(name);
    if (!init) return this.fieldAssigned.get(key);
    this.fieldMemo.set(key, UNK); // cycle guard
    const v = new Ev(this, cm, new Map(), false).expr(init);
    this.fieldMemo.set(key, v);
    return v;
  }
  hasField(cm: ClassModel, name: string): boolean {
    return cm.fieldInits.has(name) || this.fieldAssigned.has(`${cm.file}:${cm.name}.${name}`);
  }
  assignField(cm: ClassModel, name: string, v: V): void {
    const key = `${cm.file}:${cm.name}.${name}`;
    if (cm.fieldInits.has(name)) return;
    const old = this.fieldAssigned.get(key);
    // several different assignments (version branches): keep the first, it is a valid candidate
    if (!old || old.k === "unk") this.fieldAssigned.set(key, v);
  }
  classNamed(n: string): ClassModel | undefined {
    return this.byName.get(n)?.[0];
  }
  methodsNamed(n: string, cm?: ClassModel): Method[] {
    const own = cm?.methods.filter((m) => m.name === n) ?? [];
    if (own.length) return own;
    return this.classes.flatMap((c) => c.methods.filter((m) => m.name === n));
  }

  // -------- summaries --------
  summary(m: Method): Summary {
    const hit = this.summaries.get(m);
    if (hit) return hit;
    if (this.summarizing.has(m)) return { ret: UNK, forNames: [] };
    this.summarizing.add(m);
    const env = new Map<string, V>();
    m.params.forEach((p, i) => env.set(p.name, /^(String|CharSequence|java\.lang\.String)(\.\.\.)?$/.test(p.type) ? str(`{p${i}}`) : UNK));
    const ev = new Ev(this, m.cls, env, false);
    ev.capture = [];
    const ret = ev.block(m.body);
    const strParams = m.params.filter((p) => /String/.test(p.type)).length;
    // lambda/cache patterns: prefix + unknown with exactly one String parameter → the parameter
    const forNames = [...new Set(ev.capture.map((n) => (strParams === 1 && SERVER_DOTTED.test(n) && n.includes(Q) && !n.includes("{p") ? n.replace(Q, "{p0}") : n)).filter((n) => n.includes("{p")))];
    const s: Summary = { ret: ret ?? UNK, forNames };
    this.summarizing.delete(m);
    this.summaries.set(m, s);
    return s;
  }
  isWrapper(m: Method): boolean {
    const s = this.summary(m);
    return s.forNames.length > 0 || (s.ret.k === "cls" && s.ret.name.includes("{p")) || (s.ret.k === "str" && s.ret.s.includes("{p") && SERVER_DOTTED.test(s.ret.s));
  }

  emit(r: NmsRef): void {
    const key = `${r.kind}|${r.owner}|${r.name ?? ""}|${r.where}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.refs.push(r);
  }

  run(): ReflectResult {
    // field values assigned in initializers / constructors first
    for (const c of this.classes) {
      for (const b of c.inits) new Ev(this, c, new Map(), false).block(b);
      for (const m of c.methods.filter((x) => x.name === "<init>")) new Ev(this, c, new Map(), false).block(m.body);
    }
    for (const c of this.classes) {
      for (const [f, init] of c.fieldInits) {
        void f;
        new Ev(this, c, new Map(), true).expr(init);
      }
      for (const b of c.inits) new Ev(this, c, new Map(), true).block(b);
      for (const m of c.methods) {
        const wrapper = this.isWrapper(m);
        const env = new Map<string, V>();
        for (const p of m.params) env.set(p.name, UNK);
        const ev = new Ev(this, c, env, true);
        ev.quietDynamic = wrapper;
        ev.block(m.body);
      }
    }
    return { refs: this.refs, dynamic: this.dynamic };
  }
}

const MEMBER_LOOKUP: Record<string, { kind: "method" | "field"; declared: boolean }> = {
  getMethod: { kind: "method", declared: false },
  getDeclaredMethod: { kind: "method", declared: true },
  getField: { kind: "field", declared: false },
  getDeclaredField: { kind: "field", declared: true },
};
const HANDLE_LOOKUP: Record<string, "method" | "field"> = {
  findVirtual: "method",
  findStatic: "method",
  findSpecial: "method",
  findGetter: "field",
  findSetter: "field",
  findStaticGetter: "field",
  findStaticSetter: "field",
  findVarHandle: "field",
  findStaticVarHandle: "field",
};
const STMT_KEYWORDS = new Set(["return", "throw", "else", "try", "do", "finally", "yield", "assert"]);
const HEADER_KEYWORDS = new Set(["if", "while", "for", "switch", "catch", "synchronized"]);
const isIdent = (s: string | undefined) => !!s && /^[A-Za-z_$][\w$]*$/.test(s);

/** Evaluates statements/expressions of one scope. */
class Ev {
  private t: Tok[] = [];
  private i = 0;
  private end = 0;
  capture?: string[];
  quietDynamic = false;
  private ret: V | undefined;

  constructor(private readonly a: Analyzer, private readonly cm: ClassModel, private readonly env: Map<string, V>, private readonly emitOn: boolean) {}

  private where(tok?: Tok): string {
    return `${this.cm.file}:${tok?.startLine ?? 1}`;
  }

  // ---- statements ----
  /** Run a body; returns the first `return` value seen (summary). */
  block(ts: Tok[]): V | undefined {
    let s = 0;
    let depth = 0;
    for (let i = 0; i <= ts.length; i++) {
      const im = ts[i]?.image;
      if (im === "(" || im === "[") depth++;
      else if (im === ")" || im === "]") depth--;
      if (i === ts.length || (depth <= 0 && (im === ";" || im === "{" || im === "}"))) {
        if (i > s) this.stmt(ts.slice(s, i));
        s = i + 1;
        depth = Math.max(depth, 0);
      }
    }
    return this.ret;
  }

  private stmt(ts: Tok[]): void {
    let k = 0;
    while (k < ts.length) {
      const im = ts[k]!.image;
      if (STMT_KEYWORDS.has(im)) {
        const isRet = im === "return";
        k++;
        if (isRet) {
          const v = this.expr(ts.slice(k));
          this.ret ??= v.k === "unk" ? undefined : v;
          return;
        }
        continue;
      }
      if (HEADER_KEYWORDS.has(im) && ts[k + 1]?.image === "(") {
        const close = matching(ts, k + 1);
        const inner = ts.slice(k + 2, close);
        if (im === "for" && inner.some((t) => t.image === ";")) this.block(inner);
        else if (im !== "catch") this.expr(inner.filter((t) => t.image !== ":"));
        k = close + 1;
        continue;
      }
      if (im === "case" || im === "default") {
        const c = ts.findIndex((t, j) => j > k && (t.image === ":" || t.image === "->"));
        k = c < 0 ? ts.length : c + 1;
        continue;
      }
      break;
    }
    ts = ts.slice(k);
    if (!ts.length) return;
    // declaration / assignment: … name (=|+=) expr
    let depth = 0;
    for (let i = 0; i < ts.length; i++) {
      const im = ts[i]!.image;
      if (im === "(" || im === "[" || im === "<") depth++;
      else if (im === ")" || im === "]" || im === ">") depth--;
      else if ((im === "=" || im === "+=") && depth <= 0 && i > 0 && isIdent(ts[i - 1]!.image)) {
        const name = ts[i - 1]!.image;
        const isThis = ts[i - 2]?.image === "." && ts[i - 3]?.image === "this";
        const lhsIsSimple = i === 1 || isThis || isIdent(ts[i - 2]?.image) || [">", "]"].includes(ts[i - 2]?.image ?? "");
        if (!lhsIsSimple) break;
        let v = this.expr(ts.slice(i + 1));
        if (im === "+=") v = plus(this.lookup(name) ?? UNK, v);
        const isDecl = i >= 2 && !isThis && ts[i - 2]!.image !== ".";
        if (!isDecl && (isThis || (!this.env.has(name) && this.a.hasField(this.cm, name)) || this.cm.fieldInits.has(name) || (!this.env.has(name) && i === 1))) this.a.assignField(this.cm, name, v);
        if (!isThis) this.env.set(name, v);
        return;
      }
    }
    this.expr(ts);
  }

  private lookup(name: string): V | undefined {
    if (this.env.has(name)) return this.env.get(name);
    if (this.cm.fieldInits.has(name) || this.a.hasField(this.cm, name)) return this.a.field(this.cm, name);
    return undefined;
  }

  // ---- expressions ----
  expr(ts: Tok[]): V {
    const save = [this.t, this.i, this.end] as const;
    this.t = ts;
    this.i = 0;
    this.end = ts.length;
    let v: V = UNK;
    try {
      v = this.ternary();
      while (this.i < this.end) {
        // anything left (operators we do not model): evaluate the rest for side effects
        this.i++;
        this.ternary();
        v = UNK;
      }
    } catch {
      v = UNK;
    }
    [this.t, this.i, this.end] = save;
    return v;
  }
  private peek(o = 0): string | undefined {
    return this.i + o < this.end ? this.t[this.i + o]!.image : undefined;
  }
  private next(): Tok {
    return this.t[this.i++]!;
  }

  private ternary(): V {
    let v = this.concat();
    for (;;) {
      const p = this.peek();
      if (p === "?") {
        this.i++;
        const x = this.ternary();
        if (this.peek() === ":") this.i++;
        const y = this.ternary();
        v = x.k === y.k && x.k === "str" && sOf(x) === sOf(y) ? x : x.k === "cls" ? { ...x, alts: [...(x.alts ?? []), ...(y.k === "cls" ? [y.name] : [])] } : UNK;
      } else if (p && ["==", "!=", "&&", "||", "<", ">", "<=", ">=", "*", "/", "%", "&", "|", "^", "instanceof", "<<", ">>"].includes(p)) {
        this.i++;
        this.concat();
        v = UNK;
      } else return v;
    }
  }

  private concat(): V {
    let v = this.unary();
    while (this.peek() === "+" || this.peek() === "-") {
      const op = this.next().image;
      const r = this.unary();
      v = op === "+" ? plus(v, r) : v.k === "num" && r.k === "num" ? { k: "num", n: v.n - r.n } : UNK;
    }
    return v;
  }

  private unary(): V {
    const p = this.peek();
    if (p === "!" || p === "-" || p === "~" || p === "++" || p === "--" || p === "+") {
      this.i++;
      const v = this.unary();
      return p === "-" && v.k === "num" ? { k: "num", n: -v.n } : UNK;
    }
    // cast: ( Type ) operand
    if (p === "(") {
      const close = matching(this.t, this.i, this.end);
      const inner = this.t.slice(this.i + 1, close).map((x) => x.image);
      const after = this.t[close + 1]?.image;
      if (close + 1 < this.end && after === "->") return this.lambda(close + 2);
      if (inner.length && inner.every((x) => isIdent(x) || ".<>[]?,&".includes(x)) && /^[A-Z]|^(int|long|byte|short|char|boolean|double|float)$/.test(inner[inner.length - 1] === ">" ? inner[0]! : inner.filter(isIdent).at(-1)!) && after !== undefined && close + 1 < this.end && (isIdent(after) || after.startsWith('"') || after === "(")) {
        this.i = close + 1;
        return this.unary();
      }
    }
    let v = this.primary();
    v = this.suffixes(v);
    if (this.peek() === "++" || this.peek() === "--") this.i++;
    return v;
  }

  private lambda(bodyStart: number): V {
    this.i = bodyStart;
    if (this.peek() === "{") {
      const close = matching(this.t, this.i, this.end);
      new Ev(this.a, this.cm, new Map(this.env), this.emitOn).withCapture(this.capture, this.quietDynamic).block(this.t.slice(this.i + 1, close));
      this.i = close + 1;
    } else this.concat();
    return UNK;
  }
  withCapture(c: string[] | undefined, q: boolean): Ev {
    this.capture = c;
    this.quietDynamic = q;
    return this;
  }

  private args(): V[] {
    const out: V[] = [];
    if (this.peek() !== "(") return out;
    this.i++;
    while (this.i < this.end && this.peek() !== ")") {
      out.push(this.ternary());
      if (this.peek() === ",") this.i++;
      else if (this.peek() !== ")") this.i++; // unexpected token: skip
    }
    this.i++;
    return out;
  }

  private primary(): V {
    const tok = this.next();
    if (!tok) return UNK;
    const im = tok.image;
    if (im.startsWith('"')) return str(unquote(im));
    if (im.startsWith("'")) return str(unquote(im));
    if (/^\d/.test(im)) return { k: "num", n: Number(im.replace(/[lLfFdD_]/g, "")) || 0 };
    if (im === "(") {
      const v = this.ternary();
      if (this.peek() === ")") this.i++;
      return v;
    }
    if (im === "new") {
      const typeParts: string[] = [];
      while (this.i < this.end && (isIdent(this.peek()) || this.peek() === ".")) typeParts.push(this.next().image);
      if (this.peek() === "<") this.i = matchingAngle(this.t, this.i, this.end) + 1;
      const type = typeParts.filter((x) => x !== ".").at(-1) ?? "";
      if (this.peek() === "[") {
        while (this.peek() === "[") this.i = matching(this.t, this.i, this.end) + 1;
        if (this.peek() === "{") this.i = matching(this.t, this.i, this.end) + 1;
        return UNK;
      }
      const args = this.args();
      if (this.peek() === "{") {
        const close = matching(this.t, this.i, this.end);
        new Ev(this.a, this.cm, new Map(this.env), this.emitOn).withCapture(this.capture, this.quietDynamic).block(this.t.slice(this.i + 1, close));
        this.i = close + 1;
      }
      if (type === "StringBuilder" || type === "StringBuffer") return { k: "sb", s: args[0] && args[0].k !== "num" ? sOf(args[0]) : "" };
      if (type === "String") return args[0] ? str(sOf(args[0])) : str("");
      return UNK;
    }
    if (im === "this" || im === "super") {
      if (this.peek() === "." && isIdent(this.peek(1)) && this.peek(2) !== "(") {
        this.i++;
        const f = this.next().image;
        return this.a.field(this.cm, f) ?? UNK;
      }
      if (this.peek() === "(") this.args();
      return UNK;
    }
    if (!isIdent(im)) return UNK;
    if (this.peek() === "->") return this.lambda(this.i + 1);
    if (this.peek() === "(") return this.call(undefined, im, this.args(), tok);
    const local = this.lookup(im);
    if (local) return local;
    return { k: "path", parts: [im] };
  }

  private suffixes(v: V): V {
    for (;;) {
      const p = this.peek();
      if (p === "." && this.peek(1) === "class") {
        this.i += 2;
        v = v.k === "path" ? this.classLiteral(v.parts) : UNK;
      } else if (p === "." && this.peek(1) === "<") {
        this.i = matchingAngle(this.t, this.i + 1, this.end) + 1; // explicit type args: x.<T>m()
        this.i--;
        this.t[this.i] = { ...this.t[this.i]!, image: "." };
      } else if (p === "." && isIdent(this.peek(1))) {
        this.i++;
        const nameTok = this.next();
        const name = nameTok.image;
        if (this.peek() === "(") v = this.call(v, name, this.args(), nameTok);
        else if (v.k === "path") {
          const cls = this.a.classNamed(v.parts[v.parts.length - 1]!);
          const fv = cls && v.parts.length === 1 ? this.a.field(cls, name) : undefined;
          v = fv ?? { k: "path", parts: [...v.parts, name] };
        } else if (name === "length" && v.k === "arr") v = { k: "num", n: v.items.length };
        else v = UNK;
      } else if (p === "[") {
        const close = matching(this.t, this.i, this.end);
        const idx = new Ev(this.a, this.cm, this.env, this.emitOn).withCapture(this.capture, this.quietDynamic).expr(this.t.slice(this.i + 1, close));
        this.i = close + 1;
        v = v.k === "arr" && idx.k === "num" ? (v.items[idx.n] ?? UNK) : UNK;
      } else if (p === "::") {
        this.i += 2;
        v = UNK;
      } else return v;
    }
  }

  private classLiteral(parts: string[]): V {
    const n = parts.join(".");
    if (SERVER_DOTTED.test(n)) return { k: "cls", name: n };
    const imp = this.cm.imports.get(parts[0]!);
    if (imp) return { k: "cls", name: [imp, ...parts.slice(1)].join(".") };
    return { k: "cls", name: n };
  }

  private forName(v: V, tok: Tok): V {
    const n = sOf(v);
    this.capture?.push(n);
    this.classRef(n, tok);
    return { k: "cls", name: n };
  }

  private classRef(n: string, tok: Tok, alt?: string, soft?: boolean): void {
    if (!SERVER_DOTTED.test(n) || n.includes("{p")) return;
    if (n.includes(Q)) {
      if (this.emitOn && !this.quietDynamic) this.a.dynamic.push(`${this.where(tok)} ${n.replace(new RegExp(Q, "g"), "<?>")}`);
      return;
    }
    if (this.emitOn && /\.[A-Z][\w$]*$/.test(n)) this.a.emit({ kind: "class", owner: toInternal(n), origin: "reflection", where: this.where(tok), ...(alt ? { alt } : {}), ...(soft ? { soft } : {}) });
  }

  private memberRef(owner: V, kind: "method" | "field", nameV: V, tok: Tok, declared: boolean): void {
    if (owner.k !== "cls" || !this.emitOn) return;
    const all = [owner.name, ...(owner.alts ?? [])].filter((n) => SERVER_DOTTED.test(n));
    if (!all.length) return;
    const name = sOf(nameV);
    if (name.includes(Q) || name.includes("{p") || all.some((n) => n.includes(Q))) {
      if (!this.quietDynamic && !all.some((n) => n.includes("{p"))) this.a.dynamic.push(`${this.where(tok)} ${kind} ${all[0]!.replace(new RegExp(Q, "g"), "<?>")}#${name.replace(new RegExp(Q, "g"), "<?>")}`);
      return;
    }
    const alt = all.length > 1 ? `${this.where(tok)}#${name}` : undefined;
    for (const n of all) this.a.emit({ kind, owner: toInternal(n), name, origin: "reflection", where: this.where(tok), ...(declared ? { declared: true } : {}), ...(alt ? { alt } : {}) });
  }

  private call(recv: V | undefined, name: string, args: V[], tok: Tok): V {
    // static / unqualified calls
    const q = recv?.k === "path" ? recv.parts.join(".") : recv === undefined ? "" : undefined;
    if (q !== undefined) {
      const last = q.split(".").at(-1) ?? "";
      if ((last === "Class" || q === "java.lang.Class") && name === "forName" && args[0]) return this.forName(args[0], tok);
      if (name === "getServer") return { k: "server" };
      if (last === "String") {
        if (name === "format" && args[0]) return str(format(sOf(args[0]), args.slice(1)));
        if (name === "valueOf" && args[0]) return str(sOf(args[0]));
        if (name === "join" && args.length > 1) return str(args.slice(1).flatMap((x) => (x.k === "arr" ? x.items : [x])).map(sOf).join(sOf(args[0]!)));
      }
      if (last === "MethodHandles" && (name === "lookup" || name === "privateLookupIn" || name === "publicLookup")) return { k: "lookup" };
      // project methods (unqualified: own class first; qualified: that class)
      const target = q && q !== "this" ? this.a.classNamed(last) : this.cm;
      const ms = target ? target.methods.filter((m) => m.name === name && m.params.length === args.length) : [];
      const cands = ms.length ? ms : q === "" ? [] : this.a.methodsNamed(name).filter((m) => m.params.length === args.length && (!q || m.cls.name === last));
      if (cands.length) return this.applySummary(cands[0]!, args, tok);
      const lib = libCall(name, args);
      if (lib && lib.k === "cls") {
        const alt = lib.alts?.length ? `${this.where(tok)}#${name}` : undefined;
        for (const n of [lib.name, ...(lib.alts ?? [])]) this.classRef(n, tok, alt, true);
        return lib;
      }
      return UNK;
    }
    if (!recv) return UNK;
    switch (recv.k) {
      case "server":
        if (name === "getClass") return { k: "cls", name: `${CB_PKG}.CraftServer` };
        return UNK;
      case "cls": {
        if (name === "getPackage") return { k: "pkg", name: recv.name.slice(0, recv.name.lastIndexOf(".")) };
        if (name === "getName" || name === "getCanonicalName" || name === "getTypeName") return str(recv.name);
        if (name === "getSimpleName") return str(recv.name.slice(recv.name.lastIndexOf(".") + 1));
        if (name === "getPackageName") return str(recv.name.slice(0, recv.name.lastIndexOf(".")));
        const ml = MEMBER_LOOKUP[name];
        if (ml && args[0]) this.memberRef(recv, ml.kind, args[0], tok, ml.declared);
        return UNK;
      }
      case "pkg":
        return name === "getName" ? str(recv.name) : UNK;
      case "lookup": {
        const kind = HANDLE_LOOKUP[name];
        if (kind && args.length >= 2) this.memberRef(args[0]!, kind, args[1]!, tok, false);
        if (name === "findClass" && args[0]) return this.forName(args[0], tok);
        return name === "in" ? recv : UNK;
      }
      case "sb":
        if (name === "append") return { k: "sb", s: recv.s + sOf(args[0] ?? UNK) };
        if (name === "toString") return str(recv.s);
        return UNK;
      case "str":
        return strMethod(recv.s, name, args);
      case "arr":
        return UNK;
      default: {
        // unknown receiver: member lookups by literal on an unknown class are not server-checkable
        const kind = HANDLE_LOOKUP[name];
        if (kind && args.length >= 2) this.memberRef(args[0]!, kind, args[1]!, tok, false);
        return UNK;
      }
    }
  }

  private applySummary(m: Method, args: V[], tok: Tok): V {
    const s = this.a.summary(m);
    const sub = (x: string) => x.replace(/\{p(\d+)\}/g, (_, i: string) => sOf(args[Number(i)] ?? UNK));
    const forNames = s.forNames.map(sub);
    let ret: V = UNK;
    if (s.ret.k === "str") ret = str(sub(s.ret.s));
    else if (s.ret.k === "cls") ret = { k: "cls", name: sub(s.ret.name), alts: s.ret.alts?.map(sub) };
    if (ret.k === "unk" && forNames.length) ret = { k: "cls", name: forNames[0]!, alts: forNames.slice(1) };
    if (ret.k === "cls" && ret.name.includes(Q) && forNames.length) ret = { k: "cls", name: forNames[0]!, alts: forNames.slice(1) };
    const names = ret.k === "cls" ? [...new Set([ret.name, ...(ret.alts ?? []), ...forNames])] : forNames;
    if (s.forNames.length || (s.ret.k === "cls" && s.ret.name.includes("{p"))) {
      this.capture?.push(...names);
      const alt = names.length > 1 ? `${this.where(tok)}#${m.name}` : undefined;
      for (const n of names) this.classRef(n, tok, alt);
    }
    return ret;
  }
}

function plus(a: V, b: V): V {
  if (a.k === "num" && b.k === "num") return { k: "num", n: a.n + b.n };
  if (a.k === "unk" && b.k === "unk") return str(Q);
  return str(sOf(a) + sOf(b));
}

function format(fmt: string, args: V[]): string {
  let i = 0;
  return fmt.replace(/%(\d+\$)?[-#+ 0,(]*\d*(\.\d+)?([sdSn%])/g, (all, pos: string | undefined, _p, conv: string) => {
    if (conv === "%") return "%";
    if (conv === "n") return "\n";
    const v = pos ? args[Number(pos.slice(0, -1)) - 1] : args[i++];
    return v ? sOf(v) : Q;
  });
}

function strMethod(s: string, name: string, args: V[]): V {
  const a0 = args[0];
  const n = (v: V | undefined) => (v?.k === "num" ? v.n : undefined);
  switch (name) {
    case "split": {
      const re = a0 && jre(sOf(a0));
      if (!re || sOf(a0!).includes(Q)) return UNK;
      return { k: "arr", items: s.split(re).map(str) };
    }
    case "substring": {
      const b = n(a0);
      const e = args[1] ? n(args[1]) : s.length;
      return b === undefined || e === undefined ? str(Q) : str(s.substring(b, e));
    }
    case "lastIndexOf":
    case "indexOf": {
      const x = a0 ? sOf(a0) : Q;
      if (x.includes(Q)) return UNK;
      return { k: "num", n: name === "indexOf" ? s.indexOf(x) : s.lastIndexOf(x) };
    }
    case "length":
      return s.includes(Q) ? UNK : { k: "num", n: s.length };
    case "replace":
      return args.length === 2 ? str(s.split(sOf(args[0]!)).join(sOf(args[1]!))) : UNK;
    case "replaceAll":
    case "replaceFirst": {
      const re = a0 && jre(sOf(a0));
      if (!re || args.length < 2) return UNK;
      return str(name === "replaceAll" ? s.replace(re, sOf(args[1]!)) : s.replace(new RegExp(re.source), sOf(args[1]!)));
    }
    case "concat":
      return str(s + (a0 ? sOf(a0) : Q));
    case "trim":
    case "intern":
    case "toString":
      return str(s);
    case "toLowerCase":
      return str(s.toLowerCase());
    default:
      return UNK;
  }
}

function matching(ts: Tok[], open: number, end = ts.length): number {
  const o = ts[open]!.image;
  const c = o === "(" ? ")" : o === "[" ? "]" : "}";
  let d = 0;
  for (let i = open; i < end; i++) {
    const im = ts[i]!.image;
    if (im === o) d++;
    else if (im === c && --d === 0) return i;
  }
  return end - 1;
}
function matchingAngle(ts: Tok[], open: number, end: number): number {
  let d = 0;
  for (let i = open; i < end; i++) {
    const im = ts[i]!.image;
    if (im === "<") d++;
    else if (im === ">") d--;
    else if (im === ">>") d -= 2;
    else if (im === ">>>") d -= 3;
    if (d <= 0) return i;
  }
  return end - 1;
}

/** Analyse the project's Java sources together (constants and wrappers cross files). Files the parser rejects are returned. */
export function analyzeReflection(files: { text: string; file: string }[]): ReflectResult & { failed: string[] } {
  const a = new Analyzer();
  const failed: string[] = [];
  for (const f of files) if (!a.add(f.text, f.file)) failed.push(f.file);
  return { ...a.run(), failed };
}
