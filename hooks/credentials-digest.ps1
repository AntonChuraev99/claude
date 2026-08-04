# SessionStart: показать креды текущего проекта из реестра, чтобы сессия сразу знала,
# под каким аккаунтом работает и что сверять перед деплоем.
# Реестр: ~/.claude/config/project-credentials.local.md (шаблон — *.example.md).
# Любая ошибка => exit 0: хук информационный, ломать старт сессии он не должен.
# Запуск: pwsh 7+, stdin = hook JSON ({cwd, source, ...}).

$ErrorActionPreference = 'SilentlyContinue'

# Дайджест русский; без явного UTF-8 на stdout он приходит в сессию mojibake.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

try {
    $cwd = $null
    try {
        $stdin = [Console]::In.ReadToEnd()
        if ($stdin) { $cwd = (ConvertFrom-Json $stdin).cwd }
    } catch { }
    if (-not $cwd) { $cwd = (Get-Location).Path }

    $registry = Join-Path $env:USERPROFILE '.claude\config\project-credentials.local.md'
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
        [void]$sb.AppendLine("КРЕДЫ ПРОЕКТА (реестр project-credentials.local.md)")
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
        [void]$sb.AppendLine("Деплой, публикация, запись секрета — сверить фактический активный аккаунт с этим ДО выполнения.")
        [void]$sb.AppendLine("Не совпало — остановиться и сказать пользователю, аккаунт самому не переключать.")
    }

    @{ hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $sb.ToString() } } |
        ConvertTo-Json -Depth 5 -Compress
    exit 0
}
catch {
    exit 0
}
