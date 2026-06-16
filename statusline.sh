#!/usr/bin/env bash
# Claude Code status line script
# Format: [Model] folder (branch) | ██░░░░░░░░ 27% of 200k tokens

input=$(cat)

# Parse JSON fields via Python (jq not available on this machine)
read -r model cwd used_pct ctx_size worktree_branch << 'EOF_HEREDOC'
EOF_HEREDOC
eval "$(echo "$input" | PYTHONIOENCODING=utf-8 python -c "
import sys, json, os
d = json.load(sys.stdin)

model = ''
m = d.get('model', '')
if isinstance(m, dict):
    model = m.get('display_name', '')
elif isinstance(m, str):
    model = m
if not model:
    model = 'Claude'

cwd = d.get('workspace', {}).get('current_dir', '') or d.get('cwd', '')
used_pct = str(d.get('context_window', {}).get('used_percentage', ''))
ctx_size = str(d.get('context_window', {}).get('context_window_size', 200000))
worktree_branch = d.get('worktree', {}).get('branch', '') or ''
cost = d.get('cost', {}).get('total_cost_usd', 0) or 0
cost_str = '\${:.2f}'.format(cost)
transcript_path = d.get('transcript_path', '') or ''

print('model=' + repr(model))
print('cwd=' + repr(cwd))
print('used_pct=' + repr(used_pct))
print('ctx_size=' + repr(ctx_size))
print('worktree_branch=' + repr(worktree_branch))
print('cost_str=' + repr(cost_str))
print('transcript_path=' + repr(transcript_path))
" 2>/dev/null)"

# --- Current dir (folder name only) ---
# Convert Windows backslashes to forward slashes before basename
cwd_unix=$(echo "$cwd" | tr '\\' '/')
folder=$(basename "$cwd_unix")

# --- Git branch ---
if [ -n "$worktree_branch" ]; then
    branch="$worktree_branch"
else
    branch=$(git -C "$cwd_unix" branch --show-current 2>/dev/null)
fi

# --- Context window ---
ctx_k=$(( ctx_size / 1000 ))

# --- ANSI colors ---
RESET='\033[0m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
DIM='\033[2m'
BOLD='\033[1m'

# --- Build progress bar (10 chars) ---
if [ -n "$used_pct" ] && [ "$used_pct" != "0" ]; then
    pct_int=$(printf '%.0f' "$used_pct")

    if [ "$pct_int" -ge 90 ]; then
        BAR_COLOR="$RED"
    elif [ "$pct_int" -ge 70 ]; then
        BAR_COLOR="$YELLOW"
    else
        BAR_COLOR="$GREEN"
    fi

    filled=$(( pct_int * 10 / 100 ))
    [ "$filled" -gt 10 ] && filled=10
    empty=$(( 10 - filled ))

    bar=""
    for i in $(seq 1 $filled); do bar="${bar}█"; done
    for i in $(seq 1 $empty);  do bar="${bar}░"; done

    ctx_part="${BAR_COLOR}${bar}${RESET} ${BAR_COLOR}${pct_int}%${RESET}"
else
    ctx_part="${DIM}0%${RESET}"
fi

# --- ADB device (cached to avoid blocking) ---
ADB="${ANDROID_ADB:-$HOME/AppData/Local/Android/Sdk/platform-tools/adb.exe}"
ADB_CACHE="/tmp/statusline_adb_device"
CACHE_TTL=10

now=$(date +%s)
cache_mtime=$(date -r "$ADB_CACHE" +%s 2>/dev/null || echo 0)

if [ $(( now - cache_mtime )) -gt $CACHE_TTL ]; then
    {
        # Get unique serials: prefer entries without spaces, deduplicate by base serial
        # (two TLS entries like "serial._adb-tls-connect._tcp" and "serial (2)._adb-tls..." = same device)
        serials=$("$ADB" devices 2>/dev/null \
            | awk -F'\t' 'NR>1 && $2=="device" && $1 !~ / /{print $1}' \
            | sed 's/\._adb-tls-connect\._tcp$//' \
            | sort -u)

        names=""
        while IFS= read -r serial; do
            [ -z "$serial" ] && continue
            full_serial="${serial}._adb-tls-connect._tcp"
            # try full TLS serial first, then bare serial
            name=$("$ADB" -s "$full_serial" shell getprop ro.product.model 2>/dev/null | tr -d '\r\n')
            [ -z "$name" ] && name=$("$ADB" -s "$serial" shell getprop ro.product.model 2>/dev/null | tr -d '\r\n')
            [ -z "$name" ] && name="$serial"
            names="${names}${name}"$'\n'
        done <<< "$serials"

        printf '%s' "$names" > "$ADB_CACHE"
    } &>/dev/null &
    disown
fi

