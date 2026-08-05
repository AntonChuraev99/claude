---
title: "Субагенты не получают MCP-инструменты, если в агенте объявлен явный tools:"
date: 2026-08-05
status: done
resolved: 2026-08-05
area: agents
keywords: [subagent, mcp, tools, frontmatter, mcpServers, context7, jira, toolsearch, deferred-tools]
---

# Субагент с явным `tools:` теряет все MCP-инструменты

> **ФИНАЛЬНОЕ РЕШЕНИЕ — `disallowedTools:` вместо `tools:`.** Ниже документ идёт хронологически, и промежуточный вариант с inline `mcpServers:` в нём разобран подробно — **он снят**. Применять надо это:
>
> ```yaml
> disallowedTools: Agent, Workflow, NotebookEdit
> ```
>
> Ни `tools:`, ни inline `mcpServers:`. Агент наследует серверы активного профиля — дублировать определение в каждом агенте не нужно, и при смене профиля ничего не ломается. Раскатано на 12 агентов, подтверждено живыми вызовами: `context7` → `/ktorio/ktor-documentation`, `/insertkoinio/koin`; `atlassianUserInfo` → ok + 2 проекта.
>
> **Оговорка:** `disallowedTools` ограничивает не всё. Запрет `Grep, Glob` не сработал — форсированный вызов `Grep` прошёл и вернул 14 совпадений. Значит denylist это намерение, а не граница; оставшиеся `Agent`/`Workflow` не проверены. Гарантии, которые обязаны держать, — в хук.
>
> Хронология ниже сохранена намеренно: она показывает, какие гипотезы уже отброшены замером, чтобы не проверять их заново.

## Симптом

Спавн любого доменного агента возвращал список инструментов без единого `mcp__*`:

```
Read, Grep, Glob, Edit, Write, Bash, Skill, WebSearch, WebFetch
```

При этом **инструкции MCP-серверов в контекст субагента инжектились** — про серверы он «знал», вызвать не мог.

## Корень (замер 2026-08-05, 5 проб живыми спавнами)

Решающее сравнение двух агентов в одной сессии:

| Агент | `tools:` | MCP-тулов | `ToolSearch` |
|---|---|---|---|
| `general-purpose` | `*` (без ограничения) | **315** (deferred) | **есть**, схема грузится |
| `kmp-expert` | явный перечень | **0** | нет |

**Объявление явного `tools:` вырезает у субагента все MCP-тулы и сам `ToolSearch`** — включая случаи, когда MCP-имена перечислены прямо в этом же `tools:`.

Проверено на `kmp-expert`, каждый раз свежий спавн после правки frontmatter:

| В `tools:` стояло | Результат |
|---|---|
| wildcard `mcp__context7__*` + два plugin-варианта | ни одного `mcp__` |
| точные живые имена `mcp__context7__{resolve-library-id,query-docs}` | ни одного `mcp__` |
| добавлен `ToolSearch` | `HAS_TOOLSEARCH: no` — не доставлен |

Документация Claude Code обещает обратное — наследование MCP субагентом и поддержку паттернов `mcp__<server>__*` в `tools:`. Фактически не работает; `@claude-code-guide` связывает это с issue #25200 / #30280 (номера не верифицировались, но вывод от них не зависит — он получен прямым замером).

## Решение — inline `mcpServers:` в frontmatter агента

Работает и проверено сквозняком: тул появляется в списке И сервер реально отвечает.

```yaml
---
name: kmp-expert
tools: Read, Grep, Glob, Edit, Write, Bash, Skill, WebSearch, WebFetch, mcp__context7__resolve-library-id, mcp__context7__query-docs
mcpServers:
  context7:
    type: stdio
    command: npx
    args: ["-y", "@upstash/context7-mcp"]
model: opus
---
```

Доказательства живых вызовов:
- `kmp-expert` → `resolve-library-id("kotlinx.coroutines")` → `/kotlin/kotlinx.coroutines`, 944 сниппета;
- `best-practices-scout` → `resolve-library-id("ktor")` → `/ktorio/ktor-documentation`.

Ключевое: inline-сервер поднимается при старте субагента и не попадает под вырезание, в отличие от ссылки на уже сконфигурированный сервер.

### Ограничение: inline работает ТОЛЬКО для `type: stdio`

Проверено разделяющим экспериментом — одному агенту добавлены сразу два inline-сервера:

