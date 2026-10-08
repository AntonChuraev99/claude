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
    # Тул PowerShell исполняет ровно те же деплой-команды, что и Bash, и на Windows
    # он основной. Пока здесь стояло только 'Bash', `firebase deploy` через
    # PowerShell проходил мимо guard целиком — сверки не было вовсе.
    if ($payload.tool_name -notin @('Bash', 'PowerShell')) { exit 0 }
    if ($env:CLAUDE_ALLOW_DEPLOY -eq '1') { exit 0 }

    $cmd = [string]$payload.tool_input.command
    if (-not $cmd) { exit 0 }

    # 1. Опасна ли команда: инструмент внешнего сервиса + глагол, меняющий состояние.
    #    Инструмент ищется В ПОЗИЦИИ КОМАНДЫ (начало строки либо после ; && || |), иначе
    #    блокировалось всё, где слово встречается внутри строки: `echo "firebase deploy"`,
    #    `git commit -m "fix wrangler deploy"`, тексты отчётов. До перевода на deny эти
    #    ложные срабатывания были не видны — CLI проглатывал ask. Скобка открывает
    #    позицию команды только как subshell — не после буквы: `fix(firebase): deploy`
    #    в commit-message — scope Conventional Commits, а не вызов (ревью 2026-09-18).
    #    Позицию команды открывают и обёртки: `npx wrangler deploy` — канонический вызов
    #    wrangler, и без этого он обходил guard целиком (как и `pnpm dlx`, `bash -c`,
    #    префикс `VAR=1 gcloud ...`). Паттерн один на детект и на разбор сервисов —
    #    два разных выражения тихо расходились бы при правке.
    #    Слова живут в config/credentials-guard-patterns.json — тот же файл читает
    #    hooks/credentials-guard-prefilter.js, который решает, платить ли за старт
    #    pwsh вообще. Два списка в двух файлах разъехались бы молча, и разъезд был бы
    #    не виден до пропущенного деплоя. Файл недоступен или битый — берём встроенный
    #    дефолт: детект опасности обязан работать всегда.
    $tool = 'gcloud|wrangler|firebase|gh|adb|gsutil'
    $verb = 'deploy|publish|release\s+create|secret\s+(set|put)|functions\s+deploy|hosting:channel:deploy|pages\s+deploy|apps\s+release|repo\s+delete|uninstall|rm\s+-r'
    try {
        $patternsFile = Join-Path $env:USERPROFILE '.claude\config\credentials-guard-patterns.json'
        if (Test-Path -LiteralPath $patternsFile) {
            $patterns = Get-Content -LiteralPath $patternsFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($patterns.tools -and $patterns.tools.Count -gt 0) { $tool = ($patterns.tools -join '|') }
            if ($patterns.verbs -and $patterns.verbs.Count -gt 0) { $verb = ($patterns.verbs -join '|') }
        }
    } catch { }
    $wrap = '(?:(?:npx|pnpm|yarn|bunx|sudo|env|command|time|nice)\s+(?:dlx\s+|exec\s+|-\S+\s+)*|\w+=\S+\s+|bash\s+-c\s+["'']?|sh\s+-c\s+["'']?)*'
    $posRe = "(?m)(?:^|[;&|]|(?<![\w)])\(|&&|\|\|)\s*$wrap"

    # Позиции ищутся по МАСКЕ инертного текста, если её передал префильтр
    # (guard_code: та же длина, сообщение коммита / тело issue / строки-значения
    # заменены пробелами, см. guardCode в credentials-guard-prefilter.js). Иначе
    # строка heredoc'а, начатая с `gcloud … deploy`, — «начало строки», то есть
    # вызов (replay 2026-10-08: 5 deny на тексте команд, которые ничего не деплоят).
    # Маски нет или длина не сошлась — судим исходную команду, как раньше.
    $detect = $cmd
    if ($payload.guard_code -is [string] -and $payload.guard_code.Length -eq $cmd.Length) { $detect = $payload.guard_code }

    # Глагол засчитывается, только если он в СЕГМЕНТЕ своего инструмента: от имени
    # инструмента до разделителя команды (; & | ) перевод строки), кавычки и
    # продолжение строки (`\`+перевод, PowerShell-бэктик) сегмент не рвут. Раньше
    # хватало глагола где угодно в команде: `TOK=$(gcloud auth print-access-token);
    # curl …/publishers/…` и `node deploy_rules.mjs` с токеном из gcloud сверялись как
    # деплой gcloud — 2 deny за месяц, плюс `adb shell … && rm -rf rec` (replay
    # 2026-10-08). Сервис в списке сверки — только тот, чей сегмент меняет состояние.
    $segBody = '(?:\\\r?\n|`\r?\n|\\.|`.|"(?:[^"\\`]|[\\`][\s\S])*"|''[^'']*''|[^;&|)\r\n"''\\`])*'
    $services = @()
    $segments = @{}
    foreach ($t in $tool.Split('|')) {
        $segRe = [regex]::new("\G(?:$t)\b$segBody", 'IgnoreCase')
        foreach ($h in [regex]::Matches($detect, "$posRe(?<t>$t)\b", 'IgnoreCase')) {
            $seg = $segRe.Match($detect, $h.Groups['t'].Index)
            if ($seg.Success -and $seg.Value -match "\b($verb)") {
                $services += $t
                if (-not $segments.ContainsKey($t)) { $segments[$t] = @() }
                $segments[$t] += $seg.Value
            }
        }
    }
    $services = @($services | Select-Object -Unique)
    if ($services.Count -eq 0) { exit 0 }
    # gsutil сверяется тем же GCP-проектом, что и gcloud — не гонять пробу дважды.
    # Сам gsutil — legacy (Google убирает его из Cloud CLI после марта 2027; штатно —
    # `gcloud storage`, которое сюда приходит как обычный gcloud); детект оставлен
    # сетью под отдельно установленный бинарь.
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
    #
    # Разбор пути (replay 2026-10-08: 9 deny за месяц на разборе `cd`, ни одного по делу):
    #   * POSIX-форма Git Bash `/c/Users/...` -> `C:\Users\...`;
    #   * `~`, `~/x` -> профиль пользователя;
    #   * `$VAR`, `${VAR}`, `$env:VAR` — из присваиваний В САМОЙ команде до этого `cd`
    #     (`S="..."; cd "$S/x"`), затем из окружения. Состояние шелла между вызовами
    #     тулов не живёт, так что других источников у переменной нет;
    #   * PowerShell `Set-Location '...'` — одинарные кавычки.
    # Каталог так и не разобрался — deny остаётся, КРОМЕ случая, когда все сверяемые
    # сервисы от каталога не зависят (gcloud/gsutil — проект из флага или глобального
    # конфига, adb — пакет из аргумента): там каталог задаёт только строку реестра, и
    # сверка по строке каталога сессии проверяет ровно то, что исполнится. Для
    # firebase/wrangler/gh каталог определяет фактический проект (.firebaserc,
    # wrangler.toml, git remote) — сверять их по каталогу сессии значило бы пропустить
    # деплой из неизвестного каталога, поэтому там deny.
    $cdHits = [regex]::Matches($detect, '(?im)(?:^|[;&|]|&&)\s*(?:cd|pushd|set-location|sl)\s+(?:/d\s+)?')
    if ($cdHits.Count -gt 0) {
        $last = $cdHits[$cdHits.Count - 1]
        $tm = [regex]::new('\G(?:"([^"]+)"|''([^'']+)''|([^\s&|;]+))').Match($cmd, $last.Index + $last.Length)
        $cdTarget = ''
        if ($tm.Success) { foreach ($g in 1..3) { if ($tm.Groups[$g].Success) { $cdTarget = $tm.Groups[$g].Value.Trim(); break } } }

        # Присваивания до этого cd: bash `NAME=value` и PowerShell `$NAME = 'value'`.
        $assign = @{}
        $before = $cmd.Substring(0, $last.Index)
        foreach ($a in [regex]::Matches($before, '(?m)(?:^|[;&|\s])\$?(\w+)\s*=\s*(?:"([^"]*)"|''([^'']*)''|([^\s;&|]*))')) {
            $val = if ($a.Groups[2].Success) { $a.Groups[2].Value } elseif ($a.Groups[3].Success) { $a.Groups[3].Value } else { $a.Groups[4].Value }
            $assign[$a.Groups[1].Value] = $val
        }
        $expand = {
            param([string]$s)
            for ($k = 0; $k -lt 4 -and $s -match '\$'; $k++) {
                $s = $s -replace '\$\{(\w+)\}|\$env:(\w+)|\$(\w+)', {
                    $m = $_
                    $n = if ($m.Groups[1].Success) { $m.Groups[1].Value } elseif ($m.Groups[2].Success) { $m.Groups[2].Value } else { $m.Groups[3].Value }
                    if (-not $m.Groups[2].Success -and $assign.ContainsKey($n)) { return $assign[$n] }
                    $e = [Environment]::GetEnvironmentVariable($n)
                    if ($null -ne $e) { return $e }
                    return $m.Value
                }
            }
            return $s
        }
        $resolved = & $expand $cdTarget
        if ($resolved -match '\$') { $resolved = $null }   # переменная не раскрылась
        if ($resolved) {
            $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
            if ($resolved -eq '~') { $resolved = $homeDir }
            elseif ($resolved -match '^~[\\/](.*)$') { $resolved = Join-Path $homeDir $Matches[1] }
            if ($resolved -match '^/([a-zA-Z])(?:/(.*))?$') {
                $resolved = "$($Matches[1].ToUpperInvariant()):\" + ([string]$Matches[2] -replace '/', '\')
            }
            if (-not [System.IO.Path]::IsPathRooted($resolved)) { $resolved = Join-Path $cwd $resolved }
        }
        if ($resolved -and (Test-Path -LiteralPath $resolved -PathType Container)) {
            $cwd = (Resolve-Path -LiteralPath $resolved).Path
        } elseif (@($services | Where-Object { $_ -notin @('gcloud', 'gsutil', 'adb') }).Count -gt 0) {
            Deny "Команда меняет каталог перед деплоем, но целевой каталог не разобран или не существует ('$cdTarget'). Сверить креды не с чем — выполни деплой из каталога проекта явно, либо попроси пользователя разрешить разово (CLAUDE_ALLOW_DEPLOY=1)."
        }
        # иначе: сервисы от каталога не зависят — строка реестра по каталогу сессии
    }

    # Scratchpad сессии (`%TEMP%\claude\<проект>\<uuid>\scratchpad`): шелл главного
    # агента сохраняет cwd между вызовами, и после одного `cd` в scratchpad все
    # следующие команды шли с cwd вне реестра — «креды не заданы» (replay 2026-10-08).
    # Имя каталога проекта в пути — это путь проекта сессии, где каждый не-алфавитно-
    # цифровой символ заменён на `-`. Сверяем его с так же закодированными строками
    # реестра: точное совпадение или worktree проекта (`…--claude-worktrees-…`).
    # Только когда каталог сессии — scratchpad, а не когда команда САМА делает туда
    # `cd`: явный переход в чужой каталог перед деплоем остаётся под сверкой как есть.
    $scratchOwner = $null
    if ($cdHits.Count -eq 0 -and ($cwd -replace '/', '\') -match '(?i)\\Temp\\claude\\([^\\]+)\\[0-9a-f]{8}-[0-9a-f-]{27}\\scratchpad(\\|$)') {
        $scratchOwner = $Matches[1].ToLowerInvariant()
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
        $hit = $cwdKey -eq $key -or $cwdKey.StartsWith($key) -or $cwdKey.Contains('\' + $key)
        if (-not $hit -and $scratchOwner) {
            $enc = ([regex]::Replace($repoPath.TrimEnd('\', '/'), '[^a-zA-Z0-9]', '-')).ToLowerInvariant()
            $hit = $scratchOwner -eq $enc -or $scratchOwner.StartsWith($enc + '--claude-worktrees-')
        }
        if ($hit) {
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
                # Проект, названный в САМОЙ команде, приоритетнее глобального конфига:
                # исполнится именно он. Так команду и выравнивает hooks/account-align.js
                # (`CLOUDSDK_CORE_PROJECT=... gcloud ...`), и без этой ветки guard сверял бы
                # активную конфигурацию, к которой команда уже не относится, — то есть
                # блокировал бы штатный деплой. Заодно экономит спавн gcloud.
                # Несколько РАЗНЫХ значений в одной цепочке — доверять нечему, идём пробой.
                $explicit = @([regex]::Matches($cmd, '(?:CLOUDSDK_CORE_PROJECT=|--project[=\s]+)([^\s;&|]+)') |
                              ForEach-Object { $_.Groups[1].Value.Trim('"''') } |
                              Select-Object -Unique)
                if ($explicit.Count -eq 1) {
                    $actual = $explicit[0]
                } else {
                    $actual = Get-CmdOutput 'gcloud config get-value project' $cwd (Get-Budget)
                }
                $checks += @{ svc = $svc; label = 'GCP project'; expected = $row[3]; actual = $actual
                              ok = (Test-CredMatch $actual $row[3]) }
            }
            'firebase' {
                if (-not $row[5]) { $checks += @{ svc = $svc; label = 'Firebase project'; expected = '(в реестре не задан)'; actual = ''; ok = $false }; break }
                # Локальные источники читаются мгновенно; `firebase use` (CLI, может лезть
                # в сеть) — последний резерв. Порядок: .firebaserc, затем google-services.json
                # модуля приложения (Android-проект может не иметь .firebaserc вовсе).
                # Проект, названный флагом в самом вызове (`--project X` / `-P X`),
                # исполнится вместо .firebaserc. Сверяется КАЖДЫЙ вызов firebase цепочки
                # отдельно: явный флаг — своим значением, вызов без флага — локальными
                # источниками ниже; любое расхождение — deny. Флаг может быть алиасом из
                # .firebaserc (`--project staging`) — резолвим через `projects.<alias>`,
                # нет такого алиаса — значение и есть project id.
                $rc = Join-Path $cwd '.firebaserc'
                $rcProjects = $null
                if (Test-Path -LiteralPath $rc) { $rcProjects = (Get-Content -LiteralPath $rc -Raw -Encoding UTF8 | ConvertFrom-Json).projects }
                $fbExplicit = @()
                $needLocal = $false
                foreach ($s in @($segments['firebase'])) {
                    $flags = @([regex]::Matches($s, '(?:--project[=\s]+|\s-P\s+)([^\s;&|]+)') | ForEach-Object { $_.Groups[1].Value.Trim('"''') })
                    if ($flags.Count -eq 0) { $needLocal = $true; continue }
                    foreach ($p in $flags) {
                        $resolvedP = if ($rcProjects -and $rcProjects.PSObject.Properties[$p]) { [string]$rcProjects.$p } else { $p }
                        $fbExplicit += $resolvedP
                    }
                }
                foreach ($p in @($fbExplicit | Select-Object -Unique)) {
                    $checks += @{ svc = $svc; label = 'Firebase project (флаг)'; expected = $row[5]; actual = $p
                                  ok = (Test-CredMatch $p $row[5]) }
                }
                if (-not $needLocal) { break }

                $actual = $null
                if ($rcProjects) { $actual = $rcProjects.default }
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
                # Сверяется КАЖДАЯ цель удаления, и только в сегментах adb, где есть
                # глагол. Раньше бралось первое dotted-слово после install/uninstall/
                # `pm <что угодно>` во всей строке: `adb shell pm enable com.google.android.gms
                # && adb uninstall <свой пакет>` сверял gms и давал deny, а `adb uninstall
                # <свой> && adb uninstall <чужой>` сверял только первый и пропускал чужой.
                $pkgs = @($segments['adb'] | ForEach-Object {
                        [regex]::Matches($_, '(?i)\buninstall\s+(?:(?:--user\s+\S+|-\S+)\s+)*([a-zA-Z]\w*(?:\.\w+)+)') | ForEach-Object { $_.Groups[1].Value }
                    } | Select-Object -Unique)
                $pkgOk = $row[6] -and $pkgs.Count -gt 0 -and @($pkgs | Where-Object { -not (Test-CredMatch $_ $row[6]) }).Count -eq 0
                $checks += @{ svc = $svc; label = 'Play package'
                              expected = $(if ($row[6]) { $row[6] } else { '(в реестре не задан)' })
                              actual = ($pkgs -join ', '); ok = [bool]$pkgOk }
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
    # не признана опасной, поэтому fail-open (хук не должен ломать сессию). Но не
    # молча: строка в stats/ отличает «не сработал» от «упал» (журнал общий с
    # protected-branch-guard). Сбой записи журнала хук не роняет.
    try {
        $log = Join-Path (Split-Path $PSScriptRoot -Parent) 'stats\hook-degraded.log'
        New-Item -ItemType Directory -Force -Path (Split-Path $log -Parent) | Out-Null
        Add-Content -LiteralPath $log -Encoding UTF8 -Value ("{0}`tcredentials-guard`t{1}" -f
            (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), ($_.Exception.Message -replace '\s+', ' '))
    } catch { }
    exit 0
}
