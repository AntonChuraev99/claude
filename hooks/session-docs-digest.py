#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart hook: digest of the current project's task docs.

Sources
    docs/active/*.md   «в работе»  — markdown header, `**Статус:**` not Done/Complete/…
    docs/todos/*.md    «отложено»  — YAML frontmatter `status: deferred`
    docs/backlog/*.md  «бэклог»    — YAML frontmatter `status: backlog`

Output is two different things for two different readers:

* `systemMessage` — what the USER sees in the terminal. Sized by a **line
  budget**, not by an entry count, and scaled down by `source`: a `/clear` in
  the middle of a working session gets one summary line, an auto-compact gets
  nothing at all.
* `additionalContext` — what the MODEL sees. Always the complete list,
  regardless of `source`: `/clear` and `/compact` wipe the model's context, so
  this is exactly when the full list has to be re-injected.

Rendering rules learned the hard way (2026-08-10):

* No box drawing. The CLI prints `⎿ SessionStart:<source> says:` in front of the
  hook output and indents the remaining lines, so any frame that assumes column
  0 is broken before its first character. Columns are aligned with padding
  instead, and the longest field (the title) always comes last so clipping it
  can never wrap a line.
* Width comes from the console (`lib/term.py`), minus the CLI's own indent.
* The screen shows an age (`6д`); the ISO date stays in `additionalContext`,
  where it is worth its characters.

Silent (exit 0, no output) when no docs dir exists or every entry is closed.
Any error is swallowed — an informational hook must never break session start.

Env
    CLAUDE_DIGEST_LINES  — line budget for the visible block (default 14)
    CLAUDE_DIGEST_COLOR  — 1/on/true to emit ANSI dim; default off until the
                           CLI is confirmed to pass escapes through untouched
    NO_COLOR             — wins over the above
    CLAUDE_TERM_COLS     — width override (shared with the status line)

Run: python hooks/session-docs-digest.py, stdin = hook JSON ({cwd, source, …}).
Tests: hooks/session-docs-digest.tests.py
"""

import io
import os
import re
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))
from hookout import WARN, cwd_of, emit, force_utf8, read_payload, width  # noqa: E402
from term import DIM, RESET, dpad, dtrunc, dwidth  # noqa: E402

DEFAULT_BUDGET = 14
MIN_TITLE_COLS = 16
MAX_META_COLS = 20
SKIP_FILES = ("TEMPLATE.md", "INDEX.md", "README.md")

DONE_ACTIVE = re.compile(r"^(Done|Complete|Resolved|Завершен|Закрыт)", re.I)
ISO_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
FM_LINE = re.compile(r"^([A-Za-z_]+):\s*(.*)$")
INDEX_LINK = re.compile(r"\]\(([^)]+\.md)\)")


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def clip(s, limit=160):
    if not s:
        return ""
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit - 1] + "…" if len(s) > limit else s


def head_lines(path, count):
    with io.open(path, encoding="utf-8", errors="replace") as f:
        out = []
        for i, line in enumerate(f):
            if i >= count:
                break
            out.append(line.rstrip("\n").rstrip("\r"))
        return out


def parse_frontmatter(path, head=30):
    """YAML frontmatter of the first lines; None when the file has no header."""
    lines = head_lines(path, head)
    if not lines or lines[0].strip() != "---":
        return None
    fm, closed = {}, False
    for line in lines[1:]:
        if line.strip() == "---":
            closed = True
            break
        m = FM_LINE.match(line)
        if m:
            key, val = m.group(1), m.group(2).strip()
            if len(val) > 1 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            fm[key] = val
    return fm if closed else None


def parse_date(s):
    m = ISO_DATE.search(s or "")
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def age_label(d):
    """Compact age: сегодня / вчера / 6д / 3мес / 2г."""
    if not d:
        return ""
    days = (date.today() - d).days
    if days < 0:
        return "→"          # dated in the future
    if days == 0:
        return "сегодня"
    if days == 1:
        return "вчера"
    if days < 30:
        return "%dд" % days
    if days < 365:
        return "%dмес" % max(1, days // 30)
    return "%dг" % max(1, days // 365)


def sort_key(entry):
    """Newest first; entries without a date sink to the bottom."""
    return (entry["date"] is None, -(entry["date"].toordinal() if entry["date"] else 0),
            entry["title"])


# --------------------------------------------------------------------------
# collection
# --------------------------------------------------------------------------

def md_files(folder):
    if not os.path.isdir(folder):
        return []
    out = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".md") or name in SKIP_FILES:
            continue
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            out.append((name, path))
    return out


def collect_active(root):
    """docs/active — markdown header (# Title, **Статус:**, **Дата старта:**, ## Цель)."""
    entries = []
    for name, path in md_files(os.path.join(root, "docs", "active")):
        try:
            lines = head_lines(path, 60)
        except OSError:
            continue
        status_line = next((l for l in lines if l.startswith("**Статус:**")), None)
        if not status_line:
            continue                            # no header — not a tracked doc
        status = status_line[len("**Статус:**"):].strip()
        # strip leading emoji/decoration before matching, so "✅ Done" is caught
        # while "Partially Done" (which does not *start* with Done) survives
        if DONE_ACTIVE.match(re.sub(r"^[^^\wЀ-ӿ]+", "", status)):
            continue
        title_line = next((l for l in lines if re.match(r"^#\s+", l)), None)
        title = re.sub(r"^#\s+", "", title_line).strip() if title_line else name[:-3]
        date_line = next((l for l in lines if re.match(r"^\*\*Дата( старта)?:\*\*", l)), None)
        raw_date = re.sub(r"^\*\*[^*]+\*\*\s*", "", date_line).strip() if date_line else ""
        goal, in_goal = "", False
        for l in lines:
            if re.match(r"^##\s+Цель", l):
                in_goal = True
                continue
            if in_goal:
                if l.startswith("#"):
                    break
                if l.strip():
                    goal = l.strip()
                    break
        entries.append({
            "title": clip(title, 100), "file": name, "folder": "docs/active",
            "meta": clip(status, MAX_META_COLS * 2), "raw_date": raw_date,
            "date": parse_date(raw_date), "desc": clip(goal, 160), "hot": False,
        })
    return sorted(entries, key=sort_key)


def collect_todos(root):
    """docs/todos — deferred by an EXTERNAL blocker; a dated trigger can come due."""
    entries = []
    today = date.today()
    for name, path in md_files(os.path.join(root, "docs", "todos")):
        try:
            fm = parse_frontmatter(path)
        except OSError:
            continue
        if not fm or fm.get("status") != "deferred":
            continue
        trigger = fm.get("resume_trigger", "")
        # A trigger is only machine-checkable when it carries a date; anything
        # else ("выйдет Compose 1.9") stays cold and is a human's call.
        due = parse_date(fm.get("resume_after", "")) or parse_date(trigger)
        entries.append({
            "title": clip(fm.get("title") or name[:-3], 100), "file": name,
            "folder": "docs/todos", "meta": clip(fm.get("blocking_reason", ""), MAX_META_COLS * 2),
            "raw_date": fm.get("date", ""), "date": parse_date(fm.get("date", "")),
            "desc": clip(trigger, 160), "hot": bool(due and due <= today),
        })
    # hot triggers first — they are the only entries that ask for action today
    return sorted(entries, key=lambda e: (not e["hot"],) + sort_key(e))


def collect_backlog(root):
    """docs/backlog — taken by hand, nothing external is blocking it."""
    entries = []
    for name, path in md_files(os.path.join(root, "docs", "backlog")):
        try:
            fm = parse_frontmatter(path)
        except OSError:
            continue
        if not fm or fm.get("status") != "backlog":
            continue
        entries.append({
            "title": clip(fm.get("title") or name[:-3], 100), "file": name,
            "folder": "docs/backlog", "meta": clip(fm.get("area", ""), MAX_META_COLS * 2),
            "raw_date": fm.get("date", ""), "date": parse_date(fm.get("date", "")),
            "desc": "", "hot": False,
        })
    return sorted(entries, key=sort_key)


def index_drift(root, folder, entries):
    """Files whose frontmatter says open but which no INDEX.md `## Open` row lists.

    The INDEX is maintained by hand and the frontmatter is what this hook reads,
    so the two drift silently — one such drift was live in ~/.claude when this
    check was written.
    """
    path = os.path.join(root, "docs", folder, "INDEX.md")
    if not entries or not os.path.isfile(path):
        return []
    try:
        with io.open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return []
    m = re.search(r"^##\s+Open\s*$(.*?)(?=^##\s|\Z)", text, re.M | re.S)
    if not m:
        return []
    listed = {os.path.basename(x) for x in INDEX_LINK.findall(m.group(1))}
    return [e["file"] for e in entries if e["file"] not in listed]


# --------------------------------------------------------------------------
# rendering — the user-facing block
# --------------------------------------------------------------------------

def use_color():
    if os.environ.get("NO_COLOR"):
        return False
    return (os.environ.get("CLAUDE_DIGEST_COLOR") or "").lower() in ("1", "on", "true", "yes")


def render_row(entry, age_w, meta_w, width, color):
    """`  ! 6д  hooks  Заголовок…` — fixed columns first, clippable title last."""
    marker = "!" if entry["hot"] else " "
    age = dpad(age_label(entry["date"]), age_w)
    # Never rstrip the lead: the trailing padding IS the column, and stripping
    # it is what made titles start at three different offsets (fixed 2026-08-10).
    if meta_w:
        lead = "  %s %s  %s  " % (marker, age, dpad(dtrunc(entry["meta"], meta_w), meta_w))
    else:
        lead = "  %s %s  " % (marker, age)
    room = width - dwidth(lead)
    if room < MIN_TITLE_COLS:                      # narrow terminal: drop the meta column
        lead = "  %s %s  " % (marker, age)
        room = width - dwidth(lead)
    title = dtrunc(entry["title"], max(1, room))
    if color:
        return "%s%s%s%s" % (DIM, lead, RESET, title)
    return lead + title


def plan_budget(sections, budget, multi):
    """Hand out the line budget by priority, guaranteeing every section one row."""
    remaining = budget
    shown = {}
    pending = [s for s in sections if s["entries"]]
    for i, sec in enumerate(pending):
        header = 1 if multi else 0
        # keep one line (plus header) in reserve for each section still to come
        reserve = sum(1 + (1 if multi else 0) for _ in pending[i + 1:])
        can = remaining - header - reserve
        take = max(0, min(len(sec["entries"]), can))
        shown[sec["key"]] = take
        remaining -= take + (header if take else 0)
    return shown


def render_screen(project, sections, warns, budget, width, color):
    lines = []
    counts = " · ".join("%s %d" % (s["label"], len(s["entries"]))
                        for s in sections if s["entries"])
    header = "%s · %s" % (project, counts)
    lines.append(dtrunc(header, width))

    visible = [s for s in sections if s["entries"]]
    multi = len(visible) > 1
    total = sum(len(s["entries"]) for s in visible)
    body_budget = budget - 1 - len(warns)
    # a footer line is only worth its budget when something is actually hidden
    trial = plan_budget(visible, body_budget, multi)
    hidden = total - sum(trial.values())
    if hidden:
        trial = plan_budget(visible, body_budget - 1, multi)
        hidden = total - sum(trial.values())

    for sec in visible:
        take = trial.get(sec["key"], 0)
        if not take:
            continue
        if multi:
            lines.append(sec["title"] if not color else DIM + sec["title"] + RESET)
        rows = sec["entries"][:take]
        age_w = max((dwidth(age_label(e["date"])) for e in rows), default=0)
        meta_w = min(MAX_META_COLS, max((dwidth(e["meta"]) for e in rows), default=0))
        for e in rows:
            lines.append(render_row(e, age_w, meta_w, width, color))

    if hidden:
        tail = "  +%d ещё · спроси «что в работе / отложено / в бэклоге?»" % hidden
        lines.append(dtrunc(tail, width) if not color else DIM + dtrunc(tail, width) + RESET)
    for w in warns:
        lines.append(dtrunc("  %s %s" % (WARN, w), width))
    return "\n".join(lines)


# --------------------------------------------------------------------------
# rendering — the model-facing context
# --------------------------------------------------------------------------

def render_context(sections, warns):
    out = ["Дайджест доков задач проекта (docs/active + docs/todos + docs/backlog):"]
    for sec in sections:
        if not sec["entries"]:
            continue
        out.append("")
        out.append("%s (%d)%s:" % (sec["title"], len(sec["entries"]), sec["note"]))
        for e in sec["entries"]:
            head = "- %s" % e["title"]
            bits = [b for b in (e["raw_date"], e["meta"]) if b]
            if bits:
                head += " (%s)" % ", ".join(bits)
            if e["hot"]:
                head += " — ТРИГГЕР НАСТАЛ"
            out.append(head)
            out.append("  %s/%s" % (e["folder"], e["file"]))
            if e["desc"]:
                out.append("  %s" % e["desc"])
    for w in warns:
        out.append("")
        out.append("ВНИМАНИЕ: %s" % w)
    out.append("")
    out.append("Это фоновая справка о незавершённых/отложенных задачах проекта — не начинай "
               "работу по этим докам без явного запроса пользователя. В терминале пользователю "
               "показана сокращённая версия — на вопрос «что в работе/отложено/в бэклоге?» "
               "отвечай из этого полного списка.")
    return "\n".join(out)


# --------------------------------------------------------------------------

def main():
    payload = read_payload()
    cwd = cwd_of(payload)
    source = (payload.get("source") or "").lower()

    docs = os.path.join(cwd, "docs")
    if not any(os.path.isdir(os.path.join(docs, d)) for d in ("active", "todos", "backlog")):
        return 0

    active = collect_active(cwd)
    todos = collect_todos(cwd)
    backlog = collect_backlog(cwd)
    if not (active or todos or backlog):
        return 0

    hot = sum(1 for e in todos if e["hot"])
    sections = [
        {"key": "active", "label": "в работе", "title": "В РАБОТЕ", "entries": active, "note": ""},
        {"key": "todos", "label": "отложено", "title": "ОТЛОЖЕНО", "entries": todos,
         "note": (" — триггер настал у %d" % hot) if hot else ""},
        {"key": "backlog", "label": "бэклог", "title": "БЭКЛОГ", "entries": backlog,
         "note": " — берётся руками, внешней блокировки нет"},
    ]

    warns = []
    for folder, entries in (("todos", todos), ("backlog", backlog)):
        missing = index_drift(cwd, folder, entries)
        if missing:
            warns.append("docs/%s/INDEX.md не сходится с файлами — нет в ## Open: %s"
                         % (folder, ", ".join(missing[:3])
                            + (" и ещё %d" % (len(missing) - 3) if len(missing) > 3 else "")))

    project = os.path.basename(os.path.normpath(cwd)) or cwd
    w = width()
    try:
        budget = int(os.environ.get("CLAUDE_DIGEST_LINES") or DEFAULT_BUDGET)
    except ValueError:
        budget = DEFAULT_BUDGET

    if source == "compact":
        screen = None                          # mid-task: the screen stays quiet
    elif source == "clear":
        counts = " · ".join("%s %d" % (s["label"], len(s["entries"]))
                            for s in sections if s["entries"])
        line = "%s · %s" % (project, counts)
        if warns:
            line += " · %s INDEX" % WARN
        screen = dtrunc(line, w)
    else:                                       # startup, resume, unknown
        screen = render_screen(project, sections, warns, max(4, budget), w, use_color())

    # context is always complete: /clear and /compact are exactly when the model
    # has just lost this list
    emit(system_message=screen, context=render_context(sections, warns))
    return 0


if __name__ == "__main__":
    try:
        force_utf8()
        sys.exit(main())
    except Exception:
        sys.exit(0)                             # informational hook: never break startup
