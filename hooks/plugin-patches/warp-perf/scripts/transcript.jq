# Extracts the notification title fields from a Claude Code transcript.
#
# Run with `jq -jrs -f transcript.jq <transcript.jsonl>`: it walks the slurped
# transcript once and emits the last user prompt and the last assistant
# message, in that order, separated by a single U+0001.
#
# The previous code ran this walk twice -- one `jq -rs` for the query and
# another for the response -- reading the whole transcript each time. Stop
# hooks measured a 3,856 ms median on Windows (issue #77) and transcripts grow
# for the length of the session, so the second pass was the expensive half.
#
# U+0001 as the separator rather than @tsv: @tsv escapes the very characters it
# protects, so a prompt came back carrying a literal backslash-n where its
# newlines were, and every Windows path arrived with doubled backslashes. The
# shell has no matching unescape, and that text is what the notification
# displays. U+0001 cannot occur in transcript text, so the split stays
# unambiguous and both fields survive verbatim.
#
# Clipping happens here rather than in the shell: ${VAR:0:197} cuts by byte and
# split multibyte UTF-8, producing invalid JSON that Claude Code rejected (#70).

def clip($n):
    ( . // "" )
    | if length > $n then .[0:$n - 3] + "..." else . end;

def text_of:
    if ( .message.content | type ) == "array"
    then [ .message.content[] | select(.type == "text") | .text ] | join(" ")
    else ( .message.content // "" )
    end;

def last_user:
    [ .[]
      | select(.type == "user")
      | select(
            ( .message.content | type ) == "string"
            or ( [ .message.content[]? | select(.type == "text") ] | length > 0 )
        )
    ]
    | last
    | if . == null then "" else text_of end;

def last_assistant:
    [ .[] | select(.type == "assistant" and .message.content != null) ]
    | last
    | if . == null then "" else text_of end;

[ ( last_user | clip(200) ), ( last_assistant | clip(200) ) ]
| join("\u0001")
