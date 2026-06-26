# Bug-pattern review system

Система против багов, которые повторяются из сессии в сессию (системный бар не покрашен, анимация сломалась, кривые отступы, бэк задеплоен не в тот регион, субагент молча выпилил фичу).

**Корень проблемы:** знание о прошлых багах есть (126 `improvements/`, каталоги pitfalls, `feedback_*` по проектам), но оно **пассивное** — лежит в memory, поднимается только если `knowledge-scout` случайно зацепит. Баг повторяется, потому что его никто не сторожит на каждом diff. Эта система делает знание **исполняемым**: каждый прошлый баг → постоянная проверка, привязанная к области, срабатывает сама.

## Три слоя × три режима провала

| Слой | Что делает | Ловит режим | Стоимость |
|---|---|---|---|
| **L1** `run.py` | детерминированный grep/glob-гейт, без LLM | **static** — green-but-broken (компилится, тесты зелёные, ломается в release/web/на девайсе) | ~0, каждый diff |
| **L2** `bug-pattern-reviewer` (агент) | суждение по red-flags тронутых областей | **runtime** — гонки, insets, анимация, video (grep флагует, подтверждает прогон) | 1 субагент |
| **L3** process-gate в `/end-session` | triggered-вопросы перед «готово» | **process** — поведение агента (тихое выпиливание фичи, слепой патч, deploy-skew) | проза-чеклист |

Наивный «один reviewer + плоский checklist.md» свалил бы все три в кучу: режим A не нужен LLM (дорого), режим B чеклист не подтверждает (нужен прогон), режим C — не про код. Поэтому слои разделены.

## Где живёт, против чего работает

- **Живёт глобально** в `~/.claude/review-rules/` — один источник правды для всех проектов.
- **Работает против проектных реп** (Android-KMP, web, бэкенд): `run.py` берёт `git diff` *текущего* проекта. Правило применяется, только если его `globs` совпали с изменёнными файлами (так `*.kt`-правила не трогают Next.js-проект). `stack`-тег — документация/опц. фильтр.

## Точки входа

1. **`/end-session`** (Definition of Done) — гонит L1 + спавнит L2 + проходит L3. Главный канал, забыть нельзя.
2. **git pre-commit hook** (только L1) — блокирует коммит на static HIGH. Ставится **в репозиторий проекта**, зовёт глобальный `run.py`. **Настраивается сам:** SessionStart-хук (`ensure-hook.ps1` → `run.py --ensure-hook`) при старте сессии ставит hook в git-root текущего проекта, если его нет. Безопасно — никогда не трогает `~/.claude`, не клобберит чужой pre-commit (только флагует), opt-out `REVIEW_RULES_NO_AUTOHOOK=1`. Проверка статуса:
   ```bash
   python ~/.claude/review-rules/run.py --check-hook    # установлен / нет / чужой
   python ~/.claude/review-rules/run.py --ensure-hook   # поставить вручную (то же, что делает SessionStart)
   ```
   Если в проекте уже есть свой pre-commit — auto не перезатирает; `--check-hook`/end-session подскажут строку для ручного дописывания.

## Использование `run.py`

```bash
python ~/.claude/review-rules/run.py                 # рабочее дерево vs HEAD (+ untracked)
python ~/.claude/review-rules/run.py --staged        # staged (для pre-commit)
python ~/.claude/review-rules/run.py --base origin/main   # всё с ветки
python ~/.claude/review-rules/run.py --json          # для агента L2
python ~/.claude/review-rules/run.py --warn-only     # никогда не exit≠0 (advisory)
python ~/.claude/review-rules/run.py --area backend-deploy  # одна область
```
Exit ≠ 0 — есть `static` HIGH (коммит/гейт блокируется). `runtime` — WARN, не блокирует. `process` — L1 пропускает (их читают L2/L3).

## Схема правила

Каждый area-файл (`<area>.yaml`) — список правил. Полная схема — в `manifest.yaml`. Кратко:

```yaml
- id: firebase-functions-region   # уникальный kebab-case
  pain: 4                          # опц. — какую из 5 болей сторожит
  mode: static                     # static | runtime | process
  severity: high                   # high | medium | low
  stack: [firebase, wasmjs]        # опц. тег
  globs: ["**/init.js"]            # правило бежит только по совпавшим файлам
  detect:                          # static/runtime:
    type: grep                     #   grep | glob
    has: 'getFunctions\('          #   per-line positive (grep)
    unless: '...'                  #   per-line negative — пропустить строку (grep)
    lacks: 'FUNCTIONS_REGION'      #   file-level — пропустить файл, если есть guard (grep)
  trigger: "..."                   # process: условие на diff (вместо detect)
  question: "..."                  # process: что главный обязан проверить
  message: "..."                   # класс бага, одна строка
  fix: "..."                       # правильный паттерн
  source: "improvements/..."       # из какого инцидента выжато
```

Типы детекторов:
- **grep** — `has` (есть на строке) → находка; `unless` гасит строку; `lacks` гасит весь файл, если guard уже есть.
- **glob** — срабатывает просто потому, что файл по `globs` попал в diff (напр. `.svg` в commonMain).

## Компаундинг (движок, который останавливает повторение)

Починили баг — особенно **2+ итерации / recurring / «фикс не помог»** — допиши **одну строку-правило** в нужный area-файл, `source:` → инцидент. Пойманное один раз больше не возвращается.

1. Определи режим: ловится grep'ом → `static`; только на девайсе/прогоном → `runtime`; про поведение агента → `process`.
2. Напиши `detect` (или `trigger`+`question` для process), `message`, `fix`, `source`.
3. Прогони smoke (см. ниже), убедись, что правило срабатывает на примере и не даёт ложных на чистом коде.
4. `/end-session` и pre-commit подхватят автоматически — регистрировать нигде не нужно.

Это и есть compound-engineering loop: каждый баг делает систему умнее на одно правило.

## Текущее покрытие (тонкий срез)

21 правило, 6 областей. Боли: **#4** (регион/deploy) — static, **#3** (отступы/insets) — static+runtime, **#1** (system bars) — runtime, **#2** (анимация) — частично runtime, **#5** (выпиливание фичи) — process-gate. Доращивается по инцидентам.

## Smoke-тест правил

```bash
cd ~/.claude && python - <<'PY'
import importlib.util
s=importlib.util.spec_from_file_location("rr","review-rules/run.py")
rr=importlib.util.module_from_spec(s); s.loader.exec_module(rr)
rules=rr.load_rules(None)
r=next(x for x in rules if x['id']=='ТВОЙ-ID')
print(rr.run_detector(r,"file.kt","строка-которая-должна-сработать"))  # ждём находку
print(rr.run_detector(r,"file.kt","чистая строка"))                    # ждём []
PY
```

## Что система НЕ заменяет

- `/code-review`, `ce-*` — generic correctness/security/perf. bug-pattern-reviewer — **другая линза**: твоя личная история инцидентов. Дополняют, не дублируют.
- `knowledge-scout` поднимает паттерн **реактивно** → реестр его **энфорсит**. Тоже дополняют.
