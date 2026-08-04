# PreToolUse(Write|Edit|NotebookEdit|…Edit) guard: не дать писать код прямо на защищённой
# ветке (main / master / develop и т.п.). Правило: работа идёт в отдельной ветке и
# вливается в транк через MR/PR.
#
# Реестр веток по проектам — ~/.claude/config/protected-branches.local.json
# (шаблон — protected-branches.example.json). Реестра нет / репозитория в нём нет
# => применяются defaults.
#
# Решение — `deny`, а не `ask`. Проверено вживую 2026-08-04: при
# `defaultMode: bypassPermissions` (плюс skipAutoPermissionPrompt) CLI молча
# проглатывает `ask` — хук отрабатывает, печатает решение, запись всё равно
# проходит. `deny` в той же конфигурации блокирует. Документация обещает
# обратное, поэтому менять обратно только после нового живого прогона.
# Разовые исключения покрывает escape-hatch внизу, а не мягкость решения.
#
# No-op (тихий exit 0), если: инструмент не пишет файл · путь вне git-репозитория ·
# репозиторий самого профиля Claude (~/.claude, ~/.claude-work — их правки должны
# применяться к текущей сессии) · ветка не защищена · выставлен escape-hatch.
# Любая внутренняя ошибка => exit 0 (хук не должен ломать сессию).
#
# ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: покрывает только файловые инструменты. Запись через Bash
# (`cat > f`, `sed -i`, `git apply`, `git checkout -- path`) и правки фоновых
# субагентов (run_in_background не наследует PreToolUse) хук НЕ видит — они
# закрываются процедурно (process-gate.yaml → no-code-on-protected-branch).
#
# Escape-hatch: env CLAUDE_ALLOW_PROTECTED_BRANCH=1 либо файл-флаг
# <repo>\.claude\.allow-protected-branch-edits
#
# $ErrorActionPreference намеренно 'SilentlyContinue', а не 'Stop' как у соседних
# хуков: под 'Stop' нативный `git ... 2>$null` бросает NativeCommandError и хук
# разваливается на штатном пути.
#
# Запуск: pwsh 7+, stdin = hook JSON ({tool_name, tool_input:{file_path|notebook_path}, cwd, ...}).
#
# ВАЖНО: файл публикуется в открытый репозиторий — никаких абсолютных путей,
# имён проектов и логинов в коде.

$ErrorActionPreference = 'SilentlyContinue'

# Сообщение хука — русское; без явного UTF-8 на stdout CLI получает mojibake
# (в консоли Windows кодировка по умолчанию OEM). Собственный try: падение
# установки кодировки не должно убивать весь хук.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function ConvertTo-WindowsPath([string]$p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return $p }
    $s = $p.Trim()
    # git-bash / WSL формы: /mnt/c/foo, /c/foo, //c/foo
    if ($s -match '^/+mnt/([a-zA-Z])/(.*)$') { $s = "$($Matches[1]):/$($Matches[2])" }
    elseif ($s -match '^/+([a-zA-Z])/(.*)$') { $s = "$($Matches[1]):/$($Matches[2])" }
    return ($s -replace '/', '\').TrimEnd('\')
}

function Get-PathKey([string]$p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return '' }
    return (ConvertTo-WindowsPath $p).ToLowerInvariant()
}

