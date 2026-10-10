/** Check collected NMS/CraftBukkit references against a server index. */
import { descToJava } from "../index/classfile.js";
import type { McIndex } from "../index/store.js";
import { type NmsRef, VERSION_SEG } from "./refs.js";

export interface Problem {
  severity: "error" | "warn";
  text: string;
  where: string[];
}

export interface CheckResult {
  problems: Problem[];
  checked: number;
  unverifiable: number;
  /** CraftBukkit refs skipped because the index has no CraftBukkit (vanilla). */
  skippedCraftBukkit: number;
}

export interface CheckOptions {
  /** Extra class suggestions from other namespaces (simple name → names in the index's namespace). */
  translateClass?: (internal: string) => string[];
  /** CraftBukkit package segment the server uses ("" = unversioned) when the index itself has no CraftBukkit: package checks only. */
  expectedCb?: string;
}

const d = (n: string) => n.replace(/\//g, ".");
const simple = (n: string) => n.slice(n.lastIndexOf("/") + 1);

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** Versioned package segments present in an index. */
export function indexPackages(index: McIndex): { cb?: string; nms?: string } {
  let nms: string | undefined;
  for (const n of index.classes.keys()) {
    const m = /^net\/minecraft\/server\/(v\d+_\d+_R\d+)\//.exec(n);
    if (m) {
      nms = m[1];
      break;
    }
  }
  return { cb: index.meta.craftBukkitPackage, nms };
}

export function checkRefs(index: McIndex, refs: NmsRef[], opts: CheckOptions = {}): CheckResult {
  // alternatives (version branches): fine when one resolves cleanly, otherwise every variant is reported
  const plain: NmsRef[] = [];
  const groups = new Map<string, NmsRef[]>();
  for (const r of refs) {
    if (!r.alt) plain.push(r);
    else groups.set(r.alt, [...(groups.get(r.alt) ?? []), r]);
  }
  let altOk = 0;
  for (const g of groups.values()) {
    if (g.some((r) => checkCore(index, [r], opts).problems.every((p) => p.severity !== "error"))) altOk++;
    else plain.push(...g);
  }
  const res = checkCore(index, plain, opts);
  res.checked += altOk;
  return res;
}

function checkCore(index: McIndex, refs: NmsRef[], opts: CheckOptions): CheckResult {
  const pk = indexPackages(index);
  const problems = new Map<string, Problem>();
  let soft = false;
  let guarded = false;
  const add = (key: string, severity: Problem["severity"], text: string, where: string) => {
    if (soft && severity === "error") {
      severity = "warn";
      text += " (name built by a reflection library at runtime — best-effort check)";
    } else if (guarded && severity === "error") {
      severity = "warn";
      text += " (inside try/catch that swallows the failure — probe or optional path?)";
    }
    const p = problems.get(key);
    if (p) {
      if (!p.where.includes(where)) p.where.push(where);
    } else problems.set(key, { severity, text, where: [where] });
  };
  let checked = 0;
  let unverifiable = 0;
  let skippedCb = 0;
  const seen = new Set<string>();

  // Rewrite versioned packages to the index's; report package moves once per (from → to).
  const normalize = (name: string, r: NmsRef): string | undefined => {
    const t = name.replace(/\{v\}/, "\u0000");
    const tm = /^(net\/minecraft\/server|org\/bukkit\/craftbukkit)\/\u0000\/(.*)$/.exec(t);
    const isCb = name.startsWith("org/bukkit/craftbukkit/");
    if (tm) {
      // runtime-built name ("…" + version + ".X"): resolves to whatever the server has
      const seg = isCb ? pk.cb : pk.nms;
      if (isCb) return seg ? `${tm[1]}/${seg}/${tm[2]}` : `${tm[1]}/${tm[2]}`;
      if (seg) return `${tm[1]}/${seg}/${tm[2]}`;
      add(`pkg-gone ${tm[2]}`, "error", `net.minecraft.server.<version>.${d(tm[2]!)}: versioned NMS packages do not exist on this server (1.17+ uses Mojang packages)${hint(simple(tm[2]!))}`, r.where);
      return undefined;
    }
    const m = VERSION_SEG.exec(name);
    if (isCb) {
      const cb = pk.cb ?? opts.expectedCb;
      if (cb === undefined) return name; // no CraftBukkit in index: caller skips
      const rest = m ? name.slice(m[0].length) : name.slice("org/bukkit/craftbukkit/".length);
      const seg = m?.[2];
      if (seg && seg !== cb) {
        const sev = cb === "" && r.origin !== "reflection" ? "warn" : "error";
        add(`pkg ${seg}`, sev, cb === ""
          ? `org.bukkit.craftbukkit.${seg}: this server has no versioned CraftBukkit package${sev === "warn" ? " (Paper rewrites compiled refs at load for now — PaperMC announced removing this)" : "; reflection strings are not rewritten"}`
          : `org.bukkit.craftbukkit.${seg}: server has ${cb} → NoClassDefFoundError/ClassNotFoundException (versioned package)`, r.where);
      }
      if (!seg && cb) add(`pkg none`, "error", `org.bukkit.craftbukkit.${d(rest)}: CraftBukkit is org.bukkit.craftbukkit.${cb}.* on this version (unversioned only from Paper 1.20.5)`, r.where);
      if (pk.cb === undefined) return name;
      return cb ? `org/bukkit/craftbukkit/${cb}/${rest}` : `org/bukkit/craftbukkit/${rest}`;
    }
    if (m && m[1] === "net/minecraft/server") {
      if (pk.nms === m[2]) return name;
      const rest = name.slice(m[0].length);
      if (pk.nms) {
        add(`pkg ${m[2]}`, "error", `net.minecraft.server.${m[2]}: server has ${pk.nms} → NoClassDefFoundError (versioned package)`, r.where);
        return `net/minecraft/server/${pk.nms}/${rest}`;
      }
      add(`moved ${rest}`, "error", `net.minecraft.server.${m[2]}.${d(rest)}: versioned NMS packages are gone (1.17+)${hint(simple(rest))}`, r.where);
      return undefined;
    }
    return name;
  };
  const hint = (s: string) => {
    const found = index.resolve(s).filter((n) => n.startsWith("net/minecraft/"));
    const tr = found.length ? found : (opts.translateClass?.(s) ?? []);
    return tr.length ? ` → now ${tr.slice(0, 3).map(d).join(", ")}` : "";
  };
  const nd = (desc: string, r: NmsRef) => desc.replace(/L([^;]+);/g, (all, c: string) => {
    const n = normalize(c, r);
    return n ? `L${n};` : all;
  });

  const classSuggest = (owner: string) => {
    const s = simple(owner).replace(/.*\$/, "");
    const same = index.resolve(s).filter((n) => n !== owner);
    if (same.length) return ` → found as ${same.slice(0, 3).map(d).join(", ")}`;
    const tr = opts.translateClass?.(owner) ?? [];
    if (tr.length) return ` → in these names: ${tr.slice(0, 3).map(d).join(", ")}`;
    const sim = index.search(s, "class", 3).map((h) => d(h.name));
    return sim.length ? `; similar: ${sim.join(", ")}` : "";
  };

  for (const r0 of refs) {
    soft = !!r0.soft;
    guarded = !!r0.guarded;
    const owner = normalize(r0.owner, r0);
    if (!owner) continue;
    const r = { ...r0, owner, desc: r0.desc ? nd(r0.desc, r0) : undefined };
    if (owner.startsWith("org/bukkit/craftbukkit/") && pk.cb === undefined) {
      skippedCb++;
      continue;
    }
    const key = `${r.kind} ${owner}#${r.name ?? ""}${r.desc ?? ""}${r.declared ? "!" : ""}`;
    const c = index.get(owner);
    if (!c) {
      add(`class ${owner}`, "error", `class ${d(owner)} not found${classSuggest(owner)}`, r.where);
      continue;
    }
    if (r.kind === "class") {
      if (!seen.has(key)) checked++;
      seen.add(key);
      continue;
    }
    if (seen.has(key)) {
      const p = problems.get(key);
      if (p && !p.where.includes(r.where)) p.where.push(r.where);
      continue;
    }
    seen.add(key);
    checked++;
    const chain = r.declared ? [c] : index.hierarchy(owner);
    const complete = r.declared || chainComplete(index, owner);
    const pick = (x: typeof c) => (r.kind === "field" ? x.f : x.m);
    const exact = chain.some((x) => pick(x).some(([n, ds]) => n === r.name && (!r.desc || ds === r.desc)));
    if (exact) continue;
    // most-derived declaration only (overrides with covariant returns would repeat up the chain)
    const named = chain.map((x) => pick(x).filter(([n]) => n === r.name)).find((l) => l.length) ?? [];
    // hide compiler bridges (covariant returns) when real declarations exist
    const real = named.filter(([, , acc]) => !(acc & 0x1000));
    const sameName = (real.length ? real : named).map(([n, ds]) => `${n}${fmtDesc(r.kind as "field" | "method", ds)}`);
    if (sameName.length) {
      add(key, "error", `${r.kind} ${d(owner)}#${r.name}${fmtDesc(r.kind, r.desc ?? "")}: ${r.kind === "field" ? "type" : "signature"} changed, now ${[...new Set(sameName)].slice(0, 3).join(", ")}`, r.where);
      continue;
    }
    if (!complete) {
      unverifiable++;
      continue;
    }
    const all = chain.flatMap((x) => pick(x).map(([n, ds]) => ({ n, ds })));
    const lname = r.name!.toLowerCase();
    const similar = [...new Set(all.filter((x) => x.n.length > 2 && (lev(x.n.toLowerCase(), lname) <= 2 || (lname.length > 3 && x.n.toLowerCase().includes(lname)))).map((x) => `${x.n}${fmtDesc(r.kind, x.ds)}`))].slice(0, 3);
    // moved to another class? (same name elsewhere, e.g. ServerPlayer#latency → ServerCommonPacketListenerImpl#latency())
    const elsewhere = r.name!.length > 2 ? index.search(r.name!, "any", 400).filter((h) => h.kind !== "class" && h.name === r.name && h.owner !== owner).slice(0, 3).map((h) => `${d(h.owner!)}#${h.name}${fmtDesc(h.kind as "field" | "method", h.desc!)}`) : [];
    const obfNames = r.name!.length <= 2;
    const sameDesc = obfNames && r.desc && r.kind === "method" ? [...new Set(all.filter((x) => x.ds === r.desc && x.n !== "<init>").map((x) => x.n))].slice(0, 4) : [];
    const sugg = [similar.length ? `similar: ${similar.join(", ")}` : "", elsewhere.length ? `elsewhere: ${elsewhere.join(", ")}` : "", sameDesc.length ? `same descriptor: ${sameDesc.join(", ")}` : ""].filter(Boolean).join("; ");
    add(key, "error", `${r.kind} ${d(owner)}#${r.name}${r.desc ? fmtDesc(r.kind, r.desc) : ""} not found${r.declared ? " (getDeclared*: declared in this class only)" : ""}${sugg ? `; ${sugg}` : ""}`, r.where);
  }
  return { problems: [...problems.values()], checked, unverifiable, skippedCraftBukkit: skippedCb };
}

const fmtDesc = (kind: string, desc: string) => (!desc ? "" : kind === "field" ? `: ${descToJava(desc).replace(/^.*\./, "")}` : desc);

/** True when every supertype of the class is in the index (or java.lang.Object), so "not found" is reliable. */
function chainComplete(index: McIndex, name: string): boolean {
  const todo = [name];
  const seen = new Set<string>();
  while (todo.length) {
    const n = todo.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (n === "java/lang/Object") continue;
    const c = index.get(n);
    if (!c) return false;
    if (c.s) todo.push(c.s);
    todo.push(...c.i);
  }
  return true;
}
