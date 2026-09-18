# protected-branch-guard.tests.ps1 — suite for protected-branch-guard.ps1 (PreToolUse hook).
# Dependency-free: spawns the hook as a child pwsh with piped stdin, asserts on JSON stdout.
# Hermetic: temp git repo, temp registry (env CLAUDE_BRANCH_GUARD_REGISTRY), temp state dir
# (env CLAUDE_BRANCH_GUARD_STATE_DIR) — the suite never touches the real registry or %TEMP% state.
# Exit code = number of failed assertions.
#
# Contract (2026-09-18): first Write/Edit on a protected branch -> deny with the rule text;
# the same agent (transcript_path) repeating on the same repo+branch -> passes through with
# additionalContext + systemMessage and NO permissionDecision; another agent / another
# protected branch -> deny again; escape hatches and unprotected branches -> silent.
# Run: pwsh -NoProfile -File hooks/protected-branch-guard.tests.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$hook = Join-Path $PSScriptRoot 'protected-branch-guard.ps1'
$script:pass = 0
$script:fail = 0

function Assert-Eq {
    param($Expected, $Actual, [string]$Name)
    if ($Expected -eq $Actual) {
        $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green
    } else {
        $script:fail++; Write-Host "  FAIL  $Name`n        expected: [$Expected]`n        actual:   [$Actual]" -ForegroundColor Red
    }
}

function Assert-Match {
    param([string]$Pattern, [string]$Actual, [string]$Name)
    if ($Actual -and $Actual -match $Pattern) {
        $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green
    } else {
        $script:fail++; Write-Host "  FAIL  $Name`n        pattern: [$Pattern]`n        actual:  [$Actual]" -ForegroundColor Red
    }
}

# --- fixtures -------------------------------------------------------------------------
$fx = Join-Path ([System.IO.Path]::GetTempPath()) ('pbg-fx-' + [guid]::NewGuid().ToString('N'))
$repo = Join-Path $fx 'repo'
$stateDir = Join-Path $fx 'state'
$registry = Join-Path $fx 'registry.json'
New-Item -ItemType Directory -Force -Path $repo, $stateDir | Out-Null

# Registry: defaults only, repo unknown -> mrTarget must fall back to the matched branch.
@'
{ "defaults": { "protected": ["main", "develop", "release/*"], "mrTarget": "develop" }, "repos": {}, "ignoreRepos": [] }
'@ | Set-Content -LiteralPath $registry -Encoding UTF8

& git -C $repo init -q -b main
& git -C $repo -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
$file = Join-Path $repo 'a.txt'

function Invoke-Hook {
    param([string]$Json, [hashtable]$Vars = @{})
    $saved = @{}
    foreach ($k in $Vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $Vars[$k]) }
    $env:CLAUDE_BRANCH_GUARD_REGISTRY = $registry
    $env:CLAUDE_BRANCH_GUARD_STATE_DIR = $stateDir
    try {
        $out = $Json | pwsh -NoProfile -ExecutionPolicy Bypass -File $hook 2>$null
    } finally {
        foreach ($k in $Vars.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
        Remove-Item Env:CLAUDE_BRANCH_GUARD_REGISTRY -ErrorAction SilentlyContinue
        Remove-Item Env:CLAUDE_BRANCH_GUARD_STATE_DIR -ErrorAction SilentlyContinue
    }
    return ($out -join "`n")
}

function Payload {
    param([string]$Tool = 'Write', [string]$Path = $file, [string]$Agent = 'agent-A')
    return (@{
        tool_name = $Tool
        tool_input = @{ file_path = $Path }
        cwd = $repo
        session_id = 'sess-1'
        transcript_path = "C:\transcripts\$Agent.jsonl"
    } | ConvertTo-Json -Compress)
}

function Parse([string]$Out) {
    if ([string]::IsNullOrWhiteSpace($Out)) { return $null }
    try { return (ConvertFrom-Json $Out) } catch { return $null }
}

Write-Host "protected-branch-guard.ps1 — suite"

# 1. first hit on main -> deny with the rule and the "repeat passes" hint
$r = Parse (Invoke-Hook (Payload))
Assert-Eq 'deny' $r.hookSpecificOutput.permissionDecision 'first Write on main -> deny'
Assert-Match "защищённой ветке 'main'" $r.hookSpecificOutput.permissionDecisionReason 'deny names the branch'
Assert-Match 'повтори тот же вызов' $r.hookSpecificOutput.permissionDecisionReason 'deny explains the repeat escape'
Assert-Match 'EnterWorktree' $r.hookSpecificOutput.permissionDecisionReason 'deny points at EnterWorktree'
Assert-Match "'main' только через MR/PR" $r.hookSpecificOutput.permissionDecisionReason 'unknown repo: mrTarget falls back to matched branch'

