# model-overlay.ps1 — SessionStart + PostModelSwitch hook: injects a model-specific behavioral overlay.
# Reads the active model from the hook's stdin JSON — ground truth from the runtime, NOT the
# model's self-report — and returns the matching overlay file as additionalContext.
#   fable*     -> fable.md
#   *opus-5-5* -> opus-5-5.md
#   *opus-5*   -> opus-5.md
#   else       -> opus.md  (Opus 4.x overlay AND the fallback when a picked file is missing)
# Events:
#   SessionStart    -> `.model`. On /clear (and possibly /compact) the payload carries NO model:
#                      the last known model id is cached in a per-profile state file and reused;
#                      no cache -> newest overlay (opus-5-5.md).
#   PostModelSwitch -> `.to_model` / `.from_model` (CLI >= 2.1.251; fires after `/model`, /config,
#                      auto fallback, resume). Before this event existed, `/model X` mid-session kept
#                      the overlay of the STARTED model (4 Fable sessions on the Opus overlay in a
#                      month). The overlay is sent once per switch and only when the switch changes
#                      the overlay file (opus-5-5 -> opus-5-5[1m] stays silent); the cache always
#                      follows to_model so a later /clear picks the right overlay. The CLI delivers
#                      the output with the next request; several switches -> only the last one.
# Rationale: an instruction that must run at a fixed lifecycle point belongs in a hook, not
# CLAUDE.md (Anthropic memory docs); the model id is exposed only to these events, so routing
# here is deterministic and does not depend on the model correctly self-identifying.
# Never throws, never blocks the session: any failure -> silent exit 0.
# Overlay dir override via $env:CLAUDE_MODEL_OVERLAY_DIR, state file via
# $env:CLAUDE_MODEL_OVERLAY_STATE (both used by model-overlay.tests.ps1).
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Overlay file by model family (case-insensitive substring). '*opus-5-5*' must precede '*opus-5*';
# '*opus-5*' matches claude-opus-5 / [1m] / bedrock arns, but NOT claude-opus-4-5. No model at all
# -> newest overlay. `break` is required: a PowerShell switch runs EVERY matching clause, so
# opus-5-5 would be overwritten by the '*opus-5*' branch.
function Get-OverlayFile([string]$m) {
    switch -Wildcard (([string]$m).ToLowerInvariant()) {
        ''           { return 'opus-5-5.md' }
        '*fable*'    { return 'fable.md' }
        '*opus-5-5*' { return 'opus-5-5.md' }
        '*opus-5*'   { return 'opus-5.md' }
        default      { return 'opus.md' }
    }
}

try {
    # --- payload (optional; may be absent, empty, malformed) ---
    $p = $null
    try {
        $stdin = [Console]::In.ReadToEnd()
        if ($stdin) { $p = ConvertFrom-Json $stdin }
    } catch {}

    $isSwitch = ([string]$p.hook_event_name) -eq 'PostModelSwitch'
    $evtName = if ($isSwitch) { 'PostModelSwitch' } else { 'SessionStart' }
    $model = if ($isSwitch) { [string]$p.to_model } else { [string]$p.model }
    if ($isSwitch -and -not $model) { exit 0 }   # nothing to route on; SessionStart already injected

    # --- model cache: per profile, so claude / claude-work do not overwrite each other ---
    $state = $env:CLAUDE_MODEL_OVERLAY_STATE
    if (-not $state) {
        $cfg = $env:CLAUDE_CONFIG_DIR
        if (-not $cfg) { $cfg = Join-Path $env:USERPROFILE '.claude' }
        $state = Join-Path $cfg 'model-overlay-last-model.txt'
    }
    $cached = ''
    if (Test-Path -LiteralPath $state) {
        try { $cached = (Get-Content -LiteralPath $state -Raw -Encoding UTF8).Trim() } catch {}
    }
    if ($model) {
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $state) | Out-Null
            Set-Content -LiteralPath $state -Value $model -NoNewline -Encoding UTF8
        } catch {}
    } else {
        $model = $cached
    }

    $file = Get-OverlayFile $model

    # Switch that keeps the same overlay: the model already has it in context -> stay silent.
    if ($isSwitch) {
        $prevModel = [string]$p.from_model
        if (-not $prevModel) { $prevModel = $cached }
        if ($prevModel -and (Get-OverlayFile $prevModel) -eq $file) { exit 0 }
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
            hookEventName     = $evtName
            additionalContext = $ctx
        }
    } | ConvertTo-Json -Depth 4
} catch {}
exit 0
