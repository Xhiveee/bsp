/**
 * SpecialSource's automatic member names, which BuildTools applies on top of BuildData (Spigot names pre-1.17 and
 * Spigot runtime names 1.17–1.20.4): see BuildData info.json classMapCommand/memberMapCommand (--auto-member …).
 *  - SYNTHETIC: a method called by a synthetic bridge takes the bridge's name (compareTo, parse, apply …)
 *  - LOGGER:    a static log4j Logger field is named LOGGER
 *  - TOKENS:    enum constant fields take their constant name (NORTH, SOUTH …)
 */
import AdmZip from "adm-zip";
import { ACC, ClassReader } from "./classfile.js";
import { key, type MappingSet } from "./mappings.js";

const paramCount = (desc: string) => (desc.slice(1, desc.indexOf(")")).match(/\[*(?:L[^;]+;|[ZBCSIJFD])/g) ?? []).length;

export function addSpigotAutoMembers(jar: string, set: MappingSet, modes: string[]): number {
  const want = new Set(modes.map((m) => m.toUpperCase()));
  let added = 0;
  const put = (map: Map<string, string[]>, k: string, name: string) => {
    if (map.has(k)) return;
    map.set(k, set.namespaces.map((_, i) => (i === 0 ? k.split("\t")[1]! : name)));
    added++;
  };
  for (const e of new AdmZip(jar).getEntries()) {
    if (!e.entryName.endsWith(".class")) continue;
    let r: ClassReader;
    try {
      r = new ClassReader(e.getData());
    } catch {
      continue;
    }
    const c = r.info.name;
    if (want.has("SYNTHETIC")) {
      for (const m of r.info.methods) {
        // Mojang's obfuscated jars drop ACC_BRIDGE; a non-static synthetic method is a bridge (lambdas are static or private)
        if (!(m.access & ACC.SYNTHETIC) || m.access & (ACC.STATIC | ACC.PRIVATE) || m.name.startsWith("<")) continue;
        const t = r.analyze(m).invokes.find((i) => i.owner === c && i.name !== m.name && !i.name.startsWith("<") && paramCount(i.desc) === paramCount(m.desc));
        if (t && r.info.methods.some((x) => x.name === t.name && x.desc === t.desc && !(x.access & ACC.SYNTHETIC))) put(set.methods, key(c, t.name, t.desc), m.name);
      }
    }
    if (want.has("LOGGER")) {
      for (const f of r.info.fields) if (f.access & ACC.STATIC && f.desc === "Lorg/apache/logging/log4j/Logger;" && !set.fields.has(key(c, f.name, f.desc)) && !set.fields.has(key(c, f.name, ""))) put(set.fields, key(c, f.name, f.desc), "LOGGER");
    }
    if (want.has("TOKENS") && r.info.access & ACC.ENUM) {
      const clinit = r.info.methods.find((m) => m.name === "<clinit>");
      if (!clinit) continue;
      let last: string | undefined;
      for (const n of r.analyze(clinit).seq) {
        if (n.kind === "NEW") last = undefined;
        else if (n.kind === "CONSTANT" && n.key.startsWith("string:") && last === undefined) last = n.key.slice(7);
        else if (n.kind === "FIELD" && n.opcode === "PUTSTATIC" && last) {
          const m = /^L([^;]+);([^:]+):(.*)$/.exec(n.key);
          if (m && m[1] === c && m[3] === `L${c};` && /^[A-Z_$][A-Z0-9_$]*$/.test(last) && !set.fields.has(key(c, m[2]!, "")) && !set.fields.has(key(c, m[2]!, m[3]!))) put(set.fields, key(c, m[2]!, m[3]!), last);
          last = undefined;
        }
      }
    }
  }
  return added;
}
