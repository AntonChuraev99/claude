#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Terminal rendering primitives shared by the status line and SessionStart hooks.

Everything here runs in short-lived processes that the CLI spawns on every
render or session start, so the module deliberately imports nothing but the
standard `os`/`re`/`ctypes` trio:

* `unicodedata` costs ~17ms to import — the width tables below are hand-rolled
  to avoid it (measured while writing the status line, 2026-08-07).
* Terminal width is not in the environment for these processes (no tty, no
  COLUMNS) — it is read from the attached console through CONOUT$.

Consumers: `statusline.py`, `hooks/session-docs-digest.py`.
"""

import os
import re

RESET = "\033[0m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
DIM = "\033[2m"

ELLIPSIS = "…"
FALLBACK_COLS = 120


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
# emoji presentation — the status-line icons live here.
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


def dpad(s, width):
    """Left-align `s` in `width` cells, measuring by rendered width."""
    gap = width - dwidth(s)
    return s + " " * gap if gap > 0 else s


def strip_ansi(s):
    return re.sub(r"\033\[[0-9;]*m", "", s)


def terminal_cols():
    """Console width via CONOUT$ — stdout is a pipe, so tty probes all fail."""
    for var in ("CLAUDE_TERM_COLS", "CLAUDE_STATUSLINE_COLS"):
        override = os.environ.get(var)
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
