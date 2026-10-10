import { IndexService } from "./index/service.js";
import { loadConfig, type BspConfig } from "./config.js";
import { loadProfiles, type ProfileSet } from "./profiles/loader.js";
import { resolveProfile, type VersionFacts } from "./profiles/resolve.js";
import type { Platform, ResolvedProfile } from "./profiles/schema.js";
import { Notes, VersionService } from "./sources/index.js";
import { CachingFetcher, type Fetcher } from "./util/http.js";

/** Everything the tools need, constructed once per server (injectable for tests). */
export interface Services {
  config: BspConfig;
  versions: VersionService;
  /** Profiles are reloaded on every call so edits to user profiles apply without a restart. */
  profiles(): Promise<ProfileSet>;
  /** Server code indexes (built lazily, cached on disk). */
  indexes: IndexService;
}

export function createServices(opts: { config?: BspConfig; fetcher?: Fetcher } = {}): Services {
  const config = opts.config ?? loadConfig();
  const fetcher = opts.fetcher ?? new CachingFetcher({ cacheDir: config.cacheDir, defaultTtlMs: config.cacheTtlMs, offline: config.offline, userAgent: config.userAgent });
  const services: Services = {
    config,
    versions: new VersionService(fetcher),
    profiles: () => loadProfiles(config.builtinProfilesDir, config.userProfilesDir),
    indexes: undefined as unknown as IndexService,
  };
  services.indexes = new IndexService(services);
  return services;
}

/** Live facts about a Minecraft version: Java (Mojang), Mojang mappings, obfuscation (Spigot BuildData). */
export async function versionFacts(services: Services, mc: string, notes: Notes = new Notes()): Promise<VersionFacts> {
  const facts: VersionFacts = {};
  try {
    const d = await services.versions.mojangVersion(mc, notes);
    if (!d) {
      facts.known = false;
      notes.warn(`Minecraft ${mc} is not in Mojang's version manifest; Java version and obfuscation could not be verified.`);
      return facts;
    }
    Object.assign(facts, { known: true, javaMajor: d.javaMajor, mojangMappings: d.mojangMappings });
    if (d.mojangMappings) facts.obfuscated = true;
  } catch (e) {
    notes.warn(`Could not read Mojang metadata for ${mc}: ${(e as Error).message}`);
  }
  if (facts.obfuscated === undefined) {
    try {
      const bd = await services.versions.buildData(mc, notes);
      if (bd) facts.obfuscated = !!bd.info.classMappings;
    } catch (e) {
      notes.warn(`Could not read Spigot BuildData for ${mc}: ${(e as Error).message}`);
    }
  }
  return facts;
}

export interface ProfileLookup {
  profile: ResolvedProfile;
  release: string;
  facts: VersionFacts;
  notes: Notes;
}

/** Resolve a profile (bukkit → the spigot profile) using live facts. */
export async function lookupProfile(services: Services, platform: Platform, mcVersion: string, notes: Notes = new Notes()): Promise<ProfileLookup> {
  const profiles = await services.profiles();
  const key = platform === "bukkit" ? "spigot" : platform;
  const lp = profiles[key];
  if (!lp) throw new Error(`No profile for platform "${platform}".`);
  const { release, note } = await services.versions.profileVersionFor(mcVersion, notes);
  if (note) notes.warn(note);
  const facts = await versionFacts(services, mcVersion, notes);
  const profile = resolveProfile(lp, release, facts);
  if (release !== mcVersion) profile.mcVersion = mcVersion;
  for (const w of profile.warnings) notes.warn(w);
  return { profile, release, facts, notes };
}
