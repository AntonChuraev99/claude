[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet("Stop", "Notification", "SubagentStop")]
    [string]$EventType = "Stop"
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

# ---------- Force UTF-8 on console streams (stdin from hook is UTF-8 JSON) ----------
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
try {
    [Console]::InputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
} catch { }

# ---------- Debug log (raw .NET write to guarantee UTF-8 regardless of existing file BOM) ----------
$logFile = "$env:USERPROFILE\.claude\notify_debug.log"
function Write-DebugLog([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [$EventType] $msg`r`n"
    try {
        [System.IO.File]::AppendAllText($logFile, $line, [System.Text.Encoding]::UTF8)
    } catch { }
}
Write-DebugLog "Script started"

# ---------- Read stdin (UTF-8) ----------
$rawInput = ""
try {
    $stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8NoBom)
    $rawInput = $stdin.ReadToEnd()
} catch {
    Write-DebugLog "stdin read error: $_"
}
Write-DebugLog "stdin length: $($rawInput.Length)"

# ---------- Parse JSON ----------
$data = $null
try {
    if ($rawInput.Trim()) {
        $data = $rawInput | ConvertFrom-Json -ErrorAction Stop
    }
} catch {
    Write-DebugLog "JSON parse error: $_"
}

$cwd        = $null
$sessionId  = $null
$message    = $null
$lastMsg    = $null
if ($data) {
    $cwd       = $data.cwd
    $sessionId = $data.session_id
    $message   = $data.message
    $lastMsg   = $data.last_assistant_message
}
Write-DebugLog "cwd=$cwd | session=$sessionId"

# ---------- Project name + git branch ----------
$projectName = if ($cwd) { Split-Path -Leaf $cwd } else { "Claude Code" }
$branch = ""
if ($cwd -and (Test-Path $cwd)) {
    try {
        $b = & git -C $cwd rev-parse --abbrev-ref HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $b) { $branch = $b.Trim() }
    } catch { }
}

# ---------- Profile indicator (kept for session metadata only, no longer shown in title) ----------
$profileTag = "P"
if ($env:CLAUDE_CONFIG_DIR -and $env:CLAUDE_CONFIG_DIR -match "claude-work") {
    $profileTag = "W"
}

# ---------- Title / Subtitle ----------
$titleSuffix = switch ($EventType) {
    "Notification" { " — вопрос" }
    "SubagentStop" { " — субагент готов" }
    default        { " — готово" }
}
if ($branch) {
    # branch becomes the bold title line, project + suffix is shown below it
    $title    = $branch
    $subtitle = "$projectName$titleSuffix"
} else {
    $title    = "$projectName$titleSuffix"
    $subtitle = $null
}

# ---------- Body (preview cleanup) ----------
function Format-Preview {
    param([string]$text)
    if (-not $text) { return "" }
    $t = $text
    $t = $t -replace '```[\s\S]*?```', ' [code] '
    $t = $t -replace '`([^`]+)`', '$1'
    $t = $t -replace '\*\*([^*]+)\*\*', '$1'
    $t = $t -replace '__([^_]+)__', '$1'
    $t = $t -replace '\*([^*]+)\*', '$1'
    $t = $t -replace '_([^_]+)_', '$1'
    $t = $t -replace '\[([^\]]+)\]\([^)]+\)', '$1'
    $t = $t -replace '(?m)^#{1,6}\s*', ''
    $t = $t -replace '(?m)^\s*[-*+]\s+', ''
    $t = $t -replace '(?m)^\s*\d+\.\s+', ''
    $t = $t -replace '\s+', ' '
    return $t.Trim()
}

$body = switch ($EventType) {
    "Notification" { if ($message) { $message } else { "Ожидает ответ" } }
    default        { Format-Preview $lastMsg }
}
if (-not $body) { $body = "Задача выполнена" }

$maxLen = 220
if ($body.Length -gt $maxLen) {
    $body = $body.Substring(0, $maxLen).TrimEnd() + "..."
}
Write-DebugLog "Title: $title"
Write-DebugLog "Body length: $($body.Length)"

# ---------- Register custom protocol handler (idempotent) ----------
$protoName = "claude-toast"
$protoKey  = "HKCU:\Software\Classes\$protoName"
$launcherVbs = "$env:USERPROFILE\.claude\toast-action-launcher.vbs"
$expectedCmd = "wscript.exe `"$launcherVbs`" `"%1`""

$needRegister = $false
if (-not (Test-Path "$protoKey\shell\open\command")) {
    $needRegister = $true
} else {
    $currentCmd = (Get-ItemProperty -Path "$protoKey\shell\open\command" -Name "(default)" -ErrorAction SilentlyContinue)."(default)"
    if ($currentCmd -ne $expectedCmd) { $needRegister = $true }
}

if ($needRegister) {
    try {
        New-Item -Path $protoKey -Force | Out-Null
        Set-ItemProperty -Path $protoKey -Name "(default)" -Value "URL:Claude Code Toast Action" -Force
        Set-ItemProperty -Path $protoKey -Name "URL Protocol" -Value "" -Force
        New-Item -Path "$protoKey\shell\open\command" -Force | Out-Null
        Set-ItemProperty -Path "$protoKey\shell\open\command" -Name "(default)" -Value $expectedCmd -Force
        Write-DebugLog "Registered protocol handler: $protoName"
    } catch {
        Write-DebugLog "Protocol handler registration failed: $_"
    }
}

