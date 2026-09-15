# Task-gate — Step 4: Recommendations Pull (детальная механика)

Полная процедура извлечения, 4-тестовой классификации, записи в queue и inline-вывода. Инварианты продублированы в SKILL.md → Step 4; здесь — механика 4.2–4.5.

## Step 4 — Recommendations Pull

Документ задачи несёт секцию `## Предложения по улучшению агентов` — главный заполняет её на COMPLETE (`doc-task`) из собственных наблюдений за специалистами; это артефакт compound effect. (До 2026-09-15 секцию писал субагент `doc-writer` в своём COMPLETE-ответе.)

**Изменение 2026-05-27 (очередь, не интерактив):** скилл больше **НЕ** спрашивает `[a]pply / [d]efer / [s]kip` — под нагрузкой долгой сессии решения хуже (пропускают ритуальные правила, накопившиеся в `agents/*.md` до 113 КБ). Вместо этого: (1) извлечь рекомендации из документа задачи; (2) классифицировать (HIGH/MEDIUM/LOW — критерии в `~/.claude/recommendations/README.md`); (3) записать в `~/.claude/recommendations/<YYYY-MM-DD>-<session-slug>.md` со `status: pending-review`; (4) в 5.2.1 показывать **только summary** (count + path).

Пользователь раз в неделю запрашивает обзор очереди («рассмотрим рекомендации», «что в queue»), Claude читает pending файлы и предлагает применить отсортированные по relevance.

### 4.1 Обязательное правило вывода (ОБЯЗАТЕЛЬНО)

**ВСЕГДА** записывать ВСЕ рекомендации в файл — даже LOW-relevance. Фильтр НЕ удаляет, а **классифицирует**: пользователь раз в неделю сам решает что спасти. Удаление LOW записей на этапе скилла = потеря compound effect (на случай, если LOW окажется началом recurring паттерна — увидим во 2-й и 3-й сессии).

Если рекомендаций ноль — НЕ создавать пустой файл; в финальном отчёте строка `✅ no recommendations this task`. Документа задачи нет — `✅ N/A (no task doc)`.

### 4.2 Извлечение

1. Открыть документ задачи (`docs/active/<slug>-<date>.md`, после архивации — `docs/archive/`).
2. Найти секцию `## Предложения по улучшению агентов` (в легаси-документах также `## Recommendations`, `## Improvements`, `Предложения для агентов`, `Improvements for sub-agents`). Регистр и язык не важны.
3. Если секция есть, но пуста (заголовок без пунктов) — считать как «нет рекомендаций» и так и зафиксировать.
4. Документа задачи за эту задачу нет — пропустить шаг с пометкой `✅ N/A (no task doc)`.

### 4.3 Best-practice классификация (автомат)

Для каждой рекомендации применить **4 теста** (источник — `~/.claude/recommendations/README.md` → «Best-practice критерии классификации»). Каждый тест даёт ✅ / ⚠️ / ❌ результат:

| # | Тест | ✅ когда | ❌ когда |
|---|---|---|---|
| 1 | **Concrete path** | Указан `~/.claude/agents/<x>.md` / `~/.claude/skills/<x>/SKILL.md` / явный новый файл | Размыто (`shared`, `где-нибудь в agents/`, нет path) |
| 2 | **Concrete action** | `Append paragraph to "## X"` / `Replace block X with Y` / `Add new section "..."` | Vague: «consider», «think about», «maybe», «возможно стоит» |
| 3 | **Why с прецедентом** | Есть commit SHA / ссылка на solution doc / упоминание 2+ предыдущих случаев | Why слабый («показалось бы полезным», без прецедента) |
| 4 | **Recurring или accountability gap** | Паттерн в проекте встречался 2+ раза ИЛИ закрывает реальный gap (специалист систематически промахивается) | One-off, «если в следующий раз случится…» |

**Дополнительные red flags** (мгновенно → LOW relevance, не считая 4-х тестов):
- **Out-of-scope** — рекомендация менять Anthropic-managed plugins/skills (`compound-engineering:*`, `vercel:*`, `cloudflare:*`, `figma:*`, `amplitude:*`). Мы не должны их трогать.
- **Self-loop** — рекомендация менять `task-gate/SKILL.md` правилом, которое **уже там есть** (`grep` по ключевым словам action).
- **Возможный дубль** — `grep` по action keywords нашёл похожее правило в `CLAUDE.md` или соответствующем `agents/*.md`. Пометить `⚠️ возможный дубль с <path>:<line>` (не блокирующий, но видимый при review).

Итоговая classification:

- **🟢 HIGH** — все 4 теста ✅, без red flags.
- **🟡 MEDIUM** — 2–3 теста ✅, без red flags.
- **🔴 LOW** — 0–1 тест ✅ ИЛИ любой red flag.

### 4.4 Запись в queue

1. **Определить task slug** — приоритет: (a) имя активного doc **этой задачи** из `docs/active/` без расширения; (b) `commit-<short-sha>` если был коммит; (c) topic из формулировки задачи (slugify первых ~6 слов запроса, породившего задачу — не первого сообщения сессии).
2. **Имя файла:** `~/.claude/recommendations/<YYYY-MM-DD>-<task-slug>.md`. Повторный прогон gate **той же задачи** — append в существующий файл, не перезаписывать. Новая задача той же сессии — **новый файл** со своим slug (frontmatter-ключ `session_slug` оставлен для совместимости схемы, кладётся task slug).
3. **Frontmatter:**
   ```yaml
   ---
   date: <YYYY-MM-DD>
   session_slug: <slug>
   session_doc: <docs/active/...md или ->
   project: <project-name>
   total_recs: <N>
   high_relevance: <H>
   medium_relevance: <M>
   low_relevance: <L>
   status: pending-review
   ---
   ```
4. **Тело файла** — рекомендации сгруппированы по relevance (🟢 → 🟡 → 🔴). Шаблон каждой рекомендации — в `~/.claude/recommendations/README.md`.
5. **Inline-вывод в чат** — короткий блок (НЕ полный текст рекомендаций, чтобы не дублировать с файлом):

```
💡 Recommendations queued (N items):
   🟢 HIGH:    <H> recs
   🟡 MEDIUM:  <M> recs
   🔴 LOW:     <L> recs

   📁 Saved to: ~/.claude/recommendations/<YYYY-MM-DD>-<slug>.md
   📋 Review:   запроси «рассмотрим рекомендации» когда будешь готов (раз в неделю — норма)
```

Если LOW-relevance ≥ 50% от total — добавить warning-строку:
```
   ⚠️  LOW-relevance ≥50% — секция заполнена ритуально, а не по наблюдениям.
      Просмотри файл; пустая секция честнее списка для галочки.
```

### 4.5 НЕТ интерактива — не задавать вопросы пользователю

Скилл **НЕ** вызывает `AskUserQuestion` для apply/defer/skip. Все рекомендации идут в queue без подтверждения. Решение откладывается на еженедельный review. Это сознательный design choice (см. `~/.claude/recommendations/README.md` → «Зачем эта папка»).

**Исключение:** если рекомендация имеет ❌ ВСЕ 4 теста + явный red flag (out-of-scope или self-loop) — НЕ записывать вообще, в summary показать `⊘ X recs rejected (out-of-scope / self-loop)`. Это страховка от мусора в queue.

---
