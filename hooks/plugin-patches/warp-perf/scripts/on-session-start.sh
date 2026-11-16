#!/bin/bash
# Hook script for Claude Code SessionStart event
# Sends a structured Warp notification when a Claude Code session starts.

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exec "$SCRIPT_DIR/legacy/on-session-start.sh"
fi

if ! command -v jq &>/dev/null; then
    cat << 'EOF'
{
  "systemMessage": "🚨 Warp notifications require jq! Install it with your system package manager (e.g. brew install jq, apt install jq) 🚨"
}
EOF
    exit 0
fi

source "$SCRIPT_DIR/emit-terminal-sequence.sh"
source "$SCRIPT_DIR/emit.sh"

# Record the Claude Code version for later hooks: emit-terminal-sequence.sh
# needs it to decide between the terminalSequence field and /dev/tty, and
# `claude --version` is far too slow to run on every hook fire.
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -z "${CLAUDE_CODE_VERSION:-}" ]; then
    CC_VERSION=$(claude --version 2>/dev/null | head -1 || true)
    if [ -n "$CC_VERSION" ]; then
        echo "export CLAUDE_CODE_VERSION=\"$CC_VERSION\"" >> "$CLAUDE_ENV_FILE"
        export CLAUDE_CODE_VERSION="$CC_VERSION"
    fi
fi

# Plugin version straight out of the manifest, without spawning jq for it.
PLUGIN_VERSION="unknown"
PLUGIN_MANIFEST="$SCRIPT_DIR/../.claude-plugin/plugin.json"
if [ -f "$PLUGIN_MANIFEST" ]; then
    MANIFEST_TEXT=$(<"$PLUGIN_MANIFEST")
    if [[ "$MANIFEST_TEXT" =~ \"version\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
        PLUGIN_VERSION="${BASH_REMATCH[1]}"
    fi
fi

warp_emit "session_start" --arg plugin_version "$PLUGIN_VERSION"
