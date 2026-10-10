# Справочник BSP

## Источники данных (всё вживую, кэш с TTL)

| Что | Откуда |
|---|---|
| Версии и билды Paper, ссылки на jar, `server:mojang` (Mojang-маппинг, ~1.18–1.20.4) | PaperMC Fill v3 `fill.papermc.io/v3/projects/paper` |
| Версии Spigot, коммиты BuildData / CraftBukkit | `hub.spigotmc.org/versions/*.json`, Stash raw (BuildData `info.json`, `mappings/*.csrg`, CraftBukkit `pom.xml`) |
| Java, наличие Mojang-маппингов, server.jar | Mojang version manifest v2 |
| paper-api, dev-bundle, spigot-api, bukkit | `maven-metadata.xml` на repo.papermc.io и hub.spigotmc.org/nexus |
| paperweight-userdev, shadow и их требования (минимальный Gradle, JVM) | Gradle Plugin Portal: marker pom → Gradle module metadata (`org.gradle.plugin.api-version`, `org.gradle.jvm.version`) |
| Документация | архив PaperMC/docs (paper/dev, adventure, folia), посты PaperMC/website (новости релизов), javadoc-индексы jd.papermc.io, hub.spigotmc.org/javadocs, jd.advntr.dev |

Ничего версионного в коде не зашито: всё, что меняется между версиями, — правила в `profiles/*.yaml`.

## Профили

`profiles/paper.yaml`, `profiles/spigot.yaml` (Bukkit API использует профиль Spigot). Каждое правило:

```yaml
- since: "1.20.5"          # с этой версии (until: — по какую, необязательно)
  when: { obfuscated: false } # условие по живым фактам (obfuscated берётся из Mojang/BuildData)
  description: ...
  verified: ["1.21.11"]     # версии, на которых правило проверено сборкой
  set: { ... }              # объекты сливаются, массивы и скаляры заменяются; addNotes дописывает заметки
```

Поля `set`: `java` (`auto` = из Mojang), `api` (группа/артефакт/шаблоны версий/репозиторий), `nms` (`approach`, `devMappings`, `runtimeMappings`, `reobf`, `craftBukkitRelocated`, `versionedNmsPackage`, `gradlePlugin`, `mavenPlugin`, `dependency`, `howTo`), `pluginYml` (`files`, `apiVersion: minor|full`), `gradle`, `maven`, `notes`, `references`.

Версия новее `testedUpTo` или неизвестная Mojang берёт ближайшие нижние правила и помечается `UNVERIFIED`; обфусцированность для неё берётся у последнего известного релиза. Пользовательские файлы из `BSP_PROFILES_DIR` с тем же `platform` дописывают правила в конец (побеждают) и могут поднять `testedUpTo`. Читаются при каждом вызове.

## Индекс сервера

`search_server_source`, `get_class`, `nms_validate` работают по индексу классов (имена, дескрипторы, наследование, байткод-ссылки) и лениво декомпилируют нужные классы Vineflower.

- `source: paper` (по умолчанию для Paper): Paperclip-jar с Fill распаковывается `java -Dpaperclip.patchonly=true` — сервер не запускается, `eula.txt` не создаётся; рабочая папка удаляется после индексации. Содержит NMS + CraftBukkit + API.
- `source: spigot`: вывод BuildTools из `~/.m2` или `BSP_BUILDTOOLS_DIRS` (сам BuildTools BSP не запускает).
- `source: vanilla`: server.jar Mojang + API-jar, переименованный в нужные имена (tiny-remapper). Без CraftBukkit.
- `serverJar`: любой jar (например, системная зависимость проекта).

Имена по умолчанию — те, на которых пишут плагин для этой платформы/версии (`nms.devMappings`): Paper ≤1.16.5 — Spigot, Paper 1.17+ — Mojang, 26.x — Mojang (без обфускации).

Spigot-имена для обфусцированных версий считаются как у BuildTools: BuildData `*-cl.csrg` + `*-members.csrg` + `package.srg`, вложенные классы следуют за внешним, необработанные классы получают пакет `net/minecraft/server[/vX_Y_RZ]`, автоимена SpecialSource (`--auto-member SYNTHETIC/LOGGER/TOKENS`), релокация CraftBukkit из pom.

## Инструменты — детали

- **list_versions** без версии: сводная таблица (Paper, Spigot, spigot-api, paper-api). С версией: Java, обфускация, билд и ссылка Paper, артефакты API/dev-bundle, нужна ли BuildTools, пакет CraftBukkit.
- **get_profile**: конкретные координаты (последние версии из metadata), NMS-подход, версия Gradle по требованиям плагинов, `api-version`; `build: gradle|maven` — готовый сниппет (paperweight, `javaLauncher` для старых dev-bundle, MOJANG_PRODUCTION, SpecialSource-исполнения для Spigot remapped-mojang).
- **translate_mapping**: класс/метод/поле между `mojang`, `spigot`, `obf`; без `from` пробует по очереди. CraftBukkit не маппится — меняется только пакет. Для 26.x — тождественно.
- **nms_validate**: собирает ссылки из `target/classes` / `build/classes` (constant pool, дескрипторы, супертипы), из исходников — импорты и рефлексию (`Class.forName`, `getDeclaredMethod/Field`, шаблоны `"net.minecraft.server." + v + ".X"`). Рефлексия проверяется в runtime-именах (её не ремапит ни reobf, ни SpecialSource). Подсказки: «now …» для пропавших `v1_X_RY`, похожие имена, тот же член в других классах, изменённая сигнатура. CraftBukkit: версионированный пакет против неверсионированного сервера — warn (Paper пока переписывает при загрузке), рефлексия — error.
- **build**: Gradle (wrapper обязателен) или Maven (mvnw → mvn → скачанный Apache Maven). JDK подбирается по профилю, paperweight требует 21+, `--release` у Maven собирает старые цели на JDK 17. Лог — в `<проект>/.bsp/logs`.
- **analyze_crash**: виды находок: compile_error, jvm_mismatch, toolchain_missing, dependency_resolution, build_failure, plugin_load, missing_dependency, api_version, plugin_yml, duplicate_plugin, plugin_error, class_not_found, nms_mismatch, linkage_error, async_access, watchdog, out_of_memory, eula, crash. Виновник — по имени плагина в сообщениях и jar в стеке; если падают несколько независимых плагинов, выводится их список.
- **docs_search**: BM25 по разделам документации; новости фильтруются по версии; javadoc — индексы типов и членов (`Class#member`). URL проверяются.

## Архитектура

`src/tools/registry.ts` — 9 инструментов; схемы (zod) грузятся сразу, реализации — при первом вызове. `src/sources` — живые данные, `src/profiles` — правила, `src/index` — индекс/маппинги/декомпиляция, `src/nms` — сбор и проверка ссылок, `src/diagnostics` — разбор логов, `src/docs` — документация и javadoc.
