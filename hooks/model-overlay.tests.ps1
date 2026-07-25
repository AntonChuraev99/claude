# model-overlay.tests.ps1 — TDD suite for model-overlay.ps1 (SessionStart hook).
# Dependency-free: spawns the hook as a child pwsh with piped stdin, asserts on JSON stdout.
# Overlay dir is redirected to a temp fixture via $env:CLAUDE_MODEL_OVERLAY_DIR, so the suite
# never touches the real ~/.claude/model-overlays. Exit code = number of failed assertions.
#
# Contract: fable* -> fable.md ; *opus-5* -> opus-5.md ; everything else (opus 4.x, unknown,
# absent, malformed) -> opus.md. opus.md is BOTH the Opus 4.x overlay AND the fallback.
# Run: pwsh -NoProfile -File hooks/model-overlay.tests.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$hook = Join-Path $PSScriptRoot 'model-overlay.ps1'
$script:pass = 0
$script:fail = 0

function Invoke-Hook {
    param([string]$Json, [string]$OverlayDir)
    $prev = $env:CLAUDE_MODEL_OVERLAY_DIR
    $env:CLAUDE_MODEL_OVERLAY_DIR = $OverlayDir
    try {
        $out = $Json | pwsh -NoProfile -ExecutionPolicy Bypass -File $hook 2>$null
    } finally {
        if ($null -eq $prev) { Remove-Item Env:CLAUDE_MODEL_OVERLAY_DIR -ErrorAction SilentlyContinue }
        else { $env:CLAUDE_MODEL_OVERLAY_DIR = $prev }
    }
    return ($out -join "`n")
}

function Ctx {
    # hook stdout -> additionalContext, or $null when there is no / invalid output
    param([string]$Out)
    if ([string]::IsNullOrWhiteSpace($Out)) { return $null }
    try { return (ConvertFrom-Json $Out).hookSpecificOutput.additionalContext } catch { return $null }
}

function Assert-Eq {
    param($Expected, $Actual, [string]$Name)
    if ($Expected -eq $Actual) {
        $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green
    } else {
        $script:fail++; Write-Host "  FAIL  $Name`n        expected: [$Expected]`n        actual:   [$Actual]" -ForegroundColor Red
    }
}

