# Токены и запуск

Оценка: символы / 4. Замеры: `node scripts/measure-startup.mjs`, `node scripts/measure-tokens.mjs '<[[tool, args, label], ...]>'`.

## Постоянная цена (каждый запрос)

| | токены |
|---|---|
| tools/list, 9 инструментов | ≈2 740 |
| instructions сервера | ≈177 |

По инструментам: list_versions 170, get_profile 210, search_server_source 451, get_class 558, translate_mapping 258, nms_validate 331, docs_search 311, build 231, analyze_crash 218.

Запуск: медиана ≈270 мс, RSS ≈76 МБ (реализации инструментов грузятся при первом вызове).

## Типичные ответы

| вызов | токены |
|---|---|
| list_versions (сводка) | ≈473 |
| list_versions 1.20.4 | ≈157 |
| get_profile paper 1.21.11 + gradle-сниппет | ≈463 |
| search_server_source "ServerPlayer" | ≈138 |
| get_class ServerPlayer, outline целиком | ≈2 840 |
| get_class ServerPlayer, memberFilter "glow" | ≈61 |
| get_class один метод | ≈358 |
| translate_mapping класса | ≈73 |
| nms_validate, без проблем | ≈39 |
| nms_validate 1.16.5 → 1.20.4, 7 ошибок | ≈303 |
| docs_search | ≈680 |
| build (Maven, успех) | ≈76 |
| analyze_crash, 4 ошибки | ≈336 |

Ответы — только текст (без structuredContent), длинные списки пагинируются (`offset`/`limit`), outline большого класса лучше сужать `memberFilter` или брать `method=`.
