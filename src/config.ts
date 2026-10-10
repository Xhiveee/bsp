import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the installed BSP package (contains profiles/). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function defaultConfigHome(): string {
  if (process.platform === "win32") return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

function defaultCacheHome(): string {
  if (process.platform === "win32") return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches");
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

export interface BspConfig {
  /** Built-in profiles shipped with BSP. */
  builtinProfilesDir: string;
  /** User profiles: override / extend built-ins without touching code. */
  userProfilesDir: string;
  cacheDir: string;
  /** TTL for mutable version indexes (manifests, maven-metadata). */
  cacheTtlMs: number;
  /** Never touch the network; serve from cache only. */
  offline: boolean;
  userAgent: string;
  /** Local Maven repository (BuildTools installs org.spigotmc:spigot here). */
  mavenLocal: string;
  /** Extra directories with BuildTools output jars (spigot-<mc>.jar). */
  buildToolsDirs: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BspConfig {
  const ttlMin = Number(env.BSP_CACHE_TTL_MINUTES ?? "360");
  return {
    builtinProfilesDir: path.join(PACKAGE_ROOT, "profiles"),
    userProfilesDir: env.BSP_PROFILES_DIR ?? path.join(defaultConfigHome(), "bsp", "profiles"),
    cacheDir: env.BSP_CACHE_DIR ?? path.join(defaultCacheHome(), "bsp"),
    cacheTtlMs: (Number.isFinite(ttlMin) && ttlMin >= 0 ? ttlMin : 360) * 60_000,
    offline: env.BSP_OFFLINE === "1" || env.BSP_OFFLINE === "true",
    userAgent: env.BSP_USER_AGENT ?? "BSP-MCP/0.2 (Bukkit/Spigot/Paper plugin dev MCP server; +https://github.com/Xhiveee/bsp)",
    mavenLocal: env.BSP_MAVEN_LOCAL ?? path.join(os.homedir(), ".m2", "repository"),
    buildToolsDirs: (env.BSP_BUILDTOOLS_DIRS ?? "").split(path.delimiter).filter(Boolean),
  };
}
