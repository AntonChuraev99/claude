# SessionStart hook: дайджест доков задач текущего проекта.
# - docs/active/*.md  — «в работе»: шапка `**Статус:**` != Done/Complete/Resolved
# - docs/todos/*.md   — «отложено»: YAML frontmatter status: deferred (TEMPLATE/INDEX пропускаются)
# Вывод: JSON c systemMessage (видит пользователь, top-N свежих, box-drawing оформление)
#        + additionalContext (видит модель, ПОЛНЫЙ список компактно).
# systemMessage намеренно ограничен top-N: терминал persist'ит вывод >~10KB в файл,
# показывая только 2KB превью — длинная версия была бы не видна пользователю вовсе.
# В проектах без подходящих доков молчит (exit 0 без вывода).
# Запуск: pwsh 7+ (UTF-8 без BOM), stdin = hook JSON ({cwd, source, ...}).

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$MaxPretty = 7  # записей на секцию в видимой пользователю части

# --- cwd из stdin JSON хука, fallback — текущая директория ---
$cwd = $null
try {
    $stdin = [Console]::In.ReadToEnd()
    if ($stdin) { $cwd = (ConvertFrom-Json $stdin).cwd }
} catch {}
if (-not $cwd) { $cwd = (Get-Location).Path }

$activeDir = Join-Path $cwd 'docs/active'
$todosDir  = Join-Path $cwd 'docs/todos'
if (-not (Test-Path $activeDir) -and -not (Test-Path $todosDir)) { exit 0 }

function Clip([string]$s, [int]$max = 160) {
    if (-not $s) { return '' }
    $s = ($s -replace '\s+', ' ').Trim()
    if ($s.Length -gt $max) { return $s.Substring(0, $max - 1) + [char]0x2026 }
    return $s
}

# --- docs/active: markdown-шапка (# Title, **Статус:**, **Дата старта:**, ## Цель) ---
$active = @()
if (Test-Path $activeDir) {
    foreach ($f in Get-ChildItem $activeDir -Filter '*.md' -File) {
        $lines = Get-Content $f.FullName -TotalCount 60 -Encoding UTF8
        if (-not $lines) { continue }
        $statusLine = $lines | Where-Object { $_ -match '^\*\*Статус:\*\*' } | Select-Object -First 1
        if (-not $statusLine) { continue }  # без шапки — не трекаемая дока
        $status = ($statusLine -replace '^\*\*Статус:\*\*\s*', '').Trim()
        # завершённые скрыть (вкл. "✅ Done", "COMPLETE"); "Partially Done" не начинается с Done — остаётся
        $statusClean = $status -replace '^[^\p{L}]+', ''
        if ($statusClean -match '^(Done|Complete|Resolved|Завершен|Закрыт)') { continue }
        $titleLine = $lines | Where-Object { $_ -match '^#\s+' } | Select-Object -First 1
        $title = if ($titleLine) { ($titleLine -replace '^#\s+', '').Trim() } else { $f.BaseName }
        $dateLine = $lines | Where-Object { $_ -match '^\*\*Дата( старта)?:\*\*' } | Select-Object -First 1
        $date = if ($dateLine) { ($dateLine -replace '^\*\*[^*]+\*\*\s*', '').Trim() } else { '' }
        # первая непустая строка после "## Цель" (включая "## Цель (продуктовая)")
        $goal = ''
        $inGoal = $false
        foreach ($l in $lines) {
            if ($l -match '^##\s+Цель') { $inGoal = $true; continue }
            if ($inGoal) {
                if ($l -match '^#') { break }
                if ($l.Trim()) { $goal = $l; break }
            }
        }
        $active += [pscustomobject]@{
            Title  = Clip $title 100
            Path   = "docs/active/$($f.Name)"
            Status = Clip $status 60
            Date   = Clip $date 24
            Desc   = Clip $goal 160
        }
    }
    $active = @($active | Sort-Object Date -Descending)
}

# --- docs/todos: YAML frontmatter (title, date, status, blocking_reason, resume_trigger) ---
$todos = @()
if (Test-Path $todosDir) {
    foreach ($f in Get-ChildItem $todosDir -Filter '*.md' -File) {
        if ($f.Name -in @('TEMPLATE.md', 'INDEX.md')) { continue }
        $lines = Get-Content $f.FullName -TotalCount 30 -Encoding UTF8
        if (-not $lines -or $lines[0].Trim() -ne '---') { continue }
        $fm = @{}
        foreach ($l in ($lines | Select-Object -Skip 1)) {
            if ($l.Trim() -eq '---') { break }
            if ($l -match '^([A-Za-z_]+):\s*(.*)$') { $fm[$Matches[1]] = $Matches[2].Trim() }
        }
        if ($fm['status'] -ne 'deferred') { continue }
        $title = if ($fm['title']) { $fm['title'] } else { $f.BaseName }
        $todos += [pscustomobject]@{
            Title  = Clip $title 100
            Path   = "docs/todos/$($f.Name)"
            Date   = Clip $fm['date'] 24
            Reason = Clip $fm['blocking_reason'] 40
            Resume = Clip $fm['resume_trigger'] 160
        }
    }
    $todos = @($todos | Sort-Object Date -Descending)
}

