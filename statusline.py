#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Claude Code status line.

Reads the status-line JSON payload on stdin and prints one line:

    repo (branch) │ <ctx bar> │ $cost │ <devices> │ <status> │ <task title>

Status icons: ⚡ turn running · ❓ waiting for your answer · 💤 idle,
🤖N background agents still working · 📋done/total session todo list.

Design notes
------------
* This is the entry point — no shell wrapper. The status line re-renders many
  times per turn, and on Windows every `date`/`dirname` subprocess a shell
  wrapper spawns costs more than the whole render.
* Transcripts reach tens of MB, so the transcript is parsed **incrementally**:
  byte offset plus derived state live in TEMP, and only the appended tail is
  scanned.
* Terminal width is not in the environment (no tty, no COLUMNS), so it is read
  from the attached console through CONOUT$.
* `unicodedata` and `tempfile` are deliberately not imported — together they
  cost ~40ms of the render budget for two lookups done by hand below.
"""

import json
import os
import re
import sys

RESET = "\033[0m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
DIM = "\033[2m"

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = os.environ.get("TEMP") or os.environ.get("TMP") or r"C:\Windows\Temp"
ADB_CACHE = os.path.join(TMP, "statusline_adb_device")
ADB_SEL = os.path.join(TMP, "statusline_adb_sel")
ADB_STAMP = os.path.join(TMP, "statusline_adb_stamp")
ADB_TTL = 10  # seconds

SEP = DIM + "│" + RESET
ELLIPSIS = "…"
FALLBACK_COLS = 120
MIN_TITLE_COLS = 12

ICON_BUSY = "\u26a1"          # turn in progress
ICON_ASK = "\u2753"           # waiting for the user's answer
ICON_IDLE = "\U0001f4a4"      # idle, waiting for input
ICON_AGENT = "\U0001f916"     # background agents
ICON_TODO = "\U0001f4cb"      # todo list


# --------------------------------------------------------------------------
# display width  (hand-rolled: importing unicodedata costs ~17ms per render)
# --------------------------------------------------------------------------

_WIDE = (
    (0x1100, 0x115F), (0x2329, 0x232A), (0x2E80, 0x303E), (0x3041, 0x33FF),
    (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xA000, 0xA4CF), (0xAC00, 0xD7A3),
    (0xF900, 0xFAFF), (0xFE10, 0xFE19), (0xFE30, 0xFE6F), (0xFF00, 0xFF60),
    (0xFFE0, 0xFFE6), (0x1F000, 0x1FAFF), (0x20000, 0x3FFFD),
)
# Dingbats/misc symbols render double-width in modern terminals when they are
# emoji presentation — the icons above live here.
_WIDE_SYMBOL = ((0x2600, 0x27BF), (0x2B50, 0x2B55))
_ZERO = (
    (0x0300, 0x036F), (0x1AB0, 0x1AFF), (0x1DC0, 0x1DFF), (0x20D0, 0x20F0),
    (0xFE00, 0xFE0F), (0x200B, 0x200F),
)


def _in(o, table):
    for lo, hi in table:
        if lo <= o <= hi:
            return True
    return False


def dwidth(s):
    """Rendered width in terminal cells (emoji and CJK count as 2)."""
    w = 0
    for ch in s:
        o = ord(ch)
        if o < 0x0300:            # fast path: ASCII, Latin-1, Cyrillic
            w += 0 if o < 0x20 else 1
        elif _in(o, _ZERO):
            continue
        elif _in(o, _WIDE) or _in(o, _WIDE_SYMBOL):
            w += 2
        else:
            w += 1
    return w


def dtrunc(s, limit):
    """Truncate to `limit` cells, appending an ellipsis when clipped."""
    if limit <= 0:
        return ""
    if dwidth(s) <= limit:
        return s
    limit -= 1  # room for the ellipsis
    out, w = [], 0
    for ch in s:
        cw = dwidth(ch)
        if w + cw > limit:
            break
        out.append(ch)
        w += cw
    return "".join(out).rstrip() + ELLIPSIS


def strip_ansi(s):
    return re.sub(r"\033\[[0-9;]*m", "", s)


def terminal_cols():
    """Console width via CONOUT$ — stdout is a pipe, so tty probes all fail."""
    override = os.environ.get("CLAUDE_STATUSLINE_COLS")
    if override and override.isdigit():
        return int(override)
    try:
        import ctypes

        class COORD(ctypes.Structure):
            _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]

        class SMALL_RECT(ctypes.Structure):
            _fields_ = [("Left", ctypes.c_short), ("Top", ctypes.c_short),
                        ("Right", ctypes.c_short), ("Bottom", ctypes.c_short)]

        class CSBI(ctypes.Structure):
            _fields_ = [("dwSize", COORD), ("dwCursorPosition", COORD),
                        ("wAttributes", ctypes.c_ushort), ("srWindow", SMALL_RECT),
                        ("dwMaximumWindowSize", COORD)]

        k = ctypes.windll.kernel32
        handle = k.CreateFileW("CONOUT$", 0xC0000000, 3, None, 3, 0, None)
        if handle in (0, -1):
            return FALLBACK_COLS
        try:
            csbi = CSBI()
            if not k.GetConsoleScreenBufferInfo(handle, ctypes.byref(csbi)):
                return FALLBACK_COLS
            cols = csbi.srWindow.Right - csbi.srWindow.Left + 1
            return cols if cols > 20 else FALLBACK_COLS
        finally:
            k.CloseHandle(handle)
    except Exception:
        return FALLBACK_COLS


# --------------------------------------------------------------------------
# git  (read .git directly — a subprocess per render is far too expensive)
# --------------------------------------------------------------------------

def git_info(cwd):
    """Return (branch, main_repo_name) without spawning git."""
    if not cwd or not os.path.isdir(cwd):
        return "", ""
    d = os.path.abspath(cwd)
    gitpath = None
    while True:
        cand = os.path.join(d, ".git")
        if os.path.exists(cand):
            gitpath = cand
            break
        parent = os.path.dirname(d)
        if parent == d:
            return "", ""
        d = parent

    gitdir = gitpath
    if os.path.isfile(gitpath):  # worktree: ".git" is a file holding "gitdir: <path>"
        try:
            with open(gitpath, "r", encoding="utf-8", errors="replace") as f:
                line = f.read().strip()
        except OSError:
            return "", ""
        if not line.startswith("gitdir:"):
            return "", ""
        gitdir = line.split(":", 1)[1].strip()
        if not os.path.isabs(gitdir):
            gitdir = os.path.normpath(os.path.join(d, gitdir))

    branch = ""
    try:
        with open(os.path.join(gitdir, "HEAD"), "r", encoding="utf-8", errors="replace") as f:
            head = f.read().strip()
        if head.startswith("ref:"):
            branch = head.split("/", 2)[-1]
        elif head:
            branch = head[:7]  # detached HEAD
    except OSError:
        pass

    # `commondir` points at the primary .git of a linked worktree, which is how
    # a worktree learns the real project name instead of its own folder name.
    common = gitdir
    try:
        cpath = os.path.join(gitdir, "commondir")
        if os.path.isfile(cpath):
            with open(cpath, "r", encoding="utf-8", errors="replace") as f:
                rel = f.read().strip()
            common = rel if os.path.isabs(rel) else os.path.normpath(os.path.join(gitdir, rel))
    except OSError:
        pass
    repo = os.path.basename(os.path.dirname(os.path.normpath(common)))
    return branch, repo


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


# Raw prompts carry attachment markers and injected blocks that say nothing
# about the task; the title falls back to a prompt only when Claude Code has
# not named the session yet, so it still needs the scrub.
RE_TITLE_NOISE = (
    re.compile(r"<system-reminder>.*?</system-reminder>", re.S),
    re.compile(r"<(command|local-command)-[a-z-]+>.*?</\1-[a-z-]+>", re.S),
    re.compile(r"\[Image[^\]]*\]"),
)


def clean_title(s):
    for rx in RE_TITLE_NOISE:
        s = rx.sub("", s)
    return " ".join(s.split())


# --------------------------------------------------------------------------
# transcript: incremental scan
# --------------------------------------------------------------------------

# Cheap byte markers gate which lines get parsed. They are never trusted on
# their own: any tool_result that merely quotes one (a grep over transcripts, a
# cat of this very file) would otherwise register a phantom agent. Every marker
# hit is confirmed against real message blocks below.
M_AGENT_TOOL = (b'"Agent"', b'"SendMessage"')
M_ASK_TOOL = (b'"AskUserQuestion"', b'"ExitPlanMode"')
M_NOTIFY = b"<tool-use-id>"
M_TURN_END = b"turn_duration"
M_LASTPROMPT = b'"last-prompt"'
M_ASSISTANT = (b'"type": "assistant"', b'"type":"assistant"')
M_USER = (b'"type": "user"', b'"type":"user"')

AGENT_TOOLS = ("Agent", "SendMessage")
ASK_TOOLS = ("AskUserQuestion", "ExitPlanMode")
# A background agent replies immediately with a launch receipt and reports back
# later via <task-notification>. Any other result means it already finished.
ASYNC_RECEIPTS = ("Async agent launched successfully",
                  "resumed from transcript in the background")

RE_NOTIFY_ID = re.compile(rb"<tool-use-id>([^<]+)</tool-use-id>")


def blank_state():
    return {"offset": 0, "pending": {}, "last_prompt": "", "phase": "idle", "ask": False}


def _payload_blocks(raw):
    try:
        d = json.loads(raw)
    except Exception:
        return []
    if d.get("isSidechain"):
        return []  # a subagent's own turns must not drive the main status line
    msg = d.get("message")
    if not isinstance(msg, dict):
        return []
    content = msg.get("content")
    return content if isinstance(content, list) else []


def _tool_uses(raw):
    """Yield (tool_name, tool_use_id) for genuine tool_use blocks."""
    for b in _payload_blocks(raw):
        if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("id"):
            yield b.get("name") or "", b["id"]


def _tool_results(raw):
    """Yield (tool_use_id, result_text) for genuine tool_result blocks."""
    for b in _payload_blocks(raw):
        if not isinstance(b, dict) or b.get("type") != "tool_result":
            continue
        tuid = b.get("tool_use_id")
        if not tuid:
            continue
        text = b.get("content")
        if isinstance(text, list):
            text = " ".join(p.get("text", "") for p in text
                            if isinstance(p, dict) and p.get("type") == "text")
        yield tuid, text if isinstance(text, str) else ""


def _is_type(raw, wanted):
    try:
        return json.loads(raw).get("type") == wanted
    except Exception:
        return False


def scan_transcript(path, session_id):
    """Return {pending agents, phase, ask, last_prompt} for this session."""
    state = blank_state()
    if not path or not os.path.isfile(path):
        return state

    cache_path = os.path.join(TMP, "statusline_state_%s.json" % (session_id or "default"))
    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            cached = json.load(f)
        if isinstance(cached, dict) and isinstance(cached.get("pending"), dict):
            state.update(cached)
    except Exception:
        state = blank_state()

    try:
        size = os.path.getsize(path)
    except OSError:
        return state
    if size < state["offset"]:  # transcript rewritten (/clear, compact) → reparse
        state = blank_state()
    if size == state["offset"]:
        return state

    try:
        with open(path, "rb") as f:
            f.seek(state["offset"])
            chunk = f.read()
    except OSError:
        return state

    cut = chunk.rfind(b"\n")
    if cut == -1:
        return state  # no complete line appended yet
    consumed = cut + 1

    pending = state["pending"]
    for raw in chunk[:consumed].split(b"\n"):
        if not raw.strip():
            continue

        if M_TURN_END in raw and _is_type(raw, "system"):
            state["phase"] = "idle"
            state["ask"] = False
            continue

        if any(m in raw for m in M_ASSISTANT):
            state["phase"] = "busy"
            if any(m in raw for m in M_AGENT_TOOL) or any(m in raw for m in M_ASK_TOOL):
                for name, tuid in _tool_uses(raw):
                    if name in AGENT_TOOLS:
                        pending[tuid] = name
                    elif name in ASK_TOOLS:
                        state["ask"] = True
        elif any(m in raw for m in M_USER):
            state["phase"] = "busy"
            if b"tool_result" in raw:
                state["ask"] = False
                # Resolve tracked agents: a launch receipt keeps them pending,
                # anything else (real output, error) means they are done.
                if pending and b"tool_use_id" in raw:
                    for tuid, text in _tool_results(raw):
                        if tuid in pending and not any(r in text for r in ASYNC_RECEIPTS):
                            pending.pop(tuid, None)

        if M_NOTIFY in raw and pending:  # a background agent reported back
            for tid in RE_NOTIFY_ID.findall(raw):
                pending.pop(tid.decode("utf-8", "replace"), None)

        if M_LASTPROMPT in raw:
            try:
                d = json.loads(raw)
            except Exception:
                continue
            if d.get("type") == "last-prompt":
                state["last_prompt"] = d.get("lastPrompt") or state["last_prompt"]

    state["offset"] += consumed
    state["pending"] = pending

    tmp_path = "%s.%d.tmp" % (cache_path, os.getpid())
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp_path, cache_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    return state


# --------------------------------------------------------------------------
# session todo list (TaskCreate/TaskUpdate state on disk)
# --------------------------------------------------------------------------

def todo_counts(transcript_path, session_id):
    """Return (completed, total) for this session's todo list."""
    if not transcript_path or not session_id:
        return 0, 0
    # <config>/projects/<slug>/<session>.jsonl  ->  <config>/tasks/<session>/
    config = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(transcript_path))))
    tdir = os.path.join(config, "tasks", session_id)
    done = total = 0
    try:
        names = os.listdir(tdir)
    except OSError:
        return 0, 0
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(tdir, name), "r", encoding="utf-8") as f:
                status = json.load(f).get("status")
        except Exception:
            continue
        if not status:
            continue
        total += 1
        if status == "completed":
            done += 1
    return done, total


