import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { matchVersion } from "../index/service.js";
import type { ResolvedProfile } from "../profiles/schema.js";
import { lookupProfile, type Services } from "../services.js";
import { Notes } from "../sources/index.js";
import { compareLooseVersions } from "../util/mcversion.js";
import { okText } from "./result.js";
import { getProfileInput } from "./schemas.js";

type A = z.infer<z.ZodObject<typeof getProfileInput>>;
type Ref = NonNullable<ResolvedProfile["nms"]["gradlePlugin"]>;

export interface ConcreteProfile {
  profile: ResolvedProfile;
  api?: string;
  apiRepo: string;
  nmsDep?: string;
  nmsDepLocal?: boolean;
  gradlePlugin?: string;
  mavenPlugin?: string;
  shadow?: string;
  craftBukkitPackage?: string;
  apiVersion: string;
  /** Minimum Gradle / Gradle JVM: the profile's, raised to what the Gradle plugins' metadata requires. */
  gradle: { version: string; jvm?: number; why?: string };
  notes: Notes;
}

/** Profile with live artifact versions, plugin versions and the CraftBukkit package filled in. */
export async function concreteProfile(services: Services, platform: A["platform"], mc: string): Promise<ConcreteProfile> {
  const notes = new Notes();
  const { profile } = await lookupProfile(services, platform, mc, notes);
  const v = services.versions;
  const plugin = async (r: Ref | null | undefined) => {
    if (!r) return undefined;
    const ver = r.version === "latest" && r.metadataUrl ? await v.latestMaven(r.metadataUrl, { prefix: r.versionPrefix, allowUnstable: r.allowUnstable }, notes).catch(() => undefined) : r.version;
    return `${r.id}:${ver ?? "?"}`;
  };
  const coord = async (c: ResolvedProfile["api"] | null | undefined) => {
    if (!c) return undefined;
    const ver = matchVersion(await v.mavenVersions(c.metadataUrl, notes).catch(() => []), c.versions, mc);
    return ver ? `${c.group}:${c.artifact}:${ver}${c.classifier ? `:${c.classifier}` : ""}` : undefined;
  };
  let api = await coord(profile.api);
  if (!api && platform === "bukkit") api = await coord({ ...profile.api, group: "org.bukkit", artifact: "bukkit", metadataUrl: profile.api.metadataUrl.replace("org/spigotmc/spigot-api", "org/bukkit/bukkit") });
  if (!api) notes.warn(`${profile.api.group}:${profile.api.artifact} has no build for ${mc}${profile.platform === "paper" ? "; compile against org.spigotmc:spigot-api of this version (Paper is API-compatible) or the patched server jar" : ""}.`);
  let nmsDep: string | undefined;
  let nmsDepLocal: boolean | undefined;
  const dep = profile.nms.dependency;
  if (dep && platform !== "bukkit") {
    if (dep.artifact === "spigot") {
      const ver = `${mc}-R0.1-SNAPSHOT`;
      nmsDep = `${dep.group}:${dep.artifact}:${ver}${dep.classifier ? `:${dep.classifier}` : ""}`;
      nmsDepLocal = existsSync(path.join(services.config.mavenLocal, "org", "spigotmc", "spigot", ver, `spigot-${ver}${dep.classifier ? `-${dep.classifier}` : ""}.jar`));
    } else {
      nmsDep = await coord(dep);
      if (!nmsDep) notes.warn(`No ${dep.artifact} published for ${mc} (paperweight-userdev needs one).`);
    }
  }
  let cbPkg: string | undefined;
  if (profile.nms.craftBukkitRelocated) {
    const cb = await v.craftBukkit(mc, notes).catch(() => undefined);
    cbPkg = cb ? (cb.packageVersion ? `org.bukkit.craftbukkit.v${cb.packageVersion}` : "org.bukkit.craftbukkit") : undefined;
  } else cbPkg = "org.bukkit.craftbukkit";
  const minor = mc.split(".").slice(0, 2).join(".");
  const gradlePlugin = platform === "bukkit" ? undefined : await plugin(profile.nms.gradlePlugin);
  const shadow = await plugin(profile.gradle.shadow);
  const gradle: ConcreteProfile["gradle"] = { version: profile.gradle.version };
  for (const ref of [gradlePlugin, shadow]) {
    if (!ref) continue;
    const i = ref.lastIndexOf(":");
    const needs = await v.gradlePluginNeeds(ref.slice(0, i), ref.slice(i + 1), notes).catch(() => undefined);
    if (needs?.gradle && compareLooseVersions(needs.gradle, gradle.version) > 0) Object.assign(gradle, { version: needs.gradle, why: `${ref} needs it` });
    if (needs?.jvm && needs.jvm > (gradle.jvm ?? 0)) gradle.jvm = needs.jvm;
  }
  return {
    profile,
    api,
    apiRepo: profile.api.repository,
    nmsDep,
    nmsDepLocal,
    gradlePlugin,
    mavenPlugin: platform === "bukkit" ? undefined : await plugin(profile.nms.mavenPlugin),
    shadow,
    gradle,
    craftBukkitPackage: cbPkg,
    apiVersion: profile.pluginYml.apiVersion === "full" ? mc : minor,
    notes,
  };
}

