#!/bin/bash
# Hook script for Claude Code Notification event
# Sends a structured Warp notification when Claude needs user input,
# transitioning the session status to Blocked.

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    [ "$TERM_PROGRAM" = "WarpTerminal" ] && exec "$SCRIPT_DIR/legacy/on-notification.sh"
    exit 0
fi

source "$SCRIPT_DIR/emit-terminal-sequence.sh"
source "$SCRIPT_DIR/emit.sh"

# An empty event name tells notify.jq to take the event from the payload's
# notification_type and the summary from its message.
warp_emit ""
