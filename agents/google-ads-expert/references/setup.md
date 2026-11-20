# Setup: Google Ads API и MCP для проекта

Шаг 0 метода `@google-ads-expert`, на каждом спавне. Быстрый путь — § 0 и § 4: ключ есть и проверка прошла, дальше не идёшь. Остальные разделы — только по результату проверки.

Схема: у каждого проекта свой Cloud-проект (колонка `gcp_project` реестра `~/.claude/config/project-credentials.local.md`). В нём включается Google Ads API, в нём живёт service account, его уровень доступа к API (Test / Explorer / Basic / Standard) решает, можно ли читать боевой кабинет. Ключ лежит вне репозиториев: `~/.config/google-ads-mcp/<P>/credentials.json`. Лаунчер `scripts/mcp_launch.py` передаёт серверу именно этот путь; общий ADC gcloud сервер не видит.

## 0. Конфигурация

```bash
python "$HOME/.claude/agents/google-ads-expert/scripts/mcp_launch.py" --print-config
```

- `gcp_project: null` → `STATUS: NEEDS_INPUT`: у `repo_root` в реестре пустой `gcp_project`. Главный заполняет реестр. Лаунчер читает реестр при старте сервера, поэтому новое значение работает только со следующего спавна.
- `credentials_exists: true` → § 4.
- `credentials_exists: false` → § 1, § 2, § 3, § 4 по порядку. Сервер перечитывает ключ на каждом вызове: ключ, созданный в § 2, работает в этом же спавне.

Ниже `<P>` — значение `gcp_project`, `<SA>` — `google-ads-agent@<P>.iam.gserviceaccount.com`. Аккаунт gcloud подставляет хук `account-align` по реестру; `--account` руками не добавляй и аккаунт не переключай.

## 1. Google Ads API в Cloud-проекте

```bash
gcloud services list --enabled --project=<P> --filter="config.name=googleads.googleapis.com" --format="value(config.name)"
```

Пустой вывод → `gcloud services enable googleads.googleapis.com --project=<P>`. Включение API бесплатно. После включения у проекта уровень Test.

## 2. Service account и ключ

```bash
gcloud iam service-accounts describe <SA> --project=<P> --format="value(email)"
```

Нет → `gcloud iam service-accounts create google-ads-agent --display-name="Google Ads agent" --project=<P>`.

```bash
mkdir -p "$HOME/.config/google-ads-mcp/<P>"
gcloud iam service-accounts keys create "$HOME/.config/google-ads-mcp/<P>/credentials.json" --iam-account=<SA> --project=<P>
```

- Ключ — секрет. Содержимое не читай, не печатай и не копируй в репозиторий; проверка — только наличие файла.
- Перед созданием посмотри `gcloud iam service-accounts keys list --iam-account=<SA> --managed-by=user`. Старые ключи есть, а файла нет — новый ключ создай, старые не удаляй сам: перечисли их главному с предложением удалить.
- Ошибка `constraints/iam.disableServiceAccountKeyCreation` (политика организации) → § 5.

## 3. Ручные шаги пользователя

Агент их сделать не может. Верни их главному блоком «Ручные шаги» с подставленными значениями.

1. **Доступ SA в кабинет.** [Google Ads](https://ads.google.com/) → Admin → Access and security → Users → «+» → email `<SA>` → уровень доступа. Standard — для записи ассетов и меток через MCP и для будущих изменений через API; Read only — только отчёты. Кабинет под MCC — выдавать доступ можно на уровне MCC.
2. **Уровень Explorer для боевого кабинета.** [Google Ads API в Cloud Console](https://console.cloud.google.com/apis/api/googleads.googleapis.com/overview) → проект `<P>` → заявка на доступ Explorer. Проверка обычно автоматическая. На уровне Test API работает только с тестовыми кабинетами. Лимит Explorer на боевых кабинетах — 2 880 операций в сутки (снимок 2026-11-20, `https://developers.google.com/google-ads/api/docs/api-policy/access-levels`).

## 4. Проверка

1. Имена инструментов — `ToolSearch` с запросом `+google-ads`. Инструментов нет совсем → сервер не поднялся: `STATUS: BLOCKED` с выводом `--print-config` и командой ручного запуска `python "$HOME/.claude/agents/google-ads-expert/scripts/mcp_launch.py"` для главного.
2. `customers_list_accessible_customers` → в списке есть кабинет проекта.
3. `search_search` c `customer_id` кабинета и запросом `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer` → вернулась одна строка.
4. Кабинет под MCC → `login_customer_id=<MCC>` в каждом вызове, у которого есть этот параметр (у `customers_list_accessible_customers` его нет).

| Ошибка | Причина | Действие |
|---|---|---|
| `DefaultCredentialsError`, `File ... was not found` | нет ключа | § 2 |
| `SERVICE_DISABLED`, `googleads.googleapis.com has not been used` | API не включён | § 1 |
| `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` (до v25 — `ACTION_NOT_PERMITTED`) | у проекта уровень Test | § 3.2, ждать одобрения |
| пустой список кабинетов, `USER_PERMISSION_DENIED` | SA не добавлен в кабинет | § 3.1 |
| `RefreshError`, `invalid_grant` | ключ SA удалён, SA отключён или OAuth-токен отозван | SA — новый ключ по § 2; OAuth — повторный вход по § 5 |
| `PERMISSION_DENIED` от gcloud | у аккаунта нет прав в Cloud-проекте | `STATUS: NEEDS_INPUT` с аккаунтом и проектом |

После успеха запиши в свою память строку проекта: `repo_root`, `gcp_project`, `customer_id`, MCC, валюта, часовой пояс, уровень доступа, способ авторизации (SA или OAuth), дата проверки.

## 5. Запасной путь: OAuth пользователя

Когда: политика организации запрещает ключи SA, или Google Ads не принимает SA. Под Workspace-аккаунтом с session control токен пользователя живёт ~12-16 ч — для таких проектов это временная мера, сообщи об этом в отчёте.

Ручные шаги пользователя (верни главному):

1. [Google Auth Platform](https://console.cloud.google.com/auth/overview) → проект `<P>` → Audience: External, статус **In production**. В статусе Testing refresh token живёт 7 дней.
2. Clients → Create client → Desktop app → скачать JSON в `~/.config/google-ads-mcp/<P>/client_secret.json`.
3. Вход в отдельный каталог gcloud, общий ADC не трогается (пользователь запускает с префиксом `!`):

   ```bash
   CLOUDSDK_CONFIG="$HOME/.config/google-ads-mcp/<P>/gcloud" gcloud auth application-default login --client-id-file="$HOME/.config/google-ads-mcp/<P>/client_secret.json" --scopes=https://www.googleapis.com/auth/adwords,https://www.googleapis.com/auth/cloud-platform
   ```

После входа агент сам: проверяет, что файл `~/.config/google-ads-mcp/<P>/gcloud/application_default_credentials.json` появился и что дата изменения общего `%APPDATA%\gcloud\application_default_credentials.json` не изменилась; копирует файл в `~/.config/google-ads-mcp/<P>/credentials.json`; выполняет § 4. То, что gcloud кладёт ADC внутрь `CLOUDSDK_CONFIG`, официальная дока прямо не подтверждает — поэтому проверка обязательна.
