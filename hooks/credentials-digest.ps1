# SessionStart: показать креды текущего проекта из реестра, чтобы сессия сразу знала,
# под каким аккаунтом работает и что сверять перед деплоем, — и ДО первой команды
# проверить, жива ли сессия gcloud этого аккаунта.
# Реестр: ~/.claude/config/project-credentials.local.md (шаблон — *.example.md).
# Любая ошибка => exit 0: хук информационный, ломать старт сессии он не должен.
# Запуск: pwsh 7+, stdin = hook JSON ({cwd, source, ...}).
# Env: CLAUDE_HOME — корень профиля, по умолчанию %USERPROFILE%\.claude (ставят тесты).
# Тесты: hooks/credentials-digest.tests.ps1.
#
# Зачем проба. Аккаунт Google Workspace живёт под политикой домена «Google Cloud
# session control»: с частотой, которую задал админ (1–24 ч), refresh-токен требует
# повторной аутентификации (RAPT). В интерактивном терминале gcloud спросил бы пароль,
# а из сессии агента отвечает «Reauthentication failed. cannot prompt during
# non-interactive execution». По логам gcloud за три недели (2026-08-19 … 09-09) отказ
# был в 14 из 19 рабочих дней, и каждый раз агент узнавал о нём посреди задачи, тратил
# ретраи и путал с нехваткой прав. Проба на старте (только там, где реестр называет
# GCP или Firebase) ставит вердикт сразу под заголовок дайджеста вместе с точной
# командой для пользователя. Сам ежедневный цикл снимает только админ домена —
# см. skills/claude-profiles/SKILL.md.

$ErrorActionPreference = 'SilentlyContinue'

# Дайджест русский; без явного UTF-8 на stdout он приходит в сессию mojibake.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# Проба стоит от 1 с (тёплый gcloud) до 9 с (холодный старт под нагрузкой — замерено
# на этой машине), а сессий за день десятки. Живой вердикт запоминается файлом-меткой
# на 30 мин; любой другой вердикт метку стирает, так что после логина пользователя
# следующая сессия пробует заново. Сессия, просроченная внутри окна кеша, проявится как
# раньше — первой командой, но не позже чем через 30 мин.
$script:ProbeTimeoutMs = 12000
$script:ProbeCacheTtlMin = 30

# Почта из ячейки реестра: рядом может стоять уточнение «(GitHub Nickname)», а в
# --account должна уйти только сама почта — то же правило, что в account-align.js.
function Get-AccountEmail([string]$cell) {
    if ($cell -and $cell -match '[^\s(]+@[^\s)]+') { return $Matches[0] }
    return $null
}

# Сколько миллисекунд осталось до дедлайна; минимум 1, чтобы Wait не ждал вечно.
function Get-RemainingMs([datetime]$deadline) {
    return [Math]::Max(1, [int]($deadline - [datetime]::UtcNow).TotalMilliseconds)
}

# Запуск CLI с жёстким таймаутом. Через ComSpec, потому что gcloud на Windows — .cmd-шим.
# stdin закрывается сразу: gcloud обязан увидеть неинтерактивный режим и ответить
# ошибкой, а не ждать пароль. Оба потока читаются асинхронно — нечитаемый stderr
# переполняет буфер пайпа и вешает процесс.
#
# Дедлайн ОДИН на процесс и оба потока. WaitForExit ждёт только сам процесс, а внуки
# .cmd-шима держат хендл пайпа после его выхода; с per-шаговыми таймаутами бюджет
# складывался бы в 3× — больше таймаута самого хука в settings.json, и убитый хук не
# печатал бы даже таблицу кредов (та же ловушка, что закрыта в credentials-guard.ps1).
function Invoke-Cli([string]$command, [int]$timeoutMs) {
    $p = $null
    $deadline = [datetime]::UtcNow.AddMilliseconds($timeoutMs)
    $timedOut = @{ code = -1; out = ''; err = "таймаут $timeoutMs мс" }
    try {
        if (-not $env:ComSpec) { return $null }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $env:ComSpec
        $psi.Arguments = "/c $command"
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        try { $p.StandardInput.Close() } catch { }
        $so = $p.StandardOutput.ReadToEndAsync()
        $se = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit((Get-RemainingMs $deadline))) {
            try { $p.Kill($true) } catch { }
            return $timedOut
        }
        if (-not $so.Wait((Get-RemainingMs $deadline)) -or -not $se.Wait((Get-RemainingMs $deadline))) {
            try { $p.Kill($true) } catch { }
            return $timedOut
        }
        return @{ code = $p.ExitCode; out = [string]$so.Result; err = [string]$se.Result }
    } catch { return $null }
    finally { if ($p) { try { $p.Dispose() } catch { } } }
}

