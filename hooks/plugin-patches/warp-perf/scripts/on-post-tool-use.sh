#!/bin/bash
# Hook script for Claude Code PostToolUse event
# Sends a structured Warp notification after a tool call completes,
# transitioning the session status from Blocked back to Running.
#
# Hot path: this fires after every tool call, so it stays at one jq process.
# Payload construction lives in notify.jq, the shared gate in emit.sh.

# Cheapest possible bail-out for non-Warp environments (sub-agents, CI, other
# terminals): two variable tests, before resolving SCRIPT_DIR or sourcing.
[ -n "${WARP_CLI_AGENT_PROTOCOL_VERSION:-}" ] || exit 0
[ -n "${WARP_CLIENT_VERSION:-}" ] || exit 0

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
source "$SCRIPT_DIR/should-use-structured.sh"
source "$SCRIPT_DIR/emit-terminal-sequence.sh"
source "$SCRIPT_DIR/emit.sh"

# No legacy equivalent for this hook
warp_gate || exit 0

warp_emit "tool_complete"