| Сервер | Транспорт | Авторизация | Результат |
|---|---|---|---|
| `context7` | `stdio` (`npx`) | не нужна | **тулы пришли** |
| `<own-http-server>` | `http` | не нужна | **`none`** |

`<own-http-server>` авторизации не требует вовсе, и всё равно ноль ⇒ дело не в OAuth, а в самом транспорте: **`type: http` инлайном субагенту не доставляется**.

Следствие: удалённый HTTP-сервер надо заворачивать в stdio-мост `mcp-remote`:

```yaml
mcpServers:
  <name>:
    type: stdio
    command: npx
    args: ["-y", "mcp-remote", "https://<remote-url>/mcp"]
```

`mcp-remote` — npm-пакет, штатный прокси remote↔stdio; на первом запуске открывает браузер для OAuth и кеширует токен в `~/.mcp-auth`, дальше стартует молча.

Альтернатива — **убрать `tools:` целиком** (тогда наследуется всё, включая 315 deferred MCP-тулов и `ToolSearch`). Отвергнута: агент получает вдобавок `Agent`/`Workflow` (вложенные спавны) и ~315 имён тулов в контекст на каждом спавне. Inline-вариант даёт ровно 2 нужных тула.

Цена inline-варианта: каждый спавн поднимает свой `npx @upstash/context7-mcp`. При медиане жизни доменного агента 12–25 мин старт в 1–2 с — шум.

## Применено

`mcpServers: context7` добавлен 11 агентам: `android-platform-expert`, `best-practices-scout`, `compose-feature-expert`, `design-expert`, `google-play-console-expert`, `kmp-expert`, `kotlin-expert`, `nextjs-expert`, `react-ui-expert`, `test-expert`, `wasmjs-expert`.

Попутно исправлены имена тулов: было `mcp__plugin_compound-engineering_context7__*` — namespace, которого не давал ни один зарегистрированный сервер. Стало `mcp__context7__{resolve-library-id,query-docs}`. То же в `settings.json` → `permissions.allow`. context7 зарегистрирован дважды: прямой сервер `context7` (живой) и плагин `context7@claude-plugins-official` (отключён); старое имя не принадлежало ни одному.

## `jira-expert` — конфиг готов, ждёт одноразовой авторизации

Конфиг atlassian нашёлся в **другом профиле** — `~/.claude-work/.claude.json` → `mcpServers.atlassian`: `{"type":"http","url":"https://mcp.atlassian.com/v1/mcp"}`. Профиль `~/.claude` его не содержит, поэтому в этой сессии сервера нет ни у главного агента, ни у субагентов.

Прямой inline `type: http` не годится (см. ограничение выше — проверено). Поэтому в `jira-expert` прописан stdio-мост:

```yaml
mcpServers:
  atlassian:
    type: stdio
    command: npx
    args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/mcp"]
```

Плюс `tools:` переведён с нерабочего wildcard `mcp__atlassian__*` на явный перечень 17 Jira-тулов (Confluence-тулы намеренно не включены — они вне зоны агента).

**Авторизация пройдена 2026-08-05** — пользователь выполнил `npx -y mcp-remote https://mcp.atlassian.com/v1/mcp`, токен лежит в `~/.mcp-auth/mcp-remote-0.1.37/*_tokens.json`. Мост проверен автономно из shell: `Connected to remote server` → `Proxy established successfully`, exit 0, браузер повторно не запрашивался.

**И всё равно не работает — причина не найдена.** После авторизации `jira-expert` по-прежнему получает 0 MCP-тулов. Отброшенные гипотезы (каждая проверена отдельным спавном):

| Гипотеза | Проверка | Итог |
|---|---|---|
| неверные имена тулов | заменены на точные | ноль |
| wildcard не работает | заменён явным перечнем | ноль |
| `#`-комментарии ломают YAML | удалены | ноль |
| медленный мост роняет весь блок | atlassian убран, оставлен только context7 | ноль |
| «отравленный» allow-list (неразрешимое имя) | все atlassian-имена убраны | ноль |
| два сервера в блоке | оставлен один | ноль |
| BOM / переносы строк | `od`-сравнение с рабочим агентом | файлы идентичны |
| самоотчёт агента врёт | приказ вызвать вслепую | `tool_uses: 0`, вызов не состоялся |

Ключевая аномалия: frontmatter `jira-expert` **побайтно эквивалентен** рабочему `best-practices-scout` в полях `tools:` / `mcpServers:` / `model:` / `memory:` — и один получает Context7, другой ноль. Значит причина вне frontmatter.