# Вердикт по живости сессии gcloud для аккаунта. Проба — print-access-token: она
# дёргает ровно тот refresh, который падает на просроченном RAPT, и ничего не меняет.
# Порядок проверок важен: под той же политикой firebase-tools и любой клиент на
# google-auth отвечают `invalid_grant: reauth related error (invalid_rapt)` — текст
# содержит и invalid_grant, поэтому reauth проверяется раньше отозванного токена.
function Get-SessionVerdict([string]$account) {
    $r = Invoke-Cli "gcloud auth print-access-token --account=$account" $script:ProbeTimeoutMs
    if ($null -eq $r) { return @{ state = 'unknown'; detail = 'проба не запустилась' } }
    if ($r.code -eq 0 -and $r.out -match '\S') { return @{ state = 'ok'; detail = '' } }
    $text = "$($r.out)`n$($r.err)"
    if ($text -match 'Reauthentication failed|invalid_rapt|reauth related') { return @{ state = 'reauth'; detail = '' } }
    if ($text -match 'invalid_grant|expired or revoked') { return @{ state = 'revoked'; detail = '' } }
    if ($text -match 'does not have any valid credentials|do not currently have an active account|No credentialed accounts') { return @{ state = 'nologin'; detail = '' } }
    $head = @(($text -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
    $head = if ($head.Count) { ([string]$head[0]).Trim() } else { "код $($r.code)" }
    if ($head.Length -gt 160) { $head = $head.Substring(0, 160) + '…' }
    return @{ state = 'unknown'; detail = $head }
}

# Файл-метка живого вердикта: stats/ вне git, имя — хеш почты, чтобы не класть адрес в
# имя файла. Возвращает локальное время последней удачной пробы либо $null.
function Get-ProbeCachePath([string]$claudeHome, [string]$account) {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $hex = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($account.ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') })
    return Join-Path $claudeHome "stats\credentials-probe\$hex.ok"
}
function Get-CachedOkTime([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $item = Get-Item -LiteralPath $path
    $age = [datetime]::UtcNow - $item.LastWriteTimeUtc
    if ($age.TotalMinutes -lt $script:ProbeCacheTtlMin) { return $item.LastWriteTime }
    return $null
}

try {
    $cwd = $null
    $source = ''
    try {
        $stdin = [Console]::In.ReadToEnd()
        if ($stdin) {
            $payload = ConvertFrom-Json $stdin
            $cwd = $payload.cwd
            $source = [string]$payload.source
        }
    } catch { }
    if (-not $cwd) { $cwd = (Get-Location).Path }

    $claudeHome = if ($env:CLAUDE_HOME) { $env:CLAUDE_HOME } else { Join-Path $env:USERPROFILE '.claude' }
    $registry = Join-Path $claudeHome 'config\project-credentials.local.md'
    if (-not (Test-Path $registry)) { exit 0 }

    # --- строка реестра для текущего каталога ---
    $row = $null
    $ignored = $false
    $inIgnored = $false

    foreach ($line in (Get-Content $registry -Encoding UTF8)) {
        if ($line -match '^##\s') { $inIgnored = $line -match 'Не наши репозитории' ; continue }
        if ($line -notmatch '^\s*\|') { continue }

        $cells = ($line -split '\|') | ForEach-Object { $_.Trim() }
        $first = $cells[1]
        if (-not $first -or $first -eq 'repo_path' -or $first -eq 'путь' -or $first -match '^-+$') { continue }

        # в секции игнора путь завёрнут в бэктики
        $path = $first.Trim('`')
        if ($inIgnored) {
            if ($cwd.ToLower().Contains($path.ToLower())) { $ignored = $true; $row = $cells; break }
            continue
        }
        if ($cwd.ToLower().Contains($path.ToLower()) -or $path.ToLower().Contains($cwd.ToLower())) {
            $row = $cells
            break
        }
    }

    $sb = [System.Text.StringBuilder]::new()

    if ($ignored) {
        [void]$sb.AppendLine("КРЕДЫ ПРОЕКТА: это НЕ рабочий репозиторий ($($row[2])).")
        [void]$sb.AppendLine("Деплой и публикация отсюда не выполняются. Нужна правка — сначала уточни у пользователя.")
    }
    elseif (-not $row) {
        # вне известных проектов молчим, кроме случая, когда это явно git-репозиторий
        if (-not (Test-Path (Join-Path $cwd '.git'))) { exit 0 }
        [void]$sb.AppendLine("КРЕДЫ ПРОЕКТА: репозиторий не заведён в ~/.claude/config/project-credentials.local.md.")
        [void]$sb.AppendLine("Перед любым деплоем, публикацией или записью секрета — сверь активный аккаунт вручную")
        [void]$sb.AppendLine("(gcloud config get-value project / wrangler whoami / firebase use) и допиши строку в реестр.")
    }
    else {
        # Колонки: 1 repo_path | 2 account | 3 gcp | 4 cf | 5 firebase | 6 play | 7 git_remote
        #
        # Проба только там, где реестр называет GCP или Firebase: остальным проектам
        # gcloud не нужен, и секунды на старте ушли бы впустую. `compact` сессию не
        # меняет — повторять пробу незачем. Строки — одинарные кавычки с -f: в двойных
        # PowerShell съел бы бэктики, а они здесь и есть разметка команды.
        $verdict = $null
        $account = Get-AccountEmail $row[2]
        if ($account -and ($row[3] -or $row[5]) -and $source -ne 'compact') {
            $cache = Get-ProbeCachePath $claudeHome $account
            $since = Get-CachedOkTime $cache
            if ($since) {
                $verdict = 'gcloud: сессия {0} живая (проверено в {1}, кеш {2} мин). firebase — отдельный логин под той же политикой: на invalid_rapt → `! firebase login --reauth`.' -f $account, $since.ToString('HH:mm'), $script:ProbeCacheTtlMin
            } else {
                $v = Get-SessionVerdict $account
                if ($v.state -eq 'ok') {
                    try {
                        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cache) | Out-Null
                        Set-Content -LiteralPath $cache -Value ([datetime]::UtcNow.ToString('o')) -NoNewline -Encoding ascii
                    } catch { }
                } else {
                    Remove-Item -LiteralPath $cache -Force -ErrorAction SilentlyContinue
                }
                $verdict = switch ($v.state) {
                    'ok'      { 'gcloud: сессия {0} живая (проверено на старте). firebase — отдельный логин под той же политикой: на invalid_rapt → `! firebase login --reauth`.' -f $account }
                    'reauth'  { '⚠ gcloud: сессия {0} ПРОСРОЧЕНА — Workspace session control, штатно раз в сутки; не баг и не нехватка прав. ДО первой команды gcloud/firebase попроси пользователя выполнить: `! gcloud auth login {0}` и `! firebase login --reauth`. Ретраи и личный аккаунт как fallback не помогут.' -f $account }
                    'revoked' { '⚠ gcloud: токен {0} отозван (invalid_grant). Попроси пользователя выполнить: `! gcloud auth login {0}`; firebase при той же ошибке — `! firebase login --reauth`.' -f $account }
                    'nologin' { '⚠ gcloud: аккаунт {0} не залогинен. Попроси пользователя выполнить: `! gcloud auth login {0}`.' -f $account }
                    default   { 'gcloud: живость сессии {0} не проверена ({1}) — покажет первая же команда.' -f $account, $v.detail }
                }
            }
        }

        # Вердикт — сразу под заголовком, до таблицы: просроченная сессия важнее
        # реквизитов, и агент обязан увидеть её раньше, чем спланирует первую команду.
        [void]$sb.AppendLine("КРЕДЫ ПРОЕКТА (реестр project-credentials.local.md)")
        if ($verdict) { [void]$sb.AppendLine($verdict) }
        [void]$sb.AppendLine("")
        [void]$sb.AppendLine("| поле | значение |")
        [void]$sb.AppendLine("|---|---|")
        if ($row[2]) { [void]$sb.AppendLine("| аккаунт | **$($row[2])** |") }
        if ($row[3]) { [void]$sb.AppendLine("| GCP project | $($row[3]) |") }
        if ($row[4]) { [void]$sb.AppendLine("| Cloudflare account | $($row[4]) |") }
        if ($row[5]) { [void]$sb.AppendLine("| Firebase project | $($row[5]) |") }
        if ($row[6]) { [void]$sb.AppendLine("| Play package | $($row[6]) |") }
        if ($row[7]) { [void]$sb.AppendLine("| git remote | $($row[7]) |") }
        [void]$sb.AppendLine("")
        [void]$sb.AppendLine("Аккаунт подставляется в команды автоматически (hooks/account-align.js):")
        [void]$sb.AppendLine("gcloud получает --account/--project, firebase — --account. Не покрыты gsutil и MCP-тулы.")
        [void]$sb.AppendLine("Переключать конфигурации руками не нужно и не следует — состояние CLI не трогаем.")
        [void]$sb.AppendLine("")
        [void]$sb.AppendLine("Позвать пользователя — только в трёх случаях, сам не логинься:")
        [void]$sb.AppendLine('1. `Reauthentication failed` / `invalid_rapt` — Workspace session control, штатно раз в сутки: `! gcloud auth login <почта>`, `! firebase login --reauth`. Ретраи и личный аккаунт не помогут.')
        [void]$sb.AppendLine('2. `Token has been expired or revoked` / `Failed to authenticate` — токен отозван либо аккаунта в CLI нет: `! gcloud auth login <почта>`, `! firebase login`.')
        [void]$sb.AppendLine('3. credentials-guard дал deny — креды разошлись с реестром вопреки подстановке: показать пользователю, блокировку себе не снимать.')
    }

    @{ hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $sb.ToString() } } |
        ConvertTo-Json -Depth 5 -Compress
    exit 0
}
catch {
    exit 0
}
