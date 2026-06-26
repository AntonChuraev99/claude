# SessionStart self-config for the bug-pattern L1 gate.
# Installs the pre-commit hook into the CURRENT project repo if it's missing.
# Safe: never touches ~/.claude, never clobbers a foreign hook (only flags it),
# silent when there's nothing to do. Opt out with $env:REVIEW_RULES_NO_AUTOHOOK=1.
$ErrorActionPreference = 'SilentlyContinue'
$runner = Join-Path $HOME '.claude/review-rules/run.py'
if (Test-Path $runner) {
    # cwd is the project dir at SessionStart -> --ensure-hook resolves its git root.
    python $runner --ensure-hook 2>$null
}
exit 0
