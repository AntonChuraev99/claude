[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Uri
)

$ErrorActionPreference = "Continue"

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
try {
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
} catch { }

$logFile = "$env:USERPROFILE\.claude\toast-action.log"
function Write-ActionLog([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg`r`n"
    try {
        [System.IO.File]::AppendAllText($logFile, $line, [System.Text.Encoding]::UTF8)
    } catch { }
}
Write-ActionLog "Invoked with: $Uri"

# ---------- Parse URI: claude-toast:action=...&session=...&path=... ----------
$payload = ""
if ($Uri -match '^claude-toast:(.*)$') {
    $payload = $matches[1]
    $payload = $payload.TrimStart('/')
}

$params = @{}
foreach ($pair in ($payload -split '&')) {
    if (-not $pair) { continue }
    $kv = $pair -split '=', 2
    if ($kv.Count -eq 2) {
        $params[$kv[0]] = [Uri]::UnescapeDataString($kv[1])
    } else {
        $params[$kv[0]] = ""
    }
}

$action  = $params['action']
$session = $params['session']
$path    = $params['path']
Write-ActionLog "action=$action | session=$session | path=$path"

# ---------- Restore from session file if path missing ----------
if (-not $path -and $session) {
    $sessionFile = "$env:TEMP\claude-session-$session.json"
    if (Test-Path $sessionFile) {
        try {
            $sessionData = Get-Content -Path $sessionFile -Encoding utf8 -Raw | ConvertFrom-Json
            if (-not $path) { $path = $sessionData.cwd }
        } catch {
            Write-ActionLog "Session file parse error: $_"
        }
    }
}

# ---------- IDE resolution ----------
function Resolve-Ide {
    param([string]$ProjectPath)
    if (-not $ProjectPath -or -not (Test-Path $ProjectPath)) { return $null }

    $isJvmProject =
        (Test-Path (Join-Path $ProjectPath ".idea")) -or
        (Test-Path (Join-Path $ProjectPath "build.gradle.kts")) -or
        (Test-Path (Join-Path $ProjectPath "build.gradle")) -or
        (Test-Path (Join-Path $ProjectPath "settings.gradle.kts")) -or
        (Test-Path (Join-Path $ProjectPath "settings.gradle")) -or
        ((Get-ChildItem -Path $ProjectPath -Filter *.iml -ErrorAction SilentlyContinue | Select-Object -First 1) -ne $null)

    $isNodeProject = Test-Path (Join-Path $ProjectPath "package.json")

    if ($isJvmProject) {
        $candidates = @(
            "$env:LOCALAPPDATA\Programs\Android Studio\bin\studio64.exe",
            "${env:ProgramFiles}\Android\Android Studio\bin\studio64.exe",
            "${env:ProgramFiles(x86)}\Android\Android Studio\bin\studio64.exe"
        )
        foreach ($c in $candidates) {
            if ($c -and (Test-Path $c)) { return @{ Exe = $c; Args = @($ProjectPath) } }
        }
        $studioCmd = Get-Command studio64.exe -ErrorAction SilentlyContinue
        if ($studioCmd) { return @{ Exe = $studioCmd.Source; Args = @($ProjectPath) } }

        $ideaCmd = Get-Command idea64.exe -ErrorAction SilentlyContinue
        if ($ideaCmd) { return @{ Exe = $ideaCmd.Source; Args = @($ProjectPath) } }
    }

    if ($isNodeProject) {
        $codeCmd = Get-Command code.cmd -ErrorAction SilentlyContinue
        if (-not $codeCmd) { $codeCmd = Get-Command code -ErrorAction SilentlyContinue }
        if ($codeCmd) { return @{ Exe = $codeCmd.Source; Args = @($ProjectPath) } }
        $cursorCmd = Get-Command cursor.cmd -ErrorAction SilentlyContinue
        if ($cursorCmd) { return @{ Exe = $cursorCmd.Source; Args = @($ProjectPath) } }
    }

    return $null
}

# ---------- Window activation via P/Invoke ----------
function Initialize-NativeMethods {
    if (-not ('NativeMethods' -as [type])) {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeMethods {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
}
"@
    }
}

function Set-WindowForeground {
    param([int]$ProcessId)
    if (-not $ProcessId) { return $false }
    try {
        Initialize-NativeMethods
        $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if (-not $proc) { return $false }
        $hwnd = $proc.MainWindowHandle
        if ($hwnd -eq [IntPtr]::Zero) { return $false }
        [void][NativeMethods]::AllowSetForegroundWindow($ProcessId)
        if ([NativeMethods]::IsIconic($hwnd)) {
            [void][NativeMethods]::ShowWindowAsync($hwnd, 9)  # SW_RESTORE
        }
        [void][NativeMethods]::SetForegroundWindow($hwnd)
        return $true
    } catch {
        Write-ActionLog "Window activation failed: $_"
        return $false
    }
}

# Fallback: find any running Warp window (when session terminal_pid is stale/missing)
function Find-WarpWindow {
    $warp = Get-Process -Name warp -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
            Select-Object -First 1
    if ($warp) { return $warp.Id } else { return $null }
}

# ---------- Dispatch ----------
switch ($action) {
    "open-folder" {
        if ($path -and (Test-Path $path)) {
            Start-Process explorer.exe -ArgumentList $path
            Write-ActionLog "Opened folder: $path"
        } else {
            Write-ActionLog "open-folder: path missing or not exists ($path)"
        }
    }
    "open-ide" {
        $ide = Resolve-Ide -ProjectPath $path
        if ($ide) {
            try {
                Start-Process -FilePath $ide.Exe -ArgumentList $ide.Args
                Write-ActionLog "Opened IDE: $($ide.Exe) $path"
            } catch {
                Write-ActionLog "IDE launch failed: $_ - falling back to Explorer"
                if ($path -and (Test-Path $path)) { Start-Process explorer.exe -ArgumentList $path }
            }
        } else {
            Write-ActionLog "No IDE resolved for $path - falling back to Explorer"
            if ($path -and (Test-Path $path)) { Start-Process explorer.exe -ArgumentList $path }
        }
    }
    "focus-terminal" {
        $terminalPid = $null
        if ($session) {
            $sessionFile = "$env:TEMP\claude-session-$session.json"
            if (Test-Path $sessionFile) {
                try {
                    $sessionData = Get-Content -Path $sessionFile -Encoding utf8 -Raw | ConvertFrom-Json
                    $terminalPid = $sessionData.terminal_pid
                } catch { Write-ActionLog "Session read error: $_" }
            }
        }

        $ok = $false
        if ($terminalPid) {
            $ok = Set-WindowForeground -ProcessId $terminalPid
            Write-ActionLog "Focus terminal (session pid=$terminalPid) result=$ok"
        }
        if (-not $ok) {
            $warpPid = Find-WarpWindow
            if ($warpPid) {
                $ok = Set-WindowForeground -ProcessId $warpPid
                Write-ActionLog "Focus terminal fallback (warp pid=$warpPid) result=$ok"
            } else {
                Write-ActionLog "focus-terminal: no terminal_pid and no warp.exe with visible window"
            }
        }
    }
    default {
        Write-ActionLog "Unknown action: $action"
    }
}
