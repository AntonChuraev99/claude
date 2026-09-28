# worktree-shell-sweep.ps1
# SessionStart hook (user-level): убирает пустые «скорлупы» worktree, оставшиеся
# после ExitWorktree({action:"remove"}) прошлых сессий.
#
# Проблема: на Windows ExitWorktree снимает регистрацию в git и выносит содержимое,
# но сам каталог удалить не может, пока его держит хендл сессии, которая только что
# из него вышла («Permission denied» / «could not remove it — kept at …»). Изнутри
# той же сессии rmdir тоже отказывает, и агент отдавал это пользователю ручным шагом.
# Из НОВОЙ сессии хендла уже нет, и пустой каталог сносится обычным rmdir.
#
# Что делает, для репозитория текущей сессии (главный checkout по `git worktree list`):
#   - каталог в <main>\.claude\worktrees\ не зарегистрирован в git, пуст и старше
#     10 минут → удаляется (только пустой: Directory.Delete без recursive);
#   - не зарегистрирован, НЕ пуст, и локальной ветки worktree-<name> / <name> нет →
#     недоснесённый worktree (удаление оборвал залоченный файл), git уже проверил и снял
#     его ветку — сносится `rmdir /s /q` (не проходит внутрь junction);
#   - не зарегистрирован, НЕ пуст, ветка жива → не трогается, имя уходит в контекст;
#   - зарегистрированные и свежие (<10 мин, гонка с git worktree add) — пропуск.
# Fail-open: любая ошибка → exit 0, старт сессии не блокируется.
#
# Тестовый оверрайд: CLAUDE_SHELL_SWEEP_MIN_AGE_MIN — порог возраста в минутах.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Normalize([string]$p) { return ($p -replace '/', '\').TrimEnd('\').ToLowerInvariant() }

try {
    $cwd = $null
    try {
        $raw = [Console]::In.ReadToEnd()
        if (-not [string]::IsNullOrWhiteSpace($raw)) { $cwd = ($raw | ConvertFrom-Json).cwd }
    } catch { }
    if ([string]::IsNullOrWhiteSpace($cwd)) { $cwd = (Get-Location).Path }

    $porcelain = & git -C $cwd worktree list --porcelain 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $porcelain) { exit 0 }   # не git-репозиторий

    $registered = @($porcelain | Where-Object { $_ -like 'worktree *' } |
        ForEach-Object { Normalize $_.Substring(9) })
    if ($registered.Count -eq 0) { exit 0 }
    $mainRoot = $registered[0]   # первая запись porcelain — всегда главный checkout

    $worktreesDir = Join-Path $mainRoot '.claude\worktrees'
    if (-not (Test-Path -LiteralPath $worktreesDir)) { exit 0 }

    $minAge = 10
    if ($env:CLAUDE_SHELL_SWEEP_MIN_AGE_MIN) { $minAge = [double]$env:CLAUDE_SHELL_SWEEP_MIN_AGE_MIN }
    $cutoff = (Get-Date).AddMinutes(-$minAge)

    $removed = @(); $halfRemoved = @(); $leftovers = @()
    foreach ($d in Get-ChildItem -LiteralPath $worktreesDir -Directory -Force) {
        try {
            if ($registered -contains (Normalize $d.FullName)) { continue }
            if ($d.LastWriteTime -gt $cutoff) { continue }
            $hasItems = $null -ne (Get-ChildItem -LiteralPath $d.FullName -Force | Select-Object -First 1)
            if (-not $hasItems) {
                [System.IO.Directory]::Delete($d.FullName, $false)   # только пустой
                $removed += $d.Name
                continue
            }
            # Непустой и вне git worktree list: удаление начато и оборвано (залоченный файл).
            # Сносим, только если локальной ветки worktree тоже нет — ExitWorktree/`git worktree
            # remove` удаляют её последней, после проверок на незакоммиченное и невлитое.
            # Ветка жива → решать не хуку.
            & git -C $mainRoot show-ref --verify --quiet "refs/heads/worktree-$($d.Name)" 2>$null
            $hasBranch = $LASTEXITCODE -eq 0
            & git -C $mainRoot show-ref --verify --quiet "refs/heads/$($d.Name)" 2>$null
            $hasBranch = $hasBranch -or ($LASTEXITCODE -eq 0)
            if ($hasBranch) { $leftovers += $d.Name; continue }
            # rmdir /s не проходит внутрь junction (node_modules бывает слинкован на главный checkout)
            & cmd.exe /d /c "rmdir /s /q `"$($d.FullName)`"" 2>$null | Out-Null
            if (Test-Path -LiteralPath $d.FullName) { $leftovers += $d.Name } else { $halfRemoved += $d.Name }
        } catch { continue }   # хендл держит живая сессия / нет прав — следующий старт
    }

    if ($removed.Count -eq 0 -and $halfRemoved.Count -eq 0 -and $leftovers.Count -eq 0) { exit 0 }

    $screen = @()
    $ctx = @()
    if ($removed.Count -gt 0) {
        $screen += "worktree-sweep: убраны пустые скорлупы worktree: $($removed -join ', ')"
        $ctx += "worktree-shell-sweep: removed empty worktree shells: $($removed -join ', ')."
    }
    if ($halfRemoved.Count -gt 0) {
        $screen += "worktree-sweep: добиты недоудалённые worktree (ветки уже нет): $($halfRemoved -join ', ')"
        $ctx += "worktree-shell-sweep: removed half-deleted worktree dirs (unregistered, no local branch): $($halfRemoved -join ', ')."
    }
    if ($leftovers.Count -gt 0) {
        $screen += "$([char]0x26A0) worktree-sweep: каталоги вне git worktree list не тронуты (жива ветка или хендл): $($leftovers -join ', ')"
        $ctx += "worktree-shell-sweep: NON-empty directories in .claude/worktrees not registered in " +
                "git worktree list, left untouched (local branch still exists or delete failed): " +
                "$($leftovers -join ', '). Check the branch for unmerged work before deleting."
    }

    @{
        suppressOutput     = $true
        systemMessage      = ($screen -join "`n")
        hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = ($ctx -join ' ') }
    } | ConvertTo-Json -Depth 5 -Compress
} catch {
    exit 0
}
exit 0