Гипотеза «набор inline-серверов регистрируется один раз за сессию, при первом спавне» — **опровергнута рестартом 2026-08-05**. После перезапуска `jira-expert` по-прежнему ноль, но теперь с настоящей ошибкой рантайма вместо самоотчёта: `No such tool available: mcp__atlassian__atlassianUserInfo` (`tool_uses: 5` — агент реально пытался). Тем же рестартом подтверждено, что фикс context7 стабилен между сессиями: `best-practices-scout` → живой вызов → `/ktorio/ktor-documentation`.

## Итоговое правило — три условия одновременно

Четыре замера, сведённые в таблицу:

| Сервер | Подключён в главной сессии | Транспорт | Inline-блок у агента | Дошёл до субагента |
|---|---|---|---|---|
| `context7` | да | stdio | да | **✅** |
| `context7` | да | stdio | нет | ❌ |
| `<own-http-server>` | да | **http** | да | ❌ |
| `atlassian` | **нет** | stdio (мост) | да | ❌ |

**Субагент получает MCP-сервер, только если тот одновременно:**
1. подключён в главной сессии (то есть объявлен в `mcpServers` активного профиля);
2. на транспорте `stdio` — `http` не доставляется даже без авторизации;
3. объявлен у агента и в `mcpServers:`, и в `tools:` (последний работает как allow-list).

Inline-блок сам по себе сервер НЕ поднимает — он разрешает субагенту уже подключённый.

## `jira-expert` — почему не работает и что нужно

Валится на условии (1): `atlassian` отсутствует в профиле `~/.claude` вовсе — он объявлен в `~/.claude-work/.claude.json`. И дополнительно на (2): там он `type: http`.

Значит одной правки агента мало — нужна правка профиля.

**Сделано 2026-08-05** по решению пользователя: только в рабочем профиле, разделение `~/.claude` / `~/.claude-work` сохранено. В `~/.claude-work/.claude.json` → `mcpServers.atlassian` http-объявление заменено на stdio-мост:

```jsonc
"atlassian": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/mcp"]
}
```

Бэкап — `.claude.json.bak-atlassian-stdio-20260805`, JSON после правки валиден. Токен OAuth получен и лежит в `~/.mcp-auth/mcp-remote-0.1.37/`; мост проверен запуском из shell (`Connected to remote server` → `Proxy established successfully`, exit 0, браузер не запрашивался).

Сам агент уже настроен: `mcpServers.atlassian` тем же stdio-мостом + 17 явных Jira-тулов в `tools:` (Confluence намеренно не включён).

**Проверено 2026-08-05 под профилем `claude-work`: работает.** Живые вызовы — `atlassianUserInfo` → ok, `getVisibleJiraProjects` → 2 проекта, `tool_uses: 3`.

## Фикс профиль-зависим — следствие условия (1)

Та же проверка под `claude-work` вскрыла обратную сторону: `best-practices-scout` там **не получил** context7 (`Tool mcp__context7__resolve-library-id не присутствует в списке`). Причина ровно та же — условие (1): в рабочем профиле был подключён `plugin_context7_context7`, а не `context7`, объявленный у агентов.

Правило: **набор MCP у субагента определяется профилем**, а не только файлом агента. Один и тот же агент работает в одном профиле и не работает в другом, если сервер объявлен не везде.

Устранено симметрией — `context7` добавлен в `~/.claude-work/.claude.json` → `mcpServers` тем же stdio-объявлением, что и в `~/.claude.json`:

```jsonc
"context7": { "type": "stdio", "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "env": {} }
```

`CONTEXT7_API_KEY` берётся из `settings.json`, который симлинкнут между профилями — отдельно прописывать не нужно. Бэкапы: `.claude.json.bak-atlassian-stdio-20260805`, `.claude.json.bak-context7-20260805`.

**Не проверено:** context7 в рабочем профиле требует рестарта сессии (сервер подключается при старте). Проверка — спавн `best-practices-scout` с вызовом `resolve-library-id`.

Побочное наблюдение: CLI переписывает `.claude.json` при старте сессии (разворачивает однострочные массивы в многострочные), поэтому правки этого файла делать по устойчивым якорям, а не по точному форматированию.

Альтернатива OAuth — Atlassian поддерживает API-токены ([atlassian/atlassian-mcp-server](https://github.com/atlassian/atlassian-mcp-server)); точные имена переменных окружения не проверялись, поэтому в конфиг не заводились.
