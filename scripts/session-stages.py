"""session-stages.py — сколько времени сессии ест каждый этап, по JSONL-транскриптам Claude Code.

Запуск: `python ~/.claude/scripts/session-stages.py [дней=7]`. Читает
`<CLAUDE_CONFIG_DIR>/projects/*/<session>.jsonl` (+ `<session>/subagents/agent-*.jsonl`),
печатает per-session разбивку, агрегат по критическому пути главного, фазы по Skill-маркерам
(`task-gate`, `commit`, `code-review`), субагентов по категориям, ревью и test-expert по видам,
самые долгие Bash-вызовы. Источник цифр improvements/2026-09-15-gate-review-tests-relax.md;
replay — тем же скриптом.

Модель времени:
- События главного треда: human prompt, assistant message, tool_use, tool_result, agent_done (task-notification).
- Интервал между соседними событиями относится к категории:
    открыт инструмент          -> категория инструмента (bash:build / bash:tests / read / edit / mcp ...)
    следующее событие agent_done -> wait:<категория этого агента>  (главный ждал субагента)
    следующее — human prompt     -> idle (пользователь думал) — исключается
    gap > GAP_CAP                -> idle (сессия спала / resume) — исключается
    иначе                        -> main:llm (генерация главного)
- Фаза по Skill-маркерам: work → skill:task-gate → skill:commit (Step 6: push/PR/merge) / skill:code-review.
- Субагенты: wall = сумма gap'ов внутри их транскрипта с тем же капом; внутри — категории инструментов.
"""
import json, os, re, sys, glob, collections
from datetime import datetime, timedelta, timezone

CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
ROOT = os.path.join(CONFIG_DIR, "projects")
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 7
MIN_KB = 300                      # сессии меньше — обычно один вопрос-ответ, шум
GAP_CAP = 15 * 60                 # пауза длиннее — сессия спала или resume, не работа
SELF_SESSION = os.environ.get("SESSION_STAGES_SKIP", "")   # id текущей сессии, чтобы не мерить саму себя
CUTOFF = datetime.now(timezone.utc) - timedelta(days=DAYS)   # события старше окна не считаются, даже в живом файле

def parse_ts(s):
    if not s: return None
    try: return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception: return None

def read_jsonl(path):
    out = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: out.append(json.loads(line))
            except Exception: pass
    return out

SCOUTS = {"knowledge-scout", "best-practices-scout"}
REVIEWERS = {"bug-pattern-reviewer", "caveman:cavecrew-reviewer"}
TESTERS = {"test-expert"}
EXPLORE = {"Explore", "Plan", "caveman:cavecrew-investigator"}
PRODUCT = {"product-expert", "marketing-expert", "design-expert"}
REVIEW_RE = re.compile(r"\b(review|ревью|ревьюер|verify|верифи|sanity|independent|независим\w*)\b|проверь дифф", re.I)

def agent_category(subtype, desc, prompt):
    st = subtype or "general-purpose"
    if st in SCOUTS: return "agent:scout"
    if st in REVIEWERS: return "agent:review"
    if st in TESTERS: return "agent:test-expert"
    if st in EXPLORE: return "agent:explore"
    if st in PRODUCT: return "agent:product/design"
    if st == "doc-writer": return "agent:doc-writer"
    text = (desc or "") + " " + (prompt or "")[:600]
    if re.search(r"close .*review findings|починка находок|fix.*findings|fixes for", desc or "", re.I): return "agent:specialist"
    if REVIEW_RE.search(desc or "") or (st in ("general-purpose", "claude") and REVIEW_RE.search(text)): return "agent:review"
    if st.endswith("-expert") or st in ("general-purpose", "claude"): return "agent:specialist"
    return "agent:other(" + st + ")"

