# Stop-hook for the bug-pattern review system (L1 -> arms L2).
#
# Runs the deterministic L1 static gate on EVERY agent stop, in the CURRENT project
# repo, so recurring-bug findings surface 100% of sessions — not only when the user
# remembers to run /task-gate (historically 14%). It also logs every L1 run to
# stats/review-rules-events.jsonl so the system's usefulness can be measured later.
#
# Behaviour (decided 2026-06-29):
#   - static-HIGH finding -> BLOCK the stop ONCE per unique working-tree state (diff
#     hash ack marker in .git/review-rules-ack), feeding the agent the findings so it
#     fixes them or spawns @bug-pattern-reviewer (L2). Block-once = loop-safe: the
#     same diff never re-blocks; an edited diff is re-evaluated.
#   - runtime/process findings -> printed to stderr, never block.
#   - tool/setup error (exit 3, e.g. no PyYAML) -> warn, never block (fail-open).
#
# Safe: never touches ~/.claude / ~/.claude-work (our own config repo is skipped).
# Opt out with $env:REVIEW_RULES_NO_STOPGATE = '1'.
$ErrorActionPreference = 'SilentlyContinue'

if ($env:REVIEW_RULES_NO_STOPGATE -eq '1') { exit 0 }

# --- locate the project git root (cwd is the project dir at Stop) ---------------
$root = (git rev-parse --show-toplevel 2>$null)
if (-not $root) { exit 0 }                       # not a git repo -> nothing to gate
$root = $root.Trim()
$norm = $root.ToLower().Replace('\', '/')
if ($norm -like '*/.claude' -or $norm -like '*/.claude-work') { exit 0 }  # config repo

$runner = Join-Path $HOME '.claude/review-rules/run.py'
if (-not (Test-Path $runner)) { exit 0 }
$log = Join-Path $HOME '.claude/stats/review-rules-events.jsonl'

# --- run L1 (static = added lines only; logs the event itself) -------------------
$json = python $runner --changed-only --json --log $log --entry stop 2>$null
$code = $LASTEXITCODE
if ($code -eq 3) {
    [Console]::Error.WriteLine('review-rules: L1 tool error (setup) — not blocking')
    exit 0
}

try { $findings = @($json | ConvertFrom-Json | Where-Object { $_ }) } catch { $findings = @() }
$high = @($findings | Where-Object { $_.mode -eq 'static' -and $_.severity -eq 'high' })

# --- diff hash for the block-once ack marker -------------------------------------
$diff = [string]((git diff HEAD 2>$null) + (git ls-files --others --exclude-standard 2>$null))
$sha1 = [System.Security.Cryptography.SHA1]::Create()
$sha = ([System.BitConverter]::ToString($sha1.ComputeHash([Text.Encoding]::UTF8.GetBytes($diff)))).Replace('-', '').Substring(0, 8).ToLower()
$marker = Join-Path $root '.git/review-rules-ack'

if ($high.Count -gt 0) {
    $acked = (Test-Path $marker) -and ((Get-Content $marker -Raw -ErrorAction SilentlyContinue).Trim() -eq $sha)
    if ($acked) {
        [Console]::Error.WriteLine("review-rules: $($high.Count) static-HIGH already surfaced this diff — pass")
        exit 0
    }
    Set-Content -Path $marker -Value $sha -NoNewline -Encoding utf8
    $lines = ($high | ForEach-Object { "  - [$($_.area)/$($_.id)] $($_.file):$($_.line) -> $($_.fix)" }) -join "`n"
    $reason = "review-rules L1 found $($high.Count) static-HIGH recurring-bug finding(s) (added lines) in this diff:`n$lines`n`nThese are bugs that compile green but break in release/web/on device. Fix them, or — if a finding is intentional — spawn @bug-pattern-reviewer (L2) to judge it and then proceed. (They also fail the pre-commit hook.)"
    (@{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress)
    exit 0
}

# no blockers: drop the marker, surface non-blocking red-flags
if (Test-Path $marker) { Remove-Item $marker -Force -ErrorAction SilentlyContinue }
$rt = @($findings | Where-Object { $_.mode -eq 'runtime' })
if ($rt.Count -gt 0) {
    [Console]::Error.WriteLine("review-rules: $($rt.Count) runtime red-flag(s) (non-blocking) — run: python `"$runner`" --changed-only")
}
exit 0
