#!/usr/bin/env bash
# Background ADB probe for the status line.
#
# Spawned detached by statusline.py at most once every ADB_TTL seconds; it must
# never run inline, because `adb devices` blocks long enough to stall a render.
# Writes one device name per line to the cache the renderer reads.

ADB="${ANDROID_ADB:-$HOME/AppData/Local/Android/Sdk/platform-tools/adb.exe}"
ADB_CACHE="${TEMP:-/tmp}/statusline_adb_device"
ADB_CACHE=$(echo "$ADB_CACHE" | tr '\\' '/')

[ -x "$ADB" ] || exit 0

# Unique serials: skip entries with spaces and collapse the TLS suffix, since a
# device shows up as both "serial" and "serial._adb-tls-connect._tcp".
serials=$("$ADB" devices 2>/dev/null \
    | awk -F'\t' 'NR>1 && $2=="device" && $1 !~ / /{print $1}' \
    | sed 's/\._adb-tls-connect\._tcp$//' \
    | sort -u)

names=""
while IFS= read -r serial; do
    [ -z "$serial" ] && continue
    # try the full TLS serial first, then the bare one
    name=$("$ADB" -s "${serial}._adb-tls-connect._tcp" shell getprop ro.product.model 2>/dev/null | tr -d '\r\n')
    [ -z "$name" ] && name=$("$ADB" -s "$serial" shell getprop ro.product.model 2>/dev/null | tr -d '\r\n')
    [ -z "$name" ] && name="$serial"
    names="${names}${name}"$'\n'
done <<< "$serials"

printf '%s' "$names" > "$ADB_CACHE"
