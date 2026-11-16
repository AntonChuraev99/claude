# worktree-exit-watch.ps1
# PostToolUse hook (matcher: ExitWorktree), user-level. Диагностика и отложенная уборка
# каталога worktree, который ExitWorktree({action:"remove"}) не смог удалить на Windows.
#
# Проблема: в ~половине сессий ExitWorktree отвечает «could not remove it — kept at …»:
# Windows не удаляет каталог, пока он — текущий каталог живого процесса или в нём открыт
# файл. Кто держит, раньше не знал никто; каталог ждал SessionStart-хука worktree-shell-sweep.
#
# Режим hook (по умолчанию, stdin = payload PostToolUse):
#   - ответ тула не про удаление (нет «could not remove» / «removed worktree at») → выход;
#   - каталога уже нет → строка outcome=removed в лог, выход;
#   - каталог остался → сначала запускается скрытый отложенный уборщик (этот же скрипт с
#     -Cleanup) через WMI Win32_Process.Create: вне job-объекта сессии, переживает её выход,
#     окна не открывает; первая попытка — через InitialDelaySec, чтобы снимок успел;
#   - снимок держателей: текущий каталог процесса (PEB), исполняемый файл или командная
#     строка внутри каталога, открытые файлы (Restart Manager по файлам, оставшимся в
#     каталоге: тул уже снёс всё незалоченное); цепочка родителей до сессии Claude;
#     вывод handle64/handle с таймаутом, если он есть в PATH;
#   - строка outcome=kept в ~/.claude/stats/worktree-holders.jsonl;
#   - агенту в контекст — список держателей и что с ними делать.
# Режим -Cleanup: каждые IntervalSec, до MaxWaitSec, пытается снести каталог; правила
# безопасности те же, что у worktree-shell-sweep: только каталог вне `git worktree list`
# (git не отвечает → не трогать); непустой — только если ExitWorktree звали с
# discard_changes:true или локальной ветки worktree-<name> / <name> нет (ветка жива →
# ждать дальше: агент удалит её после подтверждённого merge); rmdir /s /q не проходит внутрь
# junction. Итог — строкой в лог, при отказе — повторный снимок держателей.
# Чужие процессы хук НЕ убивает: решение за агентом (TaskStop своих задач) — ошибка в выборе
# процесса стоила бы пользователю IDE или dev-server другого проекта.
# Fail-open: любая ошибка → exit 0.
#
# Тестовые оверрайды: CLAUDE_WT_WATCH_LOG (путь лога), CLAUDE_WT_WATCH_NO_SPAWN=1 (не
# запускать уборщика), CLAUDE_WT_WATCH_CLEANUP_INLINE=1 (уборщик синхронно, для тестов),
# CLAUDE_WT_WATCH_DEBUG=1 (ошибка fail-open — в stderr).

param(
    [switch]$Cleanup,
    [string]$Path,
    [string]$MainRoot,
    [string]$Session = '',
    [switch]$Discard,
    [int]$IntervalSec = 15,
    [int]$MaxWaitSec = 600,
    [int]$InitialDelaySec = 0,
    [string]$LogFile = ''   # уборщику от WMI окружение хука не достаётся — путь лога идёт параметром
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }   # Claude шлёт UTF-8, а не кодовую страницу консоли

$LogPath = if ($LogFile) { $LogFile } elseif ($env:CLAUDE_WT_WATCH_LOG) { $env:CLAUDE_WT_WATCH_LOG } else {
    Join-Path $env:USERPROFILE '.claude\stats\worktree-holders.jsonl' }

