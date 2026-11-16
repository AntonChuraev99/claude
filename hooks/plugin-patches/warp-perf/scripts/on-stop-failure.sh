#!/bin/bash
# Hook script for Claude Code StopFailure event
# Sends a structured Warp notification when Claude's turn ends in an error,
# so the session surfaces as failed rather than silently idle.

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exit 0
fi

source "$SCRIPT_DIR/emit-terminal-sequence.sh"
source "$SCRIPT_DIR/emit.sh"

# Read hook input from stdin
INPUT=$(cat)

# error, last_assistant_message and transcript_path in a single jq pass, split on
# U+0001 so the message keeps its newlines and the path its backslashes.
FIELDS=$(printf '%s' "$INPUT" | jq -j '[(.error // ""), (.last_assistant_message // ""), (.transcript_path // "")] | join("")')
ERROR_TYPE="${FIELDS%%$'\001'*}"
REST="${FIELDS#*$'\001'}"
ERROR_MESSAGE="${REST%%$'\001'*}"
TRANSCRIPT_PATH="${REST#*$'\001'}"

QUERY=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    # transcript.jq returns query and response; only the query is used here.
    QUERY=$(jq -jrs -f "$SCRIPT_DIR/transcript.jq" "$TRANSCRIPT_PATH" 2>/dev/null)
    QUERY="${QUERY%%$'\001'*}"
fi

# stdin was consumed above, so the payload pass is fed from $INPUT.
printf '%s' "$INPUT" | warp_emit "stop_failure" \
    --arg query "$QUERY" \
    --arg response "$ERROR_MESSAGE" \
    --arg error_type "$ERROR_TYPE"
