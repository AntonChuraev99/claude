# Replay метрики делегирования прод-кода (improvements/2026-08-27-delegation-rule-erosion.md,
# 2026-09-28-delegation-rule-relax.md). Методика — раздел Baseline первой записи.
# Транскрипты живут ~30 дней: результат сохранять в запись improvements сразу.
# Запуск: python ~/.claude/scripts/replay-delegation.py
import json, os, glob, re, statistics, sys
from collections import defaultdict
from datetime import datetime, date, timedelta

sys.stdout.reconfigure(encoding="utf-8")
HOME = os.path.expanduser("~")
ROOTS = [os.path.join(HOME, ".claude", "projects"), os.path.join(HOME, ".claude-work", "projects")]
# encoded-cwd репозитория ~/.claude: разделители и точки → '-'
CLAUDE_PROJ = re.sub(r"[:\\/.]", "-", os.path.join(HOME, ".claude"))
HOME_CLAUDE = (HOME.replace("\\", "/") + "/.claude/").lower()
SPEC_OLD = {"compose-feature-expert","android-platform-expert","kotlin-expert","kmp-expert",
            "wasmjs-expert","nextjs-expert","react-ui-expert","test-expert"}
SPEC_NEW = {"compose-expert","feature-expert","core-expert"}
SPEC_ALL = SPEC_OLD | SPEC_NEW
OTHER = {"design-expert","product-expert","marketing-expert","google-play-console-expert","jira-expert"}
EDIT_TOOLS = {"Edit","Write","MultiEdit","NotebookEdit"}
CODE_EXT = (".kt",".kts",".java",".ts",".tsx",".js",".jsx",".py",".swift",".go",".rs",".vue",".css",".html")

def is_claude_repo(proj):
    return proj == CLAUDE_PROJ or proj.startswith(CLAUDE_PROJ + "--claude-worktrees-")

def inside_claude(fp):
    p = fp.replace("\\", "/").lower()
    return p.startswith(HOME_CLAUDE) or p.startswith("~/.claude/")

files = {}
for root in ROOTS:
    for f in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
        name = os.path.basename(f)
        if name in files: continue
        rel = os.path.relpath(f, root)
        files[name] = (f, rel.split(os.sep)[0])

sessions = []
for name, (path, proj) in files.items():
    recs = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line: continue
                try: recs.append(json.loads(line))
                except Exception: continue
    except FileNotFoundError:
        continue  # транскрипт удалён автоочисткой между glob и open
    if not recs: continue
    recs = [r for r in recs if not r.get("isSidechain")]
    n_asst = sum(1 for r in recs if r.get("type") == "assistant")
    if n_asst < 5: continue
    # date = timestamp of first record (after sidechain filter)
    ts = next((r["timestamp"] for r in recs if r.get("timestamp")), None)
    if not ts: continue
    d = ts[:10]
    s = dict(date=d, proj=proj, agent=0, spec_old=0, spec_all=0, other=0, gp=0, edits=0, code=0, code_out=0)
    for r in recs:
        if r.get("type") != "assistant": continue
        c = (r.get("message") or {}).get("content")
        if not isinstance(c, list): continue
        for b in c:
            if not isinstance(b, dict) or b.get("type") != "tool_use": continue
            nm = b.get("name"); inp = b.get("input") or {}
            if nm in ("Task", "Agent"):
                s["agent"] += 1
                st = inp.get("subagent_type") or ""
                if st in SPEC_OLD: s["spec_old"] += 1
                if st in SPEC_ALL: s["spec_all"] += 1
                if st in OTHER: s["other"] += 1
                if st == "general-purpose": s["gp"] += 1
            elif nm in EDIT_TOOLS:
                s["edits"] += 1
                fp = inp.get("file_path") or inp.get("notebook_path") or ""
                if fp.lower().endswith(CODE_EXT):
                    s["code"] += 1
                    if not is_claude_repo(proj) and not inside_claude(fp):
                        s["code_out"] += 1
    sessions.append(s)

by_day = defaultdict(list)
for s in sessions: by_day[s["date"]].append(s)