# Совпадение путей по ГРАНИЦЕ СЕГМЕНТА: ключ реестра — либо сам путь репозитория,
# либо его предок, либо его хвост. Подстрочное сравнение здесь давало и ложные
# срабатывания (ключ `proj` подхватывал `proj-v2`), и молчаливое отключение защиты
# (запись в ignoreRepos гасила родительский каталог целиком).
function Test-RepoKeyMatch([string]$repoKey, [string]$key) {
    if (-not $repoKey -or -not $key) { return $false }
    $r = $repoKey.TrimEnd('\') + '\'
    $k = $key.TrimEnd('\') + '\'
    return ($r -eq $k) -or $r.StartsWith($k) -or $r.Contains('\' + $k)
}

function Test-HasProperty($obj, [string]$name) {
    if ($null -eq $obj) { return $false }
    return $null -ne $obj.PSObject.Properties[$name]
}

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $payload = $raw | ConvertFrom-Json

    # Любой пишущий файловый инструмент: Write, Edit, MultiEdit, NotebookEdit и
    # будущие *Edit. Точный список имён здесь уже давал дыру (matcher в settings.json
    # — regex и пропускает MultiEdit, а хук его молча игнорировал).
    $toolName = [string]$payload.tool_name
    if ($toolName -notmatch '(?i)^(write|.*edit)$') { exit 0 }
    if ($env:CLAUDE_ALLOW_PROTECTED_BRANCH -eq '1') { exit 0 }

    # 1. Целевой путь. NotebookEdit исторически носил его в notebook_path.
    $target = [string]$payload.tool_input.file_path
    if (-not $target) { $target = [string]$payload.tool_input.notebook_path }
    if (-not $target) { exit 0 }
    $target = ConvertTo-WindowsPath $target

    # Относительный путь резолвится от cwd сессии, а не от каталога запуска хука.
    if (-not [System.IO.Path]::IsPathRooted($target)) {
        $cwd = ConvertTo-WindowsPath ([string]$payload.cwd)
        if ($cwd) { $target = Join-Path $cwd $target } else { exit 0 }
    }

    # 2. Репозитории самого профиля Claude: правки конфигов должны применяться
    #    к ТЕКУЩЕЙ сессии, worktree их ломает (исключение зафиксировано в CLAUDE.md).
    #    Проверка по префиксу пути идёт ДО git — самый частый случай не платит за процессы.
    $selfRoots = @(
        (Split-Path $PSScriptRoot -Parent),
        (Join-Path $env:USERPROFILE '.claude'),
        (Join-Path $env:USERPROFILE '.claude-work')
    ) | ForEach-Object { Get-PathKey $_ } | Where-Object { $_ } | Select-Object -Unique

    $targetKey = $target.ToLowerInvariant()
    foreach ($sr in $selfRoots) {
        if ($targetKey -eq $sr -or $targetKey.StartsWith($sr + '\')) { exit 0 }
    }

    # 3. Ближайший СУЩЕСТВУЮЩИЙ каталог: файл (и его папка) может ещё не быть создан.
    $dir = $target
    if (Test-Path -LiteralPath $dir -PathType Leaf) { $dir = Split-Path $dir -Parent }
    while ($dir -and -not (Test-Path -LiteralPath $dir -PathType Container)) {
        $parent = Split-Path $dir -Parent
        if (-not $parent -or $parent -eq $dir) { $dir = $null; break }
        $dir = $parent
    }
    if (-not $dir) { exit 0 }

    # 4. Репозиторий и ветка — одним процессом git. Вне git — не наше дело.
    $gitOut = @(& git -C $dir rev-parse --show-toplevel --abbrev-ref HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $gitOut.Count -lt 2) { exit 0 }

    $repoRoot = ConvertTo-WindowsPath ([string]$gitOut[0])
    $branch = ([string]$gitOut[1]).Trim()
    if (-not $repoRoot -or -not $branch) { exit 0 }
    $repoKey = $repoRoot.ToLowerInvariant()

    if ($selfRoots -contains $repoKey) { exit 0 }
    if (Test-Path -LiteralPath (Join-Path $repoRoot '.claude\.allow-protected-branch-edits')) { exit 0 }

    # Detached HEAD: ветки нет, но коммит может стоять на вершине защищённой —
    # запись в дерево транка через `git checkout --detach main` иначе проходит молча.
    $detachedAt = @()
    if ($branch -eq 'HEAD') {
        $detachedAt = @(& git -C $dir branch --points-at HEAD --format='%(refname:short)' 2>$null) |
            ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ }
        if (-not $detachedAt) { exit 0 }
    }

    # 5. Реестр. Рядом со скриптом (работает для любого профиля), иначе — дефолтный профиль.
    $registryCandidates = @((Join-Path (Split-Path $PSScriptRoot -Parent) 'config\protected-branches.local.json'))
    if ($env:USERPROFILE) {
        $registryCandidates += (Join-Path $env:USERPROFILE '.claude\config\protected-branches.local.json')
    }
    $registry = $null
    foreach ($c in $registryCandidates) { if (Test-Path -LiteralPath $c) { $registry = $c; break } }

    $protected = @('main', 'master', 'develop')
    $trunk = $null
    $mrTarget = $null
    $repoLabel = $null
    $knownRepo = $false

    if ($registry) {
        $cfg = Get-Content -LiteralPath $registry -Raw -Encoding UTF8 | ConvertFrom-Json

        # Проверять НАЛИЧИЕ ключа, а не truthiness: пустой массив в PowerShell falsy,
        # и "protected": [] («здесь ничего не защищаем») молча превращался в дефолт.
        if (Test-HasProperty $cfg.defaults 'protected') { $protected = @($cfg.defaults.protected) }
        if ($cfg.defaults.mrTarget) { $mrTarget = [string]$cfg.defaults.mrTarget }

        foreach ($ign in @($cfg.ignoreRepos)) {
            if (Test-RepoKeyMatch $repoKey (Get-PathKey $ign)) { exit 0 }
        }

        if ($cfg.repos) {
            foreach ($prop in $cfg.repos.PSObject.Properties) {
                if (-not (Test-RepoKeyMatch $repoKey (Get-PathKey $prop.Name))) { continue }
                $entry = $prop.Value
                if ($entry.enabled -eq $false) { exit 0 }
                $knownRepo = $true
                if (Test-HasProperty $entry 'protected') { $protected = @($entry.protected) }
                if ($entry.trunk) { $trunk = [string]$entry.trunk }
                if ($entry.mrTarget) { $mrTarget = [string]$entry.mrTarget }
                if ($entry.label) { $repoLabel = [string]$entry.label }
                break
            }
        }
    }

    # 6. Совпадение ветки — с поддержкой шаблонов вида release/*.
    $branchesToTest = if ($detachedAt) { $detachedAt } else { @($branch) }
    $matched = $null
    foreach ($b in $branchesToTest) {
        foreach ($p in $protected) {
            if ([string]$p -and $b -like ([string]$p)) { $matched = $b; break }
        }
        if ($matched) { break }
    }
    if (-not $matched) { exit 0 }

    if (-not $trunk) { $trunk = $matched }
    # Глобальный mrTarget осмыслен только для репозитория, который есть в реестре;
    # иначе подсказка звала бы MR в чужой транк.
    if (-not $knownRepo -or -not $mrTarget) { $mrTarget = $trunk }
    if (-not $repoLabel) { $repoLabel = $repoRoot }

    $where = if ($detachedAt) { "detached HEAD на вершине защищённой ветки '$matched'" } else { "защищённой ветке '$matched'" }

    $msg = @"
Правка файла на $where ($repoLabel).

Правило: на $($protected -join ' / ') код не пишем. Работа идёт в отдельной ветке
и попадает в '$mrTarget' только через MR/PR — прямых коммитов в транк нет.

Порядок вместо этой правки (<slug> заменить на короткое имя задачи,
<type> — feat / fix / chore по смыслу):
  git -C "$repoRoot" worktree add .claude/worktrees/<slug> -b <type>/<slug> $trunk
  # скопировать gitignored-конфиги сборки (local.properties / secrets.properties / .env.local)
  # убедиться, что сборка стартует из нового каталога — ДО первой правки
  # повторить правку уже по пути внутри worktree

Правка сознательно делается в транке (hotfix, конфиг, который обязан примениться сразу,
явная просьба работать в текущем checkout)? Это решает пользователь, не агент: попроси
его подтвердить и снять блокировку — `setx CLAUDE_ALLOW_PROTECTED_BRANCH 1` на сессию
либо файл-флаг "$repoRoot\.claude\.allow-protected-branch-edits". Самостоятельно
выставлять их нельзя — это обход правила, а не его исполнение.
"@

    @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $msg } } |
        ConvertTo-Json -Depth 5 -Compress
    exit 0
}
catch {
    exit 0
}
