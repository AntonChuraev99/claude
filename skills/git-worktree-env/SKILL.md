---
name: git-worktree-env
description: |
  DEPRECATED — superseded by Claude Code's built-in Worktrees feature with `.worktreeinclude` (verified working 2026-05-08 on <your-project>). For new worktrees use `EnterWorktree`, `claude --worktree`, or Agent `isolation: "worktree"`; gitignored files (secrets, keystores, .env, .properties) are copied automatically when `.worktreeinclude` lives in the main worktree root. Triggers on "create worktree", "new worktree", "git worktree", "isolated copy", "parallel branch". The bundled `sync-env.sh` script is kept only as a fallback for manual `git worktree add` outside Claude Code, or projects without `.worktreeinclude`.
---

# git-worktree-env (DEPRECATED)

> **Status:** Deprecated 2026-05-08 in favour of Claude Code's official Worktrees feature.
> **Why:** the official feature does the same job natively (no bash dependency on Windows, auto-cleanup, parallel sessions, hook integration), with the file list version-controlled in the repo via `.worktreeinclude`.
> **Migration verified on:** `<your-project>` (Android/KMP), 2026-05-08 — see `~/.claude/improvements/2026-05-08-git-worktree-env-deprecated.md`.

## Recommended path: official Claude Code Worktrees

### Step 1 — Add `.worktreeinclude` to the main worktree root

The main worktree is the directory that contains a real `.git/` directory (not a `.git` file pointing elsewhere). Run `git rev-parse --git-common-dir` to find it.

```text
# .worktreeinclude — gitignore-style. Files copied into every Claude Code worktree.

# Android signing & secrets
secrets.properties
local.properties
local.defaults.properties
gradle.properties
keystore.properties
signing.properties
*.jks
*.keystore

# Firebase / Google / Huawei services
google-services.json
agconnect-services.json

# Crash & observability
fabric.properties
crashlytics.properties
sentry.properties

# Cross-platform certificates
*.pem
*.key
*.p12
*.mobileprovision

# Environment variables
.env
.env.*
```

This list mirrors the legacy `PATTERNS` array in `scripts/sync-env.sh`.

### Step 2 — Create the worktree

Pick whatever fits the workflow:

- `claude --worktree feature-x` (CLI flag, generates random name if omitted)
- `EnterWorktree` tool from inside an active session
- `isolation: "worktree"` on an `Agent` call or in a subagent's frontmatter

Claude Code creates the worktree under `.claude/worktrees/<name>/`, branching from `origin/<default-branch>` by default (override via `worktree.baseRef: "head"` setting).

### Step 3 — Verify

The build should run without missing-file errors:

```bash
./gradlew :androidApp:assembleDebug   # Android/KMP
npm install && npm run build           # Node.js
```

If something is still missing, add its pattern to `.worktreeinclude` and recreate the worktree.

### Multi-branch worktrees layout (this repo)

This project keeps long-lived worktrees per branch:

```
StudioProjects/
├── <your-project>/        # main worktree, branch `develop`, holds real .git/
├── <your-project>-android/ # worktree, branch `android`
└── <your-project>-web/    # worktree, branch `web`
```

`.worktreeinclude` must live in the **main** worktree (`<your-project>/`). New Claude Code worktrees are always created under `<your-project>/.claude/worktrees/`, regardless of which sibling worktree the session was started from.

To survive a fresh clone, commit `.worktreeinclude` to the default branch (`develop`).

## Fallback path: legacy `sync-env.sh`

Use only when the worktree was created **outside** Claude Code (e.g., manual `git worktree add ../foo bar` or a fresh clone) and you cannot or do not want to add `.worktreeinclude` to the source repo.

```bash
# Dry run
bash <skill-dir>/scripts/sync-env.sh <source-repo> <target-dir> --dry-run

# Copy
bash <skill-dir>/scripts/sync-env.sh <source-repo> <target-dir>

# Verbose
bash <skill-dir>/scripts/sync-env.sh <source-repo> <target-dir> --verbose
```

The script enumerates gitignored entries via `git ls-files --others --ignored --exclude-standard --directory` and filters them by basename against the embedded `PATTERNS` array. Same pattern set as `.worktreeinclude` above, so output is interchangeable.

## Why deprecated

| | Legacy `sync-env.sh` | Official `.worktreeinclude` |
|---|---|---|
| Trigger | manual run after `git worktree add` | automatic on `EnterWorktree` / `--worktree` / Agent isolation |
| Where the list lives | hardcoded in skill (global) | in repo (per-project, version-controlled) |
| Platform | bash (Windows needs Git Bash) | native |
| Cleanup | none | auto if no changes, prompt otherwise |
| Parallel sessions | no awareness | first-class |
| Maintenance | this repo | Anthropic |

## Troubleshooting

**Files in `.worktreeinclude` were not copied to the new worktree.**
The file must be in the **main** worktree root (where `.git/` is a real directory). If you created `.worktreeinclude` inside a nested worktree, move it. Run `git rev-parse --git-common-dir` from your session shell to confirm where the main repo lives.

**The new worktree does not have my latest commits.**
Default `worktree.baseRef` is `fresh` (branches from `origin/<default-branch>`). To branch from your local HEAD instead, set `worktree.baseRef: "head"` in `~/.claude/settings.json`.

**A pattern I need is missing.**
Add it to `.worktreeinclude` (gitignore syntax — `*`, literal names, paths) and recreate the worktree.
