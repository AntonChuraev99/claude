#!/bin/bash
# Hook script for Claude Code PermissionRequest event
# Sends a structured Warp notification when Claude needs permission,
# transitioning the session status to Blocked.

# Cheapest possible bail-out for non-Warp environments.
[ -n "${WARP_CLI_AGENT_PROTOCOL_VERSION:-}" ] || exit 0
[ -n "${WARP_CLIENT_VERSION:-}" ] || exit 0

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
source "$SCRIPT_DIR/should-use-structured.sh"
source "$SCRIPT_DIR/emit-terminal-sequence.sh"
source "$SCRIPT_DIR/emit.sh"

warp_gate || exit 0

# summary, tool_name and tool_input are derived from stdin inside notify.jq.
warp_emit "permission_request"
