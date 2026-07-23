# Amplitude→Slack payload — референс (эмодзи, пример, поиск параметров)

## Полный пример + грабли поиска параметров

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


## Структура файла при сохранении

Если пользователь просит сохранить payload в файл — ровно два блока под минимальными h2, без обвязки:

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