BASH_RULES = [
    ("bash:tests", re.compile(r"(gradlew?|gradle)[^|;&]*\b(\w*[tT]est\w*|check|pitest)\b|\b(vitest|jest|pytest|npm test|pnpm test|yarn test|npm run test|playwright test|roborazzi|Roborazzi)\b", re.I)),
    ("bash:build", re.compile(r"(gradlew?|gradle)[^|;&]*\b(assemble|build|compile|install|bundle|lint|detekt|ktlint)|\b(npm run build|pnpm build|next build|tsc\b|npm run lint|eslint|wrangler deploy|npm run typecheck)", re.I)),
    ("bash:review-rules", re.compile(r"review-rules|run\.py", re.I)),
    ("bash:git", re.compile(r"^\s*(git|gh|glab)\b", re.I)),
    ("bash:ast-index", re.compile(r"ast-index", re.I)),
    ("bash:sleep/wait", re.compile(r"\b(sleep|Start-Sleep|until\b|while\b|timeout\b)", re.I)),
    ("bash:adb/device", re.compile(r"\b(adb|emulator|maestro|scrcpy)\b", re.I)),
    ("bash:npm/node", re.compile(r"\b(npm|npx|pnpm|node|yarn)\b", re.I)),
    ("bash:python", re.compile(r"\b(python|py|pytest|uv|pip)\b", re.I)),
    ("bash:gcloud/ssh", re.compile(r"\b(gcloud|ssh|scp|firebase|curl|wget|Invoke-WebRequest)\b", re.I)),
]

def bash_category(cmd):
    for cat, rx in BASH_RULES:
        if rx.search(cmd or ""): return cat
    return "bash:other"

def tool_category(name, inp):
    if name in ("Bash", "PowerShell"): return bash_category(inp.get("command", ""))
    if name in ("Read", "Grep", "Glob"): return "main:read/search"
    if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"): return "main:edit"
    if name == "Skill": return "skill-load"
    if name == "Agent": return "agent-spawn"
    if name in ("SendMessage", "TaskOutput"): return "agent-followup"
    if name and name.startswith("mcp__"): return "mcp"
    if name in ("Monitor",): return "monitor"
    return "main:other-tool(" + str(name) + ")"

def content_blocks(rec):
    m = rec.get("message") or {}
    c = m.get("content")
    if isinstance(c, list): return c
    if isinstance(c, str): return [{"type": "text", "text": c}]
    return []

def text_of(rec):
    return " ".join(b.get("text", "") for b in content_blocks(rec) if b.get("type") == "text")

def is_human_prompt(rec):
    if rec.get("type") != "user": return False
    if rec.get("isMeta"): return False
    if rec.get("toolUseResult") is not None: return False
    if any(b.get("type") == "tool_result" for b in content_blocks(rec)): return False
    if (rec.get("origin") or {}).get("kind") == "task-notification": return False
    txt = text_of(rec)
    if "<task-notification>" in txt: return False
    return bool(txt.strip())

def notif_agent_ids(rec):
    if rec.get("type") != "user": return []
    return re.findall(r"<task-id>([0-9a-f]+)</task-id>", text_of(rec))

MUT_RE = re.compile(r"мутац|mutation|саботаж", re.I)

def analyze_subagent(path):
    recs = read_jsonl(path)
    pending = {}
    cats = collections.Counter()
    ntools = collections.Counter()
    slow = []
    dur = 0.0
    last_t = None
    mutation = False
    for r in recs:
        if r.get("type") not in ("user", "assistant"): continue
        t = parse_ts(r.get("timestamp"))
        if not t or t < CUTOFF: continue
        if last_t is not None:
            g = (t - last_t).total_seconds()
            if g <= GAP_CAP: dur += g
        last_t = t
        if r.get("type") == "assistant":
            for b in content_blocks(r):
                if b.get("type") == "text" and MUT_RE.search(b.get("text", "")): mutation = True
                if b.get("type") == "tool_use":
                    pending[b.get("id")] = (t, b.get("name"), b.get("input") or {})
        else:
            for b in content_blocks(r):
                if b.get("type") == "tool_result" and b.get("tool_use_id") in pending:
                    t0, name, inp = pending.pop(b["tool_use_id"])
                    g = (t - t0).total_seconds()
                    if g > GAP_CAP: continue
                    cat = tool_category(name, inp)
                    cats[cat] += g; ntools[cat] += 1
                    if name in ("Bash", "PowerShell"): slow.append((g, cat, (inp.get("command") or "")[:110].replace("\n", " ")))
    return {"dur": dur, "cats": cats, "ntools": ntools, "slow": slow, "mutation": mutation,
            "turns": sum(1 for r in recs if r.get("type") == "assistant")}

