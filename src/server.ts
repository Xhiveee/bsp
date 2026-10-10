import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Services } from "./services.js";
import { registerTools } from "./tools/registry.js";

export const SERVER_NAME = "bsp";
export const SERVER_VERSION = "0.1.1";

const INSTRUCTIONS = `BSP: real Paper/Spigot server code (NMS, CraftBukkit, API), mappings, NMS checks, builds and docs for Bukkit/Spigot/Paper plugins (1.13+).
- Don't guess versions or dependencies: list_versions, get_profile.
- Prefer API over NMS (docs_search, javadoc). For NMS read code cheaply: search_server_source → get_class outline → get_class method=.
- Names: Mojang in dev (paperweight / Spigot remapped), Spigot at runtime before Paper 1.20.5 / 26.1; translate_mapping converts. Reflection strings are never remapped.
- After NMS changes or before updating Minecraft: nms_validate (targetVersion=). build picks the JDK; analyze_crash explains server logs.
- UNVERIFIED = newer than tested profiles: build to confirm.`;

/** Build the MCP server. Services may be passed lazily (created on the first tool call). */
export function createServer(services: Services | (() => Services | Promise<Services>)): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  let cached: Promise<Services> | undefined;
  registerTools(server, typeof services === "function" ? () => (cached ??= Promise.resolve(services())) : () => services);
  return server;
}
