# Проверка

Всё проверено компиляцией и статическим анализом; ни один сервер Minecraft не запускался, EULA не принималась. Paper-jar распаковывались только `-Dpaperclip.patchonly=true` (`eula.txt`/`server.properties` не создаются).

## Тестовые плагины (вне репозитория, `/workspace/bsp-verify`)

| Проект | Сборка | NMS | build | nms_validate |
|---|---|---|---|---|
| Paper 1.20.1 | Gradle 9.7.1, paperweight 2.0.0-beta.24, toolchain 17, `javaLauncher` 21, reobfJar | `ServerPlayer`, `CraftPlayer` (v1_20_R1), `connection.latency`, `sendSystemMessage`, `setGlowingTag` | OK | 0 проблем |
| Paper 1.21.11 | Gradle, MOJANG_PRODUCTION, toolchain 21 | то же, CraftBukkit без версии | OK | 0 проблем |
| Paper 26.3 | Gradle, dev-bundle 26.3.build.169-beta, toolchain 25 | то же | OK | 0 проблем |
| Spigot API 1.13.2 | Maven, release 8 | нет | OK | нет NMS |
| Spigot API 1.16.5 + Paper 1.16.5 jar (system) | Maven, release 8 | `net.minecraft.server.v1_16_R3.EntityPlayer`, `ping`, `ChatComponentText`, `SystemUtils` | OK | 0 проблем |
| Spigot API 1.20.4 + Paper 1.20.4 Mojang-jar (system) | Maven, release 17 | Mojang-имена, CraftBukkit v1_20_R3 | OK | 0 проблем + warning «remap before shipping» |

Найденные этой проверкой и исправленные вещи: paperweight 2.0.0-beta.24 требует Gradle 9.7.1 (теперь читается из module metadata); старые dev-bundle требуют JDK 21 для paperweight; CraftBukkit в dev 1.20.1–1.20.4 версионирован (ошибка компиляции подтвердила, nms_validate теперь ловит это в исходниках).

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
- docs_search: живые страницы docs.papermc.io (URL из `slug`, проверены HTTP 200), новости papermc.io/news, javadoc Paper/Spigot/Adventure.
- `npm test`: 28 тестов на сохранённых ответах (без сети): источники, профили, экстраполяция, проверка NMS, разбор логов, определение проектов, реестр из 9 инструментов.
