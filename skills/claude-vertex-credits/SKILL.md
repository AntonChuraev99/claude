---
name: claude-vertex-credits
description: Переключает Claude Code с подписки claude.ai на Claude в Google Vertex AI, чтобы расход шёл из ежемесячных кредитов Google Cloud, которые дают подписки Google AI Pro и Ultra (Google Developer Program). Подписка остаётся режимом по умолчанию — Vertex включается только для запуска с отдельным settings-файлом, в том числе для продолжения текущей сессии. Используй, когда кончился лимит подписки Claude, и на «переключи на vertex», «потрать кредиты google на claude», «мигрируй на кредиты gemini», «claude через google cloud», «claude code vertex», «/claude-vertex-credits». Не для: Gemini API и моделей Gemini; оплаты через API-ключ Anthropic; постоянного переключения провайдера (это встроенный `/setup-vertex`).
allowed-tools: Bash, Read
---

# Claude Code на кредитах Google Cloud

Подписки Google AI Pro и Ultra дают ежемесячный кредит Google Cloud. Claude
доступен в Vertex AI, и Claude Code умеет работать через Vertex. Скрипт
`scripts/vertex.sh` настраивает проект и пишет отдельный settings-файл.
Claude Code, запущенный с `--settings <файл>`, идёт в Vertex. Обычный `claude`
остаётся на подписке.

```bash
bash ~/.claude/skills/claude-vertex-credits/scripts/vertex.sh <команда> [флаги]
```

## 1. Деньги — прочитай до начала

- Размер кредита (Developer Program FAQ, проверено 2026-11-20): AI Pro — $10 в
  месяц, AI Ultra 5x — $40, AI Ultra 20x — $100. Кредит не приходит сам:
  пользователь забирает его на странице Benefits профиля Google Developer
  Program и выбирает billing account. Выбор необратим, кредит живёт 12 месяцев.
- Google нигде не пишет, покрывает ли этот кредит партнёрские модели, то есть
  Claude. Кредит $300 Free Trial их точно не покрывает. Поэтому не говори
  пользователю «бесплатно», пока проверка из шага 8 не прошла.
- Бюджет только шлёт письмо, с задержкой в часы. Траты он не останавливает.
- Перед `smoke` и `setup --create` спроси пользователя через `AskUserQuestion`
  и назови цену. `smoke` — первая трата на счёте: по запросу в Haiku, Sonnet и
  Opus, вместе меньше $0.001. `setup --create` создаёт проект и привязывает к
  нему billing account. Общее «переключи на vertex» согласием на трату не
  считается.

## 2. Шаги

1. Запусти `doctor`. Он только читает и ничего не тратит.
2. Если кредит не забран, пользователь забирает его сам:
   [Developer Program benefits](https://developers.google.com/profile/help/benefits).
3. Если `doctor` пишет FAIL у ADC, пользователь входит сам:
   `! gcloud auth application-default login`.
4. Узнай billing account с кредитом: `gcloud billing accounts list`. Спроси
   пользователя об аккаунте и покажи ему gcloud-аккаунт из вывода `doctor`:
   все команды скрипта идут от активного аккаунта gcloud. Запусти `setup --project <id> --create --billing-account <B>`.
   Отдельный проект только под Claude даёт чистый отчёт, точный бюджет и
   безопасный стоп через отвязку billing. Существующий проект:
   `setup --project <id>` без `--create`.
5. Пользователь включает модели в Model Garden: поиск «Claude», открыть каждую
   закреплённую модель, нажать Enable. Ссылку печатает `setup`.
6. Запусти `smoke`. Он шлёт по 8 токенов в Haiku, Sonnet и Opus.
7. Запусти `budget --billing-account <B>`. Пользователь хочет потратить только
   часть кредита — добавь `--cap <сумма>` в валюте billing account.
8. Через 1-2 дня проверь кредит: Billing → Reports, проект, группировка по SKU.
   У строк Claude колонка Credits равна стоимости со знаком минус. Ссылку
   печатает `doctor`. Если Credits — ноль, кредит Claude не покрывает: скажи
   пользователю и предложи отвязать billing.
9. Запусти `launch` и отдай пользователю команду из вывода. Агент не может
   перезапустить сам себя: команду пользователь запускает в новом терминале.

## 3. Модели и цена

`setup` закрепляет `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` на
endpoint `global` и ставит основной моделью Sonnet. Без закрепления Claude Code
на Vertex берёт Opus, а это самая дорогая модель. `setup --model opus` ставит
Opus основной; внутри сессии модель меняет `/model`. Субагенты с
`model: opus` во frontmatter идут в Opus и на Vertex, мимо основной модели.

| Модель | Input | Cache read | Output |
|---|---|---|---|
| Opus 5.5 | $4 | $0.20 | $20 |
| Sonnet 5.5 | $2 | $0.10 | $10 |
| Haiku 5.5 | $0.10 | $0.01 | $0.50 |

Цены за 1M токенов, по странице цен Anthropic на 2026-11-20. Региональные
endpoint дороже на 10% и новые модели не обслуживают. Активная сессия на
Sonnet — порядка $1-3 в час (оценка, не замер). Расход сессии показывает
`/cost`.

## 4. Продолжение сессии

`claude --continue --settings <файл>` продолжает последнюю сессию в этом
каталоге уже через Vertex. Переход между провайдерами в документации не
описан. Подписи thinking-блоков привязаны к провайдеру, поэтому старые
thinking-блоки могут пропасть. Если API отвечает 400 с упоминанием `signature`
или `thinking`, начни новую сессию `claude --settings <файл>` и передай в неё
краткое резюме прошлой работы.

## 5. Если сломалось

| Симптом | Действие |
|---|---|
| Код `3` | Поставить gcloud: [установка](https://cloud.google.com/sdk/docs/install) |
| Код `4` или 403 `provider_credentials` в Claude Code | `! gcloud auth application-default login` |
| `smoke` 403 | Модель не включена в Model Garden, API выключен или нет роли `roles/aiplatform.user` |
| `smoke` 404 | ID модели не существует на `global`: обнови константы в начале `vertex.sh` |
| `smoke` 429 | Квота: IAM & Admin → Quotas, фильтр `anthropic`, запросить увеличение |
| `/status` в сессии не показывает Google Vertex AI | В shell или `settings.json` пользователя стоит переменная, которая перебивает файл. Проверь `CLAUDE_CODE_USE_VERTEX` и `ANTHROPIC_MODEL` |
| `budget` падает на правах | Нужна роль Billing Account Costs Manager или Administrator на billing account |

## 6. Вернуться на подписку и остановить траты

- Подписка: обычный `claude` без `--settings`.
- Стоп трат: `gcloud billing projects unlink <project>`. Делай это только для
  проекта, который служит одному Claude: отвязка останавливает все сервисы
  проекта.