def llm_next_label(events, i):
    """Куда главный шёл после генерации: по следующему tool_use в той же цепочке."""
    for t, kind, p in events[i:]:
        if kind == "human": return "llm→(final answer)"
        if kind == "tool_use":
            tid, name, inp = p
            if name == "Agent":
                return "llm→spawn:" + agent_category(inp.get("subagent_type"), inp.get("description"), inp.get("prompt", ""))
            if name in ("Edit", "Write", "MultiEdit"):
                fp = (inp.get("file_path") or "").replace("\\", "/")
                if "/docs/" in fp or fp.endswith(".md"): return "llm→edit:docs/md"
                return "llm→edit:code/other"
            if name == "Skill": return "llm→skill:" + inp.get("skill", "?").split(":")[-1]
            if name == "AskUserQuestion": return "llm→AskUserQuestion"
            return "llm→" + tool_category(name, inp)
    return "llm→(end)"

PHASE_SKILLS = {"task-gate", "code-review", "commit"}

def analyze_session(path):
    recs = read_jsonl(path)
    sid = os.path.splitext(os.path.basename(path))[0]
    subdir = os.path.join(os.path.dirname(path), sid, "subagents")
    sub_files = {os.path.basename(p)[6:-6]: p for p in glob.glob(os.path.join(subdir, "agent-*.jsonl"))}

    agents = {}
    pending = {}
    events = []
    cost = None
    for r in recs:
        typ = r.get("type")
        if typ == "cost-state": cost = r; continue
        if typ not in ("user", "assistant"): continue
        t = parse_ts(r.get("timestamp"))
        if not t or t < CUTOFF: continue
        if typ == "assistant":
            events.append((t, "assistant", None))
            for b in content_blocks(r):
                if b.get("type") == "tool_use":
                    pending[b.get("id")] = (t, b.get("name"), b.get("input") or {})
                    events.append((t, "tool_use", (b.get("id"), b.get("name"), b.get("input") or {})))
        else:
            if is_human_prompt(r): events.append((t, "human", None))
            for b in content_blocks(r):
                if b.get("type") == "tool_result" and b.get("tool_use_id") in pending:
                    t0, name, inp = pending.pop(b["tool_use_id"])
                    events.append((t, "tool_result", (b["tool_use_id"], name, inp, t0)))
            tur = r.get("toolUseResult")
            if isinstance(tur, dict) and tur.get("agentId"):
                agents[tur["agentId"]] = {"desc": tur.get("description"), "prompt": tur.get("prompt", ""), "spawn": t, "subtype": None}
            for aid in notif_agent_ids(r):
                events.append((t, "agent_done", aid))

    spawn_by_desc = collections.defaultdict(list)
    for t, kind, p in events:
        if kind == "tool_use" and p[1] == "Agent":
            spawn_by_desc[p[2].get("description")].append(p[2].get("subagent_type"))
    for aid, a in agents.items():
        lst = spawn_by_desc.get(a["desc"]) or []
        a["subtype"] = lst.pop(0) if lst else None
        a["cat"] = agent_category(a["subtype"], a["desc"], a["prompt"])
        a["sub"] = analyze_subagent(sub_files[aid]) if aid in sub_files else None

    events.sort(key=lambda e: e[0])
    main = collections.Counter()
    phase_time = collections.Counter()
    phase_break = collections.defaultdict(collections.Counter)
    slow_main = []
    llm_split = collections.Counter()
    phase_llm = collections.defaultdict(collections.Counter)
    phase = "work"
    open_tools = {}
    idle = 0.0
    last_t = None
    for i, (t, kind, p) in enumerate(events):
        if last_t is not None:
            gap = (t - last_t).total_seconds()
            if kind == "human" or gap > GAP_CAP:
                idle += gap; cat = None
            elif open_tools:
                cats = sorted(tool_category(n, i_) for (_, n, i_) in open_tools.values())
                cat = [c for c in cats if c not in ("agent-spawn", "skill-load")]
                cat = cat[0] if cat else "main:llm"
            elif kind == "agent_done":
                a = agents.get(p)
                cat = "wait:" + (a["cat"] if a else "agent:?")
            else:
                cat = "main:llm"
            if cat:
                main[cat] += gap; phase_time[phase] += gap; phase_break[phase][cat] += gap
                if cat == "main:llm":
                    lbl = llm_next_label(events, i)
                    llm_split[lbl] += gap; phase_llm[phase][lbl] += gap
        if kind == "human":
            phase = "work"
        elif kind == "tool_use":
            tid, name, inp = p
            open_tools[tid] = (t, name, inp)
            if name == "Skill" and inp.get("skill", "").split(":")[-1] in PHASE_SKILLS:
                phase = "skill:" + inp.get("skill", "").split(":")[-1]
        elif kind == "tool_result":
            tid, name, inp, t0 = p
            open_tools.pop(tid, None)
            if name in ("Bash", "PowerShell"):
                g = (t - t0).total_seconds()
                if g <= GAP_CAP: slow_main.append((g, tool_category(name, inp), (inp.get("command") or "")[:110].replace("\n", " ")))
        last_t = t

    ts_all = [e[0] for e in events]
    return {"sid": sid, "path": path,
            "start": min(ts_all) if ts_all else None, "end": max(ts_all) if ts_all else None,
            "active": sum(main.values()), "idle": idle,
            "main": main, "phase_time": phase_time, "phase_break": phase_break,
            "agents": agents, "cost": cost, "slow_main": slow_main,
            "llm_split": llm_split, "phase_llm": phase_llm,
            "n_prompts": sum(1 for e in events if e[1] == "human")}

