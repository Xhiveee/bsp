# Справочник BSP

## Источники данных (всё вживую, кэш с TTL)

| Что | Откуда |
|---|---|
| Версии и билды Paper, ссылки на jar, `server:mojang` (Mojang-маппинг, ~1.18–1.20.4) | PaperMC Fill v3 `fill.papermc.io/v3/projects/paper` |
| Версии Spigot, коммиты BuildData / CraftBukkit | `hub.spigotmc.org/versions/*.json`, Stash raw (BuildData `info.json`, `mappings/*.csrg`, CraftBukkit `pom.xml`) |
| Java, наличие Mojang-маппингов, server.jar | Mojang version manifest v2 |
| paper-api, dev-bundle, spigot-api, bukkit | `maven-metadata.xml` на repo.papermc.io и hub.spigotmc.org/nexus |
| paperweight-userdev, shadow и их требования (минимальный Gradle, JVM) | Gradle Plugin Portal: marker pom → Gradle module metadata (`org.gradle.plugin.api-version`, `org.gradle.jvm.version`) |
| Документация | архив PaperMC/docs (paper/dev, adventure, folia), посты PaperMC/website (новости релизов), javadoc-индексы jd.papermc.io (по версиям), javadoc-jar `spigot-api`/`bukkit` `<версия>-R0.1-SNAPSHOT` из hub.spigotmc.org/nexus (по версиям, распаковываются в кэш; иначе hub.spigotmc.org/javadocs — последняя), jd.advntr.dev |

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
- `source: spigot`: вывод BuildTools из `~/.m2` (`spigot-<v>-R0.1-SNAPSHOT[-remapped-mojang].jar`), `BSP_BUILDTOOLS_DIRS` или кэша BSP. С `buildtools: true` и без такого jar BSP запускает официальный BuildTools.jar (Jenkins lastSuccessfulBuild, обновляется раз в неделю): `java -jar BuildTools.jar --rev <v> --output-dir <кэш>/buildtools/out/<v> --nogui [--remapped]`. JDK — новейшая из диапазона `javaVersions` версии SpigotMC. Одновременно идёт один запуск на версию, лог — `<кэш>/buildtools/logs`. BuildTools только собирает jar, сервер не запускается.
- `source: vanilla`: server.jar Mojang + API-jar, переименованный в нужные имена (tiny-remapper). Без CraftBukkit.
- `serverJar`: любой jar (например, системная зависимость проекта).

Имена по умолчанию — те, на которых пишут плагин для этой платформы/версии (`nms.devMappings`): Paper ≤1.16.5 — Spigot, Paper 1.17+ — Mojang, 26.x — Mojang (без обфускации).

Spigot-имена для обфусцированных версий считаются как у BuildTools: BuildData `*-cl.csrg` + `*-members.csrg` + `package.srg`, вложенные классы следуют за внешним, необработанные классы получают пакет `net/minecraft/server[/vX_Y_RZ]`, автоимена SpecialSource (`--auto-member SYNTHETIC/LOGGER/TOKENS`), релокация CraftBukkit из pom.

## Инструменты — детали

- **search_server_source**: `kind: usages` — кто вызывает метод / читает поле / использует класс (байткод, вызовы через подклассы помечены `via`). `kind: callees` (`query: Class#method[(desc)]`) — обратное направление: что метод вызывает (`call`), читает/пишет (`get`/`put`), передаёт как method reference (`ref`); тела лямбд того же класса раскрываются и помечаются `(lambda)`; без дескриптора перегрузки группируются (до 5). `kind: packages` (`query`: пакет, уникальный хвост вроде `craftbukkit.entity` или `.` — корень) — подпакеты с числом классов, затем классы пакета с пометками `interface`/`enum`/`record`/`abstract`, 100 на страницу. Имена — те же, что у индекса (Mojang/Spigot, `v1_X_RY`).

- **list_versions** без версии: сводная таблица (Paper, Spigot, spigot-api, paper-api). С версией: Java, обфускация, билд и ссылка Paper, артефакты API/dev-bundle, нужна ли BuildTools, пакет CraftBukkit.
- **get_profile**: конкретные координаты (последние версии из metadata), NMS-подход, версия Gradle по требованиям плагинов, `api-version`; `build: gradle|maven` — готовый сниппет (paperweight, `javaLauncher` для старых dev-bundle, MOJANG_PRODUCTION, SpecialSource-исполнения для Spigot remapped-mojang).
- **translate_mapping**: класс/метод/поле между `mojang`, `spigot`, `obf`; без `from` пробует по очереди. CraftBukkit не маппится — меняется только пакет. Для 26.x — тождественно.
- **nms_validate**: собирает ссылки из `target/classes` / `build/classes` (constant pool, дескрипторы, супертипы), из исходников — импорты и рефлексию. Исходники разбираются java-parser (CST), выражения вычисляет абстрактный интерпретатор: строки, конкатенация, `StringBuilder`, `String.format/join/valueOf`, `split/substring/replace`, константы и поля (включая присваивания в конструкторах и static-блоках), тернарники (варианты = альтернативы: достаточно, чтобы прошёл один), обёртки (метод, строящий имя из параметра, распознаётся по телу), `MethodHandles.Lookup.find*`, `getMethod/getField/getDeclared*`, `Bukkit.getServer().getClass().getPackage()` → версия. В байткоде читаются рецепты `invokedynamic` string concat. Вызовы библиотек (`getNMSClass`, `getCraftClass`, XSeries/MinecraftReflection) дают «мягкие» ссылки (warn). Ссылки внутри `try/catch`, который глотает ошибку, тоже дают warn. Невычислимые имена выводятся как info. Maven-модули наследуют зависимости и dependencyManagement родительского POM. Рефлексия проверяется в runtime-именах (её не ремапит ни reobf, ни SpecialSource). Подсказки: «now …» для пропавших `v1_X_RY`, похожие имена, тот же член в других классах, изменённая сигнатура. CraftBukkit: версионированный пакет против неверсионированного сервера — warn (Paper пока переписывает при загрузке), рефлексия — error.
- **build**: Gradle (wrapper обязателен) или Maven (mvnw → mvn → скачанный Apache Maven). JDK подбирается по профилю, paperweight требует 21+, `--release` у Maven собирает старые цели на JDK 17. Лог — в `<проект>/.bsp/logs`.
- **analyze_crash**: виды находок: compile_error, jvm_mismatch, toolchain_missing, dependency_resolution, build_failure, plugin_load, missing_dependency, api_version, plugin_yml, duplicate_plugin, plugin_error, class_not_found, nms_mismatch, linkage_error, async_access, watchdog, out_of_memory, eula, crash. Виновник — по имени плагина в сообщениях и jar в стеке; если падают несколько независимых плагинов, выводится их список.
- **docs_search**: BM25 по разделам документации; новости фильтруются по версии; javadoc — индексы типов и членов (`Class#member`), для JDK 8 — `index-all.html`; якоря старого вида (`m-int-`) подставляются по странице. Если запрос — идентификатор API, javadoc выводится первым, а статей — не больше двух. URL проверяются.

## Архитектура

`src/tools/registry.ts` — 9 инструментов; схемы (zod) грузятся сразу, реализации — при первом вызове. `src/sources` — живые данные, `src/profiles` — правила, `src/index` — индекс/маппинги/декомпиляция, `src/nms` — сбор и проверка ссылок, `src/diagnostics` — разбор логов, `src/docs` — документация и javadoc.
