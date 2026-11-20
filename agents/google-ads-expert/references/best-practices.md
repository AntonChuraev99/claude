# Google Ads — справочник `@google-ads-expert`

Снимок на 2026-11-20 (первоисточники Google, прочитаны в этот день). У большинства страниц Google Help нет даты обновления, и Google меняет пороги без changelog. Поэтому **любую цифру из этого файла перед решением перепроверь по URL из § 11 «Читать вживую»** и укажи дату проверки в отчёте. Принципы из § 1 устойчивы, их можно применять без перепроверки; цифры в § 9 перепроверяй, как и везде.

Метки: `[G]` — первоисточник Google; `[3P]` — сторонний источник, только дополнение; `UNVERIFIED` — до владельца факта не доведено. Конфликт источников показан обеими версиями, решение для агента — рядом.

## 1. Принципы (устойчивые)

1. Smart Bidding оптимизирует ровно то, что помечено целью. Ошибка в цели или конверсиях стоит дороже любой ставки: начинай аудит с конверсий, а не со ставок.
2. Цель bidding — один этап воронки, лучше с коротким лагом. В tCPA App-кампании — одно in-app событие.
3. Каждая правка — либо сброс обучения, либо трата. Меняй редко, мелким шагом, по одной переменной, и записывай дату правки.
4. Новая цель — новая кампания, а не правка живой.
5. Оценивай кампанию после обучения: 1-2 конверсионных цикла или ~14 дней, и с поправкой на лаг конверсий (последние дни не считаются).
6. Пост-клик ROAS кабинета — это атрибуция, а не причинность. Решение о масштабировании подтверждай экспериментом (§ 8).
7. Рекомендации Google и Optimization score оценивают «настроенность» аккаунта, а не результат. Auto-apply выключен, рекомендации применяются точечно и по одной.

## 2. Цели и конверсии

- **Primary vs Secondary.** Primary — в колонке Conversions и в bidding; Secondary — только наблюдение (All conversions). Primary ставь только тем действиям, под которые оптимизируешься. GA4-конверсии импортируются как Secondary, Primary переключается в Google Ads; при дублях с UA — GA4 Primary, UA Secondary. Исключение: Secondary внутри custom goal участвует в bidding. [G] 11461796
- **Account-default goals** держи одинаковыми для веб-кампаний; custom goal — для нестандартной цели, не больше одного на кампанию. [G] 4677036, 11461796
- **App campaigns:** конверсии выбираются на уровне кампании, account-default goals к ним не применяются. [G] 9143218 (4677036 — только через поиск)
- **Событие для tCPA:** его делают ≥10 разных пользователей в день. Иначе бери более частое событие-предшественник. [G] 6167156, 6167162
- **Install без ценности:** не присваивай ценность install, если у него нет своей экономической ценности. [G] 14104492
- **Value-bidding:** ≥2 разные ненулевые ценности, нулевые не слать, ≥15 конверсий в месяц, загрузка конверсий ежедневно. Перед включением копи ценности 4 недели или 1-2 конверсионных цикла, что дольше (конфликт: 14792795 говорит 3 недели, 6268637 — 4; бери 4). Историю не backfill. [G] 14791574, 6268637
- **Dynamic vs static value:** dynamic, когда суммы разные; static — когда цена одна. Value rules (множители по аудитории, гео, устройству) работают в Search, Shopping, Display, PMax. [G] 14791574
- **Окна:** для App tROAS окно <30 дней и захватывает ~90% конверсий. До 100 конверсий окна и counting не меняй. [G] 14104492, 9176652
- **Атрибуция:** data-driven по умолчанию; first click, linear, time decay, position-based удалены; last click остаётся. [G] 6259715, 10762625
- **Auto-tagging** включён всегда — без него не работает атрибуция app-конверсий. [G] 14104492
- **Enhanced conversions** (web, leads): хешированные first-party данные дополняют тег, не заменяют. В API v26 поле `enhanced_conversions_for_leads_enabled` удалено, вместо него `enablement_setting`. [G] 9888656, release notes
- **Consent Mode v2:** сигналы `ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`. Advanced — теги грузятся, cookieless pings, модель по рекламодателю (точнее); basic — теги ждут согласия, модель общая. Результат моделирования — после ≥7 полных дней. [G] 10000067
- **Firebase/GA4 для приложений:** свяжи Firebase-проект с Google Ads, импорт — Conversions → + → App → Google Analytics 4 (Firebase). Импортируются только key events; конверсии считаются с момента импорта; пропагация 24-48 ч. UA-конверсии только Secondary (иначе дубли с GA4). [G] 6397604
- **tROAS в App** требует Firebase SDK и ценность события из SDK (на Android работает и Google Play codeless). [G] 6268637, 7100895
- **Conversion adjustments** (рефанды): retraction — удалить конверсию, restatement — изменить ценность. Окно 54 дня, нужен order ID, загрузка ≥24 ч после конверсии, retraction необратим. Описано для offline/imported конверсий; для Firebase/app-конверсий поддержка `UNVERIFIED`. [G] 7686280

