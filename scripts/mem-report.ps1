#Requires -Version 7.0
<#
.SYNOPSIS
    Снимок потребления оперативной памяти dev-машины с разбором по группам.

.DESCRIPTION
    Отвечает на два вопроса: "сколько всего занято" и "что из этого лишнее".

    Меряется COMMIT, а не Working Set. На машине, ушедшей в своп, Working Set
    врёт: он показывает лишь ту часть, что осталась в физической памяти, поэтому
    4-гигабайтный JVM-демон выглядит в диспетчере задач как 200 МБ. Commit — то,
    что процесс потребовал у системы и что она обязана обеспечить памятью или
    страничным файлом; именно он определяет, свопится машина или нет.

    Двух величин две, и они не взаимозаменяемы:
      * СИСТЕМНЫЙ commit charge (GlobalMemoryStatusEx) — заголовочная цифра и
        основа overcommit; включает ядро и shared-страницы. Тот же источник, что
        у RAM-сегмента в statusline.py, чтобы две поверхности не расходились.
      * Сумма PRIVATE commit по процессам (Win32_Process.PageFileUsage, КБ) —
        печатается отдельной строкой; она заведомо меньше системной.

    Находки дедуплицируются по PID: процесс, попавший в два правила сразу,
    считается один раз. Без этого сумма "к возврату" превышает объём машины.
    Демоны, которые правила решили оставить, помечаются INFO и в сумму не
    входят — иначе отчёт предлагает остановить то, что нужно для работы.

    Дорогих вызовов два: Add-Type для P/Invoke (~550 мс, разовая компиляция) и
    один проход по Win32_Process (~190 мс).

.PARAMETER Full
    Показать все группы, включая мелочь, и больше процессов в разбивке.

.PARAMETER Json
    Machine-readable вывод вместо таблиц, ключи ASCII. Для внешних потребителей.
    Status line сюда НЕ ходит и ходить не должен: подпроцесс в рендере дороже
    всего рендера (см. Design notes в statusline.py), поэтому её RAM-сегмент
    зовёт тот же WinAPI напрямую.

.EXAMPLE
    pwsh -NoProfile -File scripts/mem-report.ps1
.EXAMPLE
    pwsh -NoProfile -File scripts/mem-report.ps1 -Full
#>
[CmdletBinding()]
param(
    [switch]$Full,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Консоль Windows отдаёт вывод в OEM-кодировке, и весь русский текст ниже
# превращается в мусор, как только вывод уходит в пайп или в файл. Прямой
# запуск в терминале это скрывает — ломается только перенаправленный вывод.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

# Иначе в одном блоке соседствуют «45.4 GB» (интерполяция — всегда инвариантная
# точка) и «35,3 GB» (оператор -f — культурная запятая). Одна культура на весь
# отчёт снимает расхождение без переписывания каждой строки форматирования.
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture

# --------------------------------------------------------------------------
# сбор
# --------------------------------------------------------------------------

# Тот же источник, что у RAM-сегмента в statusline.py (GlobalMemoryStatusEx).
# Раньше здесь стоял Win32_OperatingSystem.FreePhysicalMemory, а он считает
# только free list, без standby-кэша — из-за чего два инструмента показывали
# разную «свободную память» в одну и ту же минуту. Счётчики производительности
# не годятся: их имена локализованы, на русской Windows путь \Memory\... не
# резолвится. P/Invoke даёт те же числа, что видит statusline, независимо от
# локали.
Add-Type -Namespace MemRep -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
public struct MEMORYSTATUSEX {
    public uint dwLength;
    public uint dwMemoryLoad;
    public ulong ullTotalPhys;
    public ulong ullAvailPhys;
    public ulong ullTotalPageFile;
    public ulong ullAvailPageFile;
    public ulong ullTotalVirtual;
    public ulong ullAvailVirtual;
    public ulong ullAvailExtendedVirtual;
}
[DllImport("kernel32.dll", SetLastError = true)]
[return: MarshalAs(UnmanagedType.Bool)]
public static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);
'@

