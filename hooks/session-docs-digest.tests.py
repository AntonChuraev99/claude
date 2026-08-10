#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for hooks/session-docs-digest.py.

Run: python hooks/session-docs-digest.tests.py

Each case builds a throwaway docs/ tree, runs the hook as a real subprocess
(stdin = SessionStart payload, stdout = hook JSON) and asserts on the parsed
result. The subprocess path is deliberate: the stdin/stdout contract with the
CLI is exactly what broke before, so the tests exercise it rather than calling
render() in-process.
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "session-docs-digest.py")
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))

# Characters the old renderer drew boxes with. None of them may appear again:
# the CLI prefixes every hook line with "⎿ SessionStart:… says:" and indents the
# rest, so a frame that assumes column 0 is broken before the first character.
BOX_CHARS = "═─│┌┐└┘├┤┬┴┼▶●━┃"

FAILURES = []
PASSED = 0


def check(name, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILURES.append("%s%s" % (name, (" — " + detail) if detail else ""))


def ago(days):
    return (date.today() - timedelta(days=days)).isoformat()


# --------------------------------------------------------------------------
# fixture builders
# --------------------------------------------------------------------------

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(text)


def make_active(root, name, title, status="In Progress", days=1, goal="Цель задачи."):
    write(os.path.join(root, "docs", "active", name),
          "# %s\n\n**Статус:** %s\n**Дата старта:** %s\n\n## Цель\n%s\n"
          % (title, status, ago(days), goal))


def make_todo(root, name, title, days=1, reason="ждём релиз upstream",
              trigger="выйдет версия 1.9", status="deferred"):
    write(os.path.join(root, "docs", "todos", name),
          "---\ntitle: \"%s\"\ndate: %s\nstatus: %s\nblocking_reason: %s\n"
          "resume_trigger: \"%s\"\n---\n\nтело\n"
          % (title, ago(days), status, reason, trigger))


def make_backlog(root, name, title, days=1, area="hooks", status="backlog"):
    write(os.path.join(root, "docs", "backlog", name),
          "---\ntitle: \"%s\"\ndate: %s\nstatus: %s\narea: %s\n---\n\nтело\n"
          % (title, ago(days), status, area))


def make_index(root, folder, entries):
    rows = "\n".join("| %s | [%s](%s) | area | суть |" % (ago(1), e[:-3], e) for e in entries)
    write(os.path.join(root, "docs", folder, "INDEX.md"),
          "# Index\n\n## Open\n\n| дата | запись | область | суть |\n|---|---|---|---|\n%s\n" % rows)


# --------------------------------------------------------------------------
# hook driver
# --------------------------------------------------------------------------

def run_hook(cwd, source="startup", cols="100", env_extra=None, color=False):
    """`color=False` (the default here) renders plain text so structural
    assertions read cleanly; `color=None` leaves the env alone and therefore
    exercises the hook's own default, which is dim ON."""
    env = dict(os.environ)
    env["CLAUDE_TERM_COLS"] = cols
    env["PYTHONIOENCODING"] = "utf-8"
    env.pop("CLAUDE_DIGEST_COLOR", None)
    env.pop("NO_COLOR", None)
    if color is False:
        env["CLAUDE_DIGEST_COLOR"] = "0"
    if env_extra:
        env.update(env_extra)
    payload = json.dumps({"cwd": cwd, "source": source})
    p = subprocess.run([sys.executable, HOOK], input=payload, env=env,
                       capture_output=True, text=True, encoding="utf-8")
    out = (p.stdout or "").strip()
    parsed = json.loads(out) if out else None
    return p.returncode, parsed, (p.stderr or "")


def sysmsg(parsed):
    return (parsed or {}).get("systemMessage")


def ctx(parsed):
    return ((parsed or {}).get("hookSpecificOutput") or {}).get("additionalContext") or ""


# --------------------------------------------------------------------------
# cases
# --------------------------------------------------------------------------

def case_silent_without_docs(root):
    code, parsed, err = run_hook(root)
    check("no docs/ → exit 0", code == 0, "code=%d" % code)
    check("no docs/ → no output", parsed is None, repr(parsed))


def case_silent_when_all_done(root):
    make_active(root, "a.md", "Закрытая", status="Done")
    make_backlog(root, "b.md", "Сделано", status="done")
    make_todo(root, "t.md", "Закрыто", status="resolved")
    code, parsed, err = run_hook(root)
    check("everything closed → no output", parsed is None, repr(parsed))


def case_backlog_only(root):
    make_backlog(root, "guard.md", "Protected-branch guard: закрыть запись в транк через Bash",
                 days=6, area="hooks")
    make_backlog(root, "noise.md", "Bug-pattern review: прополоть шум, сменить триггер L2",
                 days=7, area="review-rules")
    code, parsed, err = run_hook(root)
    msg = sysmsg(parsed) or ""
    lines = msg.splitlines()

    check("backlog renders", bool(msg), "empty systemMessage")
    check("no box-drawing", not any(c in msg for c in BOX_CHARS),
          "found: %s" % [c for c in BOX_CHARS if c in msg])
    check("compact: <= 6 lines for 2 entries", len(lines) <= 6, "%d lines: %r" % (len(lines), lines))
    check("header counts only non-empty sections",
          "бэклог 2" in lines[0] and "в работе" not in lines[0], lines[0])
    check("single section → no section header",
          not any(l.strip() == "БЭКЛОГ" for l in lines), repr(lines))
    check("age instead of ISO date", "6д" in msg and ago(6) not in msg, repr(lines))
    check("area column present", "hooks" in msg and "review-rules" in msg)
    check("no repeated folder path in rows",
          not any("docs/backlog/" in l for l in lines[1:]), repr(lines))
    check("context lists both entries",
          "guard.md" in ctx(parsed) and "noise.md" in ctx(parsed), ctx(parsed))


def case_source_aware(root):
    make_backlog(root, "b1.md", "Запись бэклога", days=3)
    make_active(root, "a1.md", "Активная задача", days=2)

    for src in ("startup", "resume"):
        _, parsed, _ = run_hook(root, source=src)
        check("%s → full block" % src, len((sysmsg(parsed) or "").splitlines()) > 1,
              repr(sysmsg(parsed)))
        check("%s → context full" % src, "Активная задача" in ctx(parsed))

    _, parsed, _ = run_hook(root, source="clear")
    msg = sysmsg(parsed) or ""
    check("clear → one line", len(msg.splitlines()) == 1, repr(msg))
    check("clear → context still full",
          "Активная задача" in ctx(parsed) and "Запись бэклога" in ctx(parsed), ctx(parsed))

    _, parsed, _ = run_hook(root, source="compact")
    check("compact → no systemMessage", sysmsg(parsed) is None, repr(sysmsg(parsed)))
    check("compact → context still full",
          "Активная задача" in ctx(parsed) and "Запись бэклога" in ctx(parsed), ctx(parsed))


def case_line_budget(root):
    for i in range(30):
        make_backlog(root, "b%02d.md" % i, "Запись бэклога номер %d" % i, days=i + 1)
    _, parsed, _ = run_hook(root)
    lines = (sysmsg(parsed) or "").splitlines()
    check("budget respected with 30 entries", len(lines) <= 14, "%d lines" % len(lines))
    check("overflow announced", any("+" in l and "ещё" in l for l in lines), repr(lines[-3:]))
    check("context keeps all 30", ctx(parsed).count("Запись бэклога номер") == 30,
          str(ctx(parsed).count("Запись бэклога номер")))


def case_priority_and_sections(root):
    make_backlog(root, "b1.md", "Бэклог раз", days=1)
    make_todo(root, "t1.md", "Ждём стор", days=2)
    make_active(root, "a1.md", "Активная одна", days=3)
    _, parsed, _ = run_hook(root)
    lines = [l for l in (sysmsg(parsed) or "").splitlines()]
    body = "\n".join(lines)
    check("three sections → section headers appear",
          "В РАБОТЕ" in body and "ОТЛОЖЕНО" in body and "БЭКЛОГ" in body, repr(lines))
    check("active before todos before backlog",
          body.index("Активная одна") < body.index("Ждём стор") < body.index("Бэклог раз"),
          repr(lines))
    check("header counts all three",
          "в работе 1" in lines[0] and "отложено 1" in lines[0] and "бэклог 1" in lines[0],
          lines[0])


def case_hot_resume_trigger(root):
    make_todo(root, "cold.md", "Холодный триггер", days=5, trigger="выйдет Compose 1.9")
    make_todo(root, "hot.md", "Наступивший триггер", days=4,
              trigger="после %s" % ago(2))
    make_todo(root, "future.md", "Будущий триггер", days=3,
              trigger="после %s" % (date.today() + timedelta(days=30)).isoformat())
    _, parsed, _ = run_hook(root)
    body = sysmsg(parsed) or ""
    check("hot trigger floats to the top",
          body.index("Наступивший триггер") < body.index("Холодный триггер"), repr(body))
    check("hot trigger marked", "!" in body.split("Наступивший")[0].splitlines()[-1], repr(body))
    check("future trigger not marked as hot",
          body.index("Будущий триггер") > body.index("Наступивший триггер"), repr(body))
    check("context flags the hot one", "триггер настал" in ctx(parsed).lower(), ctx(parsed))


def case_index_drift(root):
    make_backlog(root, "listed.md", "Есть в индексе", days=1)
    make_backlog(root, "missing.md", "Нет в индексе", days=2)
    make_index(root, "backlog", ["listed.md"])
    _, parsed, _ = run_hook(root)
    body = sysmsg(parsed) or ""
    check("index drift reported", "INDEX" in body and "missing.md" in body, repr(body))
    check("drift also in context", "missing.md" in ctx(parsed), ctx(parsed))


def case_index_in_sync(root):
    make_backlog(root, "one.md", "Единственная", days=1)
    make_index(root, "backlog", ["one.md"])
    _, parsed, _ = run_hook(root)
    check("no drift warning when in sync", "INDEX" not in (sysmsg(parsed) or ""),
          repr(sysmsg(parsed)))


def case_width(root):
    make_backlog(root, "long.md",
                 "Очень длинный заголовок записи бэклога, который заведомо не влезает "
                 "ни в какую разумную ширину терминала и обязан быть обрезан", days=2)
    _, parsed, _ = run_hook(root, cols="60")
    lines = (sysmsg(parsed) or "").splitlines()
    from term import dwidth
    over = [l for l in lines if dwidth(l) > 60 - 3]
    check("respects narrow terminal", not over, repr(over))
    check("clipped with ellipsis", any("…" in l for l in lines), repr(lines))

    _, parsed, _ = run_hook(root, cols="200")
    wide = (sysmsg(parsed) or "").splitlines()
    check("wide terminal keeps more text",
          max(dwidth(l) for l in wide) > max(dwidth(l) for l in lines), repr(wide))


def case_column_alignment(root):
    """Meta column must be padded to a common width — that is the whole point
    of dropping the box drawing: alignment carries the structure instead."""
    make_backlog(root, "b1.md", "Короткая область", days=2, area="ci")
    make_backlog(root, "b2.md", "Длинная область", days=3, area="review-rules")
    make_backlog(root, "b3.md", "Средняя область", days=12, area="hooks")
    _, parsed, _ = run_hook(root)
    from term import dwidth
    rows = [l for l in (sysmsg(parsed) or "").splitlines() if "область" in l]
    check("three rows rendered", len(rows) == 3, repr(rows))
    starts = {dwidth(r[:r.index("Короткая" if "Короткая" in r else
                                "Длинная" if "Длинная" in r else "Средняя")]) for r in rows}
    check("titles start at one column", len(starts) == 1, "column starts: %s\n%s"
          % (sorted(starts), "\n".join(repr(r) for r in rows)))


def case_color_flag(root):
    """Dim is ON by default — confirmed 2026-08-10 that the CLI forwards escapes
    to the terminal instead of printing them literally."""
    make_backlog(root, "b.md", "Запись", days=1)
    _, parsed, _ = run_hook(root, color=None)
    check("ANSI by default", "\033[" in (sysmsg(parsed) or ""), repr(sysmsg(parsed)))
    _, parsed, _ = run_hook(root, env_extra={"CLAUDE_DIGEST_COLOR": "0"})
    check("CLAUDE_DIGEST_COLOR=0 turns it off", "\033[" not in (sysmsg(parsed) or ""),
          repr(sysmsg(parsed)))
    _, parsed, _ = run_hook(root, env_extra={"CLAUDE_DIGEST_COLOR": "off"})
    check("`off` also turns it off", "\033[" not in (sysmsg(parsed) or ""), repr(sysmsg(parsed)))
    _, parsed, _ = run_hook(root, color=None, env_extra={"NO_COLOR": "1"})
    check("NO_COLOR wins over the default", "\033[" not in (sysmsg(parsed) or ""),
          repr(sysmsg(parsed)))


def case_color_does_not_break_width(root):
    """Escape sequences occupy no cells — clipping must happen before colouring,
    or a coloured row silently overflows a narrow terminal."""
    make_backlog(root, "long1.md",
                 "Очень длинный заголовок записи бэклога, заведомо не влезающий "
                 "в узкий терминал и обязанный быть обрезанным", days=2, area="review-rules")
    make_backlog(root, "long2.md",
                 "Второй столь же длинный заголовок для проверки выравнивания колонок "
                 "при включённом цвете", days=40, area="ci")
    from term import dwidth, strip_ansi
    for cols in ("60", "100"):
        _, parsed, _ = run_hook(root, cols=cols, color=None)   # hook default: dim on
        lines = (sysmsg(parsed) or "").splitlines()
        limit = int(cols) - 3
        over = [(dwidth(strip_ansi(l)), l) for l in lines if dwidth(strip_ansi(l)) > limit]
        check("coloured rows fit at cols=%s" % cols, not over, repr(over))
        check("every escape is closed at cols=%s" % cols,
              all(l.count("\033[2m") == l.count("\033[0m") for l in lines),
              repr([l for l in lines if l.count("\033[2m") != l.count("\033[0m")]))


def case_active_statuses(root):
    make_active(root, "done.md", "Завершённая", status="Done")
    make_active(root, "complete.md", "Завершённая англ", status="✅ Complete")
    make_active(root, "partial.md", "Частично готовая", status="Partially Done")
    make_active(root, "prog.md", "В процессе", status="In Progress")
    _, parsed, _ = run_hook(root)
    body = sysmsg(parsed) or ""
    check("Done hidden", "Завершённая" not in body, repr(body))
    check("Complete hidden", "Завершённая англ" not in body, repr(body))
    check("Partially Done visible", "Частично готовая" in body, repr(body))
    check("In Progress visible", "В процессе" in body, repr(body))


def case_malformed_input(root):
    write(os.path.join(root, "docs", "backlog", "broken.md"), "не фронтматтер вовсе\n")
    write(os.path.join(root, "docs", "todos", "half.md"), "---\ntitle: без закрытия\n")
    make_backlog(root, "ok.md", "Живая запись", days=1)
    code, parsed, err = run_hook(root)
    check("malformed files do not crash", code == 0, "code=%d stderr=%s" % (code, err[:200]))
    check("good entry still rendered", "Живая запись" in (sysmsg(parsed) or ""), repr(parsed))


def case_bad_stdin():
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    p = subprocess.run([sys.executable, HOOK], input="не json вовсе", env=env,
                       capture_output=True, text=True, encoding="utf-8")
    check("garbage stdin → exit 0", p.returncode == 0, "code=%d" % p.returncode)


def case_no_title_fallback(root):
    write(os.path.join(root, "docs", "backlog", "untitled.md"),
          "---\ndate: %s\nstatus: backlog\narea: misc\n---\n\nтело\n" % ago(1))
    _, parsed, _ = run_hook(root)
    check("falls back to filename", "untitled" in (sysmsg(parsed) or ""), repr(sysmsg(parsed)))


# --------------------------------------------------------------------------

CASES = [
    case_silent_without_docs, case_silent_when_all_done, case_backlog_only,
    case_source_aware, case_line_budget, case_priority_and_sections,
    case_hot_resume_trigger, case_index_drift, case_index_in_sync, case_width,
    case_column_alignment, case_color_flag, case_color_does_not_break_width,
    case_active_statuses, case_malformed_input,
    case_no_title_fallback,
]


def main():
    if not os.path.exists(HOOK):
        print("FAIL: hook not found: %s" % HOOK)
        return 1
    for fn in CASES:
        root = tempfile.mkdtemp(prefix="digest-test-")
        try:
            fn(root)
        except Exception as exc:  # a crashing case is a failing case
            FAILURES.append("%s raised %s: %s" % (fn.__name__, type(exc).__name__, exc))
        finally:
            shutil.rmtree(root, ignore_errors=True)
    case_bad_stdin()

    print("passed: %d" % PASSED)
    if FAILURES:
        print("failed: %d" % len(FAILURES))
        for f in FAILURES:
            print("  - %s" % f)
        return 1
    print("all green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