## 3. Ставки и обучение

| Стратегия | Минимум данных [G] 6268637, 10285843 |
|---|---|
| tROAS Search / Shopping | 15 конверсий за 30 дней |
| tROAS App | 10 конверсий в день или 300 за 30 дней |
| tROAS Demand Gen | 50 за 35 дней, из них 10 за последние 7 |
| Стабильное попадание в таргет | ~30 конверсий в месяц |

- **Обучение по объёму** [G] 10285843: <30 конверсий — колебание CPA/ROAS до 100%, до 4 недель; 50 — до 50%, до 3 недель; 100+ — до 20%, до 2 недель. Не трогай ≥2 недели.
- **Что запускает Learning:** новая кампания или стратегия, пауза/включение, включение/выключение трекинга, смена целей. В App изменение ставки и бюджета Learning не запускает. [G] 6167156
- **Шаг правки:** App — бюджет и таргет ≤20% за раз; Demand Gen — 5-10% в неделю, максимум 15%. Для Search Google шаг не называет: держи ≤15-20% `[3P]`. [G] 9176652, 16797388
- **Стартовый таргет** = фактический CPA/ROAS за 30 дней без последних дней лага. [G] 10285843, 6268637
- **Новый таргет проверяй** через «Save as experiment». [G] 6268637
- **Расход за день** может доходить до 2× дневного бюджета; за месяц — не больше 30,4× дневного. Учитывай это в таблице «ожидаемый расход». [G] 6268637
- **Изменение 2026-08-17:** budget-limited кампании с target-based bidding тянутся к заявленному CPA/ROAS. Затронуты Search, Shopping, PMax, Demand Gen, Travel. App campaigns и Video reach/view не затронуты. Google сам таргеты и бюджеты не меняет. [G] 17061251
- **Seasonality adjustments и data exclusions** — правила `UNVERIFIED`, перед применением читай Help вживую.

## 4. App campaigns

- **Типы** [G] 15997092: ACi (установки), ACe (вовлечение; нужно ≥50 000 установок, deep links, списки аудиторий), ACPre (pre-registration, только Android, запуск в течение 90 дней).
- **Цель → стратегия:** объём установок — tCPI или Max conversions (installs); установки с действием — tCPI «users likely to perform in-app action» (таргет ≥ all-users tCPI +20%); in-app действие — tCPA или Max conversions (in-app); ценность — tROAS или Max conversion value (статус beta проверяй вживую). [G] 15997092, 12073727
- **Бюджет к таргету:** tCPI и ACPre — ≥50×; ACi tCPA — ≥10× (6167162) или 10-15× (6167156), закладывай 15×; ACe tCPA — ≥15×. [G] 6167162, 6167156, 14104492
- **tCPA:** ставь на 20% выше наблюдаемого CPA. iOS-ставки ~1,5× от Android. Несколько событий в tCPA не выбирай. tROAS — только после tCPA, чтобы был базовый ROAS. Portfolio-стратегии и shared budget для App не поддерживаются. [G] 12073727, 6167156, 6268637
- **До 100 конверсий не менять:** окна и counting, событие, цель, гео, топ-ассеты; ставки вверх-вниз не качать. [G] 6167156, 14104492
- **Ассеты на ad group:** до 10 текстов, до 20 изображений, до 20 видео (10-30 с, вертикаль, горизонталь, квадрат), для игр до 20 HTML5. Ad Strength ≥ Good; минимум один одобренный текст, картинка и видео. Слабые ассеты не удаляй — добавляй новые. В EU, India, NY, California, South Korea, Vietnam нужна AI-метка на сгенерированных ассетах. [G] 6167162, 9176652, 14104492
- **Deep links:** ACi — deferred deep links по теме ad group; ACe — deep links рекомендованы. [G] 6167162
- **Attribution sharing** включи, если в аккаунте на одно приложение есть ACi + ACe или ACi + ACPre. [G] 14104492
- **Конкуренция кампаний:** параллельные кампании на одно приложение конкурируют за пользователей — приоритет задаётся ставкой и бюджетом. [G] 6167156
- **Статусы** «Limited by budget» / «Limited by target» проверяй в каждом аудите. [G] 6167156
- **iOS:** ≤8 install-кампаний (лимит снимается для приложений с ODM event data); ODM — Firebase iOS SDK ≥12.12.1, события из primary GA4 property; Google не поддерживает AdAttributionKit, SKAN остаётся; без ATT/ODM для tCPA/tROAS используй tCPI. [G] 10384955 (updated 2026-08-19)
- **API:** бюджет только daily и не shared; ставки только на уровне кампании; `app_id`/`app_store` неизменяемы; новые кампании создавай в PAUSED. [G] developers.google.com/google-ads/api/docs/app-campaigns/create-campaign

