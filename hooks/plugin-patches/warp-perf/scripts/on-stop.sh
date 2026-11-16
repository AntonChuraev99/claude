#!/bin/bash
# Hook script for Claude Code Stop event
# Sends a structured Warp notification when Claude finishes responding,
# including the user's query and Claude's response.

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    [ "$TERM_PROGRAM" = "WarpTerminal" ] && exec "$SCRIPT_DIR/legacy/on-stop.sh"
    exit 0
fi

source "$SCRIPT_DIR/emit-terminal-sequence.sh"
source "$SCRIPT_DIR/emit.sh"

# Read hook input from stdin
INPUT=$(cat)

# stop_hook_active and transcript_path come out of a single jq pass; they used
# to cost one process each. Split on U+0001 rather than @tsv, which escapes the
# separators it protects and would double every backslash in a Windows path.
FIELDS=$(printf '%s' "$INPUT" | jq -j '[(.stop_hook_active // false), (.transcript_path // "")] | join("\u0001")')
STOP_HOOK_ACTIVE="${FIELDS%%$'\001'*}"
TRANSCRIPT_PATH="${FIELDS#*$'\001'}"

# Prevent infinite loops when Claude continues after a Stop hook
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    exit 0
fi

# Give the transcript a moment to flush the final assistant message.
sleep 0.3

QUERY=""
RESPONSE=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    # One walk of the transcript for both fields, clipped by codepoint there.
    # Parameter expansion rather than read+IFS so each field keeps its own
    # newlines instead of arriving with literal \n in the notification text.
    FIELDS=$(jq -jrs -f "$SCRIPT_DIR/transcript.jq" "$TRANSCRIPT_PATH" 2>/dev/null)
    QUERY="${FIELDS%%$'\001'*}"
    RESPONSE="${FIELDS#*$'\001'}"
fi

# stdin was consumed above, so the payload pass is fed from $INPUT.
printf '%s' "$INPUT" | warp_emit "stop" \
    --arg query "$QUERY" \
    --arg response "$RESPONSE"
