# PreToolUse(Bash) guard: не дать выполнить деплой/публикацию с кредами чужого проекта.
# Читает реестр ~/.claude/config/project-credentials.local.md (шаблон — *.example.md),
# ищет строку по текущему cwd и блокирует команду с явным списком ожидаемых значений.
# Любая внутренняя ошибка => exit 0 (хук не должен ломать работу).
# Запуск: pwsh 7+, stdin = hook JSON ({tool_name, tool_input:{command}, cwd, ...}).
#
# Решение — `deny`, а не `ask`. Проверено вживую 2026-08-04: при
# `defaultMode: bypassPermissions` CLI молча проглатывает `ask`, и хук не защищал
# ничего — `gcloud deploy`-класс команд проходил без единого вопроса. `deny` в той же
# конфигурации блокирует. Снять блокировку на сессию: `CLAUDE_ALLOW_DEPLOY=1` —
# выставляет ПОЛЬЗОВАТЕЛЬ после сверки аккаунта, не агент.

$ErrorActionPreference = 'SilentlyContinue'

# Сообщения хука русские; без явного UTF-8 на stdout CLI получает mojibake.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# Запуск читающей команды сверки с жёстким таймаутом: хук не имеет права
# висеть дольше своего timeout в settings.json. Через ComSpec, потому что
# gcloud/firebase/wrangler на Windows — .cmd-шимы, напрямую не стартуют.
# Общий дедлайн на ВСЕ пробы. Раньше таймауты были per-проба (8+8+9+5 с) и суммарно
# перекрывали "timeout": 10 у самого хука в settings.json — убитый PreToolUse-хук
# решения не выносит, и команда исполнялась. То есть fail-open ровно на тех командах,
# где сверка дороже всего.
$script:Deadline = [datetime]::UtcNow.AddSeconds(6)
function Get-Budget {
    $left = [int]([datetime]::UtcNow - $script:Deadline).TotalMilliseconds * -1
    if ($left -lt 300) { return 300 }
    if ($left -gt 4000) { return 4000 }
    return $left
}

function Deny([string]$reason) {
    @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $reason } } |
        ConvertTo-Json -Depth 5 -Compress
    exit 0
}

function Get-CmdOutput([string]$command, [string]$workDir, [int]$timeoutMs = 3000) {
    $p = $null
    try {
        if (-not $env:ComSpec) { return $null }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $env:ComSpec
        $psi.Arguments = "/c $command"
        if ($workDir -and (Test-Path -LiteralPath $workDir -PathType Container)) { $psi.WorkingDirectory = $workDir }
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        # Читать ОБА потока асинхронно: нечитаемый stderr переполняет буфер пайпа
        # и вешает болтливый CLI намертво (firebase/wrangler пишут туда охотно).
        $stdout = $p.StandardOutput.ReadToEndAsync()
        [void]$p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($timeoutMs)) { try { $p.Kill($true) } catch { }; return $null }
        # WaitForExit ждёт только сам процесс; .cmd-шимы порождают внуков, которые
        # держат хендл пайпа — без своего таймаута .Result висит после выхода cmd.
        if (-not $stdout.Wait($timeoutMs)) { return $null }
        if ($p.ExitCode -ne 0) { return $null }
        return ($stdout.Result).Trim()
    } catch { return $null }
    finally { if ($p) { try { $p.Dispose() } catch { } } }
}

