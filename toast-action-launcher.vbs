' Invisible launcher for toast-action.ps1 — avoids PowerShell window flash
' Usage (from registered protocol handler): wscript.exe toast-action-launcher.vbs "<uri>"
Option Explicit

Dim sh, ps, scriptPath, uri, cmd
If WScript.Arguments.Count < 1 Then WScript.Quit 0

uri = WScript.Arguments(0)
scriptPath = WScript.Arguments.Named.Item("script")
If Len(scriptPath) = 0 Then scriptPath = CreateObject("WScript.Shell").ExpandEnvironmentStrings("%USERPROFILE%\.claude\toast-action.ps1")

' Prefer PS7 (pwsh) if available, fallback to Windows PowerShell
ps = "pwsh.exe"
On Error Resume Next
Dim test
test = CreateObject("WScript.Shell").Run("pwsh.exe -NoProfile -Command exit", 0, True)
If Err.Number <> 0 Then
  ps = "powershell.exe"
End If
Err.Clear
On Error Goto 0

cmd = ps & " -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """ """ & uri & """"

Set sh = CreateObject("WScript.Shell")
sh.Run cmd, 0, False  ' 0 = SW_HIDE, False = don't wait