# --------------------------------------------------------------------------
# adb devices  (probe runs detached; the render only reads the cache)
# --------------------------------------------------------------------------

def refresh_devices_async():
    """Kick off statusline-adb.sh when the cache is stale."""
    try:
        import time
        age = time.time() - os.path.getmtime(ADB_STAMP)
        if age < ADB_TTL:
            return
    except OSError:
        pass
    try:
        # Stamp *before* spawning: a slow adb must not pile up probes.
        with open(ADB_STAMP, "w") as f:
            f.write("")
    except OSError:
        return

    probe = os.path.join(HERE, "statusline-adb.sh")
    if not os.path.isfile(probe):
        return
    bash = os.environ.get("CLAUDE_BASH") or r"C:\Program Files\Git\bin\bash.exe"
    if not os.path.isfile(bash):
        return
    try:
        import subprocess
        subprocess.Popen(
            [bash, probe],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=0x00000008 | 0x08000000,  # DETACHED_PROCESS | CREATE_NO_WINDOW
            close_fds=True,
        )
    except Exception:
        pass


def read_devices():
    try:
        with open(ADB_CACHE, "r", encoding="utf-8", errors="replace") as f:
            names = [x.strip() for x in f.read().replace("\r", "").split("\n")]
    except OSError:
        return [], ""
    names = [n for n in names if n]
    sel = ""
    try:
        with open(ADB_SEL, "r", encoding="utf-8", errors="replace") as f:
            sel = f.read().strip()
    except OSError:
        pass
    if sel not in names:
        sel = names[0] if names else ""
    return names, sel


