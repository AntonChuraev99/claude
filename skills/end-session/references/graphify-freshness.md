# Graphify Freshness — decision tree для Step 2.8

Этот файл — extract из Step 2.8 `end-session/SKILL.md`. Описывает алгоритм проверки и автоматического обновления graphify knowledge graph.

## Принцип

Решение принимает скилл **сам**, без вопросов пользователю — в большинстве случаев операция безопасна и бесплатна (AST-only, без LLM, без API-cost). `graphify update .` идемпотентна.

## Decision tree

```
┌─ CLI установлен? ────────────────────────┐
│                                          │
│  NO  → ✅ N/A (no graphify cli)          │
│                                          │
│  YES → graphify-out/graph.json есть?     │
│         │                                │
│         NO  → AskUserQuestion (3 опции)  │  ← см. ниже
│         │                                │
│         YES → Freshness check            │
└──────────────────────────────────────────┘
                │
   ┌────────────┴────────────┐
   │ Fresh (commit совпадает)│
   │                         │
   │  diff содержит code?    │
   │   YES → graphify update │   (auto)
   │   NO  → ✅ graph fresh   │
   └─────────────────────────┘
                │
   ┌────────────┴──────────────┐
   │ Stale + code в diff       │
   │                           │
   │  distance ≤ 50 commits    │
   │   И deleted < 20%?        │
   │   YES → graphify update . │   (auto)
   │   NO  → ⚠️ manual rebuild │
   └───────────────────────────┘
                │
   ┌────────────┴──────────────┐
   │ Stale, но diff = только   │
   │ doc-файлы (.md/.txt/.yml) │
   │ → ✅ skipped (docs only)   │
   └───────────────────────────┘
```

## Ветка 1 — Detect

```bash
where graphify   # Windows / git-bash
which graphify   # POSIX
```

- CLI пуст → `✅ N/A (no graphify cli)`, пропустить.
- CLI установлен, `graphify-out/graph.json` отсутствует → **проект ещё не проиндексирован**.

Для случая «CLI есть, граф отсутствует» — `AskUserQuestion` с 3 опциями:

| Опция | Действие |
|---|---|
| `Run /graphify . now` | Пользователь сам запустит (требует LLM-токенов, поэтому решение его) |
| `Skip for this session` | Пометка `⚠️ no graph (deferred)`, продолжаем |
| `Never ask for this project` | Записать в project memory `graphify_optout.md`, больше не предлагать |

Если в memory есть `graphify_optout.md` — пропустить шаг тихо, без `AskUserQuestion`.

## Ветка 2 — Freshness check

```bash
# Из graphify-out/GRAPH_REPORT.md прочитать строку "Built from commit: <sha>"
grep "Built from commit:" graphify-out/GRAPH_REPORT.md

# Сравнить с
git rev-parse HEAD
```

**Если совпадают:**
- Проверить дифф сессии: `git diff --stat HEAD` + список untracked code-файлов.
- Есть code-файлы → запустить `graphify update .` (чтобы граф учёл несохранённые правки).
- Нет code-файлов → `✅ graph fresh`, пропустить.

## Ветка 3 — Stale + code-файлы в диффе

**Code-расширения:** `.kt`, `.kts`, `.java`, `.js`, `.jsx`, `.ts`, `.tsx`, `.py`, `.go`, `.swift`, `.rs`, `.rb`, `.php`, `.c`, `.cpp`, `.cs`, `.h`, `.hpp`, `.m`, `.mm`.

**Безопасные условия для auto-update (оба должны выполняться):**

1. `distance` HEAD ↔ graph-commit ≤ 50 коммитов:
   ```bash
   git rev-list --count <graph-commit>..HEAD
   ```
2. В дифф нет признаков крупного рефакторинга с удалением:
   - `deleted-files` < 20% от изменённых файлов.
   ```bash
   git diff --name-status <graph-commit>..HEAD | awk '$1=="D"' | wc -l
   ```

**Если оба условия выполнены:**
```bash
graphify update .
```
Отметить `✅ graph updated (<sec>s)`.

**Если distance > 50 коммитов ИЛИ много deleted-файлов:**
- `⚠️ graph stale, manual rebuild recommended` — крупный diff может потребовать `graphify update . --force` или полной пересборки `/graphify .`.
- Это решение пользователя — стоимость может быть высокой (LLM-токены при полной пересборке).
- **Не блокировать gate**, но в финальный отчёт строкой включить.

## Ветка 4 — Stale, только doc-файлы

Расширения только: `.md`, `.txt`, `.yml`, `.yaml`, `.json` (без кода).

→ `✅ skipped (docs only)` — graphify индексирует и доки, но обновление можно отложить, пока не накопится code-diff.

## Ветка 5 — Auto-update упал

`graphify update .` вернул non-zero exit:

- Пометить `⚠️ graphify update failed: <stderr>`.
- Не блокировать gate.
- В финальный отчёт строкой включить полный stderr.

## Why автономное решение

- `graphify update .` — AST-only, идемпотентная, без сетевых вызовов.
- Цена ошибки нулевая (всегда можно перезапустить вручную, в т.ч. с `--force`).
- Спрашивать пользователя на каждом end-session = трение без ценности.

## Why не запускаем при больших диффах

`update` без `--force` отказывается перезаписывать граф, если в новом графе **меньше** узлов (защита от случайного удаления данных рефакторингом). При >50-commit gap или массовом удалении файлов это срабатывает чаще, и `--force` нужен осознанно — это решение пользователя по бюджету и согласию с тем, что данные могут «исчезнуть».