# Сверка «фактическое vs ожидаемое». По умолчанию — СТРОГОЕ равенство: project id
# и account_id точные, а вхождение подстроки пропускало деплой в соседний проект
# того же семейства (`myapp` внутри `myapp-staging`) — то есть ровно самую частую
# необратимую ошибку. -Loose нужен там, где фактическое приходит сырым выводом CLI
# или в другой форме записи (ssh-remote против https); там вхождение проверяется
# по границе токена. Пустое фактическое совпадением НЕ считается никогда.
function Test-CredMatch([string]$actual, [string]$expected, [switch]$Loose) {
    if ([string]::IsNullOrWhiteSpace($actual) -or [string]::IsNullOrWhiteSpace($expected)) { return $false }
    $a = $actual.Trim().ToLowerInvariant()
    $e = ($expected.Trim().ToLowerInvariant() -replace '\.git$', '').Trim()
    if ([string]::IsNullOrWhiteSpace($e)) { return $false }   # '.git' в реестре иначе давал universal-pass
    if ($a -eq $e) { return $true }
    if (-not $Loose) { return $false }

    # Вхождение только по границе: сосед справа/слева не должен быть частью имени.
    $bounded = "(^|[^\w-])$([regex]::Escape($e))($|[^\w-])"
    if ($a -match $bounded) { return $true }

    # git remote: сравнить «org/repo», чтобы ssh и https формы сошлись. Хвост
    # сравнивается равенством, иначе evil-org/repo совпадал с org/repo.
    if ($e -match '[:/]([^:/]+/[^/]+?)$' ) {
        $tailE = $Matches[1]
        if ($a -match '[:/]([^:/]+/[^/]+?)(\.git)?$') {
            if ($Matches[1] -eq $tailE) { return $true }
        }
    }
    return $false
}