export async function getProfile(services: Services, a: A) {
  const c = await concreteProfile(services, a.platform, a.mcVersion);
  const p = c.profile;
  const nms = p.nms;
  const lines = [
    `${a.platform} ${a.mcVersion}${p.extrapolated ? " (UNVERIFIED: extrapolated)" : ""}: Java ${p.java}.`,
    `API: ${c.api ?? "—"} (repo ${c.apiRepo}), scope provided/compileOnly.`,
    a.platform === "bukkit"
      ? "NMS: not part of the Bukkit API."
      : `NMS: ${nms.approach}; dev names ${nms.devMappings}, runtime ${nms.runtimeMappings}${nms.reobf ? ", remap jar to runtime names" : ""}; ${nms.versionedNmsPackage ? "NMS package net.minecraft.server.v1_X_RY; " : ""}CraftBukkit ${c.craftBukkitPackage ?? "?"}.`,
    ...(c.nmsDep ? [`  depend on ${c.nmsDep}${c.nmsDepLocal === false ? " (not in local ~/.m2 yet: run BuildTools)" : c.nmsDepLocal ? " (found in ~/.m2)" : ""}`] : []),
    ...(c.gradlePlugin ? [`  Gradle plugin ${c.gradlePlugin}`] : []),
    ...(c.mavenPlugin ? [`  Maven plugin ${c.mavenPlugin}`] : []),
    ...(a.platform === "bukkit" ? [] : [`  how: ${nms.howTo.replace(/\{mc\}/g, a.mcVersion)}`]),
    `plugin.yml: ${p.pluginYml.files.join(" or ")}; api-version: '${c.apiVersion}'.`,
    `Gradle ${c.gradle.version}+ wrapper${c.gradle.why ? ` (${c.gradle.why})` : ""}${c.gradle.jvm ? `, run on JDK ${c.gradle.jvm}+` : ""}${c.shadow ? `; shading: ${c.shadow}` : ""}.`,
    ...p.notes.map((n) => `- ${n}`),
    ...(a.build ? ["", snippet(a.build, a.platform, a.mcVersion, c)] : []),
    ...(a.verbose ? [`rules: ${p.matchedRules.join("; ")}`, `refs: ${p.references.join(" ")}`] : []),
    ...c.notes.warnings.map((w) => `note: ${w}`),
  ];
  return okText(lines.join("\n"));
}

