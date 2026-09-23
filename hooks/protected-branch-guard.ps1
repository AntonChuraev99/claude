# PreToolUse(Write|Edit|NotebookEdit|…Edit) guard: не дать писать код прямо на защищённой
# ветке (main / master / develop и т.п.) НЕЗАМЕЧЕННЫМ. Правило: работа идёт в отдельной
# ветке и вливается в транк через MR/PR.
#
# Реестр веток по проектам — ~/.claude/config/protected-branches.local.json
# (шаблон — protected-branches.example.json). Реестра нет / репозитория в нём нет
# => применяются defaults.
#
# Решение — «deny один раз, повтор проходит» (с 2026-09-18; до того — безусловный deny).
# Первая правка на защищённой ветке блокируется с текстом правила и worktree-процедуры;
# повтор того же вызова (та же ветка, тот же репозиторий, тот же агент) проходит, и
# хук лишь добавляет короткое напоминание в контекст (`additionalContext`) плюс
# `systemMessage` пользователю. Агент нарушает правило сознательно, а не постфактум,
# и не упирается в стену, когда правка в транке действительно нужна (hotfix, конфиг,
# явная просьба пользователя).
#
# «Тот же агент» — ключ состояния по transcript_path (у каждого субагента свой), с
# откатом на session_id: субагенты фан-аута наследуют session_id родителя, и на ключе
# по сессии предупреждение увидел бы один из них. Состояние — файл в
# %TEMP%\claude-branch-guard\<sha1(ключ)>.json, TTL сутки, override каталога —
# env CLAUDE_BRANCH_GUARD_STATE_DIR (тесты).
#
# Почему `deny`, а не `ask`: проверено вживую 2026-08-04 — при
# `defaultMode: bypassPermissions` (плюс skipAutoPermissionPrompt) CLI молча
# проглатывает `ask`, запись проходит; `deny` блокирует. Документация обещает
# обратное, менять только после нового живого прогона. Пропуск повтора — НЕ `allow`
# (он снял бы штатный permission-flow), а отсутствие permissionDecision вовсе.
#
# No-op (тихий exit 0), если: инструмент не пишет файл · путь вне git-репозитория ·
# репозиторий самого профиля Claude (~/.claude, ~/.claude-work — их правки должны
# применяться к текущей сессии) · ветка не защищена · выставлен escape-hatch.
# Любая внутренняя ошибка => exit 0 (хук не должен ломать сессию) плюс строка в
# stats/hook-degraded.log — иначе «сломан» неотличим от «не понадобился».
#
# ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: покрывает только файловые инструменты. Запись через Bash
# (`cat > f`, `sed -i`, `git apply`, `git checkout -- path`) и правки фоновых
# субагентов (run_in_background не наследует PreToolUse) хук НЕ видит — они
# закрываются процедурно (process-gate.yaml → no-code-on-protected-branch).
#
# Escape-hatch (глушит проверку целиком, ставит пользователь): env
# CLAUDE_ALLOW_PROTECTED_BRANCH=1 либо файл-флаг <repo>\.claude\.allow-protected-branch-edits
#
# $ErrorActionPreference намеренно 'SilentlyContinue', а не 'Stop' как у соседних
# хуков: под 'Stop' нативный `git ... 2>$null` бросает NativeCommandError и хук
# разваливается на штатном пути.
#
# Запуск: pwsh 7+, stdin = hook JSON ({tool_name, tool_input:{file_path|notebook_path},
# cwd, session_id, transcript_path, ...}). Тесты: hooks/protected-branch-guard.tests.ps1
# (реестр подменяется env CLAUDE_BRANCH_GUARD_REGISTRY).
#
# ВАЖНО: файл публикуется в открытый репозиторий — никаких абсолютных путей,
# имён проектов и логинов в коде.

$ErrorActionPreference = 'SilentlyContinue'

# Сообщение хука — русское; без явного UTF-8 на stdout CLI получает mojibake
# (в консоли Windows кодировка по умолчанию OEM). Собственный try: падение
# установки кодировки не должно убивать весь хук.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$STATE_TTL_SEC = 24 * 60 * 60

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

# --- состояние «уже предупреждал» ---------------------------------------------------

function Get-StateDir {
    if ($env:CLAUDE_BRANCH_GUARD_STATE_DIR) { return $env:CLAUDE_BRANCH_GUARD_STATE_DIR }
    return (Join-Path ([System.IO.Path]::GetTempPath()) 'claude-branch-guard')
}

# Имя файла — sha1 ключа, а не сам ключ: transcript_path'ы делят длинный общий
# префикс, и усечённая строка сталкивала бы разных агентов в один файл.
function Get-StateFile([string]$key) {
    if (-not $key) { $key = 'nosession' }
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key))
    $name = ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
    return (Join-Path (Get-StateDir) "$name.json")
}

function Read-State([string]$file) {
    try {
        if (-not (Test-Path -LiteralPath $file)) { return @{} }
        $obj = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        if ($obj -is [hashtable]) { return $obj }
        return @{}
    } catch { return @{} }
}

