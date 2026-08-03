# claude-md-size-guard.ps1 — SessionStart hook.
# Enforcement для правила «CLAUDE.md ≤200 строк» (improvement 2026-05-28 replay: лимит без
# механизма не самоподдерживается). Варнит когда глобальный ИЛИ проектный CLAUDE.md > лимита,
# чтобы detail вынесли в rules/ или skills/ до регресса adherence. Не блокирует, только additionalContext.
# Запуск: pwsh 7+ (UTF-8 без BOM), stdin = hook JSON ({cwd, source, ...}).
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$limit = 200

# --- cwd из stdin JSON хука, fallback — текущая директория ---
$cwd = $null
try {
    $stdin = [Console]::In.ReadToEnd()
    if ($stdin) { $cwd = (ConvertFrom-Json $stdin).cwd }
} catch {}
if (-not $cwd) { $cwd = (Get-Location).Path }

# --- цели: глобальный source-of-truth + проектный (если это не тот же файл) ---
$global = Join-Path $env:USERPROFILE '.claude\CLAUDE.md'
$targets = @()
if (Test-Path -LiteralPath $global) { $targets += ,@('глобальный', $global) }
$proj = Join-Path $cwd 'CLAUDE.md'
if (Test-Path -LiteralPath $proj) {
    $samePath = $false
    try { $samePath = (Resolve-Path -LiteralPath $proj).Path -eq (Resolve-Path -LiteralPath $global).Path } catch {}
    if (-not $samePath) { $targets += ,@('проектный', $proj) }
}

$over = @()
foreach ($t in $targets) {
    try {
        $n = @(Get-Content -LiteralPath $t[1] -Encoding UTF8).Count
        if ($n -gt $limit) { $over += "$($t[0]) CLAUDE.md — $n строк (лимит $limit): $($t[1])" }
    } catch {}
}

if ($over.Count -eq 0) { exit 0 }

$ctx = "WARNING: CLAUDE.md > ~$limit строк (Anthropic: >200 снижает adherence + раздувает per-turn/per-subagent контекст). Вынеси detail-блоки: правило по типу файлов -> ~/.claude/rules/*.md с paths:, процедура -> ~/.claude/skills/<name>/SKILL.md; в CLAUDE.md оставь триггер+указатель. Инварианты (security/git/DoD-gate/scope) оставляй inline. Маршрутизация - скилл instruction-routing.`n" + ($over -join "`n")

@{
    systemMessage      = $ctx
    hookSpecificOutput = @{
        hookEventName     = 'SessionStart'
        additionalContext = $ctx
    }
} | ConvertTo-Json -Depth 4
