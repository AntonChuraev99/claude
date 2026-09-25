---
date: 2026-09-25
slug: mcp-memory-on-demand
status: applied
goal: вернуть 5-6 параллельных сессий на 16 GB — убрать редко нужный stdio-MCP из каждой сессии
metric: private-память одной сессии Claude Code с MCP-деревом; число параллельных сессий до нехватки RAM
baseline_date: 2026-09-25
target_date: 2026-10-09
---

# layout-debug MCP — по запросу, Gradle idle 20 мин

## Цель
Жалоба: при 2 сессиях не хватает памяти, раньше хватало на 6. Гипотеза пользователя «демоны не закрываются» проверена.

## Baseline (2026-09-25, 16 GB RAM, свободно 1,1 GB, commit 29,7 GB)
- Осиротевших MCP-процессов нет — у всех живой родитель.
- Сессия Claude Code ≈ 1,3–1,5 GB / ~22 процесса: `claude.exe` 500–750 MB + MCP ≈ 730 MB
  (firebase 237 MB, layout-debug 196 MB / 6 процессов, playwright 164, appstore 69, mobile 68).
- Живых сессий было 5 (3 CLI + 2 Desktop), не 2.
- Gradle-демон + 2 Kotlin-демона ≈ 6,5 GB, живут `idletimeout` 1 ч после сборки; два Kotlin-демона — разные версии Kotlin в проектах (2.4.20 и 2.4.0).

## Гипотеза
Рост с 09-23 — layout-debug MCP в обоих профилях (+~200 MB × N сессий) поверх Gradle-демона на час.

## Изменения
- `claude mcp remove layout-debug -s user` в обоих профилях (вне репо).
- `config/optional-capabilities.md` — секция «Выключено 2026-09-25» со строкой возврата; firebase/playwright оставлены (выключенный плагин убирает имена тулов и скиллы из сессии).
- Скилл `layout-debug` (локальный, не в репо) — MCP по умолчанию не подключён, строка включения/снятия.
- `~/.gradle/gradle.properties` — `org.gradle.daemon.idletimeout=1200000` (вне репо).

## Target
Сессия ≤ 1,2 GB; 5+ сессий без нехватки RAM, пока не идёт сборка.

## Replay (заполняется через N дней)
