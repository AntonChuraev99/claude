# Contributing

This is a personal Claude Code harness that other people install from GitHub. Changes reach
`main` only through a pull request — for the author too. Nobody pushes to `main` directly.

## Found a bug, can't fix it now

Open an [issue](https://github.com/AntonChuraev99/claude/issues/new/choose) with the **Bug report**
template and the `bug` label. Include:

- what you ran or which hook/agent/skill fired;
- what you expected and what happened instead — exact error text or hook output;
- OS, shell (PowerShell / Git Bash), Claude Code version (`claude --version`).

Issues are public: replace home paths, project names, keys and IDs in logs before pasting.

An idea or a deferred improvement goes the same way with the **Feature request** template and
the `enhancement` label. A `// TODO` or a note in chat is not a substitute: if it is not an
issue, it is lost.

## Want to change something

1. Fork the repo (or create a branch if you have write access). Never commit to `main`.
2. Branch name: any descriptive slug, e.g. `fix/statusline-width` (Claude Code worktrees create
   `worktree-<slug>` — that is fine too).
3. Make the change. A new file is invisible to git until you add a `!` rule to `.gitignore`
   — the ignore file is a whitelist on purpose.
4. Commit in [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) format:
   `feat(skills): …`, `fix(hooks): …`.
5. Open a pull request against `main` and fill in the template. Link the issue it closes
   (`Closes #N`).
6. The PR is squash-merged after review.

## Rules for every change

- **No private data.** Project and app names → `<your-project>`, `com.example.*`; home paths →
  `~/...` or `YOUR_USERNAME`; keys, tokens, numeric project IDs → placeholders. Machine-local
  values live in gitignored `config/*.local.*`, copied from `*.example.*`.
- **Do not bypass the pre-commit hook** (`--no-verify`). If it blocks a commit, remove the
  private value from the staged files and add them again.
- **A change to `CLAUDE.md`, `rules/`, `agents/`, `skills/`, `model-overlays/` or
  `settings.example.json` ships with a record in `improvements/`** — template and required fields
  are in [`improvements/README.md`](improvements/README.md).
- **`CLAUDE.md` must not grow.** The budget is 200 lines and 37 000 characters, and the file is at
  the limit: a change that adds text removes as much elsewhere. A procedure goes into a skill, a
  rule tied to file types into `rules/` with `paths:` — see `skills/instruction-routing`.
- **Third-party skills are not accepted** into the repo: they install from their own
  marketplaces.

Prose in the harness is mostly Russian. Issues and PRs in English or Russian are both fine.
