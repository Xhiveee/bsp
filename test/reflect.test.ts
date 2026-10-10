import { describe, expect, it } from "vitest";
import { analyzeReflection } from "../src/nms/reflect.js";

const run = (files: Record<string, string>) => analyzeReflection(Object.entries(files).map(([file, text]) => ({ file, text })));
const owners = (r: ReturnType<typeof run>) => r.refs.map((x) => `${x.kind} ${x.owner}${x.name ? `#${x.name}` : ""}`).sort();

describe("reflection analysis", () => {
  it("version from the CraftServer package, wrappers, members", () => {
    const r = run({
      "Reflection.java": `package a;
import org.bukkit.Bukkit;
public final class Reflection {
  public static final String VERSION = Bukkit.getServer().getClass().getPackage().getName().split("\\\\.")[3];
  private static final String NMS = "net.minecraft.server." + VERSION + ".";
  public static Class<?> getNMSClass(String name) {
    try { return Class.forName(NMS + name); } catch (ClassNotFoundException e) { throw new RuntimeException(e); }
  }
  static Class<?> getCraftClass(String name) throws Exception {
    return Class.forName(new StringBuilder("org.bukkit.craftbukkit.").append(VERSION).append('.').append(name).toString());
  }
}`,
      "Use.java": `package a;
import java.lang.invoke.*;
class Use {
  void x() throws Throwable {
    Class<?> ep = Reflection.getNMSClass("EntityPlayer");
    ep.getDeclaredField("ping");
    Class<?> cp = Reflection.getCraftClass("entity.CraftPlayer");
    cp.getMethod("getHandle");
    MethodHandles.Lookup l = MethodHandles.lookup();
    l.findVirtual(Class.forName(String.format("net.minecraft.server.%s.%s", Reflection.VERSION, "PlayerConnection")), "sendPacket", null);
    String v = Bukkit.getServer().getClass().getPackage().getName();
    v = v.substring(v.lastIndexOf('.') + 1);
    Class.forName("net.minecraft.server." + v + ".World").getField("worldData");
    Class.forName(System.getProperty("x") + ".Foo");
    Class.forName("net.minecraft.server." + someDynamic() + ".Bar");
  }
}`,
    });
    expect(owners(r)).toEqual([
      "class net/minecraft/server/{v}/EntityPlayer",
      "class net/minecraft/server/{v}/PlayerConnection",
      "class net/minecraft/server/{v}/World",
      "class org/bukkit/craftbukkit/{v}/entity/CraftPlayer",
      "field net/minecraft/server/{v}/EntityPlayer#ping",
      "field net/minecraft/server/{v}/World#worldData",
      "method net/minecraft/server/{v}/PlayerConnection#sendPacket",
      "method org/bukkit/craftbukkit/{v}/entity/CraftPlayer#getHandle",
    ]);
    expect(r.refs.find((x) => x.name === "ping")?.declared).toBe(true);
    expect(r.dynamic).toHaveLength(1);
    expect(r.dynamic[0]).toMatch(/Use\.java:15 net\.minecraft\.server\.<\?>\.Bar/);
  });

  it("version branches become alternatives; libraries are soft", () => {
    const r = run({
      "B.java": `class B {
  static Class<?> handle(boolean modern, String v) throws Exception {
    Class<?> c = modern ? Class.forName("net.minecraft.server.level.EntityPlayer") : Class.forName("net.minecraft.server.v1_16_R3.EntityPlayer");
    Class<?> d = ReflectionUtils.getNMSClass("server.level", "EntityPlayer");
    return c;
  }
}`,
    });
    const alt = r.refs.filter((x) => x.where.endsWith(":4"));
    expect(alt.length).toBe(2);
    expect(alt.every((x) => x.soft && x.alt)).toBe(true);
  });

  it("does not report wrapper internals as dynamic; parse failures are returned", () => {
    const r = run({ "W.java": `class W { static Class<?> nms(String n) throws Exception { return Class.forName("net.minecraft.server." + V + "." + n); } }`, "Bad.java": "class {" });
    expect(r.dynamic).toEqual([]);
    expect(r.failed).toEqual(["Bad.java"]);
  });
});

describe("javadoc index-all (JDK 8)", () => {
  it("parses types and members", async () => {
    const { parseIndexAll } = await import("../src/docs/javadoc.js");
    const r = parseIndexAll(`<dl><dt><span class="memberNameLink"><a href="org/bukkit/entity/Player.html#getPing--">getPing()</a></span> - Method in interface org.bukkit.entity.<a href="org/bukkit/entity/Player.html">Player</a></dt>
<dt><a href="org/bukkit/entity/Player.html" title="interface in org.bukkit.entity"><span class="typeNameLink">Player</span></a> - Interface in <a href="org/bukkit/entity/package-summary.html">org.bukkit.entity</a></dt></dl>`);
    expect(r.members).toEqual([{ p: "org.bukkit.entity", c: "Player", l: "getPing()", u: "getPing--" }]);
    expect(r.types).toEqual([{ p: "org.bukkit.entity", l: "Player" }]);
  });
  it("marks Class.forName inside a swallowing try/catch as guarded, not a rethrowing one", () => {
    const r = run({
      "P.java": `package a;
class P {
  static void probe() {
    try {
      Class.forName("net.minecraft.nbt.NBTTagCompound");
    } catch (Exception e) {
    }
    try {
      Class.forName("net.minecraft.world.entity.Entity");
    } catch (Exception e) {
      throw new RuntimeException(e);
    }
  }
}`,
    });
    const g = Object.fromEntries(r.refs.map((x) => [x.owner, !!x.guarded]));
    expect(g).toEqual({ "net/minecraft/nbt/NBTTagCompound": true, "net/minecraft/world/entity/Entity": false });
  });
});
