#!/bin/bash
# Hook script for Claude Code UserPromptSubmit event
# Sends a structured Warp notification when the user submits a prompt,
# transitioning the session status from idle/blocked back to running.
#
# UserPromptSubmit has a 30s hook timeout -- lower than the 600s default for
# other events -- and it blocks the turn until every hook of the event
# returns. The old process chain hit that ceiling on loaded Windows machines
# (issue #77), so this path is kept to a single jq process.

# Cheapest possible bail-out for non-Warp environments.
[ -n "${WARP_CLI_AGENT_PROTOCOL_VERSION:-}" ] || exit 0
[ -n "${WARP_CLIENT_VERSION:-}" ] || exit 0

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
source "$SCRIPT_DIR/should-use-structured.sh"
source "$SCRIPT_DIR/emit-terminal-sequence.sh"
source "$SCRIPT_DIR/emit.sh"

# No legacy equivalent for this hook
warp_gate || exit 0

# The prompt is read from stdin by notify.jq and clipped there, by codepoint.
warp_emit "prompt_submit"
