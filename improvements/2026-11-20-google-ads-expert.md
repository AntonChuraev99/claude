---
date: 2026-11-20
slug: google-ads-expert
status: applied
goal: работа в кабинете Google Ads (данные, цели и конверсии, ставки, кампании) уходит одному агенту с официальным MCP, процедурой подключения проекта и сводом best practices, а не главному и не @marketing-expert по памяти
metric: доля Google Ads-задач, ушедших в @google-ads-expert по description; доля ответов с цифрами из кабинета (GAQL) и датированными URL правил; число трат без явного «да» (цель — 0); время подключения нового проекта до первого успешного `search_search`
baseline_date: 2026-11-20
target_date: 2026-12-04
---

# Субагент google-ads-expert и официальный Google Ads MCP

## Цель

Пользователь попросил субагента под Google Ads: установить MCP, позже научить его управлять кампаниями через API, дать ему самому выбирать канал MCP или API и собрать best practices по настройке целей для максимальной эффективности. Отдельное требование пользователя: у каждого проекта свой Cloud-проект, и агент на старте сам проверяет доступы и включает сервис через gcloud.

## Baseline (до изменений, на дату 2026-11-20)

Доступа к кабинету Google Ads у харнесса нет: ни MCP, ни скриптов API. Google App campaigns числились в зоне `@marketing-expert` — стратегия и пороги из `references/marketing-platform-numbers.md`, без данных кабинета. Задач по Google Ads в истории нет — метрики считать не по чему.

## Исследование (2026-11-20)

- Официальный сервер `googleads/google-ads-mcp` 0.0.6 (2026-11-02): чтение (`search_search` по GAQL, `customers_list_accessible_customers`, `metadata_get_resource_metadata`) и частичная запись (ассеты, метки, propose-and-confirm). Кампании, бюджеты и ставки сервер не меняет — это делает только Google Ads API.
- Developer token отменён 2026-09-09; уровень доступа задаёт Cloud-проект OAuth-клиента или service account. Test работает только с тестовыми кабинетами, для боевого нужен Explorer (заявка в Cloud Console, обычно автоматическая проверка).
- Сервер вызывает `google.auth.default()` на каждом вызове инструмента — ключ, созданный после старта сервера, подхватывается без перезапуска (исходник `ads_mcp/utils.py`, 0.0.6).
- OAuth-токен в статусе Testing живёт 7 дней, под Workspace session control — ~12-16 ч. Service account этих ограничений не имеет и создаётся через gcloud, поэтому он — основной путь; OAuth — запасной.
- На машине есть общий ADC gcloud, которым пользуются другие инструменты. `gcloud auth application-default login` перезаписал бы его.

## Гипотеза

1. Один агент с MCP только у него (inline `mcpServers`, как у `@mobile-tester`) снимает с главного и с `@marketing-expert` работу по памяти: цифры берутся из кабинета, правила — из справочника с URL для живой проверки.
2. Лаунчер, который берёт Cloud-проект из колонки `gcp_project` реестра кредов по корню репозитория и всегда задаёт `GOOGLE_APPLICATION_CREDENTIALS` на ключ проекта, даёт «свой Cloud-проект на каждый проект» без ручной правки конфига MCP и без риска взять общий ADC.
3. Инвариант «трата и сброс обучения — только после явного да» и запрет мутирующих скриптов на лету держат деньги под контролем до фазы 2 (готовые API-скрипты с `validate_only`).

## Изменения

- `agents/google-ads-expert.md` — новый агент (opus, effort high): шесть блоков, setup на каждом спавне, таблица «действие → MCP / API / ручной шаг», инварианты денег и обучения.
- `agents/google-ads-expert/scripts/mcp_launch.py` + `test_mcp_launch.py` (12 тестов) — лаунчер inline-сервера: корень основного checkout (работает из worktree), `gcp_project` из реестра, ключ `~/.config/google-ads-mcp/<gcp_project>/credentials.json`, `--print-config` для шага setup.
- `agents/google-ads-expert/references/setup.md` — процедура подключения проекта: включить API через gcloud, service account и ключ, ручные шаги (доступ SA в кабинет, заявка Explorer), проверка, запасной OAuth без перезаписи общего ADC.
- `agents/google-ads-expert/references/best-practices.md` — свод по первоисточникам Google на 2026-11-20: цели и конверсии, ставки и обучение, App campaigns, Search и AI Max, PMax и Demand Gen, подписочные приложения, эксперименты, анти-паттерны, переименования 2026, список URL для живой проверки.
- `agents/marketing-expert.md` — кабинет Google Ads отдан `@google-ads-expert`; план каналов, бюджет на Google и тексты остаются у `@marketing-expert`. Чтобы уложиться в 1 500 символов description, из него убраны две поясняющие скобки, которые дословно есть в теле и в description соседей; триггеры и список ASO-скиллов не тронуты.
- `references/marketing-platform-numbers.md` — строки Google заменены ссылкой на справочник `@google-ads-expert` (один предмет — один адрес).
- `CLAUDE.md` § «Продукт и маркетинг» — `@google-ads-expert` в списке владельцев доменов.
- `README.md`, `config/optional-capabilities.md` — агент и сервер в реестрах.
- `docs/backlog/subagents-get-no-mcp-tools.md` — пометка, что условие «сервер должен быть в главной сессии» опровергнуто замером 2026-10-23.

## Проверка при внедрении

- `python -m unittest` по `agents/google-ads-expert/scripts` — 12 тестов зелёные.
- Проба stdio из каталога проекта с `gcp_project` в реестре: сервер поднялся за 7,5 с, отдал 7 инструментов, вызов `customers_list_accessible_customers` упал на отсутствии ключа именно этого проекта (общий ADC не использован), выход 0 после закрытия stdin.
- Сквозная проба `claude -p --agents` (подписка) из каталога того же проекта: субагент получил все 7 инструментов `mcp__google-ads__*`, вызов вернул ту же ошибку с путём ключа этого проекта. Значит, Claude Code запускает inline-сервер субагента с cwd проекта, и лаунчер находит нужный Cloud-проект.
- Ревью гейта (Standards + Spec) нашло и закрыто: адресаты кода в границах не принимали случай (оставлены `@feature-expert`, `@android-platform-expert`, `@nextjs-expert` по заявленным зонам); MCP создаёт ассет только в библиотеке, без привязки к объявлению — привязка вынесена в канал API, read-back ассета идёт по ресурсу привязки.
- Не проверено: чтение боевого кабинета. Нужны ручные шаги пользователя (доступ SA в кабинет, Explorer) — их агент выдаёт на первом спавне в проекте.

## Target

К 2026-12-04: первая задача по Google Ads ушла в `@google-ads-expert` по description; у проекта пройден setup до успешного `search_search`; в отчётах агента цифры с GAQL и URL правил с датой; ни одной траты без «да».

## Replay (заполняется через N дней)

_pending_