def agg(ss, k): return sum(x[k] for x in ss)

print("## 1. По дням")
print("| дата | сессий | spec_old | spec_all | прочих дом. | general-purpose | правок файлов | правок кода | кода вне ~/.claude | spec_all/сессия |")
print("|---|---|---|---|---|---|---|---|---|---|")
# Окно: python replay-delegation.py [FROM [TO]] (ISO-даты); по умолчанию — последние 30 дней.
# Replay записи 2026-09-28: FROM=2026-09-29 (день после правки).
d1 = date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else date.today()
d0 = date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else d1 - timedelta(days=30)
d = d0
while d <= d1:
    k = d.isoformat(); ss = by_day.get(k, [])
    n = len(ss)
    print(f"| {k} | {n} | {agg(ss,'spec_old')} | {agg(ss,'spec_all')} | {agg(ss,'other')} | {agg(ss,'gp')} | {agg(ss,'edits')} | {agg(ss,'code')} | {agg(ss,'code_out')} | {agg(ss,'spec_all')/n if n else 0:.2f} |")
    d += timedelta(days=1)

print("\n## 2. Baseline")
base = {"2026-08-20": (13,13,412), "2026-08-24": (12,7,122), "2026-08-25": (9,11,464), "2026-08-26": (0,15,236)}
print("| дата | spec_old (base) | spec_all | сессий (base) | кода вне (base) |")
print("|---|---|---|---|---|")
for k, (bs, bn, bc) in base.items():
    ss = by_day.get(k, [])
    def pct(a, b): return f"{(a-b)/b*100:+.0f}%" if b else ("0" if a == b else "n/a")
    print(f"| {k} | {agg(ss,'spec_old')} ({bs}, {pct(agg(ss,'spec_old'),bs)}) | {agg(ss,'spec_all')} | {len(ss)} ({bn}, {pct(len(ss),bn)}) | {agg(ss,'code_out')} ({bc}, {pct(agg(ss,'code_out'),bc)}) |")
# diagnostics: sessions by project on baseline days
for k in base:
    ss = by_day.get(k, [])
    pp = defaultdict(int)
    for s in ss: pp[s["proj"]] += 1
    print(f"  {k} projects: {dict(pp)}")

print(f"\n## 3. Target {d0}..{d1}")
ratios = []; zero_days = []; tgt_sessions = []
d = d0
while d <= d1:
    k = d.isoformat(); ss = by_day.get(k, [])
    tgt_sessions += ss
    if agg(ss, 'code_out') > 0:
        ratios.append(agg(ss, 'spec_all') / len(ss))
        if agg(ss, 'spec_all') == 0 and agg(ss, 'code_out') > 100: zero_days.append(k)
    d += timedelta(days=1)
print(f"дней с code_out>0: {len(ratios)}; среднее spec_all/сессия: {statistics.mean(ratios) if ratios else 0:.2f}")
print(f"дней spec_all=0 при code_out>100: {len(zero_days)} {zero_days}")
print(f"медиана правок файлов главным/сессия (все сессии периода, n={len(tgt_sessions)}): {statistics.median([s['edits'] for s in tgt_sessions]) if tgt_sessions else 0}")
act = [s for s in tgt_sessions if by_day and agg(by_day[s['date']], 'code_out') > 0]
print(f"  то же только дни с code_out>0 (n={len(act)}): {statistics.median([s['edits'] for s in act]) if act else 0}")

print("\n## 4. Понедельно")
print("| неделя (пн) | сессий | медиана Agent/сессия | медиана правок/сессия | среднее spec_all/сессия |")
print("|---|---|---|---|---|")
wk = defaultdict(list)
for s in sessions:
    dd = date.fromisoformat(s["date"])
    if dd < d0 or dd > d1: continue
    wk[(dd - timedelta(days=dd.weekday())).isoformat()].append(s)
for k in sorted(wk):
    ss = wk[k]
    print(f"| {k} | {len(ss)} | {statistics.median([x['agent'] for x in ss])} | {statistics.median([x['edits'] for x in ss])} | {agg(ss,'spec_all')/len(ss):.2f} |")