if (-not $active -and -not $todos) { exit 0 }

# --- оформление (box-drawing) ---
$proj   = Split-Path $cwd -Leaf
$Heavy  = [string][char]0x2550 * 58   # ═
$Thin   = [string][char]0x2500 * 58   # ─
$Bullet = [char]0x25CF                # ●
$Tee    = [char]0x251C                # ├
$End    = [char]0x2514                # └
$Arrow  = [char]0x25B6                # ▶
$Dot    = [char]0x00B7                # ·

# --- systemMessage: top-N свежих, с разделителями ---
$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine($Heavy)
[void]$sb.AppendLine("  ДОКИ ЗАДАЧ $($proj.ToUpper())  $Dot  в работе: $($active.Count)  $Dot  отложено: $($todos.Count)")
[void]$sb.AppendLine($Heavy)

if ($active) {
    [void]$sb.AppendLine('')
    $shown = [Math]::Min($active.Count, $MaxPretty)
    $label = if ($active.Count -gt $shown) { " (свежие $shown из $($active.Count))" } else { '' }
    [void]$sb.AppendLine("$Arrow В РАБОТЕ — docs/active$label")
    [void]$sb.AppendLine('')
    foreach ($a in ($active | Select-Object -First $MaxPretty)) {
        [void]$sb.AppendLine("$Bullet $($a.Title)")
        $meta = $a.Status
        if ($a.Date) { $meta += "  $Dot  с $($a.Date)" }
        [void]$sb.AppendLine("  $Tee $meta")
        [void]$sb.AppendLine("  $Tee $($a.Path)")
        [void]$sb.AppendLine("  $End $(Clip $a.Desc 100)")
        [void]$sb.AppendLine($Thin)
    }
    if ($active.Count -gt $MaxPretty) {
        [void]$sb.AppendLine("  $Dot$Dot$Dot и ещё $($active.Count - $MaxPretty) — полный список в контексте сессии (спроси: «что в работе?»)")
    }
}

if ($todos) {
    [void]$sb.AppendLine('')
    $shown = [Math]::Min($todos.Count, $MaxPretty)
    $label = if ($todos.Count -gt $shown) { " (свежие $shown из $($todos.Count))" } else { '' }
    [void]$sb.AppendLine("$Arrow ОТЛОЖЕНО — docs/todos$label")
    [void]$sb.AppendLine('')
    foreach ($t in ($todos | Select-Object -First $MaxPretty)) {
        [void]$sb.AppendLine("$Bullet $($t.Title)")
        $meta = @($t.Date, $t.Reason) | Where-Object { $_ }
        if ($meta) { [void]$sb.AppendLine("  $Tee $($meta -join "  $Dot  ")") }
        [void]$sb.AppendLine("  $Tee $($t.Path)")
        if ($t.Resume) { [void]$sb.AppendLine("  $End resume: $(Clip $t.Resume 100)") }
        [void]$sb.AppendLine($Thin)
    }
    if ($todos.Count -gt $MaxPretty) {
        [void]$sb.AppendLine("  $Dot$Dot$Dot и ещё $($todos.Count - $MaxPretty) — docs/todos/INDEX.md (полный список в контексте сессии)")
    }
}
$pretty = $sb.ToString().TrimEnd()

# --- additionalContext: полный список, компактно (без рамок — экономия токенов) ---
$cb = [System.Text.StringBuilder]::new()
[void]$cb.AppendLine("Дайджест доков задач проекта (docs/active + docs/todos):")
if ($active) {
    [void]$cb.AppendLine('')
    [void]$cb.AppendLine("В РАБОТЕ ($($active.Count)):")
    foreach ($a in $active) {
        $head = "- $($a.Title) — $($a.Status)"
        if ($a.Date) { $head += " (с $($a.Date))" }
        [void]$cb.AppendLine($head)
        [void]$cb.AppendLine("  $($a.Path)")
        if ($a.Desc) { [void]$cb.AppendLine("  $($a.Desc)") }
    }
}
if ($todos) {
    [void]$cb.AppendLine('')
    [void]$cb.AppendLine("ОТЛОЖЕНО ($($todos.Count)):")
    foreach ($t in $todos) {
        $head = "- $($t.Title)"
        $meta = @($t.Date, $t.Reason) | Where-Object { $_ }
        if ($meta) { $head += " ($($meta -join ', '))" }
        [void]$cb.AppendLine($head)
        [void]$cb.AppendLine("  $($t.Path)")
        if ($t.Resume) { [void]$cb.AppendLine("  resume: $($t.Resume)") }
    }
}
[void]$cb.AppendLine('')
[void]$cb.AppendLine("Это фоновая справка о незавершённых/отложенных задачах проекта — не начинай работу по этим докам без явного запроса пользователя. Пользователю в терминале показаны только $MaxPretty свежих записей каждой секции — на вопрос «что в работе/отложено?» отвечай из этого полного списка.")
$ctx = $cb.ToString().TrimEnd()

@{
    systemMessage      = $pretty
    suppressOutput     = $true
    hookSpecificOutput = @{
        hookEventName     = 'SessionStart'
        additionalContext = $ctx
    }
} | ConvertTo-Json -Depth 4