function Normalize([string]$p) { return ($p -replace '/', '\').TrimEnd('\').ToLowerInvariant() }

function Write-Log([hashtable]$rec) {
    try {
        $rec.ts = (Get-Date).ToString('o')
        $dir = Split-Path -Parent $LogPath
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
        [IO.File]::AppendAllText($LogPath, (($rec | ConvertTo-Json -Depth 6 -Compress) + "`n"),
            (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# --- WtCwd: текущий каталог чужого процесса (PEB → ProcessParameters → CurrentDirectory, x64)
# --- WtRm:  процессы, держащие файлы открытыми (Restart Manager, без прав администратора)
$nativeSrc = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WtCwd {
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
    [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
    [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr R3; }
    static byte[] Read(IntPtr h, IntPtr addr, int size) {
        var b = new byte[size]; IntPtr r;
        if (!ReadProcessMemory(h, addr, b, size, out r) || r.ToInt64() != size) return null;
        return b;
    }
    public static string Get(int pid) {
        if (IntPtr.Size != 8) return null;
        IntPtr h = OpenProcess(0x0410, false, pid);   // QUERY_INFORMATION | VM_READ
        if (h == IntPtr.Zero) return null;
        try {
            bool wow; if (IsWow64Process(h, out wow) && wow) return null;
            var pbi = new PBI(); int ret;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return null;
            var p = Read(h, new IntPtr(pbi.Peb.ToInt64() + 0x20), 8); if (p == null) return null;
            var parms = new IntPtr(BitConverter.ToInt64(p, 0));
            var us = Read(h, new IntPtr(parms.ToInt64() + 0x38), 16); if (us == null) return null;
            int len = BitConverter.ToUInt16(us, 0);
            if (len == 0 || len > 4096) return null;
            var s = Read(h, new IntPtr(BitConverter.ToInt64(us, 8)), len); if (s == null) return null;
            return Encoding.Unicode.GetString(s);
        } catch { return null; } finally { CloseHandle(h); }
    }
}
public static class WtRm {
    [StructLayout(LayoutKind.Sequential)] struct UNIQ { public int Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Start; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct INFO {
        public UNIQ Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string App;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string Svc;
        public int AppType; public uint Status; public uint Session; [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, UNIQ[] apps, uint nSvc, string[] svcs);
    [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint n, [In, Out] INFO[] info, ref uint reasons);
    public static int[] Get(string[] files) {
        uint h; var key = new StringBuilder(64);
        if (files == null || files.Length == 0 || RmStartSession(out h, 0, key) != 0) return new int[0];
        try {
            if (RmRegisterResources(h, (uint)files.Length, files, 0, null, 0, null) != 0) return new int[0];
            for (int attempt = 0; attempt < 3; attempt++) {   // список может вырасти между вызовами
                uint needed = 0, n = 0, reasons = 0;
                int r = RmGetList(h, out needed, ref n, null, ref reasons);
                if (r == 0 || needed == 0) return new int[0];
                if (r != 234) return new int[0];   // 234 = ERROR_MORE_DATA
                var info = new INFO[needed + 4]; n = (uint)info.Length;
                r = RmGetList(h, out needed, ref n, info, ref reasons);
                if (r == 234) continue;
                if (r != 0) return new int[0];
                var res = new int[n]; for (int i = 0; i < n; i++) res[i] = info[i].Process.Pid;
                return res;
            }
            return new int[0];
        } catch { return new int[0]; } finally { RmEndSession(h); }
    }
}
'@

function Get-RemainingFiles([string]$dir) {
    # Get-ChildItem -Recurse в pwsh 7 не проходит внутрь junction без -FollowSymlink
    # сначала то, что обычно залочено демонами и dev-server'ами, — в лимит 500 оно попадает первым
    try {
        $all = @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue |
                 Select-Object -First 20000 | ForEach-Object FullName)
        $hot = @($all | Where-Object { $_ -match '\\(build|\.gradle|\.kotlin|node_modules|\.next|\.vite|\.wrangler)\\' })
        $cold = @($all | Where-Object { $_ -notmatch '\\(build|\.gradle|\.kotlin|node_modules|\.next|\.vite|\.wrangler)\\' })
        return @(@($hot) + @($cold) | Select-Object -First 500)
    } catch { return @() }
}

function Get-HandleOutput([string]$dir) {
    $h = Get-Command handle64.exe, handle.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $h) { return $null }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo $h.Source, "-accepteula -nobanner `"$dir`""
        $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $task = $p.StandardOutput.ReadToEndAsync()
        if (-not $p.WaitForExit(5000)) { try { $p.Kill() } catch { }; return '<handle: timeout 5s>' }
        return (($task.Result -split "`r?`n") | Where-Object { $_ } | Select-Object -First 20) -join "`n"
    } catch { return $null }
}

function Get-Holders([string]$dir) {
    $holders = @()
    $norm = Normalize $dir
    # граница имени: …\worktrees\foo не должен совпасть с …\worktrees\foo-bar
    $cmdRe = [regex]([regex]::Escape($norm) + '(?=$|[\\"''\s])')
    try { if (-not ('WtRm' -as [type])) { Add-Type -TypeDefinition $nativeSrc -Language CSharp } } catch { }
    $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $byPid = @{}; foreach ($p in $procs) { $byPid[[int]$p.ProcessId] = $p }

    $files = Get-RemainingFiles $dir
    $filePids = @{}
    try { if ('WtRm' -as [type]) { foreach ($x in [WtRm]::Get([string[]]$files)) { $filePids[[int]$x] = $true } } } catch { }

    # корень сессии Claude — ближайший предок этого процесса с именем claude/node/bun
    $sessionRoot = $null; $mine = @{}
    $cur = $byPid[[int]$PID]; $guard = 0
    while ($cur -and $guard -lt 30) {
        $mine[[int]$cur.ProcessId] = $true
        if (-not $sessionRoot -and $cur.Name -match '^(claude|node|bun)(\.exe)?$') { $sessionRoot = [int]$cur.ProcessId }
        $cur = $byPid[[int]$cur.ParentProcessId]; $guard++
    }

    foreach ($p in $procs) {
        $procId = [int]$p.ProcessId
        if ($procId -eq $PID -or $procId -le 4) { continue }
        $cmdNorm = if ($p.CommandLine) { Normalize ([string]$p.CommandLine) } else { '' }
        if ($cmdNorm.Contains('worktree-exit-watch.ps1')) { continue }   # свои уборщики прошлых вызовов
        $why = @()
        $cwd = $null
        try { if ('WtCwd' -as [type]) { $cwd = [WtCwd]::Get($procId) } } catch { }
        if ($cwd -and ((Normalize $cwd) -eq $norm -or (Normalize $cwd).StartsWith($norm + '\'))) { $why += 'cwd' }
        if ($p.ExecutablePath -and (Normalize $p.ExecutablePath).StartsWith($norm + '\')) { $why += 'exe' }
        if ($filePids.ContainsKey($procId)) { $why += 'file' }
        if ($cmdNorm -and $cmdRe.IsMatch($cmdNorm)) { $why += 'cmdline' }
        if ($why.Count -eq 0) { continue }
        if ($mine.ContainsKey($procId) -and $why -notcontains 'cwd' -and $why -notcontains 'file') { continue }   # своя цепочка с путём в аргументах
        $chain = @(); $c = $byPid[[int]$p.ParentProcessId]; $inSession = $false; $g = 0
        while ($c -and $g -lt 12) {
            $chain += "$($c.Name)#$($c.ProcessId)"
            if ($sessionRoot -and [int]$c.ProcessId -eq $sessionRoot) { $inSession = $true; break }
            $c = $byPid[[int]$c.ParentProcessId]; $g++
        }
        $cmd = [string]$p.CommandLine
        if ($cmd.Length -gt 300) { $cmd = $cmd.Substring(0, 300) + '…' }
        $holders += [ordered]@{
            pid = $procId; name = $p.Name; why = ($why -join ','); cwd = $cwd; cmd = $cmd
            started = $(try { $p.CreationDate.ToString('o') } catch { $null })
            in_session = $inSession; parents = ($chain -join ' < ')
        }
    }
    # «сильные» держатели (cwd/exe/file) — отдельно от совпадений только по командной строке
    $strong = @($holders | Where-Object { $_.why -ne 'cmdline' })
    return @{ holders = $holders; strong = $strong.Count; session_root = $sessionRoot
              files_left = $files.Count; handle = (Get-HandleOutput $dir) }
}

function Get-TopEntries([string]$dir) {
    try { return @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop | Select-Object -First 8 | ForEach-Object Name) }
    catch { return @('<unreadable>') }
}

# $true / $false / $null (git не ответил — состояние неизвестно, удалять нельзя)
function Test-Registered([string]$root, [string]$dir) {
    $porcelain = & git -C $root worktree list --porcelain 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $porcelain) { return $null }
    $reg = @($porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { Normalize $_.Substring(9) })
    return $reg -contains (Normalize $dir)
}

# $true / $false / $null (show-ref: 0 — есть, 1 — нет, иное — ошибка git)
function Test-BranchAlive([string]$root, [string]$name) {
    foreach ($ref in "refs/heads/worktree-$name", "refs/heads/$name") {
        & git -C $root show-ref --verify --quiet $ref 2>$null
        if ($LASTEXITCODE -eq 0) { return $true }
        if ($LASTEXITCODE -ne 1) { return $null }
    }
    return $false
}

function Invoke-Cleanup([string]$dir, [string]$root, [string]$sess, [bool]$discard, [int]$interval, [int]$maxWait, [int]$initialDelay) {
    $name = Split-Path -Leaf $dir
    $start = Get-Date; $attempt = 0; $last = $null; $reason = 'locked'
    if ($initialDelay -gt 0) { Start-Sleep -Seconds $initialDelay }
    while ($true) {
        $attempt++
        $elapsed = [int]((Get-Date) - $start).TotalSeconds
        if (-not (Test-Path -LiteralPath $dir)) {
            Write-Log @{ event = 'cleanup'; outcome = 'gone'; path = $dir; session = $sess; after_sec = $elapsed; attempts = $attempt }
            return
        }
        $reg = Test-Registered $root $dir
        if ($reg -eq $true) {
            Write-Log @{ event = 'cleanup'; outcome = 'skipped_registered'; path = $dir; session = $sess; after_sec = $elapsed }
            return
        }
        if ($null -eq $reg) {
            Write-Log @{ event = 'cleanup'; outcome = 'skipped_git_error'; path = $dir; session = $sess; main_root = $root }
            return
        }
        try {
            $hasItems = $null -ne (Get-ChildItem -LiteralPath $dir -Force | Select-Object -First 1)
            if (-not $hasItems) {
                [IO.Directory]::Delete($dir, $false)
            } else {
                $alive = if ($discard) { $false } else { Test-BranchAlive $root $name }
                if ($null -eq $alive) {
                    Write-Log @{ event = 'cleanup'; outcome = 'skipped_git_error'; path = $dir; session = $sess; main_root = $root }
                    return
                }
                if ($alive) { $reason = 'branch_alive' }   # ждать: агент удалит ветку после подтверждённого merge
                else { $reason = 'locked'; & cmd.exe /d /c "rmdir /s /q `"$dir`"" 2>$null | Out-Null }
            }
        } catch { $last = $_.Exception.Message }
        if (-not (Test-Path -LiteralPath $dir)) {
            Write-Log @{ event = 'cleanup'; outcome = 'deleted'; path = $dir; session = $sess
                         after_sec = [int]((Get-Date) - $start).TotalSeconds; attempts = $attempt }
            return
        }
        if (((Get-Date) - $start).TotalSeconds + $interval -gt $maxWait) { break }
        Start-Sleep -Seconds $interval
    }
    $outcome = if ($reason -eq 'branch_alive') { 'skipped_branch_alive' } else { 'gave_up' }
    $rec = @{ event = 'cleanup'; outcome = $outcome; path = $dir; session = $sess
              after_sec = [int]((Get-Date) - $start).TotalSeconds; attempts = $attempt; error = $last; entries = (Get-TopEntries $dir) }
    if ($outcome -eq 'gave_up') { $snap = Get-Holders $dir; $rec.holders = $snap.holders; $rec.handle = $snap.handle }
    Write-Log $rec
}

function Start-DetachedCleanup([string]$dir, [string]$root, [string]$sess, [bool]$discard) {
    $exe = (Get-Process -Id $PID).Path   # тот же pwsh/powershell, что исполняет хук
    $argLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Cleanup " +
               "-Path `"$dir`" -MainRoot `"$root`" -Session `"$sess`" -LogFile `"$LogPath`" -InitialDelaySec 5"
    if ($discard) { $argLine += ' -Discard' }
    $cmdLine = "`"$exe`" $argLine"
    # WMI создаёт процесс от WmiPrvSE: вне job-объекта сессии Claude (переживёт её выход);
    # ShowWindow=0 — без окна: голый -WindowStyle Hidden на старте консоли мигает.
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $cmdLine; CurrentDirectory = $env:TEMP; ProcessStartupInformation = $startup }
    return [int]$r.ReturnValue
}

# ---------------------------------------------------------------- режим уборщика
if ($Cleanup) {
    try { Invoke-Cleanup $Path $MainRoot $Session ([bool]$Discard) $IntervalSec $MaxWaitSec $InitialDelaySec } catch {
        Write-Log @{ event = 'cleanup'; outcome = 'error'; path = $Path; error = $_.Exception.Message }
    }
    exit 0
}

# ---------------------------------------------------------------- режим хука
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $payload = $raw | ConvertFrom-Json
    if ($payload.tool_name -and $payload.tool_name -ne 'ExitWorktree') { exit 0 }
    $inp = $payload.tool_input
    if (-not $inp -or $inp.action -ne 'remove') { exit 0 }
    $discard = [bool]$inp.discard_changes
    $sess = [string]$payload.session_id

    $resp = $payload.tool_response
    $text = if ($resp -is [string]) { $resp } else { ($resp | ConvertTo-Json -Depth 10 -Compress) -replace '\\\\', '\' }
    # только ответы про удаление: отказы тула (коммиты, чужой worktree) сюда не относятся
    $kept = $text -match 'could not remove'
    if (-not $kept -and $text -notmatch 'removed worktree at') { exit 0 }

    # имя worktree — [A-Za-z0-9._-] (контракт EnterWorktree); внутри совпадения не может начаться
    # другой путь с буквой диска; хвостовая точка предложения отрезается
    $m = [regex]::Match($text, '[A-Za-z]:[\\/](?:(?![A-Za-z]:[\\/])[^«»"“”\r\n])*?[\\/]\.claude[\\/]worktrees[\\/][A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)*')
    if (-not $m.Success) { exit 0 }
    $dir = $m.Value -replace '/', '\'

    $root = $null
    if ($dir -match '^(.*)\\\.claude\\worktrees\\[^\\]+$') { $root = $Matches[1] }
    if (-not $root) { exit 0 }

    if (-not (Test-Path -LiteralPath $dir)) {
        Write-Log @{ event = 'exit'; outcome = 'removed'; path = $dir; session = $sess }
        exit 0
    }

    # уборщик — до снимка: снимок может быть долгим, а таймаут хука его не должен отменить
    $spawn = 'off'
    if ($env:CLAUDE_WT_WATCH_CLEANUP_INLINE -ne '1' -and $env:CLAUDE_WT_WATCH_NO_SPAWN -ne '1') {
        try { $rc = Start-DetachedCleanup $dir $root $sess $discard; $spawn = $(if ($rc -eq 0) { 'started' } else { "failed rc=$rc" }) }
        catch { $spawn = "failed: $($_.Exception.Message)" }
    }

    $entries = Get-TopEntries $dir
    $snap = Get-Holders $dir
    Write-Log @{ event = 'exit'; outcome = $(if ($kept) { 'kept' } else { 'kept_silent' }); path = $dir; session = $sess
                 discard = $discard; entries = $entries; files_left = $snap.files_left; session_root = $snap.session_root
                 strong_holders = $snap.strong; holders = $snap.holders; handle = $snap.handle }

    if ($env:CLAUDE_WT_WATCH_CLEANUP_INLINE -eq '1') { Invoke-Cleanup $dir $root $sess $discard 1 3 0; $spawn = 'inline' }

    $branchNote = ''
    if ((Test-BranchAlive $root (Split-Path -Leaf $dir)) -eq $true) {
        $branchNote = " Local branch for this worktree still exists - after confirming the PR is MERGED delete it: git -C `"$root`" branch -D <branch>; the cleanup keeps polling and removes the directory once the branch is gone."
    }
    $hl = @($snap.holders)
    if ($hl.Count -gt 0) {
        $list = ($hl | ForEach-Object { "$($_.name) pid $($_.pid) [$($_.why)$(if ($_.in_session) { ', started by this session' })]: $($_.cmd)" }) -join '; '
        $ctx = "worktree-exit-watch: directory $dir was NOT removed; it is held by: $list. " +
               "Stop the ones started by this session (TaskStop the background task / Monitor, close dev-server or Playwright browser, stop a Gradle daemon with gradlew --stop); " +
               "do not kill processes this session did not start and do not hand the directory to the user. " +
               "Detached cleanup retries deletion for 10 min (spawn: $spawn); the result goes to $LogPath.$branchNote"
        $screen = "$([char]0x26A0) worktree-exit-watch: каталог worktree держат $($hl.Count) процесс(а): " +
                  (($hl | ForEach-Object { "$($_.name)#$($_.pid)" }) -join ', ') + "; отложенная уборка: $spawn"
    } else {
        $ctx = "worktree-exit-watch: directory $dir was NOT removed and no holder was found by cwd, exe, command line or open files " +
               "($($snap.files_left) files left). Detached cleanup retries deletion for 10 min (spawn: $spawn); " +
               "the result goes to $LogPath. Do not hand the directory to the user.$branchNote"
        $screen = "worktree-exit-watch: каталог worktree остался, держатель не найден; отложенная уборка: $spawn"
    }
    @{
        suppressOutput     = $true
        systemMessage      = $screen
        hookSpecificOutput = @{ hookEventName = 'PostToolUse'; additionalContext = $ctx }
    } | ConvertTo-Json -Depth 5 -Compress
} catch {
    if ($env:CLAUDE_WT_WATCH_DEBUG) { [Console]::Error.WriteLine("$($_.Exception.Message) @ $($_.InvocationInfo.PositionMessage)") }
    exit 0
}
exit 0