# Подметает чужие протухшие файлы. Только при первой записи агента — readdir не
# платится на каждом вызове.
function Remove-StaleState([string]$dir) {
    try {
        $cutoff = (Get-Date).AddSeconds(-$STATE_TTL_SEC)
        Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | Where-Object { $_.LastWriteTime -lt $cutoff } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    } catch { }
}

function Write-State([string]$file, [hashtable]$state, [bool]$firstWrite) {
    try {
        $dir = Split-Path $file -Parent
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        if ($firstWrite) { Remove-StaleState $dir }
        ($state | ConvertTo-Json -Compress) | Set-Content -LiteralPath $file -Encoding UTF8 -NoNewline
    } catch {
        # Напоминание — не то, ради чего стоит ронять хук; без состояния хук
        # деградирует до «deny каждый раз», что безопаснее пропуска.
    }
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

    # 5. Реестр. Override для тестов, иначе рядом со скриптом (работает для любого
    #    профиля), иначе — дефолтный профиль.
    $registryCandidates = @()
    if ($env:CLAUDE_BRANCH_GUARD_REGISTRY) { $registryCandidates += $env:CLAUDE_BRANCH_GUARD_REGISTRY }
    $registryCandidates += (Join-Path (Split-Path $PSScriptRoot -Parent) 'config\protected-branches.local.json')
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

    # 7. Уже предупреждали этого агента про эту ветку этого репозитория? Тогда
    #    правка проходит — с напоминанием в контекст и строкой пользователю.
    $agentKey = [string]$payload.transcript_path
    if (-not $agentKey) { $agentKey = [string]$payload.session_id }
    $stateFile = Get-StateFile $agentKey
    $state = Read-State $stateFile
    $seenKey = "$repoKey|$matched"

    # Возраст записи сверяется на чтении, как в bash-tool-discipline: иначе своя запись
    # никогда не истекает, и `claude --resume` через сутки пропускал бы первую правку
    # без текста правила.
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $seenAt = if ($state.ContainsKey($seenKey)) { [int64]$state[$seenKey] } else { 0 }
    if ($seenAt -gt 0 -and ($now - $seenAt) -lt $STATE_TTL_SEC) {
        $note = "protected-branch-guard: правка на $where ($repoLabel) пропущена как сознательное исключение — " +
                "назвать причину в отчёте; результат уходит в '$mrTarget' только через MR/PR."
        @{
            systemMessage = "⚠ branch guard: правка на $where ($repoLabel) — повтор, пропущено."
            hookSpecificOutput = @{ hookEventName = 'PreToolUse'; additionalContext = $note }
        } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }

    $firstWrite = ($state.Count -eq 0)
    $state[$seenKey] = $now
    Write-State $stateFile $state $firstWrite

    $msg = @"
Правка файла на $where ($repoLabel).

Правило: на $($protected -join ' / ') код не пишем. Работа идёт в отдельной ветке
и попадает в '$mrTarget' только через MR/PR — прямых коммитов в транк нет.

Порядок вместо этой правки: тул EnterWorktree({name: "<slug>"}) — заведёт
.claude/worktrees/<slug> на новой ветке от транка и переключит сессию туда;
затем повторить правку уже по пути внутри worktree. Без тула:
  git -C "$repoRoot" worktree add .claude/worktrees/<slug> -b <type>/<slug> $trunk
  # скопировать gitignored-конфиги сборки (local.properties / secrets.properties / .env.local)
  # убедиться, что сборка стартует из нового каталога — ДО первой правки

Правка сознательно делается в транке (hotfix по согласованию, конфиг, который обязан
примениться сразу, явная просьба пользователя работать в текущем checkout)? Это
предупреждение, а не стена: повтори тот же вызов — второй и последующие пройдут
(эта ветка, этот репозиторий, этот агент, в течение суток) — и назови причину в отчёте.
Выключить проверку целиком может пользователь: файл-флаг
"$repoRoot\.claude\.allow-protected-branch-edits" (действует сразу) либо
CLAUDE_ALLOW_PROTECTED_BRANCH=1 в окружении, из которого запущен claude (хук наследует
env CLI — нужен перезапуск сессии; `setx` текущую сессию не меняет).
"@

    @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $msg } } |
        ConvertTo-Json -Depth 5 -Compress
    exit 0
}
catch {
    # Fail-open, но не молча: без строки в журнале replay не отличит «ни разу не
    # понадобился» от «сломан и не звал». stats/ — вне git (тот же каталог у
    # credentials-guard). Сбой записи журнала хук не роняет.
    try {
        $log = Join-Path (Split-Path $PSScriptRoot -Parent) 'stats\hook-degraded.log'
        New-Item -ItemType Directory -Force -Path (Split-Path $log -Parent) | Out-Null
        Add-Content -LiteralPath $log -Encoding UTF8 -Value ("{0}`tprotected-branch-guard`t{1}" -f
            (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), ($_.Exception.Message -replace '\s+', ' '))
    } catch { }
    exit 0
}
