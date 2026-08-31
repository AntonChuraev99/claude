#!/usr/bin/env python3
"""Rollup + effectiveness analysis for the bug-pattern review system.

Reads the L1/L2/L3 event log (stats/review-rules-events.jsonl), correlates it with
the rule registry, and writes a human-readable digest to stats/review-rules.md:

  - ## Counters   — L1 runs/blocks by entry, L2 invocations, L3 armed process-gates.
  - ## Per-rule   — fires / blocks / confirmed / dismissed / est-FP / last-fired,
                    so dead (never-fired) and noisy (mostly-dismissed) rules are
                    visible for pruning.
  - ## Выводы     — auto narrative on whether the system earns its keep (the section
                    a future usefulness-evaluation reads). Uses a git-free true-catch
                    heuristic: a static-HIGH that fired then VANISHED from a project's
                    latest L1 event = likely fixed (the gate caught a real bug);
                    one that persists = likely false-positive or intentional.

Usage: python stats.py [--log PATH] [--out PATH]  (defaults to the standard paths)
No API cost; safe to run on every /task-gate.
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys
from collections import defaultdict
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

HERE = Path(__file__).resolve().parent
DEFAULT_LOG = HERE.parent / "stats" / "review-rules-events.jsonl"
DEFAULT_OUT = HERE.parent / "stats" / "review-rules.md"


def load_events(path: str) -> list[dict]:
    events: list[dict] = []
    p = Path(path)
    if not p.exists():
        return events
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def registry_ids() -> dict[str, dict]:
    """All rule ids in the registry -> {area, mode, sev}. Empty if PyYAML absent."""
    try:
        import yaml
    except ImportError:
        return {}
    out: dict[str, dict] = {}
    for yml in sorted(HERE.glob("*.yaml")):
        if yml.name == "manifest.yaml":
            continue
        try:
            data = yaml.safe_load(yml.read_text(encoding="utf-8")) or []
        except yaml.YAMLError:
            continue
        for r in data:
            if isinstance(r, dict) and r.get("id"):
                out[r["id"]] = {
                    "area": yml.stem,
                    "mode": r.get("mode", "static"),
                    "sev": r.get("severity", ""),
                    # narrowed_since (YYYY-MM-DD) — когда детектор последний раз сужали.
                    # Статистика до этой даты относится к старому детектору: прополка обязана
                    # судить правило по его нынешней форме, а не по той, которую уже починили.
                    "narrowed_since": str(r.get("narrowed_since") or ""),
                }
    return out


def analyze(events: list[dict], registry: dict[str, dict]) -> dict:
    l1 = [e for e in events if e.get("layer") == "L1"]
    l2 = [e for e in events if e.get("layer") == "L2"]
    l3 = [e for e in events if e.get("layer") == "L3"]

    by_entry: dict[str, int] = defaultdict(int)
    for e in l1:
        by_entry[e.get("entry", "?")] += 1

    fires: dict[str, int] = defaultdict(int)
    rblocks: dict[str, int] = defaultdict(int)
    last_fired: dict[str, str] = {}
    for e in l1:
        ts = e.get("ts", "")
        for r in e.get("rules", []):
            rid = r.get("id")
            if not rid:
                continue
            fires[rid] += 1
            if r.get("mode") == "static" and r.get("sev") == "high":
                rblocks[rid] += 1
            if rid not in last_fired or ts > last_fired[rid]:
                last_fired[rid] = ts

    # true-catch heuristic over each project's L1 timeline
    proj_events: dict[str, list] = defaultdict(list)
    for e in l1:
        proj_events[e.get("project", "?")].append(e)
    true_catch = 0
    persisted = 0
    for evs in proj_events.values():
        evs_sorted = sorted(evs, key=lambda x: x.get("ts", ""))
        if len(evs_sorted) < 2:
            continue
        latest = evs_sorted[-1]
        latest_keys = {
            (r.get("id"), r.get("file"))
            for r in latest.get("rules", [])
            if r.get("mode") == "static" and r.get("sev") == "high"
        }
        ever_keys: set = set()
        for e in evs_sorted[:-1]:
            for r in e.get("rules", []):
                if r.get("mode") == "static" and r.get("sev") == "high":
                    ever_keys.add((r.get("id"), r.get("file")))
        for k in ever_keys:
            if k in latest_keys:
                persisted += 1
            else:
                true_catch += 1

    confirmed: dict[str, int] = defaultdict(int)
    dismissed: dict[str, int] = defaultdict(int)
    for e in l2:
        for j in e.get("judged", []):
            rid = j.get("id")
            if j.get("verdict") == "confirmed":
                confirmed[rid] += 1
            elif j.get("verdict") == "dismissed":
                dismissed[rid] += 1

    armed: dict[str, int] = defaultdict(int)
    for e in l2 + l3:
        for a in e.get("armed", []):
            armed[a] += 1

    # Post-narrow counters: for a rule carrying `narrowed_since`, everything logged BEFORE that
    # date describes the OLD detector and says nothing about the narrowed one. Weeding must not
    # judge a rule on statistics its current form never produced.
    since = {rid: m["narrowed_since"] for rid, m in registry.items() if m.get("narrowed_since")}
    fires_since: dict[str, int] = defaultdict(int)
    conf_since: dict[str, int] = defaultdict(int)
    dism_since: dict[str, int] = defaultdict(int)
    for e in l1:
        ts = e.get("ts", "")
        for r in e.get("rules", []):
            rid = r.get("id")
            if rid in since and ts >= since[rid]:
                fires_since[rid] += 1
    for e in l2:
        ts = e.get("ts", "")
        for j in e.get("judged", []):
            rid = j.get("id")
            if rid not in since or ts < since[rid]:
                continue
            if j.get("verdict") == "confirmed":
                conf_since[rid] += 1
            elif j.get("verdict") == "dismissed":
                dism_since[rid] += 1

    return {
        "since": since,
        "fires_since": dict(fires_since),
        "confirmed_since": dict(conf_since),
        "dismissed_since": dict(dism_since),
        "l1_runs": len(l1), "l2_runs": len(l2), "l3_runs": len(l3),
        "blocks": sum(1 for e in l1 if e.get("blocked")),
        "by_entry": dict(by_entry),
        "fires": dict(fires), "rblocks": dict(rblocks), "last_fired": last_fired,
        "true_catch": true_catch, "persisted": persisted,
        "confirmed": dict(confirmed), "dismissed": dict(dismissed),
        "armed": dict(armed),
        "projects": sorted(proj_events.keys()),
    }


def render(a: dict, registry: dict[str, dict], now: str) -> str:
    L = []
    L.append("# Bug-pattern review — effectiveness rollup")
    L.append("")
    L.append(f"_Last updated: {now}_ · авто-генерируется `review-rules/stats.py` из `review-rules-events.jsonl`.")
    L.append("")

    if a["l1_runs"] == 0:
        L.append("Событий пока нет — система ещё не отработала ни одной сессии. "
                 "Stop-хук залогирует L1 при первом же diff с изменениями.")
        return "\n".join(L) + "\n"

    # Counters
    L.append("## Counters")
    L.append("")
    L.append(f"- **L1**: {a['l1_runs']} прогонов, {a['blocks']} блокировок (static-HIGH). "
             f"Проекты: {', '.join(a['projects']) or '—'}.")
    if a["by_entry"]:
        ent = ", ".join(f"{k}={v}" for k, v in sorted(a["by_entry"].items()))
        L.append(f"  - по entry: {ent}")
    l2conf = sum(a["confirmed"].values())
    l2dis = sum(a["dismissed"].values())
    L.append(f"- **L2**: {a['l2_runs']} вызовов · {l2conf} confirmed / {l2dis} dismissed.")
    L.append(f"- **L3**: {sum(a['armed'].values())} armed process-вопросов "
             f"({len([x for x in a['armed'] if a['armed'][x]])} разных).")
    L.append("")

    # Per-rule
    L.append("## Per-rule")
    L.append("")
    L.append("| rule | area | mode | fires | blocks | conf | dism | est-FP | last |")
    L.append("|---|---|---|--:|--:|--:|--:|--:|---|")
    seen = set(a["fires"]) | set(a["confirmed"]) | set(a["dismissed"])
    for rid in sorted(seen, key=lambda r: -a["fires"].get(r, 0)):
        meta = registry.get(rid, {})
        conf = a["confirmed"].get(rid, 0)
        dism = a["dismissed"].get(rid, 0)
        fp = f"{dism / (conf + dism) * 100:.0f}%" if (conf + dism) else "—"
        last = a["last_fired"].get(rid, "—")[:10]
        L.append(f"| {rid} | {meta.get('area', '?')} | {meta.get('mode', '?')} | "
                 f"{a['fires'].get(rid, 0)} | {a['rblocks'].get(rid, 0)} | {conf} | {dism} | {fp} | {last} |")
    L.append("")

    # dead rules
    dead = sorted(rid for rid in registry if rid not in a["fires"])
    if dead:
        L.append(f"**Никогда не срабатывали ({len(dead)}/{len(registry)}):** "
                 f"{', '.join(dead)}. Кандидаты на проверку актуальности (либо область просто не трогали).")
        L.append("")

    # Прополка — кандидаты по порогу (docs/backlog/review-rules-noise-reduction.md)
    WEED_FIRES, WEED_FP, WEED_JUDGED = 200, 90.0, 3
    since = a.get("since", {})
    weeds, cooling, noisy_after = [], [], []
    for rid in sorted(a["fires"], key=lambda r: -a["fires"].get(r, 0)):
        meta = registry.get(rid, {})
        narrowed = since.get(rid)
        if narrowed:
            # Судим только по тому, что правило нафайрило в нынешней форме.
            fires = a["fires_since"].get(rid, 0)
            conf = a["confirmed_since"].get(rid, 0)
            dism = a["dismissed_since"].get(rid, 0)
        else:
            fires = a["fires"].get(rid, 0)
            conf = a["confirmed"].get(rid, 0)
            dism = a["dismissed"].get(rid, 0)
        judged = conf + dism
        if a["rblocks"].get(rid, 0):
            continue
        if fires < WEED_FIRES or judged < WEED_JUDGED:
            # Сужённое правило судить по FP нечем: L2 поднимается только находкой `static`
            # (task-gate 2.9), а сужают почти всегда `runtime` — суждений оно больше не набирает.
            # Поэтому у сужённых второй, независимый от L2 критерий: ОБЪЁМ срабатываний.
            # Сузили и всё равно ≥порога фаеров — сужение не сработало, это видно без вердиктов.
            if narrowed and a["fires"].get(rid, 0) >= WEED_FIRES:
                bucket = noisy_after if fires >= WEED_FIRES else cooling
                bucket.append((rid, meta.get("area", "?"), narrowed, fires, judged))
            continue
        fp = dism / judged * 100
        if fp < WEED_FP:
            continue
        weeds.append((rid, meta.get("area", "?"), fires, conf, dism, fp, narrowed))

    L.append("## Прополка — кандидаты на пересмотр")
    L.append("")
    L.append(f"_Порог: ≥{WEED_FIRES} срабатываний, 0 блокировок, ≥{WEED_JUDGED} суждений L2, est-FP ≥{WEED_FP:.0f}%. "
             "У правила с `narrowed_since` считается только то, что оно нафайрило ПОСЛЕ сужения._")
    L.append("")
    if not weeds:
        L.append("Кандидатов нет — правила либо блокируют, либо не набрали статистики в нынешней форме.")
    else:
        L.append("| rule | area | fires | conf | dism | est-FP | сужалось |")
        L.append("|---|---|--:|--:|--:|--:|---|")
        for rid, area, fires, conf, dism, fp, narrowed in weeds:
            L.append(f"| {rid} | {area} | {fires} | {conf} | {dism} | {fp:.0f}% | {narrowed or '**нет**'} |")
        L.append("")
        again = [w for w in weeds if w[6]]
        L.append(f"**{len(weeds)} кандидатов.** По каждому решить: добавить `requires`/`lacks` (контекст, о котором "
                 "правило — README → «Типы детекторов»), сузить `globs`, понизить severity или удалить. "
                 "Сужая, проставить правилу `narrowed_since: 'YYYY-MM-DD'` — иначе следующий прогон снова "
                 "посчитает его по старой статистике.")
        if again:
            L.append("")
            L.append(f"⚠️ **Сужались и снова набрали FP ({len(again)}):** {', '.join(w[0] for w in again)} — "
                     "здесь сужение уже не помогло, следующий шаг удаление, а не третья попытка.")
    if noisy_after:
        L.append("")
        L.append(f"⚠️ **Сужены, но объём не упал ({len(noisy_after)}):** "
                 + ", ".join(f"`{rid}` ({narrowed}: {f} fires после сужения)"
                             for rid, _area, narrowed, f, _j in noisy_after)
                 + f". Порог тот же ≥{WEED_FIRES}, но по **объёму**, а не по FP: вердиктов L2 у "
                   "`runtime`-правил больше нет, и ждать их бессмысленно. Сужение не сработало — "
                   "сужать точнее или удалять.")
    if cooling:
        L.append("")
        L.append(f"_Ждут новых данных после сужения ({len(cooling)}):_ "
                 + ", ".join(f"{rid} ({narrowed}: {f} fires / {j} суждений)"
                             for rid, _area, narrowed, f, j in cooling)
                 + ". Объём срабатываний после сужения упал ниже порога — сужение работает; "
                   "историческая FP относится к старому детектору и в расчёт не идёт.")
    L.append("")

    # Выводы
    L.append("## Выводы")
    L.append("")
    if a["l1_runs"] < 10:
        L.append(f"⏳ **Рано судить** — всего {a['l1_runs']} прогонов L1. Нужно ≥10 для оценки. "
                 "Накапливается автоматически через Stop-хук.")
    else:
        tc, ps = a["true_catch"], a["persisted"]
        if tc + ps:
            L.append(f"- **True-catch (эвристика):** {tc} static-HIGH исчезли из последнего состояния проекта "
                     f"после срабатывания = вероятно реально пойманный баг; {ps} держатся = вероятно FP/намеренно.")
        L.append(f"- **L1:** {a['blocks']} блокировок на {a['l1_runs']} прогонов "
                 f"({a['blocks'] / a['l1_runs'] * 100:.0f}% сессий с блокером).")
        if l2conf + l2dis:
            L.append(f"- **L2 точность:** {l2conf}/{l2conf + l2dis} находок подтверждены "
                     f"(FP-rate {l2dis / (l2conf + l2dis) * 100:.0f}%).")
        noisy = [rid for rid in a["dismissed"]
                 if a["dismissed"][rid] >= 2 and a["confirmed"].get(rid, 0) == 0]
        if noisy:
            L.append(f"- **Шумные (только dismissed, ≥2):** {', '.join(noisy)} — кандидаты на прунинг/уточнение.")
        helped = tc > 0 or a["blocks"] > 0
        L.append("")
        L.append(f"**Вердикт:** {'система ловит реальные повторяющиеся баги — окупается' if helped else 'пока без подтверждённых пойманных багов — наблюдаем'}.")
    L.append("")
    return "\n".join(L) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="Bug-pattern review effectiveness rollup")
    ap.add_argument("--log", default=str(DEFAULT_LOG))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    events = load_events(args.log)
    registry = registry_ids()
    a = analyze(events, registry)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    md = render(a, registry, now)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md, encoding="utf-8")
    print(f"review-rules/stats: wrote {out} ({a['l1_runs']} L1, {a['l2_runs']} L2, {a['l3_runs']} L3 events)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        sys.stderr.write(f"review-rules/stats: error: {exc}\n")
        sys.exit(3)
