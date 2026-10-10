# BSP

MCP-сервер для разработки плагинов Bukkit / Spigot / Paper (1.13 → новейшая версия): настоящие классы сервера (NMS, CraftBukkit, API), маппинги, проверка NMS-ссылок, сборка, разбор логов и документация для AI-агента.

## Требования

- Node.js 20+.
- JDK 17+ для индекса исходников (декомпиляция, ремаппинг). Для сборки плагинов нужна JDK под версию Minecraft (8 / 17 / 21 / 25). BSP сам находит установленные JDK; если они лежат в нестандартном месте, задайте `BSP_JDKS`.
- Maven ставить не нужно: если в проекте нет `mvnw` и в PATH нет `mvn`, BSP скачает Apache Maven с Maven Central в кэш. Для Gradle нужен wrapper в проекте.
- Сервер Minecraft BSP никогда не запускает и EULA не принимает. Paper-jar только распаковывается (`-Dpaperclip.patchonly=true`).
- Для настоящего Spigot (CraftBukkit + патчи) без ручного BuildTools: `buildtools: true` в `search_server_source` / `get_class` / `nms_validate`. BSP один раз запустит официальный BuildTools (5–15 мин, нужна JDK из диапазона версии и git; на Windows git он скачивает сам), результат кэшируется. Готовый вывод BuildTools в `~/.m2` (в том числе `remapped-mojang`) подхватывается автоматически.

## Установка

```sh
git clone https://github.com/Xhiveee/bsp.git
cd bsp
npm install
npm run build      # → dist/index.js
npm test           # необязательно
```

## Подключение к MCP-клиенту

BSP работает через stdio. В любом клиенте укажите команду `node` и **абсолютный** путь к `dist/index.js`:

```json
{
  "mcpServers": {
    "bsp": {
      "command": "node",
      "args": ["/home/you/bsp/dist/index.js"],
      "env": { "BSP_OFFLINE": "0" }
    }
  }
}
```

Блок `env` можно не указывать. На Windows путь пишется так: `"args": ["C:\\Users\\you\\bsp\\dist\\index.js"]`.

**Cursor:** файл `.cursor/mcp.json` в проекте или `~/.cursor/mcp.json` для всех проектов.

```json
{ "mcpServers": { "bsp": { "type": "stdio", "command": "node", "args": ["/home/you/bsp/dist/index.js"] } } }
```

**Claude Desktop:** Settings → Developer → Edit Config. Это файл `~/Library/Application Support/Claude/claude_desktop_config.json` на macOS или `%APPDATA%\Claude\claude_desktop_config.json` на Windows. Формат `mcpServers` такой же, как выше. После правки полностью перезапустите приложение.

**Claude Code:**

```sh
claude mcp add --transport stdio --scope user bsp -- node /home/you/bsp/dist/index.js
```

**VS Code (Copilot):** файл `.vscode/mcp.json`. Обратите внимание: здесь ключ `servers`, а не `mcpServers`.

```json
{ "servers": { "bsp": { "type": "stdio", "command": "node", "args": ["/home/you/bsp/dist/index.js"] } } }
```

**Codex CLI:** выполните `codex mcp add bsp -- node /home/you/bsp/dist/index.js` или добавьте сервер в `~/.codex/config.toml`:

```toml
[mcp_servers.bsp]
command = "node"
args = ["/home/you/bsp/dist/index.js"]
# env = { BSP_OFFLINE = "1" }
```

FFN и BSP можно подключить одновременно — это независимые серверы.

## Переменные окружения

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `BSP_CACHE_DIR` | Кэш: версии, jar-файлы, индексы, документация | `~/.cache/bsp`; macOS `~/Library/Caches/bsp`; Windows `%LOCALAPPDATA%\bsp` |
| `BSP_PROFILES_DIR` | Пользовательские профили версий | `~/.config/bsp/profiles`; macOS `~/Library/Application Support/bsp/profiles`; Windows `%APPDATA%\bsp\profiles` |
| `BSP_OFFLINE` | `1` или `true`: только кэш, без сети | выключено |
| `BSP_CACHE_TTL_MINUTES` | Как долго кэшированные списки версий считаются свежими | `360` |
| `BSP_JDKS` | Дополнительные JDK (пути через `:`, на Windows через `;`) | — |
| `BSP_MAVEN_LOCAL` | Локальный Maven-репозиторий (ищет вывод BuildTools) | `~/.m2/repository` |
| `BSP_BUILDTOOLS_DIRS` | Папки с `spigot-<версия>.jar` от BuildTools | — |
| `GITHUB_TOKEN` | Повышает лимит запросов к GitHub для `docs_search` | — |

## Инструменты (9)