# 2. same agent, same repo+branch -> pass-through with context, no permissionDecision
$r = Parse (Invoke-Hook (Payload))
Assert-Eq $null $r.hookSpecificOutput.permissionDecision 'repeat -> no permissionDecision'
Assert-Match 'пропущена как сознательное исключение' $r.hookSpecificOutput.additionalContext 'repeat -> additionalContext reminder'
Assert-Match 'повтор, пропущено' $r.systemMessage 'repeat -> systemMessage for the user'

# 3. other file, same agent+branch -> still passes (state is per repo+branch, not per file)
$r = Parse (Invoke-Hook (Payload -Path (Join-Path $repo 'sub\b.txt')))
Assert-Eq $null $r.hookSpecificOutput.permissionDecision 'repeat on another file -> passes'
Assert-Match 'пропущена' $r.hookSpecificOutput.additionalContext 'repeat on another file -> reminder'

# 4. another agent (own transcript_path) -> deny again
$r = Parse (Invoke-Hook (Payload -Agent 'agent-B'))
Assert-Eq 'deny' $r.hookSpecificOutput.permissionDecision 'other agent -> deny again'

# 5. another protected branch -> deny again for agent-A; back on main -> passes
& git -C $repo checkout -q -b develop
$r = Parse (Invoke-Hook (Payload))
Assert-Eq 'deny' $r.hookSpecificOutput.permissionDecision 'develop after main -> deny (state keyed by branch)'
& git -C $repo checkout -q main
$r = Parse (Invoke-Hook (Payload))
Assert-Eq $null $r.hookSpecificOutput.permissionDecision 'back on main -> still passes'
Assert-Match 'пропущена' $r.hookSpecificOutput.additionalContext 'back on main -> reminder present (not a silent exit)'

# 6. unprotected branch -> silent
& git -C $repo checkout -q -b feat/x
Assert-Eq '' (Invoke-Hook (Payload -Agent 'agent-C')) 'feature branch -> silent'
& git -C $repo checkout -q main

# 7. escape hatches -> silent even on the first hit
Assert-Eq '' (Invoke-Hook (Payload -Agent 'agent-D') @{ CLAUDE_ALLOW_PROTECTED_BRANCH = '1' }) 'env escape hatch -> silent'
$flagDir = Join-Path $repo '.claude'
New-Item -ItemType Directory -Force -Path $flagDir | Out-Null
New-Item -ItemType File -Path (Join-Path $flagDir '.allow-protected-branch-edits') | Out-Null
Assert-Eq '' (Invoke-Hook (Payload -Agent 'agent-E')) 'file-flag escape hatch -> silent'
Remove-Item -Recurse -Force $flagDir

# 8. non-writing tool -> silent
Assert-Eq '' (Invoke-Hook (Payload -Tool 'Read' -Agent 'agent-F')) 'Read -> silent'

# 9. state file is a sha1 name, not the raw key (collision-proof across agents);
#    only agents that were denied (A, B) own a file — silent paths write nothing
$stateFiles = @(Get-ChildItem -LiteralPath $stateDir -Filter '*.json')
Assert-Eq 2 $stateFiles.Count 'one state file per denied agent, none for silent paths'
Assert-Match '^[0-9a-f]{40}\.json$' $stateFiles[0].Name 'state file named by sha1'

# 10. missing state (fresh dir) -> deny again: no state == "never warned"
Remove-Item -Recurse -Force $stateDir
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$r = Parse (Invoke-Hook (Payload))
Assert-Eq 'deny' $r.hookSpecificOutput.permissionDecision 'state wiped -> deny again (fail-closed to deny)'

# 11. record older than the TTL (24h) is ignored on read -> deny again, then a fresh record passes.
#     Covers `claude --resume` next day: same transcript_path, but the warning must be shown anew.
$stateFile = (Get-ChildItem -LiteralPath $stateDir -Filter '*.json' | Select-Object -First 1).FullName
$aged = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json -AsHashtable
foreach ($k in @($aged.Keys)) { $aged[$k] = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 2 * 24 * 60 * 60 }
($aged | ConvertTo-Json -Compress) | Set-Content -LiteralPath $stateFile -Encoding UTF8 -NoNewline
$r = Parse (Invoke-Hook (Payload))
Assert-Eq 'deny' $r.hookSpecificOutput.permissionDecision 'record older than TTL -> deny again'
$r = Parse (Invoke-Hook (Payload))
Assert-Match 'пропущена' $r.hookSpecificOutput.additionalContext 'fresh record after expiry -> passes with reminder'

Remove-Item -Recurse -Force $fx -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "pass=$($script:pass) fail=$($script:fail)"
exit $script:fail
