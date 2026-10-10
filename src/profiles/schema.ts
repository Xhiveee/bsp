import { z } from "zod";

/** paper / spigot have profiles; bukkit = the Bukkit API only (resolved through the spigot profile, no NMS). */
export const PLATFORMS = ["paper", "spigot", "bukkit"] as const;
export const PlatformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof PlatformSchema>;
export const PROFILE_PLATFORMS = ["paper", "spigot"] as const;
export type ProfilePlatform = (typeof PROFILE_PLATFORMS)[number];

export const MAPPING_NS = ["mojang", "spigot", "obf"] as const;
export type MappingNs = (typeof MAPPING_NS)[number];

/** How a plugin gets at server internals (NMS / CraftBukkit) for this version. */
export const NMS_APPROACHES = [
  "versioned-package", // pre-1.17: depend on the server jar, NMS in net.minecraft.server.v1_X_RY (Spigot names)
  "paperweight-userdev", // Paper 1.17.1+: Gradle plugin, Mojang names in dev
  "spigot-remapped", // Spigot 1.17+: BuildTools --remapped + SpecialSource (remapped-mojang → obf → spigot)
  "mojang-unobfuscated", // the server itself ships Mojang names: compile against it directly, no remapping
] as const;

const Coord = z
  .object({
    group: z.string(),
    artifact: z.string(),
    /** Version patterns tried in order against the live maven-metadata ("{mc}" = Minecraft version, "*" = any). */
    versions: z.array(z.string()).min(1),
    repository: z.string().url(),
    metadataUrl: z.string().url(),
    classifier: z.string().nullable().optional(),
  })
  .strict();

const PluginRef = z
  .object({
    id: z.string(),
    /** "latest" (from metadataUrl) or a literal version. */
    version: z.string(),
    metadataUrl: z.string().url().optional(),
    versionPrefix: z.string().optional(),
    allowUnstable: z.boolean().optional(),
  })
  .strict();

const NmsSchema = z
  .object({
    approach: z.enum(NMS_APPROACHES),
    /** Names the plugin source is written in. */
    devMappings: z.enum(MAPPING_NS),
    /** Names the server uses at runtime. */
    runtimeMappings: z.enum(MAPPING_NS),
    /** The built jar must be remapped to runtime names (reobfJar / SpecialSource remap-obf+remap-spigot). */
    reobf: z.boolean(),
    /** CraftBukkit lives in org.bukkit.craftbukkit.v1_X_RY (true) or org.bukkit.craftbukkit (false). For Spigot the package comes from CraftBukkit's pom. */
    craftBukkitRelocated: z.boolean(),
    /** NMS classes are in net.minecraft.server.v1_X_RY (pre-1.17). */
    versionedNmsPackage: z.boolean(),
    gradlePlugin: PluginRef.nullable().optional(),
    mavenPlugin: PluginRef.nullable().optional(),
    /** Dependency to compile against internals (Maven local repo after BuildTools, or the dev bundle). */
    dependency: Coord.nullable().optional(),
    howTo: z.string(),
  })
  .strict();

const PluginYmlSchema = z
  .object({
    files: z.array(z.enum(["plugin.yml", "paper-plugin.yml"])).min(1),
    /** api-version form: "minor" (1.20) or "full" (1.20.6 / 26.3). */
    apiVersion: z.enum(["minor", "full"]),
  })
  .strict();

export const ProfileFieldsSchema = z
  .object({
    java: z.union([z.literal("auto"), z.number().int().min(8)]),
    api: Coord,
    nms: NmsSchema,
    pluginYml: PluginYmlSchema,
    gradle: z.object({ version: z.string(), shadow: PluginRef.nullable().optional() }).strict(),
    maven: z.object({ compilerRelease: z.boolean() }).strict(),
    references: z.array(z.string()),
    notes: z.array(z.string()),
  })
  .strict();
export type ProfileFields = z.infer<typeof ProfileFieldsSchema>;

const PartialFields = z
  .object({
    java: ProfileFieldsSchema.shape.java.optional(),
    api: Coord.partial().strict().optional(),
    nms: NmsSchema.partial().strict().optional(),
    pluginYml: PluginYmlSchema.partial().strict().optional(),
    gradle: z.object({ version: z.string(), shadow: PluginRef.nullable() }).partial().strict().optional(),
    maven: z.object({ compilerRelease: z.boolean() }).partial().strict().optional(),
    references: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
    /** Like notes, but appended. */
    addNotes: z.array(z.string()).optional(),
  })
  .strict();
export type PartialProfileFields = z.infer<typeof PartialFields>;

const VersionString = z.string().regex(/^\d+(\.\d+){1,3}$/, "must be a release version like 1.20.4 or 26.3");

export const RuleSchema = z
  .object({
    since: VersionString.optional(),
    until: VersionString.optional(),
    /** Conditions on facts read at runtime from official metadata. */
    when: z
      .object({
        /** The server jar is obfuscated (Spigot BuildData has class mappings / Mojang publishes mappings). */
        obfuscated: z.boolean().optional(),
        /** Mojang publishes ProGuard mappings for this version (1.14.4+ until the game was deobfuscated). */
        mojangMappings: z.boolean().optional(),
      })
      .strict()
      .optional(),
    description: z.string().optional(),
    verified: z.array(z.string()).optional(),
    set: PartialFields,
  })
  .strict();
export type ProfileRule = z.infer<typeof RuleSchema>;

export const ProfileFileSchema = z
  .object({
    platform: z.enum(PROFILE_PLATFORMS),
    minVersion: VersionString,
    testedUpTo: VersionString,
    rules: z.array(RuleSchema).min(1),
  })
  .strict();
export type ProfileFile = z.infer<typeof ProfileFileSchema>;

/** A user file may only add rules (and optionally bump testedUpTo / minVersion). */
export const UserProfileFileSchema = ProfileFileSchema.partial({ minVersion: true, testedUpTo: true });

export interface ResolvedProfile extends Omit<ProfileFields, "java"> {
  platform: ProfilePlatform;
  mcVersion: string;
  java: number;
  obfuscated: boolean;
  basedOn: string;
  matchedRules: string[];
  verified: boolean;
  extrapolated: boolean;
  warnings: string[];
}
