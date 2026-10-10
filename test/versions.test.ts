import { describe, expect, it } from "vitest";
import { matchVersion } from "../src/index/service.js";
import { lookupProfile, versionFacts } from "../src/services.js";
import { parseCraftBukkitPom, relocate } from "../src/sources/spigot.js";
import { getProfile } from "../src/tools/getProfile.js";
import { listVersions } from "../src/tools/listVersions.js";
import { fixture, fixtureServices } from "./helpers.js";

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

describe("live sources (fixtures)", () => {
  const s = fixtureServices();
  it("reads Paper and Spigot version lists", async () => {
    expect(await s.versions.paperVersions()).toContain("1.20.4");
    const sp = await s.versions.spigotVersions();
    expect(sp).toContain("1.16.5");
    expect(sp).toContain("1.20.4");
  });
  it("derives obfuscation and Mojang mappings per version", async () => {
    expect(await versionFacts(s, "1.13.2")).toMatchObject({ mojangMappings: false, obfuscated: true });
    expect(await versionFacts(s, "1.20.4")).toMatchObject({ mojangMappings: true, obfuscated: true });
    expect(await versionFacts(s, "26.3")).toMatchObject({ obfuscated: false });
  });
  it("reads the CraftBukkit package and NMS flattening from the pom", async () => {
    const old = await s.versions.craftBukkit("1.16.5");
    expect(old?.packageVersion).toBe("1_16_R3");
    expect(relocate("net/minecraft/server/level/EntityPlayer", old!.relocations)).toBe("net/minecraft/server/v1_16_R3/EntityPlayer");
    expect(relocate("org/bukkit/craftbukkit/entity/CraftPlayer", old!.relocations)).toBe("org/bukkit/craftbukkit/v1_16_R3/entity/CraftPlayer");
    const mid = await s.versions.craftBukkit("1.20.4");
    expect(mid?.packageVersion).toBe("1_20_R3");
    expect(relocate("net/minecraft/server/level/EntityPlayer", mid!.relocations)).toBe("net/minecraft/server/level/EntityPlayer");
    const pom = parseCraftBukkitPom(fixture("spigot/1.20.6-craftbukkit-pom.xml"));
    expect(pom.packageVersion).toBe("1_20_R4");
  });
  it("matches artifact versions with patterns", () => {
    expect(matchVersion(["1.21.11-R0.1-SNAPSHOT", "26.3.build.1-alpha", "26.3.build.169-beta"], ["{mc}-R0.1-SNAPSHOT", "{mc}.build.*"], "26.3")).toBe("26.3.build.169-beta");
    expect(matchVersion(["1.20.4-R0.1-SNAPSHOT"], ["{mc}-R0.1-SNAPSHOT"], "1.20")).toBeUndefined();
  });
});

describe("profiles", () => {
  const s = fixtureServices();
  it("Paper: versioned packages → paperweight → Mojang runtime → unobfuscated", async () => {
    const p13 = (await lookupProfile(s, "paper", "1.16.5")).profile;
    expect(p13.nms).toMatchObject({ approach: "versioned-package", versionedNmsPackage: true, devMappings: "spigot" });
    const p17 = (await lookupProfile(s, "paper", "1.20.4")).profile;
    expect(p17.nms).toMatchObject({ approach: "paperweight-userdev", devMappings: "mojang", runtimeMappings: "spigot", reobf: true, craftBukkitRelocated: true });
    expect(p17.pluginYml.apiVersion).toBe("minor");
    const p20 = (await lookupProfile(s, "paper", "1.20.6")).profile;
    expect(p20.nms).toMatchObject({ runtimeMappings: "mojang", reobf: false, craftBukkitRelocated: false });
    expect(p20.pluginYml.apiVersion).toBe("full");
    const p26 = (await lookupProfile(s, "paper", "26.3")).profile;
    expect(p26.java).toBeGreaterThanOrEqual(25);
    expect(p26.extrapolated).toBe(false);
  });
  it("Spigot: versioned → remapped-mojang → unobfuscated", async () => {
    expect((await lookupProfile(s, "spigot", "1.13.2")).profile.java).toBe(8);
    expect((await lookupProfile(s, "spigot", "1.17.1")).profile.nms.approach).toBe("spigot-remapped");
    expect((await lookupProfile(s, "spigot", "26.3")).profile.nms.approach).toBe("mojang-unobfuscated");
  });
  it("extrapolates unknown future versions with an UNVERIFIED warning", async () => {
    const { profile, notes } = await lookupProfile(s, "paper", "27.1");
    expect(profile.extrapolated).toBe(true);
    expect(notes.warnings.join(" ")).toMatch(/UNVERIFIED/);
  });
  it("rejects versions before 1.13", async () => {
    await expect(lookupProfile(s, "spigot", "1.12.2")).rejects.toThrow(/older than/);
  });
});

describe("list_versions / get_profile", () => {
  const s = fixtureServices();
  it("lists versions compactly", async () => {
    const t = text(await listVersions(s, { limit: 5 }));
    expect(t.split("\n").length).toBeLessThanOrEqual(7);
    expect(t).toMatch(/Minecraft versions ≥ 1\.13/);
  });
  it("details one version", async () => {
    const t = text(await listVersions(s, { mcVersion: "1.20.4" }));
    expect(t).toMatch(/Java 17/);
    expect(t).toMatch(/server:mojang/);
    expect(t).toMatch(/org\.bukkit\.craftbukkit\.v1_20_R3/);
    expect(t).toMatch(/dev-bundle:1\.20\.4-R0\.1-SNAPSHOT/);
  });
  it("gives a paperweight Gradle snippet", async () => {
    const t = text(await getProfile(s, { mcVersion: "1.21.11", platform: "paper", build: "gradle" }));
    expect(t).toMatch(/io\.papermc\.paperweight\.userdev/);
    expect(t).toMatch(/paperDevBundle\("1\.21\.11/);
    expect(t).toMatch(/MOJANG_PRODUCTION/);
    expect(t).toMatch(/api-version: '1\.21\.11'/);
  });
  it("gives a Spigot remapped Maven snippet", async () => {
    const t = text(await getProfile(s, { mcVersion: "1.20.4", platform: "spigot", build: "maven" }));
    expect(t).toMatch(/specialsource-maven-plugin/);
    expect(t).toMatch(/remapped-mojang/);
    expect(t).toMatch(/api-version: '1\.20'/);
  });
  it("Bukkit API only", async () => {
    const t = text(await getProfile(s, { mcVersion: "1.13.2", platform: "bukkit" }));
    expect(t).toMatch(/NMS: not part of the Bukkit API/);
    expect(t).toMatch(/Java 8/);
  });
});
