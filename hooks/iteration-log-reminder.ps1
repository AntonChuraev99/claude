# iteration-log-reminder.ps1
# PostToolUse(Agent) hook — напоминает главному агенту дописать строку итерации
# в активный документ задачи (docs/active/) после возврата специалиста.
#
# Скилл: ~/.claude/skills/doc-task/SKILL.md → «Итерация». До 2026-09-15 файл лежал
# в корне ~/.claude как doc-writer-update-reminder.ps1 и звал субагента doc-writer
# UPDATE; субагент распущен, строку итерации пишет главный сам — одной Edit.
#
# Срабатывает только для subagent_type из $specialists. Для скаутов, ревьюеров,
# general-purpose, Explore, Plan — выходит молча.
#
# Fail-silent: при любой ошибке парсинга exit 0 без вывода.

$ErrorActionPreference = 'SilentlyContinue'

try {
    $rawInput = [System.Console]::In.ReadToEnd()
    if (-not $rawInput) { exit 0 }

    $data = $rawInput | ConvertFrom-Json -ErrorAction Stop

    $subagent = $data.tool_input.subagent_type
    if (-not $subagent) { exit 0 }

    # Специалисты, чей возврат — итерация задачи. Список держать в согласии с
    # реестром ~/.claude/agents/.
    $specialists = @(
        'feature-expert',
        'compose-expert',
        'core-expert',
        'android-platform-expert',
        'kmp-expert',
        'wasmjs-expert',
        'react-ui-expert',
        'nextjs-expert',
        'design-expert',
        'test-expert'
    )

    if ($specialists -notcontains $subagent) { exit 0 }

    # ASCII-safe: юникод в stdout хука ломает вывод на части консолей.
    $reminder = "Specialist '$subagent' just returned. If this task has an active doc in docs/active/, " +
                "append ONE line to '## Log iteracii' now (skill doc-task -> 'Iteraciya'): " +
                "'### Iteraciya N - <date> - $subagent`: <what> -> <result>', and sync '## Tehnicheskiy plan' if it diverged. " +
                "No active doc and no documentation trigger -- ignore this reminder."

    $output = @{
        hookSpecificOutput = @{
            hookEventName     = 'PostToolUse'
            additionalContext = $reminder
        }
    } | ConvertTo-Json -Depth 5 -Compress

    Write-Output $output
    exit 0
} catch {
    exit 0
}
