import { parseMavenMetadata } from "../util/maven.js";
import { HttpError, type Fetcher, type FetchResult } from "../util/http.js";
import { compareLooseVersions, isReleaseVersion, isUnstableArtifactVersion, parseMcVersion } from "../util/mcversion.js";
import { ENDPOINTS } from "./endpoints.js";
import { type MojangManifest, type MojangVersionDetails, parseMojangManifest, parseMojangVersionDetails } from "./mojang.js";
import { parseFillBuild, parseFillProject, parseFillVersion, type PaperBuild, type PaperVersionInfo } from "./paper.js";
import { parseBuildDataInfo, parseCraftBukkitPom, parseSpigotIndex, parseSpigotVersion, type BuildDataInfo, type CraftBukkitPom, type SpigotVersionJson } from "./spigot.js";

/** Collects non-fatal problems (stale cache, missing artifacts) for the tool response. */
export class Notes {
  readonly warnings: string[] = [];
  readonly sources = new Set<string>();
  warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }
}

const IMMUTABLE = Number.POSITIVE_INFINITY;

/**
 * Live version data from official sources (Mojang, PaperMC Fill, Spigot hub/Stash, Maven repos), always through the
 * caching Fetcher. Nothing about specific versions is hardcoded.
 */
export class VersionService {
  constructor(private readonly fetcher: Fetcher) {}

  private async get(url: string, notes?: Notes, ttlMs?: number): Promise<string> {
    const r: FetchResult = await this.fetcher.getText(url, ttlMs !== undefined ? { ttlMs } : {});
    notes?.sources.add(url);
    if (r.warning) notes?.warn(r.warning);
    return r.body;
  }

  /** Like get(), but 404 → undefined. */
  private async opt(url: string, notes?: Notes, ttlMs?: number): Promise<string | undefined> {
    try {
      return await this.get(url, notes, ttlMs);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return undefined;
      throw e;
    }
  }

  /** Raw text of any endpoint through the cache (404 → undefined). */
  text(url: string, notes?: Notes, ttlMs?: number): Promise<string | undefined> {
    return this.opt(url, notes, ttlMs);
  }

  // ---------------- Mojang ----------------
  async mojangManifest(notes?: Notes): Promise<MojangManifest> {
    return parseMojangManifest(await this.get(ENDPOINTS.mojangManifest, notes));
  }

  async mojangVersion(mc: string, notes?: Notes): Promise<MojangVersionDetails | undefined> {
    const entry = (await this.mojangManifest(notes)).versions.find((v) => v.id === mc);
    if (!entry) return undefined;
    return parseMojangVersionDetails(await this.get(entry.url, notes, IMMUTABLE));
  }

  /** Map any Mojang version id to the release whose profile rules apply. */
  async profileVersionFor(mc: string, notes?: Notes): Promise<{ release: string; note?: string }> {
    if (isReleaseVersion(mc)) return { release: mc };
    const parsed = parseMcVersion(mc);
    if (parsed) {
      const rel = parsed.release.join(".");
      return { release: rel, note: `${mc} is a pre-release of ${rel}; using the ${rel} profile.` };
    }
    const manifest = await this.mojangManifest(notes);
    const entry = manifest.versions.find((v) => v.id === mc);
    if (!entry) throw new Error(`Unknown Minecraft version "${mc}" (not in Mojang's version manifest).`);
    const release = manifest.versions.filter((v) => v.type === "release" && v.releaseTime <= entry.releaseTime).sort((a, b) => b.releaseTime.localeCompare(a.releaseTime))[0];
    if (!release) throw new Error(`Cannot place snapshot ${mc} relative to any release.`);
    return { release: release.id, note: `${mc} is a snapshot; using the profile of the latest release before it (${release.id}).` };
  }

  // ---------------- Paper (Fill v3) ----------------
  async paperVersions(notes?: Notes): Promise<string[]> {
    return parseFillProject(await this.get(ENDPOINTS.fillProject, notes));
  }

  async paperVersion(mc: string, notes?: Notes): Promise<PaperVersionInfo | undefined> {
    const t = await this.opt(ENDPOINTS.fillVersion(mc), notes);
    return t ? parseFillVersion(t) : undefined;
  }

  async paperLatestBuild(mc: string, notes?: Notes): Promise<PaperBuild | undefined> {
    const t = await this.opt(ENDPOINTS.fillLatestBuild(mc), notes);
    return t ? parseFillBuild(t) : undefined;
  }

  // ---------------- Spigot (BuildTools data) ----------------
  async spigotVersions(notes?: Notes): Promise<string[]> {
    return parseSpigotIndex(await this.get(ENDPOINTS.spigotVersionsIndex, notes));
  }

  async spigotVersion(mc: string, notes?: Notes): Promise<SpigotVersionJson | undefined> {
    const t = await this.opt(ENDPOINTS.spigotVersion(mc), notes);
    return t ? parseSpigotVersion(t) : undefined;
  }