$mem = New-Object MemRep.Native+MEMORYSTATUSEX
$mem.dwLength = [System.Runtime.InteropServices.Marshal]::SizeOf($mem)
# Проверяем возврат: при FALSE все поля остаются нулями, и отчёт напечатал бы
# «0 GB всего», а overcommit ушёл бы в 0 — молчаливо и правдоподобно.
if (-not [MemRep.Native]::GlobalMemoryStatusEx([ref]$mem)) {
    throw "GlobalMemoryStatusEx failed (Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}
if ($mem.ullTotalPhys -le 0) { throw 'GlobalMemoryStatusEx вернул нулевой объём памяти' }

$totalGB = [math]::Round($mem.ullTotalPhys / 1GB, 1)
$freeGB = [math]::Round($mem.ullAvailPhys / 1GB, 1)
$usedGB = [math]::Round($totalGB - $freeGB, 1)

# Системный commit charge — включает ядро и shared-страницы, поэтому он выше
# суммы private-commit по процессам. Именно его показывает statusline; сумма по
# процессам печатается отдельной строкой как «в том числе».
$commitSysGB = [math]::Round(($mem.ullTotalPageFile - $mem.ullAvailPageFile) / 1GB, 1)

$pf = Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue | Select-Object -First 1

# PageFileUsage — private commit в КБ; WorkingSetSize — байты.
$procs = Get-CimInstance Win32_Process |
    Select-Object ProcessId, ParentProcessId, Name, CommandLine, PageFileUsage, WorkingSetSize, CreationDate

$now = Get-Date

function Uptime($start) {
    # Параметр НЕ типизирован [datetime] намеренно: привязка $null к [datetime]
    # падает раньше, чем сработает охрана ниже, и делает её недостижимой.
    if (-not $start) { return '?' }
    $start = [datetime]$start
    $d = $now - $start
    if ($d.TotalHours -ge 1) { return ('{0:0.#}ч' -f $d.TotalHours) }
    return ('{0:0}м' -f $d.TotalMinutes)
}

# --------------------------------------------------------------------------
# классификация
# --------------------------------------------------------------------------
#
# Порядок правил значим: первое совпадение выигрывает. Claude Desktop должен
# проверяться раньше Claude CLI — оба зовутся claude.exe, различает их только
# путь запуска (Desktop ставится как WindowsApps-пакет).

# Демон намертво привязан к версии тулчейна: два процесса разных версий Gradle
# (или Kotlin) НЕ могут делить один демон, сколько ни сводить jvmargs. Без этой
# разбивки отчёт валит на jvmargs то, что на самом деле разнесено по версиям.
function Get-DaemonVersion($cmd) {
    if ($cmd -match 'dists[\\/]gradle-([\d.]+)-') { return $Matches[1] }
    if ($cmd -match 'gradle-launcher-([\d.]+)\.jar') { return $Matches[1] }
    if ($cmd -match 'kotlin-build-tools[^\\/]*[\\/](\d+(?:\.\d+)+)[\\/]') { return $Matches[1] }
    if ($cmd -match 'kotlin-daemon-embeddable-(\d+(?:\.\d+)+)') { return $Matches[1] }
    return '?'
}

function Get-Xmx($cmd) {
    if ($cmd -match '-Xmx(\S+?)(\s|"|$)') { return $Matches[1] }
    return '—'
}

function Get-Bucket($p) {
    $n = $p.Name
    $c = if ($p.CommandLine) { $p.CommandLine } else { '' }

    switch -Regex ($n) {
        '^(java|javaw)\.exe$' {
            if ($c -match 'KotlinCompileDaemon|kotlin-build-tools') { return 'JVM: Kotlin' }
            if ($c -match 'GradleDaemon') { return 'JVM: Gradle' }
            if ($c -match 'gradle-launcher|GradleWrapperMain') { return 'JVM: Gradle (launcher)' }
            return 'JVM: прочее'
        }
        '^claude\.exe$' {
            if ($c -match 'WindowsApps') { return 'Claude Desktop' }
            return 'Claude CLI'
        }
        '^node\.exe$' { return 'node.js (в т.ч. MCP)' }
        '^(studio64|idea64|pycharm64|webstorm64)\.exe$' { return 'IDE' }
        '^(chrome|msedge|firefox|brave)\.exe$' { return 'Браузер' }
        # vmmem/VmmemWSL — minimal process: в Win32_Process.Name он БЕЗ
        # расширения, поэтому шаблон с обязательным `\.exe` не срабатывал
        # никогда и 4 ГБ WSL уезжали в «Прочее».
        '^(vmmem|vmmemWSL)(\.exe)?$' { return 'VM / WSL' }
        '^(vmwp|vmcompute)\.exe$' { return 'VM / WSL' }
        '^qemu-system.*\.exe$' { return 'Android emulator' }
        '^(Slack|Telegram|Discord|Notion|Spotify|steam|steamwebhelper)\.exe$' { return 'Фон: приложения' }
        '^(MsMpEng|NisSrv)\.exe$' { return 'Defender' }
        '^(pwsh|powershell|cmd|conhost|WindowsTerminal|warp)\.exe$' { return 'Шеллы' }
        default { return 'Прочее' }
    }
}

$rows = foreach ($p in $procs) {
    [pscustomobject]@{
        PID       = $p.ProcessId
        PPID      = $p.ParentProcessId
        Name      = $p.Name
        Cmd       = if ($p.CommandLine) { $p.CommandLine } else { '' }
        CommitMB  = [math]::Round($p.PageFileUsage / 1KB)
        RssMB     = [math]::Round($p.WorkingSetSize / 1MB)
        Started   = $p.CreationDate
        Bucket    = Get-Bucket $p
        Ver       = if ($p.Name -match '^(java|javaw)\.exe$') { Get-DaemonVersion $p.CommandLine } else { '' }
        Xmx       = if ($p.Name -match '^(java|javaw)\.exe$') { Get-Xmx $p.CommandLine } else { '' }
    }
}

$byPid = @{}
foreach ($r in $rows) { $byPid[[int]$r.PID] = $r }

$commitProcGB = [math]::Round((($rows | Measure-Object CommitMB -Sum).Sum) / 1KB, 1)
# Overcommit считаем по СИСТЕМНОМУ commit charge — та же величина, что в
# statusline; сумма по процессам её недосчитывает (нет ядра и shared).
$overcommit = if ($totalGB -gt 0) { [math]::Round($commitSysGB / $totalGB, 2) } else { 0 }

# --------------------------------------------------------------------------
# находки: то, за что платим зря
# --------------------------------------------------------------------------
#
# Каждая находка несёт список PID, а не готовую цифру: итог считается по
# ОБЪЕДИНЕНИЮ множеств, иначе процесс, подходящий под два правила, удваивается.
# Severity INFO — наблюдение без предлагаемого действия, в итог не входит.

$findings = [System.Collections.Generic.List[object]]::new()

function Add-Finding($severity, $what, $targetPids, $action) {
    $ids = @($targetPids | ForEach-Object { [int]$_ } | Select-Object -Unique)
    $cost = 0
    foreach ($id in $ids) { if ($byPid.ContainsKey($id)) { $cost += $byPid[$id].CommitMB } }
    $findings.Add([pscustomobject]@{
        Severity = $severity
        What     = $what
        Pids     = $ids
        CostMB   = [int]$cost
        Action   = $action
    })
}

$jvm = @($rows | Where-Object { $_.Bucket -like 'JVM:*' })
$gradleDaemons = @($jvm | Where-Object { $_.Bucket -eq 'JVM: Gradle' })
$kotlinDaemons = @($jvm | Where-Object { $_.Bucket -eq 'JVM: Kotlin' })

# 1. Несколько демонов одного вида — всегда потеря, но причина бывает разной, и
#    лечится она по-разному. Различаем три случая, иначе отчёт советует сводить
#    jvmargs там, где они уже сведены.
# PID демонов, которые правила выше решили ОСТАВИТЬ. Нужны ниже: остановка
# такого демона оплачивается холодным стартом следующей сборки, поэтому в сумму
# «к возврату» он попадать не должен, сколько бы часов ни жил.
$keepPids = [System.Collections.Generic.HashSet[int]]::new()

function Add-DaemonFinding($daemons, $kind, $fixArgs, $fixVer) {
    if ($daemons.Count -le 1) {
        foreach ($d in $daemons) { [void]$keepPids.Add([int]$d.PID) }
        return
    }

    # Разбор ПО ГРУППАМ версии, а не одним вердиктом на всех: демоны разных
    # версий и лишние демоны ОДНОЙ версии — разные болезни с разным лечением,
    # и в одном замере они встречаются одновременно. Один общий вердикт на всю
    # пачку обязательно соврёт про часть процессов.
    $byVer = $daemons | Group-Object Ver

    # '?' — неразобранная версия, а не «ещё одна версия»: считать её отдельной
    # означает объявить «разные версии» там, где просто не сработал парсер.
    $knownVers = @($byVer | Where-Object { $_.Name -ne '?' })

    # (а) Несколько РАЗНЫХ версий — демон привязан к версии, args тут не помогут.
    if ($knownVers.Count -gt 1) {
        $names = @($knownVers.Name)
        # Лишние — все группы, кроме самой тяжёлой: одна версия всё равно нужна.
        $keep = ($knownVers | Sort-Object { ($_.Group | Measure-Object CommitMB -Sum).Sum } -Descending |
            Select-Object -First 1).Name
        $extra = @($daemons | Where-Object { $_.Ver -ne $keep -and $_.Ver -ne '?' })
        Add-Finding 'HIGH' "${kind}: $($knownVers.Count) РАЗНЫХ версии ($($names -join ', '))" $extra.PID $fixVer
    }

    # (б) Внутри одной версии всё равно больше одного — это уже про args, JDK
    #     или про то, что старый ещё не истёк.
    foreach ($g in ($byVer | Where-Object { $_.Count -gt 1 })) {
        $grp = @($g.Group | Sort-Object CommitMB -Descending)
        $xmxs = @($grp.Xmx | Select-Object -Unique)
        $dupExtra = @($grp | Select-Object -Skip 1)
        [void]$keepPids.Add([int]$grp[0].PID)
        $verLabel = if ($g.Name -eq '?') { '(версия не определена)' } else { $g.Name }
        if ($g.Name -eq '?') {
            Add-Finding 'MED' "$kind $verLabel : $($g.Count) процесса — версию разобрать не удалось, причину дублирования не назвать" $dupExtra.PID 'посмотреть их командные строки вручную'
        }
        elseif ($xmxs.Count -gt 1) {
            Add-Finding 'HIGH' "$kind ${verLabel}: $($g.Count) демона, разные Xmx ($($xmxs -join ', '))" $dupExtra.PID $fixArgs
        }
        else {
            Add-Finding 'MED' "$kind ${verLabel}: $($g.Count) демона при одинаковых версии и Xmx" $dupExtra.PID 'сверить JDK демонов (gradle/gradle-daemon-jvm.properties) и остаток jvmargs; часть может быть просто ещё не истёкшими по idletimeout'
        }
    }

    # Самая тяжёлая версия остаётся жить — её представитель тоже keep.
    $keepVer = ($byVer | Sort-Object { ($_.Group | Measure-Object CommitMB -Sum).Sum } -Descending |
        Select-Object -First 1)
    if ($keepVer) {
        $top = @($keepVer.Group | Sort-Object CommitMB -Descending)[0]
        [void]$keepPids.Add([int]$top.PID)
    }
}

Add-DaemonFinding $gradleDaemons 'Gradle' `
    'унифицировать org.gradle.jvmargs в ~/.gradle/gradle.properties' `
    'свести версии Gradle в проектах — демон привязан к версии, jvmargs тут ни при чём'
Add-DaemonFinding $kotlinDaemons 'Kotlin' `
    'задать kotlin.daemon.jvmargs глобально' `
    'свести версии Kotlin в проектах (gradle/gradle#34755) — иначе демон на каждую версию'

# Простаивающий демон: жив дольше часа. Gradle держит демон 3 часа по умолчанию
# (org.gradle.daemon.idletimeout=10800000), всё это время удерживая свой heap.
# Долгоживущий демон. Именно "живёт долго", а НЕ "простаивает": демон, который
# прямо сейчас собирает проект, тоже живёт дольше часа, а по одному снимку
# Win32_Process простой от работы не отличить. Формулировка и severity подобраны
# так, чтобы отчёт не советовал убить занятый или единственный нужный процесс.
$idleJvm = @($jvm | Where-Object { $_.Started -and ($now - $_.Started).TotalHours -ge 1 })
foreach ($d in $idleJvm) {
    $isKeep = $keepPids.Contains([int]$d.PID)
    $sev = if ($isKeep) { 'INFO' } else { 'MED' }
    $tail = if ($isKeep) { ' — этот нужен для работы, остановка оплачивается холодным стартом' } else { '' }
    # `gradle --stop` не трогает Kotlin-демон (отдельный процесс) и тем более
    # посторонние JVM — советовать его им бессмысленно.
    $action = switch ($d.Bucket) {
        'JVM: Gradle' { 'gradle --stop (по каждой версии Gradle отдельно)' }
        'JVM: Kotlin' { 'умирает вместе с Gradle-демоном; отдельно — kill PID' }
        default { "разобраться, чей это процесс; при необходимости kill $($d.PID)" }
    }
    Add-Finding $sev "$($d.Bucket) PID $($d.PID) живёт $(Uptime $d.Started), всё это время удерживает свой Xmx$tail" @($d.PID) $action
}

# 2. MCP: процесс-обёртка npx только ждёт дочерний сервер, но держит свой heap.
$node = @($rows | Where-Object { $_.Bucket -eq 'node.js (в т.ч. MCP)' })
$npxWrappers = @($node | Where-Object { $_.Cmd -match 'npx-cli\.js' })
if ($npxWrappers.Count -gt 0) {
    Add-Finding 'HIGH' "npx-обёрток: $($npxWrappers.Count) — держат heap, но только ждут дочерний процесс" $npxWrappers.PID 'заменить `npx -y <pkg>` на прямой путь к серверу'
}

# Один и тот же MCP-сервер, поднятый в нескольких сессиях. stdio-транспорт даёт
# процесс на каждого клиента; HTTP-транспорт обслужил бы всех одним.
function Get-McpName($cmd) {
    if ($cmd -match '@upstash/context7-mcp') { return 'context7' }
    if ($cmd -match 'mcp-remote.*atlassian') { return 'atlassian' }
    if ($cmd -match 'claude-in-mobile') { return 'mobile' }
    if ($cmd -match 'mcp-appstore') { return 'appstore' }
    if ($cmd -match 'mcp-remote') { return 'mcp-remote (прочий)' }
    return $null
}

$mcpGroups = $node |
    ForEach-Object {
        $nm = Get-McpName $_.Cmd
        if ($nm) { [pscustomobject]@{ Server = $nm; CommitMB = $_.CommitMB; PID = $_.PID } }
    } |
    Group-Object Server |
    ForEach-Object {
        [pscustomobject]@{
            Server   = $_.Name
            Count    = $_.Count
            CommitMB = ($_.Group | Measure-Object CommitMB -Sum).Sum
            Pids     = @($_.Group.PID)
        }
    } | Sort-Object CommitMB -Descending

foreach ($g in ($mcpGroups | Where-Object { $_.Count -gt 1 })) {
    # Лишние — все копии, кроме САМОЙ ТЯЖЁЛОЙ: без сортировки `-Skip 1` отбрасывал
    # произвольную копию, и цифра «к возврату» гуляла от прогона к прогону.
    $extra = @($rows | Where-Object { $g.Pids -contains $_.PID } |
        Sort-Object CommitMB -Descending | Select-Object -Skip 1 | ForEach-Object { $_.PID })
    Add-Finding 'MED' "MCP '$($g.Server)' поднят ×$($g.Count) — по копии на сессию" $extra 'HTTP-транспорт вместо stdio: один процесс на все сессии'
}

# 3. Claude CLI-сессии — наблюдение, а не обвинение: сколько сессий держать,
#    решает пользователь. Показываем цену, действие не навязываем.
$cli = @($rows | Where-Object { $_.Bucket -eq 'Claude CLI' })
if ($cli.Count -ge 2) {
    $perSession = [math]::Round((($cli | Measure-Object CommitMB -Sum).Sum) / $cli.Count)
    Add-Finding 'INFO' "Claude CLI-сессий: $($cli.Count) × ~$perSession MB (+ свой набор MCP на каждую)" $cli.PID 'цена одной сессии — закрывать по необходимости'
}

# 4. Эмулятор и WSL.
foreach ($e in ($rows | Where-Object { $_.Bucket -eq 'Android emulator' })) {
    $avd = if ($e.Cmd -match '-avd\s+(\S+)') { $Matches[1] } else { '?' }
    Add-Finding 'MED' "Android emulator запущен (AVD $avd)" @($e.PID) 'закрыть, если сейчас не тестируешь'
}
foreach ($v in ($rows | Where-Object { $_.Name -match '^vmmem' })) {
    Add-Finding 'MED' 'WSL/VM держит память (vmmem)' @($v.PID) 'wsl --shutdown; лимит в ~/.wslconfig'
}

# --------------------------------------------------------------------------
# итог по объединению PID
# --------------------------------------------------------------------------

$reclaimPids = [System.Collections.Generic.HashSet[int]]::new()
foreach ($f in $findings) {
    if ($f.Severity -eq 'INFO') { continue }
    foreach ($id in $f.Pids) { [void]$reclaimPids.Add($id) }
}
$reclaimMB = 0
foreach ($id in $reclaimPids) { if ($byPid.ContainsKey($id)) { $reclaimMB += $byPid[$id].CommitMB } }

# --------------------------------------------------------------------------
# вывод
# --------------------------------------------------------------------------

$groups = $rows | Group-Object Bucket | ForEach-Object {
    [pscustomobject]@{
        Группа   = $_.Name
        Проц     = $_.Count
        CommitMB = ($_.Group | Measure-Object CommitMB -Sum).Sum
        RssMB    = ($_.Group | Measure-Object RssMB -Sum).Sum
    }
} | Sort-Object CommitMB -Descending

if ($Json) {
    # Ключи машинного вывода — только ASCII. Кириллические имена свойств при
    # выводе через пайп в консоли с OEM-кодовой страницей схлопывались в «????»,
    # то есть несколько ключей становились одним и JSON ломался.
    $groupsJson = $groups | ForEach-Object {
        [pscustomobject]@{
            bucket    = $_.'Группа'
            processes = $_.'Проц'
            commitMB  = $_.CommitMB
            rssMB     = $_.RssMB
        }
    }
    [pscustomobject]@{
        totalGB       = $totalGB
        freeGB        = $freeGB
        usedGB        = $usedGB
        commitGB      = $commitSysGB
        commitProcGB  = $commitProcGB
        overcommit    = $overcommit
        pagefileMB    = if ($pf) { $pf.CurrentUsage } else { $null }
        pagefilePeak  = if ($pf) { $pf.PeakUsage } else { $null }
        groups        = $groupsJson
        findings      = $findings | ForEach-Object {
            [pscustomobject]@{
                severity = $_.Severity; what = $_.What
                pids = $_.Pids; costMB = $_.CostMB; action = $_.Action
            }
        }
        reclaimableMB = $reclaimMB
    } | ConvertTo-Json -Depth 5
    return
}

$pressureColor = if ($freeGB -lt 1) { 'Red' } elseif ($freeGB -lt 2.5) { 'Yellow' } else { 'Green' }
# Шкала та же, что у RAM-сегмента statusline.py: жёлтый с 1.2×, красный с 2.0×.
$commitColor = if ($overcommit -ge 2.0) { 'Red' } elseif ($overcommit -ge 1.2) { 'Yellow' } else { 'Green' }

Write-Host ''
Write-Host '  ПАМЯТЬ  ' -NoNewline -ForegroundColor White -BackgroundColor DarkBlue
Write-Host "  $totalGB GB всего · " -NoNewline
Write-Host "$freeGB GB свободно" -NoNewline -ForegroundColor $pressureColor
Write-Host "  ·  занято $usedGB GB"

Write-Host '  Commit: ' -NoNewline -ForegroundColor DarkGray
Write-Host "$commitSysGB GB" -NoNewline -ForegroundColor $commitColor
Write-Host ' — система забронировала в ' -NoNewline -ForegroundColor DarkGray
Write-Host "${overcommit}×" -NoNewline -ForegroundColor $commitColor
Write-Host ' больше физической памяти' -ForegroundColor DarkGray
Write-Host ("          в том числе процессы: {0} GB (private; разница — ядро и shared)" -f $commitProcGB) -ForegroundColor DarkGray

if ($pf) {
    Write-Host ('  Pagefile: {0} GB занято · пик {1} GB · размер {2} GB' -f
        [math]::Round($pf.CurrentUsage / 1KB, 1),
        [math]::Round($pf.PeakUsage / 1KB, 1),
        [math]::Round($pf.AllocatedBaseSize / 1KB, 1)) -ForegroundColor DarkGray
}

if ($overcommit -gt 1.2) {
    Write-Host ''
    Write-Host '  ⚠ Машина в свопе: страницы вытесняются на диск, отсюда общая медлительность.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '  ── ПО ГРУППАМ ─────────────────────────────────────────────' -ForegroundColor DarkGray
$shown = if ($Full) { $groups } else { $groups | Where-Object { $_.CommitMB -ge 200 } }
$shown | Format-Table @{ n = 'Группа'; e = 'Группа'; w = 24 },
    @{ n = 'Проц'; e = 'Проц'; w = 5; a = 'right' },
    @{ n = 'Commit'; e = { '{0:N1} GB' -f ($_.CommitMB / 1KB) }; w = 9; a = 'right' },
    @{ n = 'В RAM'; e = { '{0:N1} GB' -f ($_.RssMB / 1KB) }; w = 9; a = 'right' } |
    Out-String -Width 120 | Write-Host

# "Прочее" копит сотни системных процессов и без разбивки читается как чёрный
# ящик — показываем, из чего именно оно состоит.
$misc = @($rows | Where-Object { $_.Bucket -eq 'Прочее' })
if ($misc.Count -gt 0) {
    $topN = if ($Full) { 15 } else { 6 }
    $miscTop = $misc | Group-Object Name | ForEach-Object {
        [pscustomobject]@{
            Процесс = $_.Name
            Шт      = $_.Count
            MB      = ($_.Group | Measure-Object CommitMB -Sum).Sum
        }
    } | Sort-Object MB -Descending | Select-Object -First $topN

    $miscRest = ($misc | Measure-Object CommitMB -Sum).Sum - (($miscTop | Measure-Object MB -Sum).Sum)
    Write-Host ('  ── ВНУТРИ «ПРОЧЕЕ» (топ {0} из {1} процессов) ─────────────' -f $topN, $misc.Count) -ForegroundColor DarkGray
    $miscTop | Format-Table @{ n = 'Процесс'; e = 'Процесс'; w = 30 },
        @{ n = 'Шт'; e = 'Шт'; w = 4; a = 'right' },
        @{ n = 'Commit'; e = { '{0} MB' -f $_.MB }; w = 10; a = 'right' } |
        Out-String -Width 120 | Write-Host
    if ($miscRest -gt 0) {
        Write-Host ('  …и ещё {0:N1} GB россыпью по остальным.' -f ($miscRest / 1KB)) -ForegroundColor DarkGray
        Write-Host ''
    }
}

# JVM-детали: Xmx и аптайм — то, чего не видно в диспетчере задач.
if ($jvm.Count -gt 0) {
    Write-Host '  ── JVM-ДЕМОНЫ ─────────────────────────────────────────────' -ForegroundColor DarkGray
    $jvm | Sort-Object CommitMB -Descending | ForEach-Object {
        [pscustomobject]@{
            PID     = $_.PID
            Тип     = $_.Bucket -replace '^JVM: ', ''
            Версия  = $_.Ver
            Xmx     = $_.Xmx
            Commit  = '{0:N1} GB' -f ($_.CommitMB / 1KB)
            Аптайм  = Uptime $_.Started
        }
    } | Format-Table -AutoSize | Out-String -Width 120 | Write-Host
}

if ($mcpGroups) {
    Write-Host '  ── MCP-СЕРВЕРЫ ────────────────────────────────────────────' -ForegroundColor DarkGray
    $mcpGroups | ForEach-Object {
        [pscustomobject]@{
            Сервер    = $_.Server
            Процессов = $_.Count
            Commit    = '{0} MB' -f $_.CommitMB
        }
    } | Format-Table -AutoSize | Out-String -Width 120 | Write-Host
}

if ($findings.Count -gt 0) {
    Write-Host '  ── ЧТО ЛИШНЕЕ ─────────────────────────────────────────────' -ForegroundColor DarkGray
    $order = @{ HIGH = 0; MED = 1; INFO = 2 }
    foreach ($f in ($findings | Sort-Object @{ e = { $order[$_.Severity] } }, @{ e = 'CostMB'; d = $true })) {
        $c = switch ($f.Severity) { 'HIGH' { 'Red' } 'MED' { 'Yellow' } default { 'DarkGray' } }
        Write-Host ('  [{0,-4}] ' -f $f.Severity) -NoNewline -ForegroundColor $c
        Write-Host ('{0,7} MB  ' -f $f.CostMB) -NoNewline -ForegroundColor White
        Write-Host $f.What
        Write-Host ('               → {0}' -f $f.Action) -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host ('  К возврату: ~{0:N1} GB commit' -f ($reclaimMB / 1KB)) -NoNewline -ForegroundColor Cyan
    Write-Host (' по {0} процессам (без строк INFO, дубли по PID схлопнуты)' -f $reclaimPids.Count) -ForegroundColor DarkGray
    Write-Host '  Физической памяти освободится меньше — у процесса в свопе RSS ниже commit.' -ForegroundColor DarkGray
}

Write-Host ''
