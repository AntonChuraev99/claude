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
function Get-CmdOutput([string]$command, [string]$workDir, [int]$timeoutMs = 6000) {
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $env:ComSpec
        $psi.Arguments = "/c $command"
        if ($workDir -and (Test-Path -LiteralPath $workDir -PathType Container)) { $psi.WorkingDirectory = $workDir }
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $stdout = $p.StandardOutput.ReadToEndAsync()
        if (-not $p.WaitForExit($timeoutMs)) { try { $p.Kill() } catch { }; return $null }
        $out = ($stdout.Result).Trim()
        if ($p.ExitCode -ne 0) { return $null }
        return $out
    } catch { return $null }
}

# Сверка «фактическое vs ожидаемое»: значения приходят из разных источников
# (ssh-remote против https в реестре, вывод CLI с префиксом), поэтому вхождение,
# а не строгое равенство. Пустое фактическое совпадением НЕ считается.
function Test-CredMatch([string]$actual, [string]$expected) {
    if ([string]::IsNullOrWhiteSpace($actual) -or [string]::IsNullOrWhiteSpace($expected)) { return $false }
    $a = $actual.Trim().ToLowerInvariant()
    $e = $expected.Trim().ToLowerInvariant() -replace '\.git$', ''
    if ($a -eq $e) { return $true }
    if ($a.Contains($e)) { return $true }
    # git remote: сравнить по «org/repo», чтобы ssh и https формы сошлись
    if ($e -match '[:/]([^:/]+/[^/]+?)(\.git)?$') {
        $tail = $Matches[1]
        if ($tail -and $a.Contains($tail)) { return $true }
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
    $tool = 'gcloud|wrangler|firebase|gh|adb|gsutil'
    $verb = 'deploy|publish|release\s+create|secret\s+(set|put)|functions\s+deploy|hosting:channel:deploy|pages\s+deploy|apps\s+release|repo\s+delete|uninstall|rm\s+-r'
    if ($cmd -notmatch "(?m)(^|[;&|]\s*|^\s*)\s*($tool)\b" -or $cmd -notmatch "\b($verb)") { exit 0 }

    # Какие именно сервисы задействованы — от этого зависит, что сверять.
    $services = @()
    foreach ($t in $tool.Split('|')) {
        if ($cmd -match "(?m)(^|[;&|]\s*|^\s*)\s*$t\b") { $services += $t }
    }
    $services = @($services | Select-Object -Unique)

    # 2. Реестр.
    $registry = Join-Path $env:USERPROFILE '.claude\config\project-credentials.local.md'
    $cwd = [string]$payload.cwd
    if (-not $cwd) { $cwd = (Get-Location).Path }

    # `cd <path> && deploy` — сверять надо каталог команды, а не каталог сессии,
    # иначе деплой из сессии, открытой в другом репозитории, ложно уходит в блок.
    if ($cmd -match '(?i)^\s*cd\s+"?([^"&|;]+?)"?\s*(&&|;)') {
        $cdTarget = $Matches[1].Trim()
        if (-not [System.IO.Path]::IsPathRooted($cdTarget)) { $cdTarget = Join-Path $cwd $cdTarget }
        if (Test-Path -LiteralPath $cdTarget -PathType Container) { $cwd = (Resolve-Path -LiteralPath $cdTarget).Path }
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

    # 3. Строка реестра для текущего cwd: ищем ту, чей repo_path входит в cwd.
    $row = $null
    foreach ($line in (Get-Content $registry)) {
        if ($line -notmatch '^\s*\|') { continue }
        $cells = ($line -split '\|') | ForEach-Object { $_.Trim() }
        $repoPath = $cells[1]
        if (-not $repoPath -or $repoPath -eq 'repo_path' -or $repoPath -match '^-+$') { continue }
        if ($cwd.ToLower().Contains($repoPath.ToLower()) -or $repoPath.ToLower().Contains($cwd.ToLower())) {
            $row = $cells
            break
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
                if (-not $row[3]) { $checks += @{ label = 'GCP project'; expected = '(в реестре не задан)'; actual = ''; ok = $false }; break }
                $actual = Get-CmdOutput 'gcloud config get-value project' $cwd 8000
                $checks += @{ label = 'GCP project'; expected = $row[3]; actual = $actual
                              ok = ($actual -and (Test-CredMatch $actual $row[3])) }
            }
            'firebase' {
                if (-not $row[5]) { $checks += @{ label = 'Firebase project'; expected = '(в реестре не задан)'; actual = ''; ok = $false }; break }
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
                if (-not $actual) { $actual = Get-CmdOutput 'firebase use' $cwd 8000 }
                $checks += @{ label = 'Firebase project'; expected = $row[5]; actual = $actual
                              ok = ($actual -and (Test-CredMatch $actual $row[5])) }
            }
            'wrangler' {
                if (-not $row[4]) { $checks += @{ label = 'Cloudflare account'; expected = '(в реестре не задан)'; actual = ''; ok = $false }; break }
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
                if (-not $actual) { $actual = Get-CmdOutput 'wrangler whoami' $cwd 9000 }
                $checks += @{ label = 'Cloudflare account'; expected = $row[4]; actual = $actual
                              ok = ($actual -and (Test-CredMatch $actual $row[4])) }
            }
            'gh' {
                if (-not $row[7]) { $checks += @{ label = 'git remote'; expected = '(в реестре не задан)'; actual = ''; ok = $false }; break }
                $actual = Get-CmdOutput 'git remote get-url origin' $cwd 5000
                $checks += @{ label = 'git remote'; expected = $row[7]; actual = $actual
                              ok = ($actual -and (Test-CredMatch $actual $row[7])) }
            }
            'adb' {
                if ($row[6] -and $cmd -match '([a-zA-Z][\w]*(\.[\w]+){2,})') {
                    $pkg = $Matches[1]
                    $checks += @{ label = 'Play package'; expected = $row[6]; actual = $pkg
                                  ok = (Test-CredMatch $pkg $row[6]) }
                }
            }
        }
    }

    $failed = @($checks | Where-Object { -not $_.ok })
    if ($checks.Count -gt 0 -and $failed.Count -eq 0) { exit 0 }   # всё сошлось — молча пропускаем

    $lines = @()
    foreach ($c in $checks) {
        $mark = if ($c.ok) { 'OK  ' } else { 'НЕТ ' }
        $act = if ($c.actual) { $c.actual } else { '(не удалось определить)' }
        $lines += "$mark $($c.label): ожидается '$($c.expected)', фактически '$act'"
    }
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

    @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $msg } } |
        ConvertTo-Json -Depth 5 -Compress
    exit 0
}
catch {
    exit 0
}