## 5. Search и AI Max

- **Связка:** RSA + Smart Bidding + broad match. [G] 6167122
- **RSA:** ≥1 RSA с Ad Strength Good/Excellent на ad group; много уникальных заголовков и описаний; pinning — только для обязательной формулировки. [G] 6167122
- **AI Max for Search** — слой внутри Search, а не тип кампании: search term matching, text customization (бывшие automatically created assets), Final URL expansion, brand и URL inclusions/exclusions. Не работает в budget-limited кампании. При включённом Final URL expansion pinning не учитывается. Старые broad теряют приоритет exact — добавь exact-копии. Проверь tracking template с `{lpurl}` (иначе 404). Конфликт: Help — «включение включает все три компонента», API doc — «text customization и URL expansion по умолчанию выключены»; сверяй в UI кампании. [G] 15910187
- **Search Partners** включены по умолчанию в новой Search-кампании — решай явно в Networks. [G] 1722047
- **Location:** по умолчанию «Presence or interest», исключения — «Presence». Для локального или регулируемого продукта ставь Presence и смотри отчёт Locations. [G] 1722038
- **Негативы:** на уровне аккаунта до 1 000, списки 20 × 5 000 (лимиты через поиск, `UNVERIFIED`). [G] 6372658
- **Brand restrictions** (broad match) ограничивают трафик запросами с выбранными брендами. [G] 13729701

## 6. Performance Max и Demand Gen

- **PMax asset group** — по теме, категории, языку или аудитории; все типы ассетов; Ad Strength Good/Excellent; слабые ассеты не меняй 2-3 недели. [G] 14528220, 10724817
- **Audience signals** широкие, first-party (Customer Match, посетители) — ускоряют обучение. [G] 14528220
- **Search themes** необязательны, до 50 на asset group, без смысловых дублей. Search-кампания с exact-совпадением приоритетнее PMax. [G] 14767319
- **Brand exclusions и negative keywords** — на уровне кампании; не души ими inventory. PMax без brand exclusions каннибализирует бренд. [G] 16286939, 13729701
- **Final URL expansion:** Google может подменить URL, ответственность за соответствие — на рекламодателе. [G] 10724817
- **Demand Gen:** бюджет ≥10× tCPA (Help) против 15× (API guide) — закладывай 15×; здоровая кампания тратит ≤~80% бюджета; ad group <30 конверсий за 30 дней — объединяй; цель live-кампании не меняй. [G] 16797388, 15209611
- **Display → Demand Gen:** Display-кампании переезжают в Demand Gen, новые создаются там. Даты миграции `UNVERIFIED`. [G] 13695777

## 7. Подписочное приложение (Firebase + RevenueCat)

