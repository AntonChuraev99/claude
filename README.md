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
| `CLAUDE.md` | The global system prompt — task classification, a Prompt Contract, delegation rules tuned for Opus 4.x, git/commit policy, documentation workflow. The core of the setup. |
| `agents/` | 12 specialist subagents (see below). |
| `skills/` | 15 authored skills (see below). |
| `commands/` | 6 slash commands. |
| `output-styles/anti-slop-ru.md` | An output style that strips "AI slop" tells from Russian prose. |
| `*.ps1`, `statusline.sh`, `*.vbs` | Hook & status-line scripts wired up in `settings.example.json`. |
| `references/` | Long-form reference docs the skills/commands point to. |
| `settings.example.json` | Template for `~/.claude/settings.json` (hooks, permissions, plugins, status line). Copy it, fill in your key, drop the `.example`. |
| `config/*.example.md` | Templates for machine-local skill config (copy to `*.local.md`, which stays gitignored). |

### Subagents (`agents/`)

`compose-feature-expert`, `android-platform-expert`, `kmp-expert`, `kotlin-expert`,
`nextjs-expert`, `react-ui-expert`, `wasmjs-expert`, `design-expert`, `test-expert`,
`doc-writer`, `knowledge-scout`, `best-practices-scout`. Domain specialists plus two
"scout" agents that read docs / the web on the main agent's behalf to keep its context
clean.

### Skills (`skills/`)

`commit`, `end-session`, `git-commit-conventions`, `git-worktree-env`,
`gradle-deps-update`, `android-core-module-builder`, `android-feature-module-builder`,
`ab-test-dashboard`, `amplitude-slack-payload`, `cloudflare-deploy-slack-notify`,
`gitlab-release-slack-ci`, `jira-task-writer`, `test-firebase-function`,
`turnstile-spin`, `stop-slop-ru`.

> Installed third-party skills (official Google Android, Cloudflare, Anthropic, etc.) are
> **not** included — they are their authors' IP and install from their own marketplaces.

## Layout

```
.claude/
├── CLAUDE.md                  # global system prompt
├── settings.example.json      # → copy to settings.json
├── agents/                    # 12 subagents
├── skills/                    # 15 authored skills
├── commands/                  # 6 slash commands
├── output-styles/
├── references/
├── config/                    # *.example.md templates → *.local.md
├── notify.ps1                 # Windows toast notifications (Stop / Notification hooks)
├── statusline.sh              # status line (model · branch · context · cost · device)
├── session-docs-digest.ps1    # SessionStart: digest of in-progress / deferred task docs
├── graphify-pretool.ps1       # PreToolUse: nudge toward the knowledge graph over grep
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
