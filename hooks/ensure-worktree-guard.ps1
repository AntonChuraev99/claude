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

    Write-Output "worktree-guard: registered PreToolUse main-repo write guard for worktree '$worktreeName' (was missing). Restart or /hooks reload if writes to the main checkout are still not blocked."
} catch {
    # fail-open: a broken guard installer must never block a session from starting
    exit 0
}
exit 0
