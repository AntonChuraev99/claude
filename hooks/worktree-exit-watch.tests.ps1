# worktree-exit-watch.tests.ps1 — pwsh -NoProfile -File hooks/worktree-exit-watch.tests.ps1
$ErrorActionPreference = 'Stop'
$hook = Join-Path $PSScriptRoot 'worktree-exit-watch.ps1'
$fails = 0
function Check([bool]$cond, [string]$name) {
    if ($cond) { Write-Host "ok   $name" } else { Write-Host "FAIL $name"; $script:fails++ }
}
function Payload([string]$dir, [string]$action = 'remove', [bool]$discard = $true, [string]$verb = 'could not remove it - kept at', [string]$tool = 'ExitWorktree') {
    @{ tool_name = $tool; session_id = 'test-session'; cwd = $env:TEMP
       tool_input = @{ action = $action; discard_changes = $discard }
       tool_response = "Exited worktree but $verb $([char]0x201C)$dir$([char]0x201D). Session is now back in $([char]0x201C)C:\x$([char]0x201D)." } | ConvertTo-Json -Compress
}
function Run([string]$json) { $json | pwsh -NoProfile -File $hook }
function LogLines { if (Test-Path $env:CLAUDE_WT_WATCH_LOG) { @(Get-Content $env:CLAUDE_WT_WATCH_LOG | ForEach-Object { $_ | ConvertFrom-Json }) } else { @() } }

