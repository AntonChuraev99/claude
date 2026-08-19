# Claude Code Configuration

My personal global configuration for [Claude Code](https://claude.com/claude-code) — the
system prompt, subagents, skills, hooks, slash commands and output style I use every day.
Published so others can borrow patterns. Fork it and adapt to your own workflow.

> **This is a personal setup, not a turnkey product.** It is opinionated, Windows-first
> (PowerShell hooks), and most of the prose is in **Russian** (the author's working
> language). Every project-specific value has been replaced with a placeholder
> (`<your-project>`, `YOUR_USERNAME`, `YOUR_*`, `com.example.*`) — search for those and
> substitute your own before relying on a file.

## What's inside

| Path | What it is |
|------|------------|
| `CLAUDE.md` | The global system prompt — the main agent's operating mode (research → plan → delegate → verify), a Prompt Contract, git/commit policy, Definition of Done. Kept under 200 lines on purpose; everything procedural lives in skills or path-scoped rules. |
| `rules/` | Path-scoped rules (`paths:` frontmatter) that load only when Claude touches matching files — `docs/**`, `*.kt`, etc. Zero context cost until they match. |
| `agents/` | 15 specialist subagents (see below). Authored against the `subagent-authoring` skill. |
| `skills/` | Authored skills: domain workflows plus the process skills migrated out of `CLAUDE.md` (see below). |
| `commands/` | 6 slash commands. |
| `*.ps1`, `statusline.py`, `*.sh`, `*.vbs` | Hook & status-line scripts wired up in `settings.example.json`. |
| `references/` | Long-form reference docs the skills/commands point to. |
| `settings.example.json` | Template for `~/.claude/settings.json` (hooks, permissions, plugins, status line). Copy it, fill in your key, drop the `.example`. |
| `config/*.example.{md,json}` | Templates for machine-local config (copy to `*.local.*`, which stays gitignored): per-project credentials and the protected-branch registry. |
| `hooks/` | Hooks wired up in `settings.example.json`: `credentials-guard` (deploy with the wrong account), `protected-branch-guard` (writing code straight onto `main`/`develop` instead of a branch + MR), `ensure-worktree-guard`, `model-overlay`, `credentials-digest`, `session-docs-digest`, `claude-md-size-guard`. Hooks that print to the terminal share one output shape — see `lib/hookout.py`. |
| `lib/` | Shared by the status line and the hooks: `term.py` (console width, display width, truncation) and `hookout.py` (the common SessionStart output shape). Required — a clone without it has a broken status line and silent hooks. |
| `scripts/` | Diagnostics you run by hand — not wired to any hook or event. `mem-report.ps1` breaks RAM down by group and names what is redundant (duplicate JVM daemons, MCP servers spawned per session), measuring commit rather than working set. |

### Subagents (`agents/`)

`compose-feature-expert`, `android-platform-expert`, `kmp-expert`, `kotlin-expert`,
`nextjs-expert`, `react-ui-expert`, `wasmjs-expert`, `design-expert`, `test-expert`,
`doc-writer`, `knowledge-scout`, `best-practices-scout`. Domain specialists plus two
"scout" agents that read docs / the web on the main agent's behalf to keep its context
clean.

### Skills (`skills/`)

**Process skills** — deliberately only three. A skill earns its place when it is needed rarely,
carries commands the model can't guess, and isn't already covered by an agent `description`, a
plugin skill, or a condensed rule in `CLAUDE.md`: `instruction-routing` (where a new instruction
belongs — CLAUDE.md vs rules vs skill vs hook), `subagent-authoring` (how to write and review a
subagent), `claude-profiles` (multi-account profiles, linking rules, and the per-project
credential registry that guards against deploying with another project's account).

**Workflow skills:** `commit`, `task-gate` (per-task Definition of Done gate; formerly
`end-session`), `git-commit-conventions`, `git-worktree-env`, `gradle-deps-update`,
`android-core-module-builder`, `android-feature-module-builder`, `ab-test-dashboard`,
`amplitude-slack-payload`, `cloudflare-deploy-slack-notify`, `gitlab-release-slack-ci`,
`jira-task-writer`, `test-firebase-function`, `turnstile-spin`.

> Installed third-party skills (official Google Android, Cloudflare, Anthropic, etc.) are
> **not** included — they are their authors' IP and install from their own marketplaces.

## Layout

```
.claude/
├── CLAUDE.md                  # global system prompt (< 200 lines)
├── settings.example.json      # → copy to settings.json
├── rules/                     # path-scoped rules, loaded on matching file access
├── agents/                    # 15 subagents
├── skills/                    # authored skills (process + workflow)
├── commands/                  # 6 slash commands
├── references/
├── config/                    # *.example.md templates → *.local.md
├── hooks/                     # hook scripts (SessionStart / PreToolUse / PostToolUse / Stop)
│   ├── session-docs-digest.py # SessionStart: digest of in-progress / deferred / backlog task docs
│   └── claude-md-size-guard.py # SessionStart: warns when a CLAUDE.md passes 200 lines
├── lib/                       # shared by the status line and the hooks
│   ├── term.py                # console width, display width, truncation, ANSI
│   └── hookout.py             # one output shape for every hook that prints
├── notify.ps1                 # Windows toast notifications (Stop / Notification hooks)
├── scripts/                   # hand-run diagnostics, not wired to any event
│   └── mem-report.ps1         # RAM breakdown by group + what is redundant
├── statusline.py              # status line (branch · context · cost · RAM · device · state · task)
├── statusline-adb.sh          # detached ADB device probe feeding the status line
├── statusline.sh              # shim → statusline.py (for sessions started before the switch)
├── doc-writer-update-reminder.ps1
├── toast-action.ps1 / .vbs    # toast button actions (open folder / focus terminal)
└── LICENSE
```

## Install

Pick what you want — there is no need to take everything.

1. **Cherry-pick.** Copy individual `agents/*.md`, `skills/<name>/`, or `commands/*.md`
   into your own `~/.claude/`. Each is self-contained.
2. **Whole config.** Clone into `~/.claude/` (back up your existing one first), then:
   - Copy `settings.example.json` → `settings.json` and set `CONTEXT7_API_KEY`
     (or remove the `env` block).
   - In `settings.json`, replace `YOUR_USERNAME` in every hook/status-line path with your
     real home path (PowerShell does not expand `~` inside hook commands).
   - On non-Windows, port the PowerShell hooks or drop them — they are optional.

## Customization

- Replace placeholders everywhere: `<your-project>`, `com.example.*`, `YOUR_*`,
  `myapp://`, `YOUR_USERNAME`.
- Skills that need workspace-specific values (e.g. `ab-test-dashboard`) read them from a
  gitignored `config/*.local.md` — copy the matching `*.example.md` and fill it in.
- `CLAUDE.md` is heavily tailored to my stack (Android/KMP + Next.js). Keep the structure,
  swap the specifics.

## Security model

Secrets and private data never enter git, by construction. `.gitignore` is a **whitelist**:
it ignores everything (`*`) and then re-includes only the files meant for publication.
Anything not explicitly allow-listed — `.credentials.json`, the real `settings.json`,
`projects/` transcripts, `history.jsonl`, logs, `agent-memory/`, `stats/`, `plugins/` —
is structurally impossible to commit, even by accident. Adding a new file to the repo
requires a new `!` rule on purpose.

If you fork this, run a secret scanner (e.g. `gitleaks detect`) before your first push.

## Keeping the repo clean (anti-leak hook)

Because the working files *are* the published files, everyday edits can quietly
reintroduce private names or secrets. A pre-commit hook guards against that. To
enable it in your clone:

```bash
cp hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
# then edit the denylist in .git/hooks/pre-commit with your own private names
```

It scans staged content against a denylist (project names, personal paths,
secret patterns) and aborts the commit on a match. The live hook lives in
`.git/hooks/` and is never tracked, so your real denylist stays local. Install
[gitleaks](https://github.com/gitleaks/gitleaks) for deeper secret scanning —
the hook runs it automatically if it's on your `PATH`.

## License

[MIT](LICENSE) © 2026 Anton Churaev

## Author

GitHub: [@AntonChuraev99](https://github.com/AntonChuraev99)