function snippet(build: "gradle" | "maven", platform: A["platform"], mc: string, c: ConcreteProfile): string {
  const p = c.profile;
  const [g, art, ver] = (c.api ?? "GROUP:ARTIFACT:VERSION").split(":");
  if (build === "gradle") {
    const userdev = p.nms.approach === "paperweight-userdev" && platform === "paper" && c.nmsDep;
    const pv = c.gradlePlugin?.split(":").pop();
    return [
      "// build.gradle.kts",
      `plugins {\n    java${userdev ? `\n    id("io.papermc.paperweight.userdev") version "${pv}"` : ""}\n}`,
      `repositories {\n    mavenCentral()\n    maven("${c.apiRepo}")\n}`,
      `dependencies {\n    ${userdev ? `paperweight.paperDevBundle("${c.nmsDep!.split(":")[2]}")` : `compileOnly("${g}:${art}:${ver}")`}${!userdev && c.nmsDep && platform !== "paper" ? `\n    compileOnly("${c.nmsDep}") // mavenLocal() after BuildTools` : ""}\n}`,
      `java.toolchain.languageVersion = JavaLanguageVersion.of(${p.java})`,
      ...(userdev && c.gradle.jvm && Number(c.gradle.jvm) > Number(p.java)
        ? [`paperweight.javaLauncher = javaToolchains.launcherFor { languageVersion = JavaLanguageVersion.of(${c.gradle.jvm}) } // paperweight ${pv} needs Java ${c.gradle.jvm}`]
        : []),
      ...(userdev && p.nms.reobf ? ["tasks.assemble { dependsOn(tasks.reobfJar) } // ship build/libs/*.jar without -dev"] : []),
      ...(userdev && !p.nms.reobf && p.obfuscated ? ["paperweight.reobfArtifactConfiguration = io.papermc.paperweight.userdev.ReobfArtifactConfiguration.MOJANG_PRODUCTION"] : []),
    ].join("\n");
  }
  const dep = (coord: string) => {
    const [dg, da, dv, dc] = coord.split(":");
    return `    <dependency><groupId>${dg}</groupId><artifactId>${da}</artifactId><version>${dv}</version>${dc ? `<classifier>${dc}</classifier>` : ""}<scope>provided</scope></dependency>`;
  };
  const deps = [c.api ? dep(c.api) : "", c.nmsDep && platform !== "paper" ? dep(c.nmsDep) : ""].filter(Boolean);
  const out = [
    "<!-- pom.xml -->",
    `<properties><maven.compiler.release>${p.java}</maven.compiler.release></properties>`,
    `<repositories><repository><id>${platform === "paper" ? "papermc" : "spigotmc-repo"}</id><url>${c.apiRepo}</url></repository></repositories>`,
    `<dependencies>\n${deps.join("\n")}\n</dependencies>`,
  ];
  if (platform === "paper" && p.nms.approach === "paperweight-userdev") out.push("<!-- NMS on Paper: paperweight-userdev is Gradle-only. With Maven compile against a Spigot remapped-mojang jar (platform=spigot) or switch to Gradle. -->");
  if (p.nms.approach === "spigot-remapped" && c.mavenPlugin && platform !== "bukkit") {
    const sv = c.mavenPlugin.split(":").pop();
    const v = `${mc}-R0.1-SNAPSHOT`;
    out.push(
      `<build><plugins><plugin><groupId>net.md-5</groupId><artifactId>specialsource-maven-plugin</artifactId><version>${sv}</version><executions>
  <execution><id>remap-obf</id><phase>package</phase><goals><goal>remap</goal></goals><configuration>
    <srgIn>org.spigotmc:minecraft-server:${v}:txt:maps-mojang</srgIn><reverse>true</reverse>
    <remappedDependencies>org.spigotmc:spigot:${v}:jar:remapped-mojang</remappedDependencies>
    <remappedArtifactAttached>true</remappedArtifactAttached><remappedClassifierName>remapped-obf</remappedClassifierName></configuration></execution>
  <execution><id>remap-spigot</id><phase>package</phase><goals><goal>remap</goal></goals><configuration>
    <inputFile>\${project.build.directory}/\${project.artifactId}-\${project.version}-remapped-obf.jar</inputFile>
    <srgIn>org.spigotmc:minecraft-server:${v}:csrg:maps-spigot</srgIn>
    <remappedDependencies>org.spigotmc:spigot:${v}:jar:remapped-obf</remappedDependencies></configuration></execution>
</executions></plugin></plugins></build>`,
    );
  }
  return out.join("\n");
}