- **Trial start приходит без ценности.** Варианты: синтетическая ценность триала (доля цены) или оптимизация под subscription started / trial converted с реальной выручкой. Официального совета Google нет. `[3P]` RevenueCat community, Apphud docs.
- **Набор событий** `[3P]` (RevenueCat blog, 2026-10-16): primary — trial started (объём) или subscription started без триалов; trial converted — secondary; install — только диагностика; слать renewals. Бюджет ~10 primary-конверсий в день; не реструктурировать до 50 конверсий. Это мнение вендора.
- **Выбор события сверяй** с правилом ≥10 пользователей в день (§ 2) и с payback от `@product-expert`.
- **Рефанды подписок** через conversion adjustments для app-конверсий — `UNVERIFIED` (§ 2).

## 8. Измерение и эксперименты

- **Experiment Center:** эксперименты (настройки, креативы, ставки), custom experiments (до 5 запланированных на кампанию, одновременно один), lift studies. Для App campaigns поддержка `UNVERIFIED`. [G] 16856494
- **Geo experiments** (holdback, go-dark, heavy-up); не совмещай с user-level lift на тех же кампаниях. [G] 18073432
- **Incrementality** с 2025-11-11: минимальный расход снижен примерно с $100 000 до $5 000. [G] 16719772
- **Conversion Lift** — через представителя Google. [G] 12003020

## 9. Анти-паттерны

- Auto-apply recommendations включён (в API след виден как `change_event.client_type = GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION`); погоня за Optimization score 100%. [G] 9061546
- Две основные цели в одной App-кампании; смешанные события в tCPA. [G] 6167156, 12073727
- Бюджет <10× tCPA — главная причина недообучения; слишком жёсткий таргет — «Limited by target». [G] 16797388, 6268637
- Нулевые ценности в value-bidding. [G] 14791574
- UA-конверсии Primary рядом с GA4. [G] 12495138
- Частые правки и удаление «слабых» ассетов вместо добавления новых.
- Search Partners и «Presence or interest» оставлены по умолчанию без решения.
- Retraction без проверки order ID (необратим). [G] 7686280

## 10. Устарело и переименовано в 2025-2026

- Июнь 2026: «Maximize conversions with a Target CPA» → «Target CPA», «Maximize conversion value with a Target ROAS» → «Target ROAS». Поведение не изменилось. Страница 10962171 (2021) описывает старую схему — не бери из неё имена. [G] 6268637
- 2026-08-17: новое поведение budget-limited кампаний с таргетом (§ 3). [G] 17061251
- «Automatically created assets» → Text customization в AI Max. [G] 15910187
- Атрибуционные модели кроме DDA и last click удалены. [G] 6259715
- Location type «Search interest» удалён; исключение по «Presence or interest» невозможно (`SETTING_VALUE_NOT_COMPATIBLE_WITH_CAMPAIGN`). [G] 1722038
- Parked domains убраны из Search Partners с 2026-02-10. [G] 16286960
- Google Ads API: developer token отменён 2026-09-09, уровень доступа задаёт Cloud-проект; актуальная версия v26 (v26.2 — 2026-11-11). [G] release notes, deprecations
- Сторонние «best practices 2026» часто путают 2025 и 2026 и дают цифры без источника — не опирайся на них.

## 11. Читать вживую

Короткий номер `NNNN` = `https://support.google.com/google-ads/answer/NNNN`.

- Пороги и таргеты по типам кампаний, блок «Upcoming changes»: 6268637
- Изменение target-based bidding 2026: 17061251, FAQ 17125145
- App campaigns: best practices 14104492, goals 6167156, bid strategy 12073727, бюджеты 6167162
- iOS: 10384955
- Demand Gen: 16797388
- AI Max: 15910187
- Google Ads API release notes: `https://developers.google.com/google-ads/api/docs/release-notes`
- Bidding FAQ (WebFetch отдаёт только заголовок; нужна страница — `NEEDS_INPUT` главному, браузер у него): `https://support.google.com/google-ads/faq/10286469`

## 12. Не подтверждено первоисточником

Seasonality adjustments и data exclusions · шаг правки tCPA/tROAS для Search · conversion adjustments для Firebase-конверсий · ценность trial start · Experiment Center для App campaigns · консолидация структуры Search · enhanced app campaigns и web-to-app установки · порог моделирования consent mode · даты Display → Demand Gen и авто-миграции в AI Max · содержимое PMax channel performance report.
