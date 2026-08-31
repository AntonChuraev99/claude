# ensure-bash-discipline-registered.tests.ps1 — suite for the SessionStart assertion hook.
# Dependency-free: spawns the hook as a child pwsh with piped stdin, asserts on JSON stdout.
# The profile root is redirected to a temp fixture via $env:CLAUDE_HOME, so the suite never
# reads the real ~/.claude/settings.json. Exit code = number of failed assertions.
#
# Contract: silent when the invariant holds; one JSON object naming every broken part when it
# does not; never blocks, never edits, always exit 0.
# Run: pwsh -NoProfile -File hooks/ensure-bash-discipline-registered.tests.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$hook = Join-Path $PSScriptRoot 'ensure-bash-discipline-registered.ps1'
$script:pass = 0
$script:fail = 0

function New-Home {
    param([object]$Settings, [bool]$WithModule = $true, [string[]]$LogLines = @())
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ("ebdr-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'hooks') | Out-Null
    if ($null -ne $Settings) {
        if ($Settings -is [string]) { Set-Content -LiteralPath (Join-Path $root 'settings.json') -Value $Settings -Encoding UTF8 }
        else { $Settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $root 'settings.json') -Encoding UTF8 }
    }
    if ($WithModule) {
        Set-Content -LiteralPath (Join-Path $root 'hooks\bash-tool-discipline.js') -Value '// stub' -Encoding UTF8
    }
    if ($LogLines.Count -gt 0) {
        $dir = Join-Path $root 'error-logs'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'hook-failures.jsonl') -Value $LogLines -Encoding UTF8
    }
    return $root
}

function Invoke-Hook {
    # NOT $Home: that is a read-only automatic variable in PowerShell.
    param([string]$ProfileRoot)
    $prev = $env:CLAUDE_HOME
    $env:CLAUDE_HOME = $ProfileRoot
    try {
        $out = '{"cwd":"C:\\x","source":"startup"}' | pwsh -NoProfile -ExecutionPolicy Bypass -File $hook 2>$null
    } finally {
        if ($null -eq $prev) { Remove-Item Env:CLAUDE_HOME -ErrorAction SilentlyContinue }
        else { $env:CLAUDE_HOME = $prev }
    }
    return ($out -join "`n")
}

function Ctx {
    param([string]$Out)
    if ([string]::IsNullOrWhiteSpace($Out)) { return $null }
    try { return (ConvertFrom-Json $Out).hookSpecificOutput.additionalContext } catch { return $null }
}

function Assert-Silent {
    param([string]$Out, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($Out)) {
        $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green
    } else {
        $script:fail++; Write-Host "  FAIL  $Name`n        expected silence, got: [$Out]" -ForegroundColor Red
    }
}

function Assert-Fires {
    param([string]$Out, [string]$Needle, [string]$Name)
    $ctx = Ctx $Out
    if ($ctx -and $ctx -match [regex]::Escape($Needle)) {
        $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green
    } else {
        $script:fail++; Write-Host "  FAIL  $Name`n        wanted [$Needle] in: [$ctx]" -ForegroundColor Red
    }
}

function Prefilter {
    param([string]$Matcher = 'Bash|Grep')
    $h = @{ type = 'command'; command = "& 'credentials-guard-prefilter.js'" }
    if ($null -eq $Matcher) { return [pscustomobject]@{ hooks = @($h) } }
    return [pscustomobject]@{ matcher = $Matcher; hooks = @($h) }
}
function Settings { param([object[]]$Entries) @{ hooks = @{ PreToolUse = $Entries } } }

Write-Host "ensure-bash-discipline-registered.ps1 — suite"

# --- invariant holds ---
Assert-Silent (Invoke-Hook (New-Home (Settings @((Prefilter))))) 'registered + Bash|Grep + module -> silent'

# --- the three breakages the hook exists to catch ---
$noEntry = Settings @([pscustomobject]@{ matcher = 'Write|Edit'; hooks = @(@{ type = 'command'; command = 'other.js' }) })
Assert-Fires (Invoke-Hook (New-Home $noEntry)) 'отсутствует в settings.json' 'prefilter entry removed -> fires'
Assert-Fires (Invoke-Hook (New-Home (Settings @((Prefilter 'Bash'))))) 'не покрывает тул Grep' 'matcher lost Grep -> fires'
Assert-Fires (Invoke-Hook (New-Home (Settings @((Prefilter 'Grep'))))) 'не покрывает тул Bash' 'matcher lost Bash -> fires'
Assert-Fires (Invoke-Hook (New-Home (Settings @((Prefilter))) -WithModule $false)) 'bash-tool-discipline.js не найден' 'module gone -> fires'

# --- regression: coverage is the UNION, and a matcher-less entry is WIDER, not narrower ---
# Both shapes are valid config. Judging only the first entry's matcher string made the hook
# cry wolf every session, which is the failure mode it was written to avoid.
Assert-Silent (Invoke-Hook (New-Home (Settings @((Prefilter 'Bash'), (Prefilter 'Grep'))))) 'Bash and Grep split across two entries -> silent'
Assert-Silent (Invoke-Hook (New-Home (Settings @((Prefilter $null))))) 'entry without matcher (matches all tools) -> silent'
Assert-Silent (Invoke-Hook (New-Home (Settings @((Prefilter 'Bash|Grep|Write'))))) 'wider matcher -> silent'

# --- degradation log: the window is judged per line ts, not by the file mtime ---
$fresh = '{"ts":"' + (Get-Date).ToUniversalTime().ToString('o') + '","hook":"credentials-guard-prefilter","event":"discipline-module-unavailable","error":"boom"}'
$stale = '{"ts":"2026-01-01T00:00:00.0000000Z","hook":"credentials-guard-prefilter","event":"discipline-module-unavailable","error":"old"}'
Assert-Fires (Invoke-Hook (New-Home (Settings @((Prefilter))) -LogLines @($fresh))) 'discipline-module-unavailable' 'fresh failure line -> fires'
# The file is written now, so its mtime is fresh while every record in it is months old:
# counting lines by file mtime would report stale records as if they happened this week.
Assert-Silent (Invoke-Hook (New-Home (Settings @((Prefilter))) -LogLines @($stale, $stale))) 'stale lines in a freshly written log -> silent'
Assert-Fires (Invoke-Hook (New-Home (Settings @((Prefilter))) -LogLines @($stale, $fresh))) 'за 7 дней 1 записей' 'mixed log counts only the fresh line'

# --- fail-open: nothing here may ever break session start ---
Assert-Silent (Invoke-Hook (New-Home $null)) 'no settings.json -> silent'
Assert-Silent (Invoke-Hook (New-Home 'not json at all')) 'malformed settings.json -> silent'

# --- output shape ---
$evt = try { (ConvertFrom-Json (Invoke-Hook (New-Home $noEntry))).hookSpecificOutput.hookEventName } catch { $null }
if ($evt -eq 'SessionStart') { $script:pass++; Write-Host "  PASS  output hookEventName = SessionStart" -ForegroundColor Green }
else { $script:fail++; Write-Host "  FAIL  output hookEventName = SessionStart (got [$evt])" -ForegroundColor Red }

Write-Host "`n$script:pass passed, $script:fail failed"
exit $script:fail
