---
name: amplitude-slack-payload
description: >
  Use this skill when the user wants to generate an Amplitude → Slack Webhook
  destination payload template (FreeMarker syntax) for a specific analytics event.

  The user provides either (a) an event name — the skill greps the project's
  source code for that event's parameters, OR (b) an explicit list of event
  name + parameter names.

  Output is always a JSON payload with FreeMarker placeholders (`${input.X!}`,
  `<#if>`), ready to paste into Amplitude Data → Destinations → Webhook.

  Triggers (RU/EN): "сгенери payload для slack", "amplitude → slack payload",
  "сделай webhook template для event X", "amplitude payload для евента", "make
  slack payload for amplitude event", "generate amplitude webhook template".

  Do NOT use for: Slack-bot creation, Slack Workflow Builder, Amplitude
  Notifications/Alerts (chart-based), or any non-event-trigger Slack integration.
---

# Amplitude → Slack Webhook Payload Generator

Генерирует payload-шаблон для Amplitude Data → Destinations → Webhook,
который отправляет конкретный analytics event в Slack channel через Incoming
Webhook URL.

## Обязательные элементы в payload (без исключений)

Каждый сгенерированный payload **ОБЯЗАН** содержать:

1. **Название event'а в заголовке** — самой первой строкой, формат `<header_emoji> *<EVENT_NAME>*`. Под заголовком обязательно **две пустые строки** (т.е. `\n\n\n` между заголовком и первой строкой контента), чтобы визуально отделить шапку.
2. **Все параметры** event'а — каждый параметр на **отдельной строке** с **собственным эмодзи** в начале строки (см. таблицу «Эмодзи на каждую строку» ниже). Склеивать поля через `·` в одну строку **запрещено** — каждое поле выделено.
3. **Ссылка на профиль пользователя в Amplitude** — `https://app.amplitude.com/analytics/<org>/project/<project_id>/search/${input.user_id!}/activity` последней строкой, тоже с эмодзи (`:link:` по умолчанию).

Если любой из трёх элементов отсутствует — payload **не возвращать**, дописать.

---

## Процесс

### Шаг 1 — определить входной режим

Возможны два режима:

| Режим | Триггер | Что делать |
|---|---|---|
| **A. Из кода** | Пользователь дал только имя event'а (например, `Submit Purchase Error Support`) | Grep по проекту: `pattern="\"<event_name>\""` → найти файл с `AnalyticsEvent(type = "...", extras = listOf(...))` или эквивалентом → прочитать список параметров |
| **B. Из описания** | Пользователь сам перечислил имя + параметры (или код недоступен) | Использовать заявленные параметры как есть |

Если режим неоднозначен — сначала попробовать grep. Если найдено 0 совпадений и нет явного списка — задать `AskUserQuestion` с двумя опциями:
- `Перечислить параметры вручную` (free text)
- `Уточнить имя event'а` (re-grep с другим именем)

### Шаг 2 — найти Amplitude org + project id

URL на пользователя в Amplitude имеет вид:
`https://app.amplitude.com/analytics/<org>/project/<project_id>/search/${input.user_id!}/activity`

`<org>` и `<project_id>` — project-specific. Источники:
1. **Grep по проекту** на `app.amplitude.com/analytics/` — обычно встречается в существующих доках/скриптах/README. Это первый источник.
2. Если не найдено — `AskUserQuestion` с двумя полями:
   - org (e.g. `myorg`)
   - project_id (e.g. `123456`)
   - Подсказка пользователю: «открой Amplitude → правый верх → Settings → Projects → нужный → URL содержит `/project/<id>/`».

Сохранить найденные значения в project memory (`amplitude_project_url.md`) на будущее.

### Шаг 3 — собрать payload

Применить дефолтную структуру (см. ниже **Шаблон**). Правила:

**3.1. Заголовок и пустая строка.** Первая строка — `<header_emoji> *<EVENT_NAME>*`. После неё **две пустые строки** (`\n\n\n` между заголовком и первой строкой контента) для воздуха в Slack. Header-эмодзи выбирается из таблицы по семантике:

  | Категория event'а | Header эмодзи |
  |---|---|
  | Submit / Error / Failure | `:warning:` |
  | Feedback / Suggestion / Send | `:memo:` |
  | Purchase / Subscription Success | `:moneybag:` |
  | Sign Up / Login / Auth | `:wave:` |
  | Default | `:bell:` |

**3.2. Каждая строка контента — со своим эмодзи на первой позиции.** Никаких голых `Label: value` — у любой строки контента префикс-эмодзи. Подбор по таблице «Эмодзи на каждую строку» (см. ниже). Принцип: эмодзи семантически отражает тип данных (email → 💌, location → 📍, error → ❌). Если для специфического параметра нет очевидного эмодзи — `:label:` (универсальный fallback).

**3.3. Платформенная строка — условный эмодзи через FreeMarker:**
  ```
  <#if (input.platform!'') == 'iOS'>🍎<#elseif (input.platform!'') == 'Android'>🤖<#else>🌐</#if> Платформа: ${input.platform!} ${(input.version_name!input.app_version!'')} (${input.os_name!} ${input.os_version!})
  ```

  **Версия приложения — `version_name` с fallback на `app_version`.** Android SDK (`amplitude-analytics-android` 1.20+) пишет версию приложения в top-level поле `version_name` (это то, что Amplitude UI показывает как «App Version»). iOS / Web SDK пишет в `app_version`. Голый `${input.app_version!}` на Android-only event'ах рендерит пустую строку → двойной пробел в Slack-сообщении (`Android  (android 16)`). Fallback-форма `${(input.version_name!input.app_version!'')}` покрывает обе платформы. Прецедент 2026-05-14 (`Submit Purchase Error Support`, Pixel 9 / Android 16 / SDK 1.26.5).

**3.4. Каждое поле — отдельной строкой через `\n`.** Склеивать второстепенные через `·` в одну строку **запрещено** (это противоречит правилу «эмодзи на каждой строке»). Длинный список из 8-10 параметров — это 8-10 строк, не «3 главные + 1 склейка».