- `list_versions` (`mcVersion?`) — версии Paper / Spigot / API с Java; с `mcVersion` — билд Paper, артефакты API и dev-bundle, пакет CraftBukkit, нужна ли BuildTools.
- `get_profile` (`mcVersion`, `platform`, `build?`) — как собрать плагин: Java, зависимости, NMS-подход (paperweight / remapped-mojang / v1_X_RY), версия Gradle, api-version, готовый `build.gradle.kts` или `pom.xml`.
- `search_server_source` (`query`, `kind`: имена / `text` / `usages` / `callees` / `packages`, `mcVersion` или `projectDir`) — поиск по классам сервера (NMS, CraftBukkit, API), кто вызывает метод (`usages`) и что вызывает он сам (`callees`), обзор пакета: подпакеты и классы (`packages`, `query: "."` — корень).
- `get_class` (`className`, `method?`, `detail`: `outline` / `hierarchy` / `full`) — класс кратко, исходник одного метода, иерархия или полный исходник постранично.
- `translate_mapping` (`mcVersion`, `name`, `from?`) — Mojang ↔ Spigot ↔ obf, перенос `v1_X_RY`-пакетов и CraftBukkit.
- `nms_validate` (`projectDir`, `targetVersion?`, `buildtools?`) — проверяет NMS/CraftBukkit-ссылки плагина по реальному серверу: байткод, импорты и рефлексию (Java-парсер + интерпретатор строк: версия из пакета CraftServer, конкатенация, StringBuilder, String.format, константы, обёртки вроде `getNMSClass`, `MethodHandles`, XSeries/MinecraftReflection). С `targetVersion` показывает, что сломается при обновлении. Имена, которые нельзя вычислить статически, выводятся как info, а не как ошибки.
- `docs_search` (`query`, `platform?`, `mcVersion?`, `topic?`) — документация Paper / Adventure / Folia, javadoc по версиям (Paper — jd.papermc.io, Spigot/Bukkit — javadoc-jar из репозитория SpigotMC), Adventure, новости релизов Paper. На запрос вида `Player#getPing` javadoc выводится первым.
- `build` (`projectDir`, `tasks?`) — Gradle или Maven с подходящей JDK; ошибки в виде `файл:строка`, список собранных jar.
- `analyze_crash` (`log`, `path` или `serverDir`) — разбирает лог сервера, крэш или вывод сборки: причина, плагин-виновник, как исправить.

Проект указывается через `projectDir` (Maven или Gradle, многомодульные сборки поддерживаются). Платформу, версию и маппинги BSP определяет по файлам сборки и `plugin.yml`.

## Профиль для новой версии Minecraft

Обычно ничего делать не нужно: версии, билды и артефакты берутся вживую у PaperMC, SpigotMC и Mojang; новые версии подхватываются автоматически с предупреждением `UNVERIFIED`. Если что-то действительно изменилось, положите YAML-файл в `BSP_PROFILES_DIR`, например `paper-27.1.yaml`:

```yaml
platform: paper
testedUpTo: "27.1"
rules:
  - since: "27.1"
    set: { java: 25, pluginYml: { apiVersion: full } }
```

Перезапускать сервер не нужно. Формат правил описан в [docs/reference.md](docs/reference.md#профили).

## Шаблон AGENTS.md

Готовые правила для агента: без JavaDoc и комментариев, плоская структура, проверка API через этот MCP, сборка, коммит и версия после каждой фичи. Скопируй [templates/AGENTS.md](templates/AGENTS.md) в корень своего проекта (для Claude Code назови `CLAUDE.md`):

```
curl -o AGENTS.md https://raw.githubusercontent.com/Xhiveee/bsp/main/templates/AGENTS.md
```

## Подробнее

- [docs/reference.md](docs/reference.md) — как работают инструменты, источники данных, профили.
- [docs/limitations.md](docs/limitations.md) — известные ограничения.
- [docs/verification.md](docs/verification.md) — что и как проверялось.
- [docs/token-economy.md](docs/token-economy.md) — замеры токенов.

## English (short)

BSP is an MCP (stdio) server for Bukkit/Spigot/Paper plugin development, 1.13 → latest: real server classes (NMS, CraftBukkit, API; real Spigot via opt-in BuildTools), Mojang ↔ Spigot mappings, NMS/reflection reference checks across versions, Gradle/Maven builds, log/crash analysis and Paper/Spigot/Adventure docs. Version data is live; profiles are declarative YAML with version-range rules. It never starts a Minecraft server and never accepts the EULA. Install: `git clone https://github.com/Xhiveee/bsp.git && cd bsp && npm install && npm run build`, then point your MCP client at `node /abs/path/bsp/dist/index.js`. Requires Node 20+ and a JDK 17+. Details in [docs/](docs/reference.md).

Лицензия: MIT.