try {
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }
    $payload = $raw | ConvertFrom-Json
    if ($payload.tool_name -ne 'Bash') { exit 0 }
    if ($env:CLAUDE_ALLOW_DEPLOY -eq '1') { exit 0 }

    $cmd = [string]$payload.tool_input.command
    if (-not $cmd) { exit 0 }

    # 1. Опасна ли команда: инструмент внешнего сервиса + глагол, меняющий состояние.
    #    Инструмент ищется В ПОЗИЦИИ КОМАНДЫ (начало строки либо после ; && || |), иначе
    #    блокировалось всё, где слово встречается внутри строки: `echo "firebase deploy"`,
    #    `git commit -m "fix wrangler deploy"`, тексты отчётов. До перевода на deny эти
    #    ложные срабатывания были не видны — CLI проглатывал ask.
    #    Позицию команды открывают и обёртки: `npx wrangler deploy` — канонический вызов
    #    wrangler, и без этого он обходил guard целиком (как и `pnpm dlx`, `bash -c`,
    #    префикс `VAR=1 gcloud ...`). Паттерн один на детект и на разбор сервисов —
    #    два разных выражения тихо расходились бы при правке.
    $tool = 'gcloud|wrangler|firebase|gh|adb|gsutil'
    $verb = 'deploy|publish|release\s+create|secret\s+(set|put)|functions\s+deploy|hosting:channel:deploy|pages\s+deploy|apps\s+release|repo\s+delete|uninstall|rm\s+-r'
    $wrap = '(?:(?:npx|pnpm|yarn|bunx|sudo|env|command|time|nice)\s+(?:dlx\s+|exec\s+|-\S+\s+)*|\w+=\S+\s+|bash\s+-c\s+["'']?|sh\s+-c\s+["'']?)*'
    $posRe = "(?m)(?:^|[;&|(]|&&|\|\|)\s*$wrap"
    if ($cmd -notmatch "$posRe($tool)\b" -or $cmd -notmatch "\b($verb)") { exit 0 }

    # Какие именно сервисы задействованы — от этого зависит, что сверять.
    $services = @()
    foreach ($t in $tool.Split('|')) {
        if ($cmd -match "$posRe$t\b") { $services += $t }
    }
    $services = @($services | Select-Object -Unique)
    # gsutil сверяется тем же GCP-проектом, что и gcloud — не гонять пробу дважды.
    if ($services -contains 'gcloud' -and $services -contains 'gsutil') {
        $services = @($services | Where-Object { $_ -ne 'gsutil' })
    }

    # --- Дальше опасность команды уже установлена. Отсюда fail-open недопустим:
    #     исключение на этом участке (залоченный реестр, битый JSON, сбой пробы)
    #     раньше уходило в общий catch и молча пропускало деплой.
    try {

    # 2. Реестр.
    if (-not $env:USERPROFILE) { Deny "Не удалось определить профиль пользователя — реестр кредов не прочитан. Сверь аккаунт вручную и покажи пользователю." }
    $registry = Join-Path $env:USERPROFILE '.claude\config\project-credentials.local.md'
    $cwd = [string]$payload.cwd
    if (-not $cwd) { $cwd = (Get-Location).Path }

    # `cd <path> && deploy` — сверять надо каталог команды, а не каталог сессии, иначе
    # деплой из сессии, открытой в другом репозитории, ложно уходит в блок. Берётся
    # ПОСЛЕДНЯЯ смена каталога в цепочке (`cd A && cd B && deploy` деплоит из B), учтены
    # pushd и cmd-флаг `/d`, кавычная и голая формы пути. Смена каталога есть, но не
    # разобралась — это не повод молча сверять каталог сессии: тогда deny.
    $cdHits = [regex]::Matches($cmd, '(?i)(?:^|[;&|]|&&)\s*(?:cd|pushd|set-location|sl)\s+(?:/d\s+)?(?:"([^"]+)"|([^\s&|;]+))')
    if ($cdHits.Count -gt 0) {
        $last = $cdHits[$cdHits.Count - 1]
        $cdTarget = if ($last.Groups[1].Success) { $last.Groups[1].Value } else { $last.Groups[2].Value }
        $cdTarget = $cdTarget.Trim()
        if ($cdTarget -and -not [System.IO.Path]::IsPathRooted($cdTarget)) { $cdTarget = Join-Path $cwd $cdTarget }
        if ($cdTarget -and (Test-Path -LiteralPath $cdTarget -PathType Container)) {
            $cwd = (Resolve-Path -LiteralPath $cdTarget).Path
        } else {
            Deny "Команда меняет каталог перед деплоем, но целевой каталог не разобран или не существует ('$cdTarget'). Сверить креды не с чем — выполни деплой из каталога проекта явно, либо попроси пользователя разрешить разово (CLAUDE_ALLOW_DEPLOY=1)."
        }
    }

    if (-not (Test-Path $registry)) {
        $msg = "Команда меняет состояние во внешнем сервисе, а реестр кредов не заведён. " +
               "Создай ~/.claude/config/project-credentials.local.md по шаблону project-credentials.example.md " +
               "(cwd: $cwd). Пока реестра нет — сверь активный аккаунт вручную, покажи результат пользователю " +
               "и попроси его снять блокировку на сессию: CLAUDE_ALLOW_DEPLOY=1."
        @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $msg } } |
            ConvertTo-Json -Depth 5 -Compress
        exit 0
    }

    # 3. Строка реестра: выбираем САМЫЙ ДЛИННЫЙ подходящий repo_path и сравниваем по
    #    границе сегмента пути. Прежнее двустороннее вхождение подстрок давало и
    #    захват соседа (`C:\dev\app` подхватывал `C:\dev\app-web`), и обратный матч
    #    короткого cwd на произвольную строку — сверка шла по чужому проекту.
    $cwdKey = ($cwd -replace '/', '\').TrimEnd('\').ToLowerInvariant() + '\'
    $row = $null
    $bestLen = -1
    foreach ($line in (Get-Content -LiteralPath $registry -Encoding UTF8)) {
        if ($line -notmatch '^\s*\|') { continue }
        $cells = ($line -split '\|') | ForEach-Object { $_.Trim() }
        $repoPath = $cells[1]
        if (-not $repoPath -or $repoPath -eq 'repo_path' -or $repoPath -match '^-+$') { continue }
        $key = ($repoPath -replace '/', '\').TrimEnd('\').ToLowerInvariant() + '\'
        if ($cwdKey -eq $key -or $cwdKey.StartsWith($key) -or $cwdKey.Contains('\' + $key)) {
            if ($key.Length -gt $bestLen) { $bestLen = $key.Length; $row = $cells }
        }
    }

    if (-not $row) {
        $msg = "Для этого репозитория креды не заданы в реестре (cwd: $cwd). " +
               "Команда меняет состояние во внешнем сервисе — сверь активный аккаунт " +
               "(gcloud config get-value project / wrangler whoami / firebase use), покажи результат " +
               "пользователю и допиши строку в ~/.claude/config/project-credentials.local.md. " +
               "Снимает блокировку пользователь: CLAUDE_ALLOW_DEPLOY=1."
        @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $msg } } |
            ConvertTo-Json -Depth 5 -Compress
        exit 0
    }

    # 4. Автосверка: фактический аккаунт vs реестр. Совпало — пропускаем молча,
    #    иначе агент дёргал бы пользователя на каждый штатный деплой.
    # Колонки: 1 repo_path | 2 account | 3 gcp | 4 cf | 5 firebase | 6 play | 7 git_remote
    $checks = @()   # @{ label; expected; actual; ok }

    foreach ($svc in $services) {
        switch ($svc) {
            { $_ -in @('gcloud', 'gsutil') } {
                if (-not $row[3]) { $checks += @{ svc = $svc; label = 'GCP project'; expected = '(в реестре не задан)'; actual = ''; ok = $false }; break }
                $actual = Get-CmdOutput 'gcloud config get-value project' $cwd (Get-Budget)
                $checks += @{ svc = $svc; label = 'GCP project'; expected = $row[3]; actual = $actual
                              ok = (Test-CredMatch $actual $row[3]) }
            }
            'firebase' {
                if (-not $row[5]) { $checks += @{ svc = $svc; label = 'Firebase project'; expected = '(в реестре не задан)'; actual = ''; ok = $false }; break }
                # Локальные источники читаются мгновенно; `firebase use` (CLI, может лезть
                # в сеть) — последний резерв. Порядок: .firebaserc, затем google-services.json
                # модуля приложения (Android-проект может не иметь .firebaserc вовсе).
                $actual = $null
                $rc = Join-Path $cwd '.firebaserc'
                if (Test-Path -LiteralPath $rc) {
                    $actual = (Get-Content -LiteralPath $rc -Raw -Encoding UTF8 | ConvertFrom-Json).projects.default
                }
                if (-not $actual) {
                    foreach ($gs in @('google-services.json', 'app\google-services.json', 'androidApp\google-services.json', 'composeApp\google-services.json')) {
                        $f = Join-Path $cwd $gs
                        if (Test-Path -LiteralPath $f) {
                            $actual = (Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json).project_info.project_id
                            if ($actual) { break }
                        }
                    }
                }
                # Локальные источники дают точное значение; вывод CLI — сырой текст,
                # его сверяем по границе токена (-Loose).
                $loose = $false
                if (-not $actual) { $actual = Get-CmdOutput 'firebase use' $cwd (Get-Budget); $loose = $true }
                $checks += @{ svc = $svc; label = 'Firebase project'; expected = $row[5]; actual = $actual
                              ok = (Test-CredMatch $actual $row[5] -Loose:$loose) }
            }
            'wrangler' {
                if (-not $row[4]) { $checks += @{ svc = $svc; label = 'Cloudflare account'; expected = '(в реестре не задан)'; actual = ''; ok = $false }; break }
                # Явный account_id в конфиге — источник правды: при нём деплой из-под чужого
                # логина падает сам. Нет его — только тогда платим за сетевой whoami.
                $actual = $null
                foreach ($n in @('wrangler.jsonc', 'wrangler.json', 'wrangler.toml')) {
                    $f = Join-Path $cwd $n
                    if (Test-Path -LiteralPath $f) {
                        $t = Get-Content -LiteralPath $f -Raw -Encoding UTF8
                        if ($t -match '"?account_id"?\s*[:=]\s*"([0-9a-fA-F]{16,})"') { $actual = $Matches[1]; break }
                    }
                }
                $loose = $false
                if (-not $actual) { $actual = Get-CmdOutput 'wrangler whoami' $cwd (Get-Budget); $loose = $true }
                $checks += @{ svc = $svc; label = 'Cloudflare account'; expected = $row[4]; actual = $actual
                              ok = (Test-CredMatch $actual $row[4] -Loose:$loose) }
            }
            'gh' {
                if (-not $row[7]) { $checks += @{ svc = $svc; label = 'git remote'; expected = '(в реестре не задан)'; actual = ''; ok = $false }; break }
                $actual = Get-CmdOutput 'git remote get-url origin' $cwd (Get-Budget)
                # ssh и https формы одного remote — сверка по org/repo, поэтому -Loose.
                $checks += @{ svc = $svc; label = 'git remote'; expected = $row[7]; actual = $actual
                              ok = (Test-CredMatch $actual $row[7] -Loose) }
            }
            'adb' {
                # Пакет берётся из аргумента самой adb-команды, а не первым dotted-токеном
                # всей строки: иначе подхватывался путь к apk или --set-env-vars=a.b.c.
                $pkg = $null
                if ($cmd -match '(?i)\badb\b[^;&|]*\b(?:uninstall|install|shell\s+pm\s+\w+)\s+(?:-\S+\s+)*([a-zA-Z][\w]*(?:\.[\w]+)+)') { $pkg = $Matches[1] }
                $checks += @{ svc = $svc; label = 'Play package'
                              expected = $(if ($row[6]) { $row[6] } else { '(в реестре не задан)' })
                              actual = $pkg; ok = ($row[6] -and (Test-CredMatch $pkg $row[6])) }
            }
        }
    }

    # Пропускаем молча, только если КАЖДЫЙ задействованный сервис реально проверен и сошёлся.
    # Раньше хватало одного успешного чека: `gcloud ... deploy && adb uninstall com.foo`
    # проходил целиком, потому что ветка adb могла не добавить чек вовсе.
    $failed = @($checks | Where-Object { -not $_.ok })
    $covered = @($checks | ForEach-Object { $_.svc } | Select-Object -Unique).Count
    if ($checks.Count -gt 0 -and $failed.Count -eq 0 -and $covered -ge $services.Count) { exit 0 }

    $lines = @()
    foreach ($c in $checks) {
        $mark = if ($c.ok) { 'OK  ' } else { 'НЕТ ' }
        # Вывод CLI бывает многострочной таблицей (wrangler whoami) — в reason нужна суть.
        $act = if ($c.actual) { (([string]$c.actual) -split "`r?`n")[0].Trim() } else { '(не удалось определить)' }
        if ($act.Length -gt 200) { $act = $act.Substring(0, 200) + '…' }
        $lines += "$mark $($c.label): ожидается '$($c.expected)', фактически '$act'"
    }
    $missing = @($services | Where-Object { $_ -notin @($checks | ForEach-Object { $_.svc }) })
    foreach ($m in $missing) { $lines += "НЕТ  $($m): сверка не выполнена (нет данных в реестре или инструмент не разобран)" }
    if ($row[2]) { $lines += "Аккаунт по реестру: $($row[2])" }

    $head = if ($checks.Count -eq 0) {
        "Команда меняет состояние во внешнем сервисе, но сверить нечего: инструмент не распознан или реестр не описывает его для этого репозитория."
    } else {
        "Фактические креды НЕ совпали с реестром (или сверку не удалось выполнить)."
    }

    $msg = "$head`n`n" + ($lines -join "`n") +
           "`n`nДеплой в чужой аккаунт необратим. Покажи это расхождение пользователю и останови работу: " +
           "аккаунт агент не переключает и блокировку себе не снимает. Решает пользователь — либо чинит " +
           "аккаунт/реестр (~/.claude/config/project-credentials.local.md), либо разрешает разово через " +
           "CLAUDE_ALLOW_DEPLOY=1."

    Deny $msg

    }
    catch {
        # Опасность уже установлена выше — здесь fail-CLOSED.
        Deny ("Внутренняя ошибка credentials-guard при сверке кредов: " + $_.Exception.Message +
              "`nСверь активный аккаунт вручную и покажи результат пользователю; блокировку себе не снимай.")
    }
}
catch {
    # Сюда попадают только сбои разбора stdin и детекта опасности — команда ещё
    # не признана опасной, поэтому fail-open (хук не должен ломать сессию).
    exit 0
}
