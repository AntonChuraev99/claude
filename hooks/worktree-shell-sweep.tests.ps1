# worktree-shell-sweep.tests.ps1 — pwsh -NoProfile -File hooks/worktree-shell-sweep.tests.ps1
$ErrorActionPreference = 'Stop'
$hook = Join-Path $PSScriptRoot 'worktree-shell-sweep.ps1'
$fails = 0
function Check([bool]$cond, [string]$name) {
    if ($cond) { Write-Host "ok   $name" } else { Write-Host "FAIL $name"; $script:fails++ }
}

$fx = Join-Path ([IO.Path]::GetTempPath()) ("wt-sweep-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $fx | Out-Null
try {
    git -C $fx init -q -b main 2>$null
    git -C $fx -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
    $wt = Join-Path $fx '.claude\worktrees'
    New-Item -ItemType Directory $wt | Out-Null
    git -C $fx worktree add -q (Join-Path $wt 'live') -b live 2>$null

    $shell = New-Item -ItemType Directory (Join-Path $wt 'shell')
    # недоснесённый worktree с живой веткой — не трогать
    git -C $fx branch worktree-kept 2>$null
    $kept  = New-Item -ItemType Directory (Join-Path $wt 'kept')
    Set-Content (Join-Path $kept 'keep.txt') 'x'
    # недоснесённый worktree без ветки, внутри junction на внешний каталог — снести, цель цела
    $target = New-Item -ItemType Directory (Join-Path $fx 'shared-node-modules')
    Set-Content (Join-Path $target 'pkg.js') 'x'
    $half  = New-Item -ItemType Directory (Join-Path $wt 'half')
    Set-Content (Join-Path $half 'leftover.txt') 'x'
    New-Item -ItemType Junction -Path (Join-Path $half 'node_modules') -Target $target.FullName | Out-Null
    $old = (Get-Date).AddHours(-1)
    foreach ($n in 'shell', 'kept', 'half') { (Get-Item (Join-Path $wt $n)).LastWriteTime = $old }
    New-Item -ItemType Directory (Join-Path $wt 'fresh') | Out-Null   # моложе порога

    $out = (@{ cwd = (Join-Path $wt 'live') } | ConvertTo-Json -Compress) | pwsh -NoProfile -File $hook
    Check (-not (Test-Path (Join-Path $wt 'shell'))) 'empty old unregistered shell removed'
    Check (-not (Test-Path (Join-Path $wt 'half'))) 'half-removed dir without branch removed'
    Check (Test-Path (Join-Path $target 'pkg.js')) 'junction target untouched'
    Check (Test-Path (Join-Path $kept 'keep.txt')) 'half-removed dir with live branch untouched'
    Check (Test-Path (Join-Path $wt 'fresh')) 'fresh empty dir kept (race guard)'
    Check (Test-Path (Join-Path $wt 'live\.git')) 'registered worktree untouched'
    $j = $out | ConvertFrom-Json
    Check ($j.hookSpecificOutput.additionalContext -match 'removed empty worktree shells: shell') 'context reports removal'
    Check ($j.hookSpecificOutput.additionalContext -match 'half-deleted worktree dirs .*: half') 'context reports half-removed'
    Check ($j.hookSpecificOutput.additionalContext -match 'untouched .*: kept') 'context reports leftover'

    $out2 = (@{ cwd = $fx } | ConvertTo-Json -Compress) | pwsh -NoProfile -File $hook
    Check (($out2 | ConvertFrom-Json).hookSpecificOutput.additionalContext -notmatch 'removed') 'second run: nothing to remove'

    $out3 = (@{ cwd = [IO.Path]::GetTempPath() } | ConvertTo-Json -Compress) | pwsh -NoProfile -File $hook
    Check ([string]::IsNullOrWhiteSpace($out3) -and $LASTEXITCODE -eq 0) 'non-git cwd: silent no-op'
} finally {
    git -C $fx worktree remove --force (Join-Path $fx '.claude\worktrees\live') 2>$null
    Remove-Item -LiteralPath $fx -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fails) { Write-Host "$fails failed"; exit 1 } else { Write-Host 'all passed' }