# Read all cached device names (one per line)
mapfile -t adb_devices < <(cat "$ADB_CACHE" 2>/dev/null | tr -d '\r' | grep -v '^$')

# Selected device: read from explicit selection file, default to first
ADB_SEL="/tmp/statusline_adb_sel"
selected_device=$(cat "$ADB_SEL" 2>/dev/null | tr -d '\r\n')
[ -z "$selected_device" ] && selected_device="${adb_devices[0]}"

# --- ADB device part ---
device_count=${#adb_devices[@]}
if [ "$device_count" -eq 0 ]; then
    device_part=""
elif [ "$device_count" -eq 1 ]; then
    device_part=" ${DIM}│${RESET} %s"
    device_args=("${adb_devices[0]}")
else
    # Show selected brighter, list up to 2 others dimmed, then +N for the rest
    other_names=()
    for d in "${adb_devices[@]}"; do
        [ "$d" != "$selected_device" ] && other_names+=("$d")
    done
    others_count=${#other_names[@]}
    if [ "$others_count" -le 2 ]; then
        others_str=""
        for d in "${other_names[@]}"; do others_str+=" ${DIM}${d}${RESET}"; done
        device_part=" ${DIM}│${RESET} [%s]${others_str}"
        device_args=("$selected_device")
    else
        device_part=" ${DIM}│${RESET} [%s] ${DIM}+${others_count}${RESET}"
        device_args=("$selected_device")
    fi
fi

# --- First user prompt of current task (from transcript) ---
# Goal: distinguish multiple parallel CC sessions by showing the task summary.
# Logic: find latest /clear in transcript, take first real user message after it
# (skip meta/system/local-command wrappers and image markers).
first_prompt=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
    first_prompt=$(PYTHONIOENCODING=utf-8 python - "$transcript_path" 2>/dev/null << 'PYEOF'
import json, re, sys
path = sys.argv[1]
last_clear_idx = -1
prompts = []
try:
    with open(path, 'r', encoding='utf-8') as f:
        for i, line in enumerate(f):
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get('type') != 'user':
                continue
            if d.get('isMeta'):
                continue
            msg = d.get('message')
            if not isinstance(msg, dict):
                continue
            content = msg.get('content', '')
            if isinstance(content, list):
                content = ' '.join(
                    p.get('text', '') for p in content
                    if isinstance(p, dict) and p.get('type') == 'text'
                )
            if not isinstance(content, str):
                continue
            stripped = content.lstrip()
            if '<command-name>/clear</command-name>' in stripped:
                last_clear_idx = i
                continue
            if stripped.startswith('<command-name>'):
                continue
            if stripped.startswith('<local-command-caveat>'):
                continue
            prompts.append((i, content))
    chosen = None
    for i, c in prompts:
        if i > last_clear_idx:
            chosen = c
            break
    if chosen is None and prompts:
        chosen = prompts[0][1]
    if chosen:
        chosen = re.sub(r'<system-reminder>.*?</system-reminder>', '', chosen, flags=re.DOTALL)
        chosen = re.sub(r'<command-[a-z-]+>.*?</command-[a-z-]+>', '', chosen, flags=re.DOTALL)
        chosen = re.sub(r'<local-command-[a-z-]+>.*?</local-command-[a-z-]+>', '', chosen, flags=re.DOTALL)
        chosen = re.sub(r'\[Image:[^\]]*\]', '', chosen)
        chosen = re.sub(r'\[Image #\d+\]', '', chosen)
        chosen = ' '.join(chosen.split())
        sys.stdout.write(chosen[:240])
except Exception:
    pass
PYEOF
)
fi

# --- Tab title (Windows Terminal / WT picks up OSC 0) ---
# Truncate to ~50 chars so tab stays readable when multiple are open.
if [ -n "$first_prompt" ]; then
    title_short=$(printf '%s' "$first_prompt" | cut -c1-50)
    printf '\033]0;%s · %s\007' "$folder" "$title_short"
fi

# --- Prompt segment for statusLine (longer — up to 100 chars) ---
if [ -n "$first_prompt" ]; then
    prompt_short=$(printf '%s' "$first_prompt" | cut -c1-100)
    prompt_part=" ${DIM}│ ${prompt_short}${RESET}"
else
    prompt_part=""
fi

if [ -n "$branch" ]; then
    printf "%s ${DIM}(${RESET}%s${DIM})${RESET} ${DIM}│${RESET} %b ${DIM}│${RESET} ${DIM}%s${RESET}${device_part}%b\n" \
        "$folder" "$branch" "$ctx_part" "$cost_str" "${device_args[@]}" "$prompt_part"
else
    printf "%s ${DIM}│${RESET} %b ${DIM}│${RESET} ${DIM}%s${RESET}${device_part}%b\n" \
        "$folder" "$ctx_part" "$cost_str" "${device_args[@]}" "$prompt_part"
fi
