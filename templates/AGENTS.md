# AGENTS.md

Minecraft server plugin (Bukkit / Spigot / Paper).

## Code
- No JavaDoc, no comments. Only exception: one line explaining WHY for a non-obvious hack or workaround.
- Clear names instead of comments. No speculative abstractions, interfaces or factories.
- Don't touch code unrelated to the task.
- No new dependencies unless required; shade and relocate the ones you add.

## Structure
- Flat structure. Never create a package for one or two classes.
- Add packages only when there are many classes of one kind (`command/`, `listener/`, `gui/`, `manager/`).
- Small related types (records, enums, nested classes) may share a file.
- Keep the project's existing structure.

## Server API
- Never guess Bukkit, Paper, CraftBukkit or NMS names. Verify with the BSP MCP: `search_server_source`, `get_class`, `docs_search`.
- Read the server platform and version from project files (`pom.xml`, `build.gradle`, `plugin.yml`). Don't change them unless asked.
- Use the Bukkit/Paper API first. Use NMS only when the API can't do it; validate with `nms_validate`.
- On Paper use Paper API (Adventure components, Paper events) where it exists; keep Spigot compatibility only if the project targets Spigot.
- Never call the Bukkit API off the main thread. Use the scheduler for async work and sync back for world/player access.
- Keep `plugin.yml` in sync: commands, permissions, `api-version`, dependencies.
- Messages and settings go in `config.yml` / message files, not hardcoded, unless trivial.

## Verification
- After changes, build (`mvn package` or `gradlew build`) and fix all compile errors. On failure use `analyze_crash`.
- Don't start a server unless asked.

## Git
- After every finished feature or fix: build passes, then commit with a short message.
- Bump the version in `pom.xml` / `build.gradle`: fix 1.0.0 -> 1.0.1, feature 1.0.0 -> 1.1.0.
- Never push, rewrite history or delete branches unless asked.

## Replies
- Short: what changed, which files, does it build. Don't restate the code.