# ---------- Find parent terminal PID for focus-terminal action ----------
$terminalPid = $null
try {
    $cur = $PID
    for ($i = 0; $i -lt 8; $i++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
        if (-not $proc) { break }
        $parentId = $proc.ParentProcessId
        if (-not $parentId) { break }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
        if (-not $parent) { break }
        if ($parent.Name -in @("warp.exe", "Warp.exe", "WindowsTerminal.exe", "wt.exe", "Code.exe", "Cursor.exe", "WindsurfNext.exe", "Hyper.exe", "Tabby.exe")) {
            $terminalPid = $parentId
            break
        }
        $cur = $parentId
    }
} catch {
    Write-DebugLog "Parent terminal lookup failed: $_"
}
Write-DebugLog "Terminal PID: $terminalPid"

# ---------- Store session info ----------
if ($sessionId) {
    try {
        $sessionData = [ordered]@{
            session_id    = $sessionId
            cwd           = $cwd
            terminal_pid  = $terminalPid
            profile_tag   = $profileTag
            event_type    = $EventType
            timestamp     = (Get-Date).ToString("o")
        }
        $sessionFile = "$env:TEMP\claude-session-$sessionId.json"
        $sessionJson = $sessionData | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($sessionFile, $sessionJson, $utf8NoBom)
    } catch {
        Write-DebugLog "Session info store failed: $_"
    }
}

# ---------- Build action buttons ----------
function Build-ProtocolArg {
    param([hashtable]$Parts)
    $pairs = @()
    foreach ($k in $Parts.Keys) {
        if ($null -ne $Parts[$k] -and "$($Parts[$k])" -ne "") {
            $pairs += "$k=$([Uri]::EscapeDataString([string]$Parts[$k]))"
        }
    }
    return "claude-toast:" + ($pairs -join '&')
}

try {
    Import-Module BurntToast -ErrorAction Stop

    $buttons = @()

    $openFolderArg = Build-ProtocolArg @{ action = "open-folder"; session = $sessionId; path = $cwd }
    $buttons += New-BTButton -Content "Open folder" -Arguments $openFolderArg -ActivationType Protocol

    if ($terminalPid -and $EventType -ne "SubagentStop") {
        $focusArg = Build-ProtocolArg @{ action = "focus-terminal"; session = $sessionId }
        $buttons += New-BTButton -Content "Focus terminal" -Arguments $focusArg -ActivationType Protocol
    }

    # ---------- AppLogo per event type ----------
    $logoFile = switch ($EventType) {
        "Notification" { "$env:USERPROFILE\.claude\assets\events\notification.png" }
        "SubagentStop" { "$env:USERPROFILE\.claude\assets\events\subagent.png" }
        default        { "$env:USERPROFILE\.claude\assets\events\stop.png" }
    }

    $uid = if ($sessionId) { "claude-$projectName-$sessionId-$EventType" } else { "claude-$projectName-$EventType" }
    if ($uid.Length -gt 60) { $uid = $uid.Substring(0, 60) }

    # Sound policy:
    #   Stop / SubagentStop: short Default / IM sound -- doesn't duck music
    #   Notification: SILENT -- alarm-loop sound (Alarm2) duck'ает воспроизведение
    $textLines = if ($subtitle) { @($title, $subtitle, $body) } else { @($title, $body) }
    $btParams = @{
        Text             = $textLines
        UniqueIdentifier = $uid
        Button           = $buttons
    }
    if ($EventType -eq "Notification") {
        $btParams['Silent'] = $true
    } else {
        $btParams['Sound'] = if ($EventType -eq "SubagentStop") { 'IM' } else { 'Default' }
    }
    if (Test-Path $logoFile) { $btParams['AppLogo'] = $logoFile }

    New-BurntToastNotification @btParams -ErrorAction Stop
    Write-DebugLog "Toast shown via BurntToast (uid=$uid)"
} catch {
    Write-DebugLog "BurntToast failed: $_ - fallback to native WinRT"
    try {
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
        $escTitle = [System.Security.SecurityElement]::Escape($title)
        $escBody  = [System.Security.SecurityElement]::Escape($body)
        if ($subtitle) {
            $escSubtitle = [System.Security.SecurityElement]::Escape($subtitle)
            $toastXml = "<toast><visual><binding template='ToastGeneric'><text id='1'>$escTitle</text><text id='2'>$escSubtitle</text><text id='3'>$escBody</text></binding></visual><audio silent='false'/></toast>"
        } else {
            $toastXml = "<toast><visual><binding template='ToastGeneric'><text id='1'>$escTitle</text><text id='2'>$escBody</text></binding></visual><audio silent='false'/></toast>"
        }
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($toastXml)
        $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Claude Code").Show($toast)
        Write-DebugLog "Fallback WinRT toast shown"
    } catch {
        Write-DebugLog "Fallback WinRT also failed: $_"
    }
}