**3.5. Ссылка на Amplitude — последней строкой с эмодзи + Slack named-link:**
  ```
  :link: <https://app.amplitude.com/analytics/<org>/project/<id>/search/${input.user_id!}/activity|Открыть профиль в Amplitude>
  ```

  **Использовать Slack named-link `<url|label>`, а не голую URL.** Slack рендерит длинную URL как auto-unfurl preview — текст URL в сообщении выглядит громоздко, и при copy-paste из Slack desktop hyperlink обрезается до видимого якорного текста, оставляя только `:link: Ссылка на Amplitude:` без URL. Named-link даёт короткий кликабельный текст («Открыть профиль в Amplitude»), визуально чище, и URL гарантированно копируется (Slack экспортирует якорь как plain `<url|label>`-форму или как «Открыть профиль в Amplitude (https://...)»). Прецедент 2026-05-14 (`Submit Purchase Error Support` — пользователь скопировал сообщение, URL пропала, debug-итерация).

### Шаг 4 — вывести payload + sample event JSON в чат

**Всегда два code-блока подряд**, в этом порядке:

1. **Payload template** — JSON в fenced code block с шапкой `Payload template (вставить в Amplitude → Webhook destination → Payload template):`.
2. **Sample Event Payload** — JSON в fenced code block с шапкой `Sample Event Payload (вставить в Amplitude → Verify connection with test data → Sample Event Payload):`. Используется при Send Test Event, чтобы убедиться, что template рендерит без ошибок и Slack получает корректное сообщение.

После двух блоков — короткий блок «Что в payload»: list какие параметры использованы и какие пропущены (если, например, `source` — хардкод и не нести в Slack).

**Sample event JSON генерируется автоматически** по правилам Шага 4.5 ниже — не спрашивать у пользователя.

### Шаг 4.5 — генерация Sample Event Payload

Sample — это JSON, имитирующий реальный Amplitude event. Он должен содержать **все поля, к которым обращается template**, иначе при Send Test Event значения отрендерятся пустыми и проверка ничего не покажет.

**Структура (всегда):**

```json
{
  "user_id": "test_user_123",
  "device_id": "test_device_abc",
  "event_type": "<EVENT_NAME>",
  "event_time": "<TODAY YYYY-MM-DD HH:MM:SS>",
  "platform": "Android",
  "version_name": "<latest version или 1.0.0>",
  "os_name": "android",
  "os_version": "16",
  "country": "United States",
  "event_properties": {
    "<param1>": "<реалистичное значение>",
    "<param2>": "<реалистичное значение>"
  },
  "user_properties": {
    "email": "test@<project>.dev"
  }
}
```

**Правила подбора значений в `event_properties`** (важно для useful Send Test Event):

| Тип параметра по имени | Тестовое значение |
|---|---|
| `text`, `message`, `feedback`, `comment` | Реалистичная фраза на русском, ~10-20 слов, отражающая контекст event'а (для error — «Покупка не прошла…», для feedback — «Хочу добавить функцию…») |
| `email*` | `"test@<project>.dev"` (берётся из git remote или просьба к пользователю) |
| `productID`, `productId`, `sku`, `product` | Пример SKU из проекта (грепнуть по `.yearly_*`, `.monthly_*` для подсказки) или `"com.<project>.yearly_v1"` |
| `purchaseType`, `subscription_type` | `"trial"` (более редкий случай, интересен для проверки) или `"sub"` |
| `offerName`, `offer`, `promo` | Пример offer-id из проекта (грепнуть на `OnboardingOffer`, `*SubscriptionOffer`) или `"DefaultOffer"` |
| `location`, `source`, `screen`, `from` | `"onboarding"` или `"paywall"` или `"profile"` |
| `errorMessage`, `error_code`, `errorCode` | `"BILLING_UNAVAILABLE"` или `"NETWORK_TIMEOUT"` или `"USER_CANCELLED"` |
| `optionalErrorMessage`, `error_details`, `stackTrace` | Многострочная строка типа `"Google Play Billing service is unavailable on this device. com.android.billingclient.api.BillingClient.queryPurchases() failed with response code 3"` |
| `userId`, `user_id` в event_properties (дубль `input.user_id`) | Совпадает с верхним `user_id` — `"test_user_123"` |
| `userCancelled`, `isCancelled` | `false` (более интересный кейс — реальная ошибка) |
| `isSandbox`, `isDebug` | `false` |
| Boolean (другие) | `false` (или `true` если ветка `<#if>` это требует) |
| Numeric (`price`, `amount`, `duration`) | Реалистичное число (`9.99`, `100`, `30`) |
| Date / timestamp | ISO 8601 string или Unix epoch |
| Enum (по контексту имени) | Самый «интересный» вариант из найденных в коде enum'а |
| Hardcode-параметры (`source = "purchaseErrorDialog"`) | Точное значение хардкода |
| Unknown | `"sample_<param_name>"` |

**Платформа в sample — Android по умолчанию.** Это даёт 🤖 в FreeMarker `<#if>`, что визуально подтверждает, что условный эмодзи работает. Если пользователь явно сказал «тест для iOS» или «для web» — поменять поля версии и os: Android → `"version_name"` + `"os_name": "android"` + `"os_version": "16"`; iOS → `"app_version"` + `"os_name": "iOS"` + `"os_version": "17"`; Web → `"app_version"` + `"os_name": "Web Browser"` + `"os_version": ""`. Платформенный template `${(input.version_name!input.app_version!'')}` корректно покрывает все три варианта.

**`event_time`** — сегодняшняя дата в формате `"YYYY-MM-DD HH:MM:SS"` (NOT ISO 8601 — Amplitude использует свой формат для Sample).

**`user_properties.email`** — `test@<project>.dev` (project = basename git root). Только если template обращается к `input.user_properties.X` — иначе можно опустить блок.

### Шаг 5 — опционально: сохранить в файл

Если пользователь говорит «сохрани в файл», «выгрузи в md», «открой отдельным файлом» — создать файл:

`docs/integrations/amplitude-slack-<event-slug>-<YYYY-MM-DD>.md`

(если папка `docs/integrations/` не существует — создать, она project-local).

**В файле — два code-блока: Payload template + Sample Event Payload**, в этом порядке, разделённые минимальными h2-заголовками. Никаких frontmatter, объяснений, таблиц, troubleshooting — пользователь хочет копировать оба JSON без терминала, без отделения от обвязки.

Шаблон файла (буквально, ничего больше):

````markdown
# <Event Name>

## Payload template

```json
{
  "text": "...полный payload..."
}
```

## Sample Event Payload

```json
{
  "user_id": "test_user_123",
  ...
}
```
````

Никаких других разделов. Если пользователь явно попросит «добавь объяснения» / «добавь troubleshooting» — тогда добавлять, иначе нет.

После создания — открыть через `start <path>` (Windows) / `open <path>` (Mac) и сказать пользователю «файл открыт; верхний блок → Payload template в Amplitude; нижний блок → Sample Event Payload для Send Test Event».

---

## Шаблон по умолчанию

```json
{
  "text": "<header_emoji> *<EVENT_NAME>*\n\n\n<platform_block>\n:bust_in_silhouette: Id: ${input.user_id!}\n<line_per_param_with_emoji>\n:link: <https://app.amplitude.com/analytics/<org>/project/<id>/search/${input.user_id!}/activity|Открыть профиль в Amplitude>"
}
```

Ключевое: **`\n\n\n` после заголовка** (две пустые строки) + **каждое поле — своя строка со своим эмодзи** + **ссылка через Slack named-link `<url|label>`** (см. правило 3.5).

Пример полного payload для `Submit Purchase Error Support` (10 параметров):

```json
{
  "text": ":warning: *Submit Purchase Error Support*\n\n\n<#if (input.platform!'') == 'iOS'>🍎<#elseif (input.platform!'') == 'Android'>🤖<#else>🌐</#if> Платформа: ${input.platform!} ${(input.version_name!input.app_version!'')} (${input.os_name!} ${input.os_version!})\n:bust_in_silhouette: Id: ${input.user_id!}\n:email: Email для ответа: ${input.event_properties.emailToAnswer!}\n:package: Product: ${input.event_properties.productID!}\n:credit_card: Purchase type: ${input.event_properties.purchaseType!}\n:fire: Offer: ${input.event_properties.offerName!}\n:round_pushpin: Location: ${input.event_properties.location!}\n:speech_balloon: Текст: ${(input.event_properties.text!'')?json_string}\n:x: Error: ${(input.event_properties.errorMessage!'')?json_string}\n:information_source: Optional: ${(input.event_properties.optionalErrorMessage!'')?json_string}\n:link: <https://app.amplitude.com/analytics/myorg/project/123456/search/${input.user_id!}/activity|Открыть профиль в Amplitude>"
}
```

---

## Поиск параметров в коде — грабли

Имена параметров в Amplitude передаются ровно так, как написаны в коде — **регистр имеет значение**. Типичные подводные камни:

1. **Случайные `productID` vs `productId`** — заглавная/строчная буква на конце ломает шаблон молча (FreeMarker вернёт пустоту вместо null-ошибки благодаря `!`). После grep'а проверять каждое имя глазами. Не «угадывать» канонический регистр.
2. **`AnalyticsEvent.Param("name", value)`** — типовой паттерн в твоём проекте. Имя — первый аргумент строкой.
3. **`logEvent(name, properties = mapOf(...))`** — альтернативный паттерн в других проектах. Ключи map'а — это имена параметров.
4. **Дублирующие источники** (например, `userId` в event_properties **и** дефолтный `input.user_id`) — в Slack использовать стандартный `input.user_id` (он Amplitude-нативный, не зависит от ручного логирования).
5. **Хардкод-параметры** (типа `source = "purchaseErrorDialog"`) — не нести в Slack, они всегда одно значение и засоряют сообщение.

---

## FreeMarker null-safety — обязательно

- **`${input.event_properties.X!}`** — оператор `!` без аргумента возвращает пустую строку, если X отсутствует. **Каждый** `${...}` должен иметь `!` либо `!"<дефолт>"`. Без него Amplitude дропнет доставку.

- **🚨 Default-operator `!` имеет очень низкий приоритет.** В `<#if>` обязательно оборачивать **всё default-выражение** скобками, **включая правую часть**:

  | ❌ ПАДАЕТ | ✅ РАБОТАЕТ |
  |---|---|
  | `<#if (input.X)!'' == 'Y'>` | `<#if (input.X!'') == 'Y'>` |
  | `<#if (input.X)!"" == "Y">` | `<#if (input.X!"") == "Y">` |

  Почему: FreeMarker парсит `(input.X)!'' == 'Y'` как `(input.X)!('' == 'Y')` — сначала evaluates `'' == 'Y'` (boolean false), потом подставляет как fallback к строковой `input.X`. Падает с `Expected a boolean, but this has evaluated to a string`. Закрывающая скобка **после** правой части default-expression фиксит парсинг.

  Прецедент 2026-05-14 (Submit Purchase Error Support): первая отправленная версия `(input.platform)!'' == 'iOS'` валилась с `Error executing transformation: For "#if" condition: Expected a boolean`. Фикс — `(input.platform!'') == 'iOS'`.

- **`<#if (input.X!false)>`** — для boolean-полей. Та же скобка-правило.

- **`?json_string` для пользовательских строк** — `${(input.event_properties.text!'')?json_string}`. Без него `"` или `\n` в пользовательском вводе ломают итоговый JSON. Обязательно для: text/message/feedback/errorMessage/optionalErrorMessage/stackTrace полей.

- **Single quotes vs double quotes в template** — Amplitude нормализует обе формы, но **single quotes `'iOS'`** удобнее: не нужен JSON-escape, читаемость выше. Использовать по умолчанию.

- **Substring для длинных error** — `${(input.event_properties.errorMessage!'')?substring(0, 500)}` если message может быть огромным (RC stacktrace).

---

## Эмодзи на каждую строку

Каждая строка контента — со своим эмодзи в начале. Unicode (🍎🤖🌐) работает во всех Slack workspace; shortcode `:apple:` есть по дефолту, `:android:` — обычно нет (custom only). Для платформ всегда Unicode.

### Header (первая строка с именем event'а)

| Категория event'а | Эмодзи | Альтернативы |
|---|---|---|
| Submit / Error / Failure | `:warning:` | `:rotating_light:`, `:sos:` |
| Feedback / Suggestion / Send | `:memo:` | `:writing_hand:`, `:speech_balloon:` |
| Purchase / Subscription Success | `:moneybag:` | `:credit_card:`, `:tada:` |
| Sign Up / Login / Auth | `:wave:` | `:key:`, `:lock:` |
| Default | `:bell:` | `:information_source:` |

### Контентные строки

| Поле / тип данных | Эмодзи | Альтернативы |
|---|---|---|
| Платформа iOS | 🍎 Unicode | `:apple:` (default Slack) |
| Платформа Android | 🤖 Unicode | `:android:` (custom only) |
| Платформа Web | 🌐 Unicode | `:globe_with_meridians:` |
| User Id / userId | `:bust_in_silhouette:` | `:adult:`, `:technologist:` |
| Email | `:email:` | `:envelope:`, `:incoming_envelope:` |
| Текст / message / feedback | `:speech_balloon:` | `:memo:`, `:writing_hand:` |
| Product / productId / SKU | `:package:` | `:label:`, `:gem:` |
| Purchase type / billing | `:credit_card:` | `:moneybag:`, `:dollar:` |
| Offer / promo / discount | `:fire:` | `:gift:`, `:label:` (⚠️ НЕ `:tag:` — отсутствует в дефолтном Slack workspace, рендерится буквально как текст `:tag:`) |
| Location / screen / source | `:round_pushpin:` | `:map:`, `:compass:` |
| Error / errorMessage | `:x:` | `:bangbang:`, `:exclamation:` |
| Optional / additional info | `:information_source:` | `:wrench:`, `:gear:` |
| Sandbox / Debug / test | `:test_tube:` | `:construction:`, `:hammer:` |
| Timestamp / date | `:clock1:` | `:calendar:`, `:hourglass:` |
| Boolean (true) | `:white_check_mark:` | `:heavy_check_mark:` |
| Boolean (false) | `:x:` | `:no_entry:` |
| Country / locale | `:earth_americas:` | `:globe_with_meridians:` |
| Device / hardware | `:iphone:` | `:computer:` |
| App version | `:label:` | `:bookmark:` |
| Session | `:hourglass_flowing_sand:` | `:stopwatch:` |
| Network / API | `:satellite_antenna:` | `:globe_with_meridians:` |
| Ссылка на Amplitude (последняя строка) | `:link:` | `:chart_with_upwards_trend:` |
| **Fallback (нет очевидного)** | `:label:` | `:diamond_shape_with_a_dot_inside:` |

---

## Чек-лист перед возвратом payload пользователю

- [ ] **Заголовок первой строкой**: `<header_emoji> *<EVENT_NAME>*`.
- [ ] **Две пустые строки после заголовка**: `\n\n\n` между header и первой строкой контента (одна `\n` закрывает строку заголовка, две дают визуальный отбой).
- [ ] **Все параметры** event'а есть (минус явный hardcode и дубли `input.user_id`).
- [ ] **Каждая строка контента — со своим эмодзи** в начале строки. Голых `Label: value` без эмодзи — нет.
- [ ] **Каждое поле — на отдельной строке через `\n`**. Склеек через `·` — нет.
- [ ] **Ссылка на профиль в Amplitude** последней строкой с эмодзи `:link:` **через Slack named-link** `<url|label>` (не голая URL — см. правило 3.5).
- [ ] Каждое `${input.X}` имеет `!` или `!"default"`.
- [ ] Платформенный эмодзи через `<#if>` присутствует.
- [ ] Версия приложения — `${(input.version_name!input.app_version!'')}` (fallback Android `version_name` → iOS/Web `app_version`), не голый `${input.app_version!}` — иначе на Android-only event'ах будет двойной пробел в Slack (см. правило 3.3).
- [ ] JSON валиден (все `"` внутри `text` экранированы как `\"`).

Если пользователь попросил сохранить в файл — файл содержит **два блока (Payload + Sample)** под минимальными h2-заголовками, без обвязки.

---

## Что НЕ делает скилл

- Не создаёт Slack Incoming Webhook URL (это вручную в Slack admin / api.slack.com/apps).
- Не настраивает Amplitude destination (это вручную в Amplitude UI).
- Не отправляет тестовый event (Amplitude UI кнопка **Send Test Event**).
- Не валидирует наличие event'а в Amplitude таксономии — берёт имя из кода/пользователя как есть.
- Не пишет Cloud Functions / backend-прокси для отправки в Slack — это отдельный flow вне scope этого скилла.

---

## Related

- Анти-паттерн source (потеря параметров callback'а в KMP-абстракции): `docs/solutions/kmp/kmp-abstraction-callback-parameter-loss-2026-05-13.md` (если есть в проекте)
- Slack Incoming Webhooks docs: <https://api.slack.com/messaging/webhooks>
- Amplitude Webhook destination: <https://amplitude.com/docs/data/destinations/webhook>
- FreeMarker template syntax: <https://freemarker.apache.org/docs/dgui_template_overallstructure.html>
