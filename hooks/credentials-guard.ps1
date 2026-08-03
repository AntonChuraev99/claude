# PreToolUse(Bash) guard: не дать выполнить деплой/публикацию с кредами чужого проекта.
# Читает реестр ~/.claude/config/project-credentials.local.md (шаблон — *.example.md),
# ищет строку по текущему cwd и требует подтверждения с явным списком ожидаемых значений.
# Любая внутренняя ошибка => exit 0 (хук не должен ломать работу).
# Запуск: pwsh 7+, stdin = hook JSON ({tool_name, tool_input:{command}, cwd, ...}).

$ErrorActionPreference = 'SilentlyContinue'

try {
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }
    $payload = $raw | ConvertFrom-Json
    if ($payload.tool_name -ne 'Bash') { exit 0 }

    $cmd = [string]$payload.tool_input.command
    if (-not $cmd) { exit 0 }

    # 1. Опасна ли команда: инструмент внешнего сервиса + глагол, меняющий состояние.
    $tool = 'gcloud|wrangler|firebase|gh|adb|gsutil'
    $verb = 'deploy|publish|release\s+create|secret\s+(set|put)|functions\s+deploy|hosting:channel:deploy|pages\s+deploy|apps\s+release|repo\s+delete|uninstall|rm\s+-r'
    if ($cmd -notmatch "\b($tool)\b" -or $cmd -notmatch "\b($verb)") { exit 0 }

    # 2. Реестр.
    $registry = Join-Path $env:USERPROFILE '.claude\config\project-credentials.local.md'
    $cwd = [string]$payload.cwd
    if (-not $cwd) { $cwd = (Get-Location).Path }

    if (-not (Test-Path $registry)) {
        $msg = "Команда меняет состояние во внешнем сервисе, а реестр кредов не заведён. " +
               "Создай ~/.claude/config/project-credentials.local.md по шаблону project-credentials.example.md, " +
               "либо подтверди вручную, что активный аккаунт принадлежит ЭТОМУ проекту (cwd: $cwd)."
        @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'ask'; permissionDecisionReason = $msg } } |
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
               "Команда меняет состояние во внешнем сервисе — сверь активный аккаунт вручную " +
               "(gcloud config get-value project / wrangler whoami / firebase use) и допиши строку в " +
               "~/.claude/config/project-credentials.local.md."
        @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'ask'; permissionDecisionReason = $msg } } |
            ConvertTo-Json -Depth 5 -Compress
        exit 0
    }

    # 4. Нашли запись — показать ожидаемое и потребовать сверки.
    # Колонки: 1 repo_path | 2 account | 3 gcp | 4 cf | 5 firebase | 6 play | 7 git_remote
    $expected = @()
    if ($row[2]) { $expected += "АККАУНТ: $($row[2])  <- главное: под этим логином должен идти деплой" }
    if ($row[3]) { $expected += "GCP project: $($row[3])  (проверить: gcloud config get-value project)" }
    if ($row[4]) { $expected += "Cloudflare account: $($row[4])  (проверить: wrangler whoami)" }
    if ($row[5]) { $expected += "Firebase project: $($row[5])  (проверить: firebase use)" }
    if ($row[6]) { $expected += "Play package: $($row[6])" }
    if ($row[7]) { $expected += "git remote: $($row[7])  (проверить: git remote -v)" }

    $msg = "Команда меняет состояние во внешнем сервисе. Для этого репозитория реестр ожидает:`n" +
           ($expected -join "`n") +
           "`n`nСверь фактический активный аккаунт с ожидаемым ДО выполнения. Не совпало — останови и разберись, " +
           "деплой в чужой аккаунт необратим."

    @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'ask'; permissionDecisionReason = $msg } } |
        ConvertTo-Json -Depth 5 -Compress
    exit 0
}
catch {
    exit 0
}
