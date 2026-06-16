---
allowed-tools: Bash(git diff:*), Grep, Glob, Read
description: Build Android Studio logcat filter string from debug logs in current changes
---

# Logcat Filter Builder

Build a ready-to-paste Android Studio Logcat filter string from debug log statements in the current git changes.

## Format Rules

Android Studio Logcat (new logcat) filter syntax:
- `tag:TagName` — filter by log tag
- `message:text` — filter by message content
- Entries are **space-separated** (implicit OR)
- **NO** `OR` keyword, **NO** `AND`, **NO** `|` — just spaces
- Tags and messages are case-sensitive

Example output:
```
tag:MainActivity tag:SplashViewModel tag:App message:OnboardingViewModel
```

## Steps

1. Run `git diff` (staged + unstaged) to find added/modified lines containing log statements.

2. Extract log tags from patterns:
   - `Log.d(TAG, ...)` or `Log.d("TagName", ...)` — Android Log class
   - `logger.debug("Tag", ...)` or `log("...")` — custom AppLogger
   - `println("DEBUG TagName ...")` — println debug logs
   - `companion object { private const val TAG = "..." }` — TAG constants in modified files

3. Extract message patterns from:
   - `println("DEBUG ClassName...")` where the class doesn't have a TAG → use `message:ClassName`

4. Deduplicate and sort tags alphabetically.

5. Output the filter string in a code block, ready to copy-paste into Android Studio Logcat filter bar.

## Output Format

```
## Logcat Filter

Paste into Android Studio Logcat filter bar:

\`\`\`
tag:Foo tag:Bar message:Baz
\`\`\`

Found N log tags in current changes.
```

If no log statements found in current changes, report that and suggest checking `git stash` or `git log`.
