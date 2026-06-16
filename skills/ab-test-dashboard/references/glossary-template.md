# Glossary Header Template

Markdown rich_text content for the first row of the dashboard. Replace `<...>` placeholders with values gathered in Step 1. Adapt sections based on test type — subscription tests need checkpoints, UI tests don't.

---

## Universal template (revenue/ARPU test)

```markdown
# A/B <Test Name> — <Platform> <Metric Name>

**Запущен:** <YYYY-MM-DD> (реальный сигнал ждите через <N> дней) | **Платформа:** <Platform> | **Split:** <A%> A / <B%> B

## Варианты

|   | Variant ID (`<propertyName>`) | <Detail Column> | Trafic share |
|---|---|---|---|
| **A (control)** | `<controlValue>` | <controlDetail e.g. "$3.99/wk"> | <A%> |
| **B (test)** | `<testValue>` | <testDetail e.g. "$7.99/wk (2×)"> | <B%> |

## Метрика: <Metric Name>

<formula explanation in 1-2 sentences>

Formula в чарте: `<formula expression>` где A=<eventA description>, B=<eventB description>, C=<eventC description>.

## Почему <Metric Name>, а не <obvious-but-wrong alternative>

<1-3 sentences explaining the methodology choice — e.g. why ARPU instead of Total Revenue when split is not 50/50; why Day-7 minimum for weekly subscription>

## Как читать

- **Столбик B > A** — <interpretation: e.g. "новый оффер выигрывает (2× цена перевесила любое падение конверсии)">
- **Столбик B < A** — <interpretation: e.g. "старый оффер выигрывает (падение CR не окупилось ростом цены)">
- **B ≈ A** — ничья, продолжать control

## Чекпоинты

- **Day 1 (сейчас):** данных почти нет — только смотрим что split работает (B получает трафик)
- **Day <N> (~<YYYY-MM-DD>):** <first meaningful checkpoint — e.g. первый renewal-цикл weekly-subscription>
- **Day <M> (~<YYYY-MM-DD>):** <full LTV checkpoint — e.g. 4 renewals, полный LTV-proxy. Решение о роллауте принимаем сюда>

## Статистическая значимость

Revenue распределён не нормально (right-skewed). Для p-value — Mann-Whitney/Wilcoxon, не t-test. При lift 1.5–2× и cohort >~1500 юзеров на variant результат визуально доверителен. До этого — не делать выводов.
```

---

## Conversion / activation test variant

Replace "Метрика" section:

```markdown
## Метрика: Conversion Rate <entryEvent> → <successEvent>

% пользователей которые после `<entryEvent>` совершили `<successEvent>` в течение <conversionWindow>.

## Почему conversion, а не revenue

Тест меняет UI/copy — цена та же, поэтому revenue per user не меняется. Что меняется — доля пользователей доходящих до покупки. Если CR(B) > CR(A) — версия B лучше при равной стоимости подписки.
```

Replace "Чекпоинты" section:

```markdown
## Чекпоинты

- **Day 1 (сейчас):** проверка split — B получает трафик
- **<conversionSeconds в днях> с момента старта когорты:** первый достоверный сигнал на cohort'е достаточного размера
- **Cohort >~1500 на variant:** lift > 10% обычно достоверен
```

---

## Retention test variant

Replace "Метрика" section:

```markdown
## Метрика: <N>-day Retention

% пользователей которые сделали `<startEvent>` в день 0 и вернулись с `<returnEvent>` к дню <N>.

## Почему retention, а не conversion

Тест меняет <feature/notification/onboarding> — эффект проявляется не сразу при покупке, а на возвращении в продукт. Retention curve показывает через сколько дней эффект становится видимым.
```

---

## Multi-metric variant (rare — only when test legitimately has 2+ winning conditions)

Add second "Метрика" section:

```markdown
## Дополнительная метрика: <secondary metric>

<reason this is also tracked>

Чарт ниже показывает <secondary chart description>.
```

Then place a second chart row in the dashboard.

---

## Style notes

- Headers `## <Name>` — sentence case, no period
- Code in backticks: variant values, property names, formulas, event types
- Bold **B > A** / **B < A** for the read-instructions
- Dates in absolute form (YYYY-MM-DD) in checkpoints — relative ("через 7 дней") rots when read later
- Always include the data caveat for early days ("данных почти нет — только смотрим что split работает")
- `start` = the experiment's **exact launch moment** (Firebase `experiments/{N}.startTime`), not 00:00 of the launch day. Header must carry the **test age** ("идёт ~N дней на момент сборки") so a 2-day-old weekly-sub test isn't read as a verdict (pitfall 18)
- For revenue tests where the variant axis is `product_id` (Google Play price points), state both: Total Revenue is splittable incl. renewals (product_id persists), BUT until Day {period} the Baseline product carries renewal from pre-test subscribers while the new Treatment product can't — compare Initial Revenue first (pitfall 14/17)
