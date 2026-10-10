# Проверка

Всё проверено компиляцией и статическим анализом. Ни один сервер Minecraft не запускался, EULA не принималась. Paper-jar распаковывались только с `-Dpaperclip.patchonly=true` (`eula.txt` и `server.properties` не создаются). BuildTools запускался через BSP (`buildtools: true`) для 1.13.2 (1 мин 46 с, JDK 8) и 1.14.3 (1 мин 8 с). BuildTools только собирает jar, `eula.txt` нигде не появился.

## Тестовые плагины (вне репозитория, `/workspace/bsp-verify`)

| Проект | Сборка | NMS | build | nms_validate |
|---|---|---|---|---|
| Paper 1.20.1 | Gradle 9.7.1, paperweight 2.0.0-beta.24, toolchain 17, `javaLauncher` 21, reobfJar | `ServerPlayer`, `CraftPlayer` (v1_20_R1), `connection.latency`, `sendSystemMessage`, `setGlowingTag` | OK | 0 проблем |
| Paper 1.21.11 | Gradle, MOJANG_PRODUCTION, toolchain 21 | то же, CraftBukkit без версии | OK | 0 проблем |
| Paper 26.3 | Gradle, dev-bundle 26.3.build.169-beta, toolchain 25 | то же | OK | 0 проблем |
| Spigot API 1.13.2 | Maven, release 8 | нет | OK | нет NMS |
| Spigot API 1.16.5 + Paper 1.16.5 jar (system) | Maven, release 8 | `net.minecraft.server.v1_16_R3.EntityPlayer`, `ping`, `ChatComponentText`, `SystemUtils` | OK | 0 проблем |
| Spigot API 1.20.4 + Paper 1.20.4 Mojang-jar (system) | Maven, release 17 | Mojang-имена, CraftBukkit v1_20_R3 | OK | 0 проблем + warning «remap before shipping» |
| `org.spigotmc:spigot:1.13.2` из BuildTools (~/.m2) | Maven, release 8 | v1_13_R2 `EntityPlayer`, `ChatComponentText`, `CraftPlayer`; рефлексия: версия через `split` пакета CraftServer, обёртка `nms(String)`, `getDeclaredField("ping")`, `getMethod("sendPacket", nms("Packet"))` | OK | 0 проблем, 13 ссылок; → Paper 1.16.5: 2 ошибки; → Paper 1.20.4: 8 ошибок (включая рефлексию `net.minecraft.server.<version>.*` с подсказками «now …») |

Найденные этой проверкой и исправленные вещи: paperweight 2.0.0-beta.24 требует Gradle 9.7.1 (теперь читается из module metadata); старые dev-bundle требуют JDK 21 для paperweight; CraftBukkit в dev 1.20.1–1.20.4 версионирован (ошибка компиляции подтвердила, nms_validate теперь ловит это в исходниках).

## Реальные open-source плагины (`/workspace/bsp-verify/real`, shallow clone)

| Плагин | Что делали | Результат |
|---|---|---|
| PaperMC/paperweight-test-plugin | build (Gradle 9.4.1, paperweight 2.0.0-beta.21, dev-bundle 26.1.2) + nms_validate + цель 1.21.11 | build OK (84 с, JDK 25); 0 проблем (4 ссылки); к 1.21.11 — 0 проблем |
| koca2000/NoteBlockAPI | build (mvnw, JDK 8) + nms_validate | build OK; NMS-ссылок нет. Неиспользуемые обёртки рефлексии ложных info не дают |
| CryptoMorin/XSeries (5 модулей) | nms_validate по исходникам | ссылок нет, 1 info: `XReflection.java:220`, версия из `Package.getPackages()` — честно не вычисляется |
| tr7zw/Item-NBT-API | nms_validate по исходникам | Сначала модули не находились: spigot-api в родительском POM. **Исправлено** наследованием parent POM. Затем `Class.forName("net.minecraft.nbt.NBTTagCompound")` (проба Forge 1.7.10 в глотающем `try/catch`) давала ложную ошибку. **Исправлено**: такие ссылки теперь warn. Enum-таблица `ClassWrapper` с версионными условиями не разбирается — см. ограничения |
| filoghost/HolographicDisplays (NMS-модули v1_13_r2…v1_20_r3) | nms_validate по исходникам + кросс-версии | Все модули: 0 проблем против своей версии. v1_13_r2 → 1.14.4: ошибка пакета v1_13_R2 ≠ v1_14_R1. v1_19_r3 → 1.20.4 сначала давал 0 проблем: CraftBukkit пропускался, потому что в индексе без BuildTools нет его классов. **Исправлено**: пакет CraftBukkit сверяется по pom CraftBukkit, теперь ошибка v1_19_R3 ≠ v1_20_R3 |

## Spigot-имена 1.13–1.14.3 (BuildData) против настоящего Spigot из BuildTools

| Версия | Классы `net/minecraft` | Методы (без лямбд) |
|---|---|---|
| 1.13.2 | 2 849 / 2 849 | 21 131 / 21 742 (97,2%) |
| 1.14.3 | все, кроме 40 классов генератора данных (`net.minecraft.data`), которых в jar Spigot нет | 24 971 / 26 059 (95,8%) |

Для 1.13.2 исправлен разбор `--auto-synth` (старая BuildData): было 873 расхождения, стало 611.

## nms_validate: поломки и кросс-версии

- Намеренно сломанные ссылки (1.16.5): `Class.forName("...v1_16_R3.EntityPlayerr")` → `class not found`; `getDeclaredField("pingg")` → `not found; similar: ping: int`.
- 1.16.5 → Paper 1.20.4: 7 ошибок — пакет CraftBukkit v1_16_R3 ≠ v1_20_R3, `v1_16_R3.EntityPlayer` → `now net.minecraft.server.level.EntityPlayer`, `SystemUtils` → `net.minecraft.SystemUtils`, сигнатура `CraftPlayer#getHandle` изменилась.
- 1.20.1 → 1.21.11: поле `latency` пропало (подсказка: где оно теперь), CraftBukkit v1_20_R1 — warn.
- 1.20.4 (Mojang) → 1.21.11: 0 ошибок, warn по версионированному CraftBukkit.
- 1.21.11 → 26.3: 0 проблем.

## Остальное

- Индексы: Paper 1.16.5 (Spigot-имена), 1.20.4 (`server:mojang`), 1.21.11, 26.3; vanilla 1.16.5 со Spigot-именами из BuildData.
- translate_mapping: 1.13.2, 1.16.5, 1.20.4, CraftBukkit 1.21.11.
- analyze_crash: логи `test/fixtures/logs` (NMS mismatch, api-version, missing dependency, NoSuchMethodError, EULA) и реальные ошибки сборок выше.
- docs_search: живые страницы docs.papermc.io (URL из `slug`, проверены HTTP 200), новости papermc.io/news, javadoc Paper/Spigot/Adventure. По версиям: `Player#getPing` есть в Spigot 1.17.1 и нет в 1.13.2 (javadoc-jar); в Paper он есть в 1.16.5 и нет в 1.15.2. Якоря JDK 8 (`#setHealthScale-double-`) проверены и для локальных jar, и для jd.papermc.io 1.13.2.
- `npm test`: тесты на сохранённых ответах (без сети): источники, профили, экстраполяция, проверка NMS, анализ рефлексии, разбор логов, определение проектов (включая parent POM), имитация Windows (`mvnw.cmd`/`gradlew.bat` через `cmd.exe`, `java.exe`, корни JDK, пути BuildTools), реестр из 9 инструментов.