# --- fixture overlay dir with sentinel contents (no default.md: opus.md is the fallback) ---
$fx = Join-Path ([System.IO.Path]::GetTempPath()) ("mov-fx-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $fx | Out-Null
Set-Content -LiteralPath (Join-Path $fx 'opus.md')   -Value 'OPUS_SENTINEL'   -NoNewline -Encoding UTF8
Set-Content -LiteralPath (Join-Path $fx 'fable.md')  -Value 'FABLE_SENTINEL'  -NoNewline -Encoding UTF8
Set-Content -LiteralPath (Join-Path $fx 'opus-5.md') -Value 'OPUS5_SENTINEL'  -NoNewline -Encoding UTF8

Write-Host "model-overlay.ps1 — TDD suite"

# happy path
Assert-Eq 'OPUS_SENTINEL'  (Ctx (Invoke-Hook '{"model":"claude-opus-4-8[1m]"}' $fx)) 'opus 4.8 id -> opus.md'
Assert-Eq 'FABLE_SENTINEL' (Ctx (Invoke-Hook '{"model":"claude-fable-5"}' $fx))      'fable id -> fable.md'
Assert-Eq 'OPUS5_SENTINEL' (Ctx (Invoke-Hook '{"model":"claude-opus-5"}' $fx))       'opus 5 id -> opus-5.md'
Assert-Eq 'OPUS5_SENTINEL' (Ctx (Invoke-Hook '{"model":"claude-opus-5[1m]"}' $fx))   'opus 5 [1m] id -> opus-5.md'

# regression: 4.x ids must NOT be swallowed by the *opus-5* pattern
Assert-Eq 'OPUS_SENTINEL'  (Ctx (Invoke-Hook '{"model":"claude-opus-4-5"}' $fx))     'opus 4.5 -> opus.md (not opus-5.md)'
Assert-Eq 'OPUS_SENTINEL'  (Ctx (Invoke-Hook '{"model":"claude-opus-4-5-20251101"}' $fx)) 'opus 4.5 dated -> opus.md'

# fallback: any non-fable / unknown / absent / empty / null model -> opus.md
Assert-Eq 'OPUS_SENTINEL'  (Ctx (Invoke-Hook '{"model":"claude-sonnet-5"}' $fx))     'sonnet (unknown) -> opus.md (fallback)'
Assert-Eq 'OPUS_SENTINEL'  (Ctx (Invoke-Hook '{"model":"claude-haiku-4-5"}' $fx))    'haiku (unknown) -> opus.md (fallback)'
Assert-Eq 'OPUS_SENTINEL'  (Ctx (Invoke-Hook '{"source":"startup"}' $fx))            'no model field -> opus.md (fallback)'
Assert-Eq 'OPUS_SENTINEL'  (Ctx (Invoke-Hook '{"model":""}' $fx))                    'empty model -> opus.md (fallback)'
Assert-Eq 'OPUS_SENTINEL'  (Ctx (Invoke-Hook '{"model":null}' $fx))                  'null model -> opus.md (fallback)'

# edge: case-insensitive + substring (bedrock-style arn)
Assert-Eq 'OPUS_SENTINEL'  (Ctx (Invoke-Hook '{"model":"CLAUDE-OPUS-4-8"}' $fx))     'uppercase OPUS -> opus.md'
Assert-Eq 'FABLE_SENTINEL' (Ctx (Invoke-Hook '{"model":"US.ANTHROPIC.CLAUDE-FABLE-5-V1"}' $fx)) 'bedrock fable arn (uppercase) -> fable.md'
Assert-Eq 'OPUS5_SENTINEL' (Ctx (Invoke-Hook '{"model":"US.ANTHROPIC.CLAUDE-OPUS-5"}' $fx)) 'bedrock opus 5 arn (uppercase) -> opus-5.md'

# error: malformed / empty stdin -> opus.md (fallback), never crash
Assert-Eq 'OPUS_SENTINEL'  (Ctx (Invoke-Hook 'not json at all' $fx))                 'malformed stdin -> opus.md (fallback)'
Assert-Eq 'OPUS_SENTINEL'  (Ctx (Invoke-Hook '' $fx))                                'empty stdin -> opus.md (fallback)'

# output shape
$evt = try { (ConvertFrom-Json (Invoke-Hook '{"model":"claude-opus-4-8"}' $fx)).hookSpecificOutput.hookEventName } catch { $null }
Assert-Eq 'SessionStart' $evt 'output hookEventName = SessionStart'

# fallback: fable.md / opus-5.md missing -> opus.md
Remove-Item -LiteralPath (Join-Path $fx 'fable.md') -Force
Assert-Eq 'OPUS_SENTINEL' (Ctx (Invoke-Hook '{"model":"claude-fable-5"}' $fx))       'fable.md missing -> opus.md (fallback)'
Remove-Item -LiteralPath (Join-Path $fx 'opus-5.md') -Force
Assert-Eq 'OPUS_SENTINEL' (Ctx (Invoke-Hook '{"model":"claude-opus-5"}' $fx))        'opus-5.md missing -> opus.md (fallback)'

# fallback: opus.md (the fallback itself) also gone -> empty stdout, exit 0 (never crash)
Remove-Item -LiteralPath (Join-Path $fx 'opus.md') -Force
$empty = Invoke-Hook '{"model":"claude-opus-4-8"}' $fx
Assert-Eq $true ([string]::IsNullOrWhiteSpace($empty)) 'all overlays gone -> empty stdout'

# --- teardown + summary ---
Remove-Item -LiteralPath $fx -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "`n$script:pass passed, $script:fail failed"
exit $script:fail
