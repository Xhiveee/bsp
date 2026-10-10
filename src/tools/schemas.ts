/**
 * Tool input schemas (zod only), kept apart from implementations so tools/list needs no implementation code.
 * Descriptions are short on purpose: they are sent to the model with every request.
 */
import { z } from "zod";
import { PlatformSchema } from "../profiles/schema.js";

const NS = ["mojang", "spigot", "obf"] as const;
const offset = z.number().int().min(0).max(1e6).optional().describe("Paging offset.");

export const indexSpecShape = {
  mcVersion: z.string().optional().describe("Minecraft version (optional with projectDir)."),
  platform: PlatformSchema.optional().describe("Default paper (or the project's)."),
  mappings: z.enum(NS).optional().describe("Default: the project's dev names, else mojang (1.14.4+) / spigot (older)."),
  source: z.enum(["auto", "paper", "spigot", "vanilla"]).optional().describe("paper: Paper server jar (NMS+CraftBukkit+API). spigot: local BuildTools jar. vanilla: Mojang server + API jar, no CraftBukkit. auto: by platform."),
  serverJar: z.string().optional().describe("Index this server jar instead (BuildTools output, Paper jar)."),
  projectDir: z.string().optional().describe("Plugin project: version, platform, names from its build files."),
};

export const listVersionsInput = {
  mcVersion: z.string().optional().describe("Details for this version: builds, artifacts, Java, NMS package."),
  includeSnapshots: z.boolean().optional().describe("Include pre-releases."),
  limit: z.number().int().min(1).max(500).optional().describe("Default 40."),
};

export const getProfileInput = {
  mcVersion: z.string().describe("e.g. 1.16.5, 1.20.4, 1.21.11, 26.3"),
  platform: PlatformSchema,
  build: z.enum(["gradle", "maven"]).optional().describe("Add a build snippet for this build tool."),
  verbose: z.boolean().optional().describe("Add matched rules and references."),
};

export const searchInput = {
  ...indexSpecShape,
  query: z.string().min(1).describe("Name fragment or /regex/. text: regex over source lines. usages: Class, Class#method[(desc)] or Class#field."),
  kind: z.enum(["any", "class", "method", "field", "text", "usages"]).optional().describe("any (default): names. text: grep sources (lazy decompile). usages: callers/readers from bytecode."),
  limit: z.number().int().min(1).max(200).optional().describe("Default 30."),
  offset,
};

export const getClassInput = {
  ...indexSpecShape,
  className: z.string().describe("FQN, internal or simple name; inner classes with . or $."),
  method: z.string().optional().describe('Only this method\'s source: name ("tick", "<init>") or name(desc). Overloads max 5.'),
  detail: z.enum(["outline", "hierarchy", "full"]).optional().describe("outline (default): signatures. hierarchy: supers, interfaces, subtypes (+ overrides with method). full: paged source."),
  members: z.array(z.enum(["fields", "methods", "inner"])).optional(),
  memberFilter: z.string().optional().describe("Outline: name contains."),
  inherited: z.boolean().optional().describe("Outline: add supertype members."),
  descriptors: z.boolean().optional().describe("Outline: name(desc) (default) or false = Java signatures."),
  offset,
  limit: z.number().int().min(1).max(2000).optional().describe("Outline members (200) / full lines (300)."),
};

export const translateInput = {
  mcVersion: z.string(),
  name: z.string().describe("Class (a.b.C, simple name, v1_16_R3.EntityPlayer, org.bukkit.craftbukkit[.vX_Y_RZ].X), member (Owner#name[(desc)]) or bare member name."),
  from: z.enum(NS).optional().describe("Namespace of name (default: first that matches: mojang, spigot, obf)."),
  to: z.enum(NS).optional().describe("Highlight this namespace."),
  kind: z.enum(["class", "field", "method"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

export const nmsValidateInput = {
  projectDir: z.string().describe("Plugin project (Maven or Gradle; multi-module: every module)."),
  targetVersion: z.string().optional().describe("Check against this Minecraft version instead of the project's (what breaks on update)."),
  targetPlatform: PlatformSchema.optional().describe("Server the plugin runs on (default: the project's)."),
  mappings: z.enum(NS).optional().describe("Names to check in (default: the project's dev names)."),
  serverJar: z.string().optional().describe("Check against this server jar."),
  include: z.array(z.enum(["bytecode", "source"])).optional().describe("Default both (bytecode only if compiled)."),
  limit: z.number().int().min(1).max(500).optional().describe("Problems shown (default 40)."),
};

export const buildInput = {
  projectDir: z.string().describe("Plugin project (Gradle or Maven)."),
  tasks: z.array(z.string()).optional().describe('Gradle tasks / Maven goals. Default ["build"] / ["package"].'),
  args: z.array(z.string()).optional().describe("Extra args, e.g. --offline, -DskipTests."),
  javaHome: z.string().optional().describe("Force a JDK (default: auto-picked)."),
  timeoutSec: z.number().int().positive().max(7200).optional().describe("Default 1200."),
};

export const analyzeCrashInput = {
  log: z.string().optional().describe("Pasted server log / crash report / build output."),
  path: z.string().optional().describe("Log or crash report file."),
  serverDir: z.string().optional().describe("Server folder: newest crash-reports/*.txt, else logs/latest.log."),
  limit: z.number().int().min(1).max(200).optional().describe("Default 20, errors first."),
  offset,
};

export const docsSearchInput = {
  query: z.string().min(2),
  platform: PlatformSchema.optional().describe("Default: from projectDir, else all."),
  mcVersion: z.string().optional().describe("Javadoc/docs version. Default: from projectDir, else latest."),
  projectDir: z.string().optional(),
  kinds: z.array(z.enum(["docs", "javadoc", "news"])).optional().describe("docs (Paper/Adventure docs), javadoc (Paper/Spigot/Adventure API index), news (Paper release posts). Default all."),
  topic: z.string().optional().describe("e.g. adventure, commands, nms, plugin-yml, scheduler, folia."),
  limit: z.number().int().min(1).max(25).optional().describe("Default 6."),
  includeCode: z.boolean().optional().describe("Default true."),
  verifyUrls: z.boolean().optional().describe("Default true."),
};

type Shape = Record<string, z.ZodType>;
export type Args<S extends Shape> = z.infer<z.ZodObject<S>>;
