# ensure-worktree-guard.ps1
# SessionStart hook (user-level): guarantees that a session running inside a git
# worktree has the main-repo write guard registered.
#
# Problem it solves: `.claude/settings.local.json` is per-checkout and is NOT
# tracked by git, so a freshly created worktree may start with no PreToolUse
# guard at all. Subagents resolve relative paths against the MAIN checkout, so
# without the guard their writes land on the wrong branch silently (precedents
# 2026-05-29, 2026-06-03, 2026-06-23, 2026-07-20).
#
# Repo-agnostic: activates only when the session cwd is under
# <repo>\.claude\worktrees\<name> AND that repo ships
# <repo>\.claude\hooks\guard-main-repo-edit.ps1. Otherwise it is a no-op.
#
# Mirrors the self-install pattern of ~/.claude/review-rules/ensure-hook.ps1.

$ErrorActionPreference = 'Stop'

# Сообщение хука содержит «⚠» и русский текст; без явного UTF-8 на stdout консоль
# Windows отдаёт их в OEM-кодировке и CLI показывает mojibake (поймано smoke-тестом
# 2026-08-10: байт 0xa3 вместо U+26A0). Свой try: падение установки кодировки не
# должно убивать регистрацию гарда.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

try {
    $cwd = $null
    try {
        $raw = [Console]::In.ReadToEnd()
        if (-not [string]::IsNullOrWhiteSpace($raw)) { $cwd = ($raw | ConvertFrom-Json).cwd }
    } catch { }
    if ([string]::IsNullOrWhiteSpace($cwd)) { $cwd = (Get-Location).Path }

    $marker = '\.claude\worktrees\'
    $norm   = ($cwd -replace '/', '\')
    $idx    = $norm.ToLowerInvariant().IndexOf($marker)
    if ($idx -lt 0) { exit 0 }   # not a worktree session

    $repoRoot     = $norm.Substring(0, $idx)
    $worktreesDir = Join-Path $repoRoot '.claude\worktrees'
    $rel          = $norm.Substring($idx + $marker.Length)
    $worktreeName = ($rel -split '\\')[0]
    if ([string]::IsNullOrWhiteSpace($worktreeName)) { exit 0 }

    $worktreeRoot = Join-Path $worktreesDir $worktreeName
    $guardScript  = Join-Path $repoRoot '.claude\hooks\guard-main-repo-edit.ps1'
    if (-not (Test-Path $guardScript)) { exit 0 }   # repo does not use this guard

    $settingsDir  = Join-Path $worktreeRoot '.claude'
    $settingsPath = Join-Path $settingsDir 'settings.local.json'
    if (-not (Test-Path $settingsDir)) { New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null }

    if (Test-Path $settingsPath) {
        $settings = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
        $settings = [pscustomobject]@{}
    }

    if (-not $settings.PSObject.Properties['hooks']) {
        $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
    }
    $hooks = $settings.hooks
    if (-not $hooks.PSObject.Properties['PreToolUse']) {
        $hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @()
    }

    $existing = @($hooks.PreToolUse)
    if (($existing | ConvertTo-Json -Depth 10 -Compress) -match 'guard-main-repo-edit') { exit 0 }

    $entry = [pscustomobject]@{
        matcher = 'Edit|Write|MultiEdit'
        hooks   = @([pscustomobject]@{
            type          = 'command'
            shell         = 'powershell'
            command       = "& '$guardScript'"
            timeout       = 10
            statusMessage = 'worktree guard: main-repo write check'
        })
    }
    $hooks.PreToolUse = $existing + $entry

    $settings | ConvertTo-Json -Depth 20 | Set-Content -Path $settingsPath -Encoding UTF8

    # Тот же формат, что у остальных печатающих SessionStart-хуков (см. lib/hookout.py):
    # `⚠ суть` плюс детали с отступом, без рамок — CLI сам префиксит и отбивает вывод.
    # Голый Write-Output сюда не годится: stdout SessionStart-хука уезжает в контекст
    # МОДЕЛИ, а пользователь на экране не видит ничего — при том что действие нужно
    # именно от него (рестарт сессии).
    $screen = @"
$([char]0x26A0) worktree guard: PreToolUse-гард записи в главный checkout не был зарегистрирован
  зарегистрирован для worktree '$worktreeName'
  нужен рестарт сессии или /hooks reload, иначе записи в главный checkout не блокируются
"@
    $ctx = "worktree-guard: registered PreToolUse main-repo write guard for worktree " +
           "'$worktreeName' (was missing). Restart or /hooks reload if writes to the main " +
           "checkout are still not blocked."

    @{
        suppressOutput     = $true
        systemMessage      = $screen.Trim()
        hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $ctx }
    } | ConvertTo-Json -Depth 5 -Compress
} catch {
    # fail-open: a broken guard installer must never block a session from starting
    exit 0
}
exit 0
