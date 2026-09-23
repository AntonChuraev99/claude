# model-overlay.ps1 — SessionStart hook: injects a model-specific behavioral overlay.
# Reads the active model from the hook's stdin JSON (.model — ground truth from the runtime,
# NOT the model's self-report) and returns the matching overlay file as additionalContext.
#   fable*     -> fable.md
#   *opus-5-5* -> opus-5-5.md
#   *opus-5*   -> opus-5.md
#   else       -> opus.md  (Opus 4.x overlay AND the fallback when a picked file is missing)
# The SessionStart payload on /clear (and possibly /compact) carries NO model: the last present
# model id is cached in a per-profile state file and reused; no cache -> newest overlay
# (opus-5-5.md). Before this, /clear silently fell back to the Opus 4.x overlay.
# Known trade-off: the cache is written only at SessionStart, so `/model X` mid-session followed
# by /clear (or two same-profile sessions on different models) reuses the last STARTED model.
# Accepted: the payload offers no better signal, and the common case (same model, /clear) is fixed.
# Rationale: an instruction that must run at a fixed lifecycle point belongs in a hook, not
# CLAUDE.md (Anthropic memory docs); the model field is exposed ONLY to SessionStart hooks, so
# routing here is deterministic and does not depend on the model correctly self-identifying.
# Never throws, never blocks the session: any failure -> silent exit 0.
# Overlay dir override via $env:CLAUDE_MODEL_OVERLAY_DIR, state file via
# $env:CLAUDE_MODEL_OVERLAY_STATE (both used by model-overlay.tests.ps1).
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    # --- active model from stdin JSON (optional; may be absent, empty, or null) ---
    $model = ''
    try {
        $stdin = [Console]::In.ReadToEnd()
        if ($stdin) { $model = [string](ConvertFrom-Json $stdin).model }
    } catch {}

    # --- model cache: per profile, so claude / claude-work do not overwrite each other ---
    $state = $env:CLAUDE_MODEL_OVERLAY_STATE
    if (-not $state) {
        $cfg = $env:CLAUDE_CONFIG_DIR
        if (-not $cfg) { $cfg = Join-Path $env:USERPROFILE '.claude' }
        $state = Join-Path $cfg 'model-overlay-last-model.txt'
    }
    if ($model) {
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $state) | Out-Null
            Set-Content -LiteralPath $state -Value $model -NoNewline -Encoding UTF8
        } catch {}
    } elseif (Test-Path -LiteralPath $state) {
        try { $model = (Get-Content -LiteralPath $state -Raw -Encoding UTF8).Trim() } catch {}
    }

    # --- pick overlay by model family (case-insensitive substring) ---
    # '*opus-5-5*' must precede '*opus-5*'; '*opus-5*' matches claude-opus-5 / [1m] / bedrock arns,
    # but NOT claude-opus-4-5. No model at all -> newest overlay. `break` is required: a PowerShell
    # switch runs EVERY matching clause, so opus-5-5 would be overwritten by the '*opus-5*' branch.
    switch -Wildcard ($model.ToLowerInvariant()) {
        ''           { $file = 'opus-5-5.md'; break }
        '*fable*'    { $file = 'fable.md'; break }
        '*opus-5-5*' { $file = 'opus-5-5.md'; break }
        '*opus-5*'   { $file = 'opus-5.md'; break }
        default      { $file = 'opus.md' }
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
