---
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*)
description: Create a Conventional Commits compliant git commit
---

# Commit Command

Create a git commit following Conventional Commits specification.

## Steps

1. Run `git status` to see changes
2. Run `git diff --staged` to see staged changes (if any)
3. Run `git diff` to see unstaged changes
4. Run `git log --oneline -5` to see recent commit style
5. Analyze changes and determine:
   - **type**: feat, fix, refactor, perf, docs, style, test, chore, build, ci
   - **scope**: affected module/component (optional)
   - **description**: short imperative description
6. Stage files with `git add` if needed
7. Create commit with format: `<type>(<scope>): <description>`

## Format Rules

- Max 50 chars for description
- No period at end
- Imperative mood (add, fix, update)
- Lowercase type and scope
- No "Co-Authored-By" trailer

## Examples

```
feat(auth): add password reset flow
fix(catalog): resolve image loading crash
refactor(data): simplify repository pattern
perf(exoplayer): cache video frames
docs: update API documentation
```

If user provides arguments, use them as commit description hint.
