# ensure-bash-discipline-registered.ps1
# SessionStart hook (user-level): asserts that the single PreToolUse entry which
# carries BOTH the credentials guard and the Bash/Grep tool discipline is still
# registered, and surfaces the failure log that guard writes when it degrades.
#
# Why an assertion and not a second hook. bash-tool-discipline.js is deliberately
# NOT registered in settings.json on its own: it is require()d in-process by
# hooks/credentials-guard-prefilter.js, because a separate PreToolUse entry costs
# another process spawn on every Bash and every Grep call — spawn cost on Windows
# was measured and is the whole reason for the in-process design; the rationale sits
# at credentials-guard-prefilter.js:177-184. That design is right; its one weakness
# is that the coupling is invisible. Drop the prefilter entry from settings.json
# — reordering hooks, a botched merge, a hand edit — and three things die at once
# and in total silence: the credentials guard before deploy, the code-search ban,
# and the sleep ban. Nothing logs, because the module was never asked to load.
#
# So this hook restates the invariant once per session, where it is cheap, rather
# than on every tool call, where it is not. It never edits settings: the user's
# own settings.json is theirs to fix, and a hook that silently rewrites it would
# hide exactly the drift this is meant to expose.
#
# Second job: hooks/credentials-guard-prefilter.js logs a JSONL line to
# ~/.claude/error-logs/ when the discipline module fails to load or throws. That
# log was added (review 2026-08-21) so «правило ни разу не понадобилось» could be
# told apart from «правило не работает» — but nothing has ever read it back. A
# recent entry there is reported here.
#
# Fail-open by construction: a broken assertion must never block session start.

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

try {
    try { [Console]::In.ReadToEnd() | Out-Null } catch { }

    # CLAUDE_HOME override mirrors hooks/claude-md-size-guard.py: without it the
    # assertion can only ever be exercised against the live profile, i.e. only in the
    # state where it stays silent.
    $claudeDir = $env:CLAUDE_HOME
    if ([string]::IsNullOrWhiteSpace($claudeDir)) {
        $claudeDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude'
    }
    $settingsPath = Join-Path $claudeDir 'settings.json'
    $problems     = @()

    if (-not (Test-Path $settingsPath)) { exit 0 }   # nothing to assert against

    $settings = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $preToolUse = @()
    if ($settings.PSObject.Properties['hooks'] -and $settings.hooks.PSObject.Properties['PreToolUse']) {
        $preToolUse = @($settings.hooks.PreToolUse)
    }

    # The prefilter is matched by command text, not by matcher shape: the matcher
    # may legitimately be reworded, the script path may not disappear.
    $entries = @($preToolUse | Where-Object {
        ($_ | ConvertTo-Json -Depth 10 -Compress) -match 'credentials-guard-prefilter'
    })

    if ($entries.Count -eq 0) {
        $problems += 'PreToolUse-запись credentials-guard-prefilter отсутствует в settings.json — ' +
                     'разом выключены credentials-guard, запрет code-search через Bash и запрет sleep'
    } else {
        # Coverage is the UNION over every entry that calls the prefilter, not the
        # matcher of the first one: splitting Bash and Grep into two entries is a
        # valid config, and so is omitting `matcher` entirely — an entry without one
        # matches every tool, which is strictly wider, not narrower. Judging a single
        # entry's matcher string would cry wolf on both shapes, and a warning that
        # fires every session is a warning nobody reads.
        $matcherless = @($entries | Where-Object {
            -not $_.PSObject.Properties['matcher'] -or [string]::IsNullOrWhiteSpace([string]$_.matcher)
        }).Count -gt 0

        if (-not $matcherless) {
            # Grep is judged by the same in-process module (renderGrepDeny); a matcher
            # narrowed back to Bash alone silently reopens text search over sources.
            $union = (($entries | ForEach-Object { [string]$_.matcher }) -join '|')
            foreach ($tool in @('Bash', 'Grep')) {
                if ($union -notmatch $tool) {
                    $problems += "matcher '$union' не покрывает тул $tool — дисциплина для него не применяется"
                }
            }
        }
    }

    $modulePath = Join-Path $claudeDir 'hooks\bash-tool-discipline.js'
    if (-not (Test-Path $modulePath)) {
        $problems += 'hooks/bash-tool-discipline.js не найден — prefilter загрузит null и промолчит'
    }

    # Degradation already recorded by the prefilter itself. The window is judged per
    # LINE (`ts` of each record), not by the file's mtime: error-logs holds a single
    # append-only file, so one fresh line would otherwise drag every stale record
    # into the count — and the count is exactly what the user is asked to react to.
    # `-Tail` bounds the read: the same directory carries a continuously appended
    # heartbeat log, and this runs on every session start.
    $logDir = Join-Path $claudeDir 'error-logs'
    if (Test-Path $logDir) {
        $cutoff = (Get-Date).AddDays(-7)
        $recent = 0
        foreach ($f in @(Get-ChildItem $logDir -Filter *.jsonl -ErrorAction SilentlyContinue |
                         Where-Object { $_.LastWriteTime -gt $cutoff })) {
            foreach ($line in @(Get-Content $f.FullName -Tail 500 -ErrorAction SilentlyContinue |
                                Where-Object { $_ -match 'discipline-module-unavailable' })) {
                try {
                    if ([datetime]((ConvertFrom-Json $line).ts) -gt $cutoff) { $recent++ }
                } catch { }
            }
        }
        if ($recent -gt 0) {
            $problems += "в error-logs за 7 дней $recent записей " +
                         'discipline-module-unavailable — модуль дисциплины падал на живых вызовах'
        }
    }

    if ($problems.Count -eq 0) { exit 0 }

    $screen = ($([char]0x26A0) + ' bash-discipline: инвариант хука нарушен') + "`n" +
              (($problems | ForEach-Object { '  ' + $_ }) -join "`n")
    $ctx = 'bash-discipline assertion failed: ' + ($problems -join '; ') +
           '. Проверь hooks.PreToolUse в ~/.claude/settings.json — запись ' +
           'credentials-guard-prefilter несёт и credentials-guard, и дисциплину Bash/Grep ' +
           '(bash-tool-discipline.js регистрации не имеет по конструкции).'

    @{
        suppressOutput     = $true
        systemMessage      = $screen
        hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $ctx }
    } | ConvertTo-Json -Depth 5 -Compress
} catch {
    exit 0
}
exit 0