REVIEW_KINDS = [
    ("gate 2.3b Standards+Spec", re.compile(r"2\.3b|standards|spec review|spec axis|spec-axis|standards\+spec|standards \+ spec", re.I)),
    ("L2 bug-pattern", re.compile(r"bug-pattern|L2", re.I)),
    ("fresh/independent diff review", re.compile(r"fresh|independent|независим|свеж|diff review|ревью дифф|review .*diff|review diff", re.I)),
    ("PR/release review", re.compile(r"\bPR\b|release|MR", re.I)),
    ("verify/sanity", re.compile(r"verify|sanity|верифи|проверь", re.I)),
]
TEST_KINDS = [
    ("red repro", re.compile(r"red|repro|репро", re.I)),
    ("e2e/parity/attest", re.compile(r"e2e|parity|attest|pair run|scenario|playwright|screenshot", re.I)),
    ("mutation", re.compile(r"mutation|мутац", re.I)),
    ("spec", re.compile(r"spec", re.I)),
]

def kind_of(desc, kinds):
    for k, rx in kinds:
        if rx.search(desc or ""): return k
    return "other"

def fmt(s): return f"{s/60:6.1f}m"

def main():
    files = []
    for p in glob.glob(os.path.join(ROOT, "*", "*.jsonl")):
        if SELF_SESSION and SELF_SESSION in p: continue
        st = os.stat(p)
        if datetime.fromtimestamp(st.st_mtime, timezone.utc) < CUTOFF or st.st_size < MIN_KB * 1024: continue
        files.append(p)
    files.sort(key=lambda p: os.stat(p).st_mtime, reverse=True)
    print(f"Сессий за {DAYS} дн. (>{MIN_KB}KB): {len(files)}, кап гэпа {GAP_CAP//60} мин\n")

    agg_main = collections.Counter(); agg_phase = collections.Counter()
    agg_phase_break = collections.defaultdict(collections.Counter)
    agg_agent_wall = collections.Counter(); agg_agent_n = collections.Counter()
    agg_agent_inner = collections.defaultdict(collections.Counter)
    slow_all = []
    total_active = 0.0
    rows = []
    gate_sessions = []
    agg_llm = collections.Counter(); agg_phase_llm = collections.defaultdict(collections.Counter)
    rev_kind_wall = collections.Counter(); rev_kind_n = collections.Counter()
    test_kind_wall = collections.Counter(); test_kind_n = collections.Counter()
    spec_test_time = 0.0; spec_test_runs = 0; spec_mut = 0; spec_n = 0; spec_build_time = 0.0
    for p in files:
        s = analyze_session(p)
        if not s["start"]: continue   # в окне ни одного события — файл жив, но сессия старая
        total_active += s["active"]
        agg_main.update(s["main"]); agg_phase.update(s["phase_time"])
        agg_llm.update(s["llm_split"])
        for ph, c in s["phase_llm"].items(): agg_phase_llm[ph].update(c)
        for ph, c in s["phase_break"].items(): agg_phase_break[ph].update(c)
        for aid, a in s["agents"].items():
            if a["sub"]:
                agg_agent_wall[a["cat"]] += a["sub"]["dur"]; agg_agent_n[a["cat"]] += 1
                agg_agent_inner[a["cat"]].update(a["sub"]["cats"])
                slow_all.extend((g, c, "[" + (a["subtype"] or "?") + "] " + cmd) for g, c, cmd in a["sub"]["slow"])
                if a["cat"] == "agent:review":
                    k = kind_of(a["desc"], REVIEW_KINDS); rev_kind_wall[k] += a["sub"]["dur"]; rev_kind_n[k] += 1
                if a["cat"] == "agent:test-expert":
                    k = kind_of(a["desc"], TEST_KINDS); test_kind_wall[k] += a["sub"]["dur"]; test_kind_n[k] += 1
                if a["cat"] == "agent:specialist":
                    spec_n += 1
                    spec_test_time += a["sub"]["cats"].get("bash:tests", 0); spec_test_runs += a["sub"]["ntools"].get("bash:tests", 0)
                    spec_build_time += a["sub"]["cats"].get("bash:build", 0)
                    if a["sub"]["mutation"]: spec_mut += 1
        slow_all.extend((g, c, "[main] " + cmd) for g, c, cmd in s["slow_main"])
        proj = re.sub(r"^[A-Za-z]--Users-[^-]+-", "", os.path.basename(os.path.dirname(p)))
        rows.append((s, proj))
        if s["phase_time"].get("skill:task-gate", 0) > 0:
            gate_sessions.append((s, proj))

    print("=== ПО СЕССИЯМ (active = сумма интервалов без idle) ===")
    for s, proj in rows:
        ph = s["phase_time"]
        ag = collections.Counter()
        for a in s["agents"].values():
            if a["sub"]: ag[a["cat"]] += a["sub"]["dur"]
        cost = s["cost"] or {}
        print(f"\n[{s['sid'][:8]}] {proj[:58]}  {s['start']:%m-%d %H:%M}→{s['end']:%m-%d %H:%M}  active={fmt(s['active'])} prompts={s['n_prompts']} cost=${cost.get('totalCostUSD',0):.0f}")
        print("  фазы: " + ", ".join(f"{k}={fmt(v)}" for k, v in ph.most_common()))
        print("  main: " + ", ".join(f"{k}={fmt(v)}" for k, v in s["main"].most_common(7)))
        if ag: print("  agents(wall): " + ", ".join(f"{k}={fmt(v)}(n={sum(1 for a in s['agents'].values() if a['sub'] and a['cat']==k)})" for k, v in ag.most_common()))
        for aid, a in sorted(s["agents"].items(), key=lambda kv: -(kv[1]["sub"]["dur"] if kv[1]["sub"] else 0))[:5]:
            if a["sub"]:
                inner = ", ".join(f"{k}={fmt(v)}" for k, v in a["sub"]["cats"].most_common(3))
                print(f"    - {a['cat']:20s} {fmt(a['sub']['dur'])} turns={a['sub']['turns']:3d} [{a['subtype']}] {str(a['desc'])[:48]} | {inner}")

    print("\n\n=== АГРЕГАТ ===")
    print(f"active всего: {fmt(total_active)}  ({total_active/3600:.1f} ч)")
    print("\nMain-thread критический путь (что блокировало главного):")
    for k, v in agg_main.most_common(22):
        print(f"  {k:34s} {fmt(v)}  {100*v/max(total_active,1):5.1f}%")
    print("\nФазы по Skill-маркерам (work → task-gate → commit/Step6):")
    for k, v in agg_phase.most_common():
        print(f"  {k:34s} {fmt(v)}  {100*v/max(total_active,1):5.1f}%")
        for k2, v2 in agg_phase_break[k].most_common(8):
            print(f"      {k2:32s} {fmt(v2)}")
    print("\nmain:llm — куда шёл главный после генерации (весь период):")
    for k, v in agg_llm.most_common(18):
        print(f"  {k:36s} {fmt(v)}  {100*v/max(agg_main['main:llm'],1):5.1f}%")
    for ph in ("skill:task-gate", "skill:commit"):
        print(f"\nmain:llm внутри {ph}:")
        for k, v in agg_phase_llm[ph].most_common(12):
            print(f"  {k:36s} {fmt(v)}")

    print("\nReview-агенты по виду (wall, n, avg):")
    for k, v in rev_kind_wall.most_common():
        print(f"  {k:32s} {fmt(v)} n={rev_kind_n[k]:3d} avg={fmt(v/rev_kind_n[k])}")
    print("\nTest-expert по виду (wall, n, avg):")
    for k, v in test_kind_wall.most_common():
        print(f"  {k:32s} {fmt(v)} n={test_kind_n[k]:3d} avg={fmt(v/test_kind_n[k])}")
    print(f"\nСпециалисты: n={spec_n}, tests внутри={fmt(spec_test_time)} runs={spec_test_runs}, build внутри={fmt(spec_build_time)}, с упоминанием мутации={spec_mut} ({100*spec_mut/max(spec_n,1):.0f}%)")

    print("\nСубагенты — wall-time по категориям (параллельно с главным):")
    for k, v in agg_agent_wall.most_common():
        n = agg_agent_n[k]
        inner = ", ".join(f"{k2}={fmt(v2)}" for k2, v2 in agg_agent_inner[k].most_common(5))
        print(f"  {k:24s} {fmt(v)}  n={n:3d}  avg={fmt(v/n)}  | {inner}")

    print("\nTask-gate: длительность фазы по сессиям (gate + Step 6 commit):")
    gs = sorted(gate_sessions, key=lambda x: -x[0]["phase_time"].get("skill:task-gate", 0))
    if not gs:
        print("  сессий с gate: 0")
    else:
        gd = sorted(s["phase_time"].get("skill:task-gate", 0) for s, _ in gs)
        cd = sorted(s["phase_time"].get("skill:commit", 0) for s, _ in gs)
        nrev = [sum(1 for a in s["agents"].values() if a["cat"] == "agent:review") for s, _ in gs]
        print(f"  сессий с gate: {len(gs)}; gate median={fmt(gd[len(gd)//2])} p75={fmt(gd[int(len(gd)*0.75)])} mean={fmt(sum(gd)/len(gd))}; step6 median={fmt(cd[len(cd)//2])}; review-агентов/сессию mean={sum(nrev)/len(nrev):.1f}")
    for s, proj in gs:
        pt = s["phase_time"]
        br = s["phase_break"]["skill:task-gate"]
        rev = sum(v for a in s["agents"].values() if a["sub"] and a["cat"] == "agent:review" for v in [a["sub"]["dur"]])
        nrev = sum(1 for a in s["agents"].values() if a["cat"] == "agent:review")
        print(f"  [{s['sid'][:8]}] {proj[:34]:34s} gate={fmt(pt.get('skill:task-gate',0))} step6={fmt(pt.get('skill:commit',0))} work={fmt(pt.get('work',0))} | in-gate: " + ", ".join(f"{k}={fmt(v)}" for k, v in br.most_common(4)) + f" | review-agents n={nrev} wall={fmt(rev)}")

    print("\nСамые долгие Bash-вызовы (main + субагенты), топ-40:")
    for g, c, cmd in sorted(slow_all, key=lambda x: -x[0])[:40]:
        print(f"  {fmt(g)} {c:16s} {cmd}")

    print("\nBash по категориям (main + субагенты), суммарно:")
    bc = collections.Counter(); bn = collections.Counter()
    for g, c, cmd in slow_all: bc[c] += g; bn[c] += 1
    for k, v in bc.most_common():
        print(f"  {k:18s} {fmt(v)} n={bn[k]}")

if __name__ == "__main__":
    main()
