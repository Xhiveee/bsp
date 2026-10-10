/** Official endpoints BSP reads (all verified to respond; see docs/reference.md "Data sources"). */
const STASH = "https://hub.spigotmc.org/stash/rest/api/1.0/projects/SPIGOT/repos";
export const REPOS = {
  spigot: "https://hub.spigotmc.org/nexus/content/repositories/snapshots/",
  paper: "https://repo.papermc.io/repository/maven-public/",
  central: "https://repo1.maven.org/maven2/",
  gradlePlugins: "https://plugins.gradle.org/m2/",
} as const;

/** group:artifact → base URL of the artifact directory in a Maven repo. */
export const artifactBase = (repo: string, ga: string) => {
  const [g, a] = ga.split(":");
  return `${repo}${g!.replace(/\./g, "/")}/${a}/`;
};
const meta = (repo: string, ga: string) => `${artifactBase(repo, ga)}maven-metadata.xml`;

export const ENDPOINTS = {
  mojangManifest: "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
  // PaperMC downloads service (Fill v3)
  fillProject: "https://fill.papermc.io/v3/projects/paper",
  fillVersion: (v: string) => `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(v)}`,
  fillLatestBuild: (v: string) => `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(v)}/builds/latest`,
  // Spigot BuildTools data
  spigotVersionsIndex: "https://hub.spigotmc.org/versions/",
  spigotVersion: (v: string) => `https://hub.spigotmc.org/versions/${encodeURIComponent(v)}.json`,
  /** Raw file of a Spigot Stash repo at a commit (the /raw/ web path is behind a JS challenge; the REST path is not). */
  stashRaw: (repo: "builddata" | "craftbukkit" | "bukkit" | "spigot", file: string, at: string) => `${STASH}/${repo}/raw/${file}?at=${encodeURIComponent(at)}`,
  // Maven metadata (versions)
  spigotApiMetadata: meta(REPOS.spigot, "org.spigotmc:spigot-api"),
  bukkitMetadata: meta(REPOS.spigot, "org.bukkit:bukkit"),
  paperApiMetadata: meta(REPOS.paper, "io.papermc.paper:paper-api"),
  legacyPaperApiMetadata: meta(REPOS.paper, "com.destroystokyo.paper:paper-api"),
  devBundleMetadata: meta(REPOS.paper, "io.papermc.paper:dev-bundle"),
  userdevPluginMetadata: meta(REPOS.gradlePlugins, "io.papermc.paperweight.userdev:io.papermc.paperweight.userdev.gradle.plugin"),
  specialSourceMetadata: meta(REPOS.central, "net.md-5:specialsource-maven-plugin"),
  shadowPluginMetadata: meta(REPOS.gradlePlugins, "com.gradleup.shadow:com.gradleup.shadow.gradle.plugin"),
  snapshotMetadata: (repo: string, ga: string, v: string) => `${artifactBase(repo, ga)}${encodeURIComponent(v)}/maven-metadata.xml`,
  artifact: (repo: string, ga: string, v: string, file: string) => `${artifactBase(repo, ga)}${encodeURIComponent(v)}/${file}`,
  // tools
  buildToolsJar: "https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar",
  /** Gradle plugin marker POM (points at the implementation artifact). */
  gradlePluginMarker: (id: string, v: string) => `${REPOS.gradlePlugins}${id.replace(/\./g, "/")}/${id}.gradle.plugin/${v}/${id}.gradle.plugin-${v}.pom`,
  /** Gradle module metadata of an artifact on the plugin portal. */
  gradleModule: (g: string, a: string, v: string) => `${REPOS.gradlePlugins}${g.replace(/\./g, "/")}/${a}/${v}/${a}-${v}.module`,
  mavenDistMetadata: meta(REPOS.central, "org.apache.maven:apache-maven"),
  mavenDist: (v: string) => `${artifactBase(REPOS.central, "org.apache.maven:apache-maven")}${v}/apache-maven-${v}-bin.zip`,
  tinyRemapperMetadata: "https://maven.fabricmc.net/net/fabricmc/tiny-remapper/maven-metadata.xml",
  tinyRemapperJar: (v: string) => `https://maven.fabricmc.net/net/fabricmc/tiny-remapper/${v}/tiny-remapper-${v}-fat.jar`,
  vineflowerMetadata: "https://repo1.maven.org/maven2/org/vineflower/vineflower/maven-metadata.xml",
  vineflowerJar: (v: string) => `https://repo1.maven.org/maven2/org/vineflower/vineflower/${v}/vineflower-${v}.jar`,
} as const;
