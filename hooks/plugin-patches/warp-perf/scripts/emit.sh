#!/bin/bash
# Shared gate and emitter for the structured hook scripts.
#
# Usage:
#   SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
#   source "$SCRIPT_DIR/should-use-structured.sh"
#   source "$SCRIPT_DIR/emit-terminal-sequence.sh"
#   source "$SCRIPT_DIR/emit.sh"
#   warp_gate || exit 0
#   warp_emit "tool_complete"
#
# warp_emit reads the hook's stdin, builds the payload with notify.jq and
# writes the result. The common path is a single jq process; extra arguments
# are forwarded to jq verbatim (see notify.jq for the contract).

# The protocol version this plugin knows how to produce.
PLUGIN_CURRENT_PROTOCOL_VERSION=1

# Cheap environment gate. The hot hooks test these two variables inline before
# sourcing anything at all; this repeats the check for the hooks that cannot
# bail that early because they have a legacy fallback to reach first.
warp_gate() {
    [ -n "${WARP_CLI_AGENT_PROTOCOL_VERSION:-}" ] || return 1
    [ -n "${WARP_CLIENT_VERSION:-}" ] || return 1
    should_use_structured
}

# min(plugin_current, warp_declared), falling back to 1 for a missing or
# non-numeric value. Assigns rather than echoes: a command substitution here
# would fork a subshell on a path that exists to avoid forks.
_negotiate_protocol_version() {
    local warp_version="${WARP_CLI_AGENT_PROTOCOL_VERSION:-1}"
    case "$warp_version" in
        '' | *[!0-9]*) warp_version=1 ;;
    esac
    if [ "$warp_version" -lt "$PLUGIN_CURRENT_PROTOCOL_VERSION" ]; then
        WARP_NEGOTIATED_VERSION="$warp_version"
    else
        WARP_NEGOTIATED_VERSION="$PLUGIN_CURRENT_PROTOCOL_VERSION"
    fi
}

warp_emit() {
    local event="$1"
    shift

    _negotiate_protocol_version
    local proto="$WARP_NEGOTIATED_VERSION"

    # Same three-way decision as emit-terminal-sequence.sh, kept intact:
    #   known and new enough -> the terminalSequence output field
    #   known and older      -> /dev/tty, which is all it accepts
    #   unknown              -> try /dev/tty, fall back to terminalSequence
    # Collapsing the last case into the second would drop the notification
    # entirely wherever CLAUDE_CODE_VERSION is unset and there is no tty --
    # which is every hook of a session whose SessionStart could not record it.
    if _supports_terminal_sequence; then
        # exec replaces the shell instead of forking one more process for jq.
        exec jq -c -f "$SCRIPT_DIR/notify.jq" \
            --argjson v "$proto" --arg event "$event" --argjson wrap true "$@"
    fi

    # The sequence is built first and written second. Redirecting jq straight
    # at /dev/tty would skip running it at all when the device is missing, and
    # the fallback below would then have nothing to send.
    local seq
    seq=$(jq -jr -f "$SCRIPT_DIR/notify.jq" \
        --argjson v "$proto" --arg event "$event" --argjson wrap false "$@")
    [ -n "$seq" ] || return 0

    # 2>/dev/null comes first: redirections are applied left to right, so with
    # the other order the shell's own "no such device" for /dev/tty is printed
    # before stderr is silenced.
    if printf '%s' "$seq" 2>/dev/null > /dev/tty; then
        return 0
    fi

    # No tty. On a known-old Claude Code terminalSequence would be rejected as
    # an unknown field, so there is nothing left to try; on an unknown version
    # it is the documented fallback.
    local raw="${CLAUDE_CODE_VERSION:-}"
    if [ -z "$raw" ] || [ -z "$(_parse_cc_version "$raw")" ]; then
        jq -nc --arg seq "$seq" '{terminalSequence: $seq}'
    fi
}
