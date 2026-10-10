import { describe, expect, it } from "vitest";
import { McIndex, type IndexedClass, type IndexMeta } from "../src/index/store.js";
import { checkRefs } from "../src/nms/check.js";
import { sourceRefs, type NmsRef } from "../src/nms/refs.js";

const meta = (over: Partial<IndexMeta> = {}): IndexMeta => ({
  formatVersion: 1, kind: "paper", mcVersion: "1.20.4", namespace: "mojang", craftBukkitPackage: "v1_20_R3",
  label: "test", jar: "x.jar", builtAt: "", classCount: 0, notes: [], ...over,
});
const cls = (n: string, s: string | undefined, m: [string, string][] = [], f: [string, string][] = []): IndexedClass => ({
  n, a: 1, ...(s ? { s } : {}), i: [], m: m.map(([a, b]) => [a, b, 1]), f: f.map(([a, b]) => [a, b, 1]),
});
const classes = [
  cls("java/lang/Object", undefined),
  cls("net/minecraft/world/entity/Entity", "java/lang/Object", [["setGlowingTag", "(Z)V"]]),
  cls("net/minecraft/server/level/ServerPlayer", "net/minecraft/world/entity/Entity", [["sendSystemMessage", "(Lnet/minecraft/network/chat/Component;)V"]], [["latency", "I"]]),
  cls("net/minecraft/network/chat/Component", "java/lang/Object"),
  cls("org/bukkit/craftbukkit/v1_20_R3/entity/CraftPlayer", "java/lang/Object", [["getHandle", "()Lnet/minecraft/server/level/ServerPlayer;"]]),
];
const index = new McIndex("/tmp/none", meta(), classes);
const ref = (r: Partial<NmsRef> & Pick<NmsRef, "kind" | "owner" | "name">): NmsRef => ({ origin: "bytecode", where: "T", ...r });

describe("checkRefs", () => {
  it("accepts existing members incl. inherited", () => {
    const r = checkRefs(index, [
      ref({ kind: "method", owner: "net/minecraft/server/level/ServerPlayer", name: "setGlowingTag", desc: "(Z)V" }),
      ref({ kind: "field", owner: "net/minecraft/server/level/ServerPlayer", name: "latency", desc: "I" }),
    ]);
    expect(r.problems).toEqual([]);
    expect(r.checked).toBe(2);
  });
  it("reports missing members with suggestions and changed signatures", () => {
    const r = checkRefs(index, [
      ref({ kind: "field", owner: "net/minecraft/server/level/ServerPlayer", name: "latencyy", desc: "I" }),
      ref({ kind: "method", owner: "net/minecraft/server/level/ServerPlayer", name: "sendSystemMessage", desc: "(Ljava/lang/String;)V" }),
    ]);
    const t = r.problems.map((p) => p.text).join("\n");
    expect(t).toMatch(/latencyy: int not found; similar: latency: int/);
    expect(t).toMatch(/signature changed, now sendSystemMessage/);
  });
  it("flags versioned NMS packages and wrong CraftBukkit package", () => {
    const r = checkRefs(index, [
      ref({ kind: "class", owner: "net/minecraft/server/v1_16_R3/EntityPlayer", name: "" }),
      ref({ kind: "class", owner: "org/bukkit/craftbukkit/v1_16_R3/entity/CraftPlayer", name: "" }),
    ]);
    const t = r.problems.map((p) => p.text).join("\n");
    expect(t).toMatch(/versioned NMS packages are gone/);
    expect(t).toMatch(/v1_16_R3.*v1_20_R3/);
    expect(r.problems.every((p) => p.severity === "error")).toBe(true);
  });
  it("unversioned CraftBukkit against a versioned server is an error", () => {
    const r = checkRefs(index, [ref({ kind: "class", owner: "org/bukkit/craftbukkit/entity/CraftPlayer", name: "" })]);
    expect(r.problems[0]?.text).toMatch(/unversioned only from Paper 1\.20\.5/);
  });
});

describe("sourceRefs", () => {
  it("finds imports, reflection and versioned templates", () => {
    const src = `import net.minecraft.server.level.ServerPlayer;
class A { void x() throws Exception {
  Class<?> c = Class.forName("net.minecraft.server." + v + ".EntityPlayer");
  ServerPlayer.class.getDeclaredField("latency");
} }`;
    const refs = sourceRefs(src, "A.java");
    expect(refs.some((r) => r.origin === "import" && r.owner === "net/minecraft/server/level/ServerPlayer")).toBe(true);
    expect(refs.some((r) => r.origin === "reflection" && r.kind === "field" && r.name === "latency" && r.declared)).toBe(true);
    expect(refs.some((r) => r.owner.includes("{v}"))).toBe(true);
  });
});
