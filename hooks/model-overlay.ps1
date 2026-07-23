# model-overlay.ps1 — SessionStart hook: injects a model-specific behavioral overlay.
# Reads the active model from the hook's stdin JSON (.model — ground truth from the runtime,
# NOT the model's self-report) and returns the matching overlay file as additionalContext.
#   fable*  -> fable.md
#   else    -> opus.md   (Opus overlay AND the fallback for any non-fable / unknown / absent model)
# Rationale: an instruction that must run at a fixed lifecycle point belongs in a hook, not
# CLAUDE.md (Anthropic memory docs); the model field is exposed ONLY to SessionStart hooks, so
# routing here is deterministic and does not depend on the model correctly self-identifying.
# Never throws, never blocks the session: any failure -> silent exit 0.
# Overlay dir override via $env:CLAUDE_MODEL_OVERLAY_DIR (used by model-overlay.tests.ps1).
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    # --- active model from stdin JSON (optional; may be absent, empty, or null) ---
    $model = ''
    try {
        $stdin = [Console]::In.ReadToEnd()
        if ($stdin) { $model = [string](ConvertFrom-Json $stdin).model }
    } catch {}

    # --- pick overlay by model family (case-insensitive substring); opus.md is the fallback ---
    switch -Wildcard ($model.ToLowerInvariant()) {
        '*fable*' { $file = 'fable.md' }
        default   { $file = 'opus.md' }
    }

    $dir = $env:CLAUDE_MODEL_OVERLAY_DIR
    if (-not $dir) { $dir = Join-Path $env:USERPROFILE '.claude\model-overlays' }

    $path = Join-Path $dir $file
    if (-not (Test-Path -LiteralPath $path)) { $path = Join-Path $dir 'opus.md' }  # fallback to Opus overlay
    if (-not (Test-Path -LiteralPath $path)) { exit 0 }                            # nothing to inject -> stay silent

    $ctx = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($ctx)) { exit 0 }

    @{
        hookSpecificOutput = @{
            hookEventName     = 'SessionStart'
            additionalContext = $ctx
        }
    } | ConvertTo-Json -Depth 4
} catch {}
exit 0