$fx = Join-Path ([IO.Path]::GetTempPath()) ("wt-watch-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $fx | Out-Null
$env:CLAUDE_WT_WATCH_LOG = Join-Path $fx 'holders.jsonl'
$holder = $null
try {
    git -C $fx init -q -b main 2>$null
    git -C $fx -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
    $wt = Join-Path $fx '.claude\worktrees'
    New-Item -ItemType Directory $wt | Out-Null

    # 1. каталог удалён — строка removed, вывода нет
    $env:CLAUDE_WT_WATCH_NO_SPAWN = '1'
    $out = Run (Payload (Join-Path $wt 'gone') 'remove' $true 'removed worktree at')
    Check ([string]::IsNullOrWhiteSpace($out)) 'removed: silent'
    Check ((LogLines)[-1].outcome -eq 'removed') 'removed: logged outcome=removed'

    # 2. keep, чужой тул, ответ-отказ — no-op
    Check ([string]::IsNullOrWhiteSpace((Run (Payload (Join-Path $wt 'x') 'keep')))) 'action keep: no-op'
    Check ([string]::IsNullOrWhiteSpace((Run (Payload (Join-Path $wt 'x') 'remove' $true 'could not remove it - kept at' 'Bash')))) 'other tool: no-op'
    $refusal = New-Item -ItemType Directory (Join-Path $wt 'refused')
    $n0 = @(LogLines).Count
    Check ([string]::IsNullOrWhiteSpace((Run (Payload $refusal.FullName 'remove' $true 'is not the owner of the worktree at')))) 'refusal text: no-op'
    Check (@(LogLines).Count -eq $n0) 'refusal text: nothing logged'

    # 2b. ответ, где путь сессии стоит раньше пути worktree, — берётся путь worktree
    $j0 = @{ tool_name = 'ExitWorktree'; tool_input = @{ action = 'remove'; discard_changes = $true }
             tool_response = "Session is now back in C:\repo. Could not remove $($refusal.FullName)" } | ConvertTo-Json -Compress
    $env:CLAUDE_WT_WATCH_NO_SPAWN = '1'
    Run $j0 | Out-Null
    Check ((LogLines)[-1].path -eq $refusal.FullName -and (LogLines)[-1].outcome -eq 'kept') 'path not glued to earlier drive path'
    Remove-Item -LiteralPath $refusal.FullName

    # 3. каталог держит процесс с cwd внутри — найден, в логе и в контексте
    $held = New-Item -ItemType Directory (Join-Path $wt 'held')
    Set-Content (Join-Path $held 'file.txt') 'x'
    $holder = Start-Process pwsh -ArgumentList '-NoProfile -Command Start-Sleep 120' -WorkingDirectory $held.FullName -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 1500
    $out = Run (Payload $held.FullName)
    $j = $out | ConvertFrom-Json
    Check ($j.hookSpecificOutput.additionalContext -match "pid $($holder.Id) \[cwd") 'held: holder pid with cwd in context'
    Check ($j.systemMessage -match "#$($holder.Id)") 'held: holder on screen'
    $rec = (LogLines)[-1]
    Check ($rec.outcome -eq 'kept' -and @($rec.holders | Where-Object { $_.pid -eq $holder.Id -and $_.why -match 'cwd' }).Count -eq 1) 'held: logged outcome=kept with holder'
    Check ($rec.entries -contains 'file.txt') 'held: logged top entries'
    Check (Test-Path (Join-Path $held 'file.txt')) 'held: NO_SPAWN leaves directory alone'

    # 4. inline-уборка, пока держатель жив — каталог не снесён, итог gave_up со снимком
    $env:CLAUDE_WT_WATCH_NO_SPAWN = $null; $env:CLAUDE_WT_WATCH_CLEANUP_INLINE = '1'
    Run (Payload $held.FullName) | Out-Null
    $rec = (LogLines)[-1]
    Check ($rec.event -eq 'cleanup' -and $rec.outcome -eq 'gave_up') 'held + inline cleanup: gave_up'
    Check (@($rec.holders | Where-Object { $_.pid -eq $holder.Id }).Count -eq 1) 'gave_up: holder snapshot repeated'
    Stop-Process -Id $holder.Id -Force; $holder = $null; Start-Sleep -Milliseconds 500

    # 4b. держатель открытого файла (cwd вне каталога) — найден Restart Manager'ом;
    #     процесс с соседним именем в командной строке — не держатель
    $env:CLAUDE_WT_WATCH_CLEANUP_INLINE = $null; $env:CLAUDE_WT_WATCH_NO_SPAWN = '1'
    $locked = Join-Path $held 'locked.bin'; Set-Content $locked 'x'
    $fileHolder = Start-Process pwsh -ArgumentList "-NoProfile -Command `$f=[IO.File]::Open('$locked','Open','Read','None'); Start-Sleep 120" -WorkingDirectory $env:TEMP -WindowStyle Hidden -PassThru
    $neighbour = Start-Process pwsh -ArgumentList "-NoProfile -Command Start-Sleep 120 # $($held.FullName)-bar" -WorkingDirectory $env:TEMP -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 2000
    Run (Payload $held.FullName) | Out-Null
    $rec = (LogLines)[-1]
    Check (@($rec.holders | Where-Object { $_.pid -eq $fileHolder.Id -and $_.why -match 'file' }).Count -eq 1) 'open-file holder found (Restart Manager)'
    Check (@($rec.holders | Where-Object { $_.pid -eq $neighbour.Id }).Count -eq 0) 'neighbour name in cmdline is not a holder'
    Stop-Process -Id $fileHolder.Id, $neighbour.Id -Force; Start-Sleep -Milliseconds 500
    Remove-Item -LiteralPath $locked -Force
    $env:CLAUDE_WT_WATCH_NO_SPAWN = $null; $env:CLAUDE_WT_WATCH_CLEANUP_INLINE = '1'

    # 5. держатель ушёл, discard=true — снесён; junction-цель цела
    $target = New-Item -ItemType Directory (Join-Path $fx 'shared')
    Set-Content (Join-Path $target 'pkg.js') 'x'
    New-Item -ItemType Junction -Path (Join-Path $held 'node_modules') -Target $target.FullName | Out-Null
    Run (Payload $held.FullName) | Out-Null
    Check (-not (Test-Path $held.FullName)) 'released + discard: directory deleted'
    Check ((LogLines)[-1].outcome -eq 'deleted') 'released: logged outcome=deleted'
    Check (Test-Path (Join-Path $target 'pkg.js')) 'junction target untouched'

    # 6. непустой, живая ветка, discard=false — не трогать
    git -C $fx branch worktree-kept 2>$null
    $kept = New-Item -ItemType Directory (Join-Path $wt 'kept')
    Set-Content (Join-Path $kept 'work.txt') 'x'
    $out = Run (Payload $kept.FullName 'remove' $false)
    Check (Test-Path (Join-Path $kept 'work.txt')) 'live branch + no discard: untouched'
    Check ((LogLines)[-1].outcome -eq 'skipped_branch_alive') 'live branch: logged skipped_branch_alive'
    Check (($out | ConvertFrom-Json).hookSpecificOutput.additionalContext -match 'branch -D') 'live branch: context names branch cleanup'

    # 7. зарегистрированный worktree — не трогать
    git -C $fx worktree add -q (Join-Path $wt 'live') -b live 2>$null
    Run (Payload (Join-Path $wt 'live')) | Out-Null
    Check (Test-Path (Join-Path $wt 'live\.git')) 'registered worktree untouched'
    Check ((LogLines)[-1].outcome -eq 'skipped_registered') 'registered: logged skipped_registered'

    # 7b. git не отвечает (главный checkout — не репозиторий) — непустой каталог не трогать
    $script:nogitRoot = Join-Path ([IO.Path]::GetTempPath()) ("wt-nogit-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $nogit = Join-Path $nogitRoot '.claude\worktrees\orphan'   # вне любого репозитория
    New-Item -ItemType Directory -Force $nogit | Out-Null
    Set-Content (Join-Path $nogit 'work.txt') 'x'
    Run (Payload $nogit 'remove' $false) | Out-Null
    Check (Test-Path (Join-Path $nogit 'work.txt')) 'git error: directory untouched'
    Check ((LogLines)[-1].outcome -eq 'skipped_git_error') 'git error: logged skipped_git_error'

    # 8. настоящий отвязанный уборщик через WMI: пустой каталог исчезает сам
    $env:CLAUDE_WT_WATCH_CLEANUP_INLINE = $null
    $shell = New-Item -ItemType Directory (Join-Path $wt 'shell')
    $out = Run (Payload $shell.FullName)
    Check ((($out | ConvertFrom-Json).hookSpecificOutput.additionalContext) -match 'spawn: started') 'detached cleanup started'
    $deadline = (Get-Date).AddSeconds(30)
    while ((Test-Path $shell.FullName) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    Check (-not (Test-Path $shell.FullName)) 'detached cleanup removed empty shell'
    Start-Sleep -Milliseconds 500
    Check (@(LogLines | Where-Object { $_.event -eq 'cleanup' -and $_.path -eq $shell.FullName -and $_.outcome -in 'deleted', 'gone' }).Count -eq 1) 'detached cleanup logged result'

    # 9. мусор на stdin — fail-open
    'not json' | pwsh -NoProfile -File $hook | Out-Null
    Check ($LASTEXITCODE -eq 0) 'garbage stdin: exit 0'
} finally {
    if ($holder) { Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue }
    $env:CLAUDE_WT_WATCH_NO_SPAWN = $null; $env:CLAUDE_WT_WATCH_CLEANUP_INLINE = $null; $env:CLAUDE_WT_WATCH_LOG = $null
    git -C $fx worktree remove --force (Join-Path $fx '.claude\worktrees\live') 2>$null
    Remove-Item -LiteralPath $fx -Recurse -Force -ErrorAction SilentlyContinue
    if ($script:nogitRoot) { Remove-Item -LiteralPath $script:nogitRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($fails) { Write-Host "$fails failed"; exit 1 } else { Write-Host 'all passed' }