  /** BuildData info.json at the commit BuildTools uses for this version. */
  async buildData(mc: string, notes?: Notes): Promise<{ info: BuildDataInfo; commit: string } | undefined> {
    const v = await this.spigotVersion(mc, notes);
    const commit = v?.refs.BuildData;
    if (!commit) return undefined;
    const t = await this.opt(ENDPOINTS.stashRaw("builddata", "info.json", commit), notes, IMMUTABLE);
    return t ? { info: parseBuildDataInfo(t), commit } : undefined;
  }

  /** CraftBukkit's versioned package (e.g. 1_20_R3) and shade relocations for a Spigot version. */
  async craftBukkit(mc: string, notes?: Notes): Promise<CraftBukkitPom | undefined> {
    const v = await this.spigotVersion(mc, notes);
    const commit = v?.refs.CraftBukkit;
    if (!commit) return undefined;
    const t = await this.opt(ENDPOINTS.stashRaw("craftbukkit", "pom.xml", commit), notes, IMMUTABLE);
    return t ? parseCraftBukkitPom(t) : undefined;
  }

  async buildDataFile(commit: string, file: string, notes?: Notes): Promise<string | undefined> {
    return this.opt(ENDPOINTS.stashRaw("builddata", `mappings/${file}`, commit), notes, IMMUTABLE);
  }

  // ---------------- Maven ----------------
  /** All versions in a maven-metadata.xml (as published). */
  async mavenVersions(metadataUrl: string, notes?: Notes): Promise<string[]> {
    const t = await this.opt(metadataUrl, notes);
    return t ? parseMavenMetadata(t).versions : [];
  }

  /** Newest version from a maven-metadata.xml, optionally by prefix and stability. */
  async latestMaven(metadataUrl: string, opts: { prefix?: string; allowUnstable?: boolean } = {}, notes?: Notes): Promise<string | undefined> {
    return (await this.mavenVersions(metadataUrl, notes))
      .filter((v) => (opts.prefix ? v.startsWith(opts.prefix) : true))
      .filter((v) => opts.allowUnstable || !isUnstableArtifactVersion(v))
      .sort((a, b) => compareLooseVersions(b, a))[0];
  }

  /**
   * What a Gradle plugin version needs, from its published Gradle module metadata: the minimum Gradle
   * (org.gradle.plugin.api-version) and the minimum JVM Gradle must run on (org.gradle.jvm.version).
   */
  async gradlePluginNeeds(id: string, version: string, notes?: Notes): Promise<{ gradle?: string; jvm?: number } | undefined> {
    const pom = await this.opt(ENDPOINTS.gradlePluginMarker(id, version), notes, IMMUTABLE);
    const dep = pom && /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>\s*<version>([^<]+)<\/version>/.exec(pom);
    if (!dep) return undefined;
    const mod = await this.opt(ENDPOINTS.gradleModule(dep[1]!, dep[2]!, dep[3]!), notes, IMMUTABLE);
    if (!mod) return undefined;
    try {
      const j = JSON.parse(mod) as { variants?: { attributes?: Record<string, unknown> }[] };
      const libs = (j.variants ?? []).map((v) => v.attributes ?? {}).filter((a) => a["org.gradle.category"] === "library");
      const gradle = libs.map((a) => a["org.gradle.plugin.api-version"]).filter((x): x is string => typeof x === "string").sort(compareLooseVersions)[0];
      const jvm = libs.map((a) => a["org.gradle.jvm.version"]).filter((x): x is number => typeof x === "number").sort((a, b) => a - b)[0];
      return { gradle, jvm };
    } catch {
      return undefined;
    }
  }

  /** File name of the main jar of a -SNAPSHOT version (timestamped), or the plain name for releases. */
  async jarFileName(repo: string, ga: string, version: string, classifier?: string, notes?: Notes): Promise<string> {
    const artifact = ga.split(":")[1]!;
    if (!version.endsWith("-SNAPSHOT")) return `${artifact}-${version}${classifier ? `-${classifier}` : ""}.jar`;
    const xml = await this.opt(ENDPOINTS.snapshotMetadata(repo, ga, version), notes);
    if (xml) {
      const vals = [...xml.matchAll(/<snapshotVersion>([\s\S]*?)<\/snapshotVersion>/g)].map((m) => m[1]!);
      const hit = vals.find((b) => /<extension>jar<\/extension>/.test(b) && (classifier ? b.includes(`<classifier>${classifier}</classifier>`) : !/<classifier>/.test(b)));
      const value = hit && /<value>([^<]+)<\/value>/.exec(hit)?.[1];
      if (value) return `${artifact}-${value}${classifier ? `-${classifier}` : ""}.jar`;
    }
    return `${artifact}-${version}${classifier ? `-${classifier}` : ""}.jar`;
  }
}