def devices_segment(names, sel):
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    others = [n for n in names if n != sel]
    if len(others) <= 2:
        return "[%s]%s" % (sel, "".join(" " + DIM + o + RESET for o in others))
    return "[%s] %s+%d%s" % (sel, DIM, len(others), RESET)


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    # Windows defaults these pipes to the ANSI code page, which cannot encode
    # the icons or Cyrillic titles — force UTF-8 here rather than relying on
    # PYTHONIOENCODING surviving whichever shell runs the status line.
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    session_id = payload.get("session_id") or ""
    transcript = payload.get("transcript_path") or ""
    workspace = payload.get("workspace") or {}
    cwd = workspace.get("current_dir") or payload.get("cwd") or ""

    refresh_devices_async()

    # --- location: repo plus branch, without saying the same thing twice ----
    branch, repo = git_info(cwd)
    if not branch:
        branch = (payload.get("worktree") or {}).get("branch") or ""
    if not repo:
        repo = (workspace.get("repo") or {}).get("name") or ""
    if not repo and cwd:
        repo = os.path.basename(os.path.normpath(cwd.replace("\\", "/")))

    nb, nr = norm(branch), norm(repo)
    if not repo:
        loc = branch
    elif not branch:
        loc = repo
    elif nb and nr and (nb == nr or nb in nr or nr in nb):
        loc = branch          # a worktree folder named after its branch
    else:
        loc = "%s %s(%s)%s" % (repo, DIM, branch, RESET)

    # --- context bar --------------------------------------------------------
    ctx = payload.get("context_window") or {}
    try:
        pct = int(round(float(ctx.get("used_percentage") or 0)))
    except (TypeError, ValueError):
        pct = 0
    pct = max(0, min(100, pct))
    color = RED if pct >= 90 else YELLOW if pct >= 70 else GREEN
    filled = min(10, pct * 10 // 100)
    bar = "%s%s%s%s%s" % (color, "█" * filled, DIM, "░" * (10 - filled), RESET)

    # --- cost ---------------------------------------------------------------
    try:
        cost = float((payload.get("cost") or {}).get("total_cost_usd") or 0)
    except (TypeError, ValueError):
        cost = 0.0

    # --- status -------------------------------------------------------------
    state = scan_transcript(transcript, session_id)
    agents = len(state.get("pending") or {})
    done, total = todo_counts(transcript, session_id)

    if state.get("ask"):
        icon, icolor = ICON_ASK, YELLOW
    elif state.get("phase") == "busy":
        icon, icolor = ICON_BUSY, GREEN
    else:
        icon, icolor = ICON_IDLE, DIM
    status = icolor + icon + RESET
    if agents:
        status += " %s%d" % (ICON_AGENT, agents)
    if total:
        status += " %s%s%d/%d%s" % (DIM, ICON_TODO, done, total, RESET)

    # --- title: the live task summary, refreshed by Claude Code -------------
    title = clean_title(payload.get("session_name") or state.get("last_prompt") or "")

    # --- assemble; the bar and status always stay, the rest sheds ----------
    cols = terminal_cols()
    names, sel = read_devices()
    parts = [loc, bar, DIM + "$%.2f" % cost + RESET, devices_segment(names, sel), status]

    def build():
        joined = (" %s " % SEP).join(p for p in parts if p)
        return joined, dwidth(strip_ansi(joined))

    joined, used = build()
    for drop in (3, 2):  # devices first, then cost
        if used <= cols:
            break
        parts[drop] = ""
        joined, used = build()
    if used > cols and parts[0]:  # last resort: clip the location
        bare = strip_ansi(parts[0])
        parts[0] = dtrunc(bare, max(3, dwidth(bare) - (used - cols)))
        joined, used = build()

    if title:
        room = cols - used - 4  # " │ " plus a spare cell
        if room >= MIN_TITLE_COLS:
            joined += " %s %s%s%s" % (SEP, DIM, dtrunc(title, room), RESET)

    out = sys.stdout
    if title:
        out.write("\033]0;%s\007" % dtrunc(title, 50))  # terminal tab label
    out.write(joined + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
