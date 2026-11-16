# Builds a warp://cli-agent notification in a single jq pass.
#
# Reads the hook's stdin JSON, derives the common fields (session_id, cwd,
# project), adds the per-event fields, and emits either the bare OSC 777
# sequence or the {terminalSequence: ...} wrapper Claude Code expects on
# stdout.
#
# Why: the previous chain spawned two bash processes and four-to-five jq
# processes per fire. On Windows MSYS2 emulates fork(), so those spawns cost
# far more than the work they do -- see issue #77, where PostToolUse alone
# measured a 1,699 ms median per tool call. Everything here is one process.
#
# Per-event fields are read straight from stdin rather than passed as --arg,
# which also avoids MSYS2 argv path conversion: a POSIX cwd handed to a native
# jq.exe as an argument came back rewritten as C:/Program Files/Git/...
#
# Caller contract:
#   --argjson v    <int>   negotiated protocol version
#   --arg event    <str>   event name recorded in the payload
#   --argjson wrap <bool>  true -> {terminalSequence: ...}, false -> raw sequence
#   --arg query    <str>   optional, on stop: last user prompt from the transcript
#   --arg response <str>   optional, on stop: last assistant message
#   --arg plugin_version <str> optional, on session_start

def basename:
    # Trailing separators must not swallow the last segment: "/a/b/" -> "b".
    ( . // "" )
    | sub("[/\\\\]+$"; "")
    | split("[/\\\\]"; "g")
    | last // "";

# Truncation is by codepoint, not by byte: the shell's ${VAR:0:197} split
# multibyte UTF-8 and produced invalid JSON that Claude Code rejected (#70).
def clip($n):
    ( . // "" )
    | if length > $n then .[0:$n - 3] + "..." else . end;

# Notification hooks name the event after the notification type carried on
# stdin, so the caller passes an empty --arg event and it is resolved here.
def event_name:
    if $event == "" then ( .notification_type // "unknown" ) else $event end;

def extras:
    if   $event == "tool_complete"      then { tool_name: ( .tool_name // "" ) }
    elif $event == "prompt_submit"      then { query: ( .prompt | clip(200) ) }
    elif $event == "permission_request" then
        ( .tool_name // "unknown" ) as $tool
        | ( .tool_input // {} ) as $ti
        | ( ( $ti.command // $ti.file_path // ( $ti | tojson ) ) | clip(120) ) as $preview
        | {
            summary: ( if $preview == "" then "Wants to run " + $tool
                       else "Wants to run " + $tool + ": " + $preview end ),
            tool_name: $tool,
            tool_input: $ti
          }
    # background_task_count / session_cron_count arrived in plugin 2.4.0: a Stop
    # with a pending background task or session cron is a pause, not the end.
    # Read from stdin here; upstream spends two extra jq processes on them.
    elif $event == "stop"               then
        { query: ( $ARGS.named.query // "" ), response: ( $ARGS.named.response // "" ),
          transcript_path: ( .transcript_path // "" ),
          background_task_count: ( .background_tasks // [] | length ),
          session_cron_count: ( .session_crons // [] | length ) }
    elif $event == "stop_failure"       then
        { query: ( $ARGS.named.query // "" ), response: ( $ARGS.named.response // "" ),
          error_type: ( $ARGS.named.error_type // "" ),
          transcript_path: ( .transcript_path // "" ) }
    elif $event == "session_start"      then
        { plugin_version: ( $ARGS.named.plugin_version // "unknown" ) }
    # Notification events reuse their own type as the event name and carry the
    # message as the summary.
    elif $event == "" then
        { summary: ( if ( .message // "" ) == "" then "Input needed" else ( .message | clip(120) ) end ) }
    else {} end;

{
    v: $v,
    agent: "claude",
    event: event_name,
    session_id: ( .session_id // "" ),
    cwd: ( .cwd // "" ),
    project: ( .cwd | basename )
} + extras
| ( "\u001b]777;notify;warp://cli-agent;" + tojson + "\u0007" ) as $seq
| if $wrap then { terminalSequence: $seq } else $seq end
