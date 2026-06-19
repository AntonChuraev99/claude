# doc-writer-update-reminder.ps1
# PostToolUse hook — напоминает главному агенту вызвать @doc-writer UPDATE
# после возврата specialist-агента.
#
# Срабатывает только для subagent_type in $specialists. Для doc-writer,
# knowledge-scout, general-purpose, Explore, Plan — выходит молча.
#
# Fail-silent: при любой ошибке парсинга exit 0 без вывода.

$ErrorActionPreference = 'SilentlyContinue'

try {
    $rawInput = [System.Console]::In.ReadToEnd()
    if (-not $rawInput) { exit 0 }

    $data = $rawInput | ConvertFrom-Json -ErrorAction Stop

    # Извлекаем subagent_type из tool_input
    $subagent = $data.tool_input.subagent_type
    if (-not $subagent) { exit 0 }

    # Список специалистов, для которых нужен UPDATE
    $specialists = @(
        'android-expert',
        'kmp-expert',
        'kotlin-expert',
        'react-ui-expert',
        'nextjs-expert',
        'design-expert',
        'wasmjs-expert',
        'security-kotlin'
    )

    if ($specialists -notcontains $subagent) { exit 0 }

    # Reminder text — ASCII-safe (без юникод-эмодзи в самом тексте чтобы не ломать stdout)
    $reminder = "Specialist '$subagent' just returned. If the task is Standard+/Impact>=Medium/Complex, " +
                "launch '@doc-writer' UPDATE in background NOW (after each specialist, before moving to the next step). " +
                "Without UPDATE the active doc freezes -> COMPLETE phase loses 10+ turns on git archaeology. " +
                "If the task is Trivial x Low -- ignore this reminder."

    $output = @{
        hookSpecificOutput = @{
            hookEventName     = 'PostToolUse'
            additionalContext = $reminder
        }
    } | ConvertTo-Json -Depth 5 -Compress

    Write-Output $output
    exit 0
} catch {
    # Fail-silent: hook не должен блокировать главный агент
    exit 0
}
