/**
 * Tool registry: schemas + descriptions are registered eagerly (cheap); implementations are imported on the first
 * call of each tool, so startup loads only the MCP SDK and zod.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Services } from "../services.js";
import * as S from "./schemas.js";
import { guard } from "./result.js";

type Impl = (services: Services, args: never) => Promise<CallToolResult>;
interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
  readOnly?: boolean;
  load: () => Promise<Impl>;
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_versions",
    title: "List versions",
    description: "Live Paper/Spigot/Bukkit-API versions (1.13+) with Java; with mcVersion: latest Paper build, downloads, API/dev-bundle artifacts, CraftBukkit package.",
    input: S.listVersionsInput,
    load: async () => (await import("./listVersions.js")).listVersions as Impl,
  },
  {
    name: "get_profile",
    title: "Version profile",
    description: "Build facts for (mcVersion, platform): Java, dependencies + repos, NMS approach (paperweight-userdev / BuildTools remapped / versioned package), mappings, plugin.yml, api-version. Optional Gradle/Maven snippet.",
    input: S.getProfileInput,
    load: async () => (await import("./getProfile.js")).getProfile as Impl,
  },
  {
    name: "search_server_source",
    title: "Search server code",
    description: "Search NMS, CraftBukkit and Bukkit/Paper API classes/methods/fields of a version, grep source text (decompiled lazily), or find usages from bytecode. Paged one-line results.",
    input: S.searchInput,
    load: async () => (await import("./source.js")).searchServerSource as Impl,
  },
  {
    name: "get_class",
    title: "Get server class",
    description: "A server/API class: outline (default), one method's source (method=), hierarchy/overrides (detail=hierarchy) or paged full source. Outline first, then method.",
    input: S.getClassInput,
    load: async () => (await import("./source.js")).getClass as Impl,
  },
  {
    name: "translate_mapping",
    title: "Translate names",
    description: "Translate NMS names between Mojang, Spigot and obfuscated for a version; resolves CraftBukkit's versioned package (v1_X_RY) and pre-1.17 net.minecraft.server.v1_X_RY names.",
    input: S.translateInput,
    load: async () => (await import("./source.js")).translateMapping as Impl,
  },
  {
    name: "nms_validate",
    title: "Validate NMS usage",
    description: "Check a plugin's NMS/CraftBukkit references (compiled bytecode, imports, reflection strings) against the real classes of its version or targetVersion; reports missing/changed members with suggestions.",
    input: S.nmsValidateInput,
    load: async () => (await import("./nms.js")).nmsValidate as Impl,
  },
  {
    name: "docs_search",
    title: "Search docs",
    description: "Search Paper docs (incl. Adventure), Paper/Spigot/Adventure javadoc indexes for the version, and Paper release posts. Verified links, short snippets.",
    input: S.docsSearchInput,
    load: async () => (await import("./docs.js")).docsSearch as Impl,
  },
  {
    name: "build",
    title: "Build plugin",
    description: "Run Gradle (gradlew) or Maven (mvnw/mvn) with an auto-picked JDK; returns parsed errors (file:line) and dependency/JVM problems. Log kept on disk.",
    input: S.buildInput,
    readOnly: false,
    load: async () => (await import("./build.js")).build as Impl,
  },
  {
    name: "analyze_crash",
    title: "Analyze server log",
    description: "Explain a server log / crash report: culprit plugin, NMS mismatch (NoSuchMethod/Field, ClassNotFound), missing depend/softdepend, api-version, wrong Java.",
    input: S.analyzeCrashInput,
    load: async () => (await import("./crash.js")).analyzeCrash as Impl,
  },
];

export function registerTools(server: McpServer, getServices: () => Services | Promise<Services>): void {
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.input as never, annotations: { readOnlyHint: t.readOnly ?? true, openWorldHint: true } },
      (async (args: never) => guard(async () => (await t.load())(await getServices(), args))) as never,
    );
  }
}
