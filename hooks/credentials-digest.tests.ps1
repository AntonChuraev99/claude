# credentials-digest.tests.ps1 — suite for credentials-digest.ps1 (SessionStart hook).
# Dependency-free: spawns the hook as a child pwsh with piped stdin, asserts on JSON stdout.
# The registry is redirected to a temp fixture via $env:CLAUDE_HOME, and `gcloud` is a
# fake .cmd shim prepended to PATH, so the suite never touches real credentials, real
# tokens or the network. Shim texts: `:reauth` is verbatim gcloud stderr from
# %APPDATA%\gcloud\logs on this machine (2026-08-19 … 09-09); `:rapt` is the firebase-tools /
# google-auth wording under the same policy; `:revoked` and `:nologin` reconstruct the gcloud
# format (not seen in the logs). Exit code = failed count.
# Run: pwsh -NoProfile -File hooks/credentials-digest.tests.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$hook = Join-Path $PSScriptRoot 'credentials-digest.ps1'
# PATH is overridden inside cases, so the child pwsh must be addressed by absolute path.
$pwshExe = (Get-Process -Id $PID).Path
$script:pass = 0
$script:fail = 0

# --- fixture: profile dir with a registry, repo dirs, fake gcloud on PATH ---
$fx = Join-Path ([System.IO.Path]::GetTempPath()) ("cdg-fx-" + [guid]::NewGuid().ToString('N'))
$profileDir = Join-Path $fx 'home'
$bin = Join-Path $fx 'bin'
$repos = Join-Path $fx 'repos'
$argsFile = Join-Path $fx 'gcloud-args.txt'
foreach ($d in @("$profileDir\config", $bin, "$repos\gcp-app\.claude\worktrees\t", "$repos\plain",
                 "$repos\stranger", "$repos\unknown\.git", "$repos\nogit", "$fx\empty")) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

@"
# Реестр кредов проектов

| repo_path | account | gcp_project | cf_account_id | firebase_project | play_package | git_remote |
|---|---|---|---|---|---|---|
| $repos\gcp-app | user@example.com (GitHub someone) | proj-1 |  | proj-1 | com.example.app | https://github.com/org/app.git |
| $repos\plain | user@example.com |  |  |  |  | https://github.com/org/plain.git |

## Не наши репозитории — в реестр не заводить

| путь | что это |
|---|---|
| ``$repos\stranger`` | чужой артефакт |
"@ | Set-Content -LiteralPath (Join-Path $profileDir 'config\project-credentials.local.md') -Encoding UTF8

# Fake gcloud: records its argv, then replays one canned outcome chosen by FAKE_GCLOUD_MODE.
# `:orphan` reproduces the .cmd-shim trap: the shim exits after ~6 s, but a grandchild that
# inherited the stdout/stderr pipes keeps them open for ~30 s.
@'
@echo off
echo %* > "%FAKE_GCLOUD_ARGS%"
goto %FAKE_GCLOUD_MODE%
:ok
echo ya29.fake-token
exit /b 0
:reauth
echo ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution. 1>&2
echo Please run: 1>&2
echo   $ gcloud auth login 1>&2
exit /b 1
:rapt
echo token exchange 400: { "error": "invalid_grant", "error_description": "reauth related error (invalid_rapt)", "error_subtype": "invalid_rapt" } 1>&2
exit /b 1
:revoked
echo ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: ('invalid_grant: Token has been expired or revoked.', {'error': 'invalid_grant', 'error_description': 'Token has been expired or revoked.'}) 1>&2
exit /b 1
:nologin
echo ERROR: (gcloud.auth.print-access-token) Your current active account [user@example.com] does not have any valid credentials 1>&2
exit /b 1
:other
echo ERROR: something else entirely 1>&2
exit /b 1
:hang
ping -n 30 127.0.0.1 >nul
exit /b 0
:orphan
start /b ping -n 30 127.0.0.1
ping -n 7 127.0.0.1 >nul
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $bin 'gcloud.cmd') -Encoding ascii

# A live verdict is cached for 30 min under <profile>\stats\credentials-probe; every case
# starts from an empty cache unless it opts in with -KeepCache.
$cacheDir = Join-Path $profileDir 'stats\credentials-probe'

function Invoke-Hook {
    param([string]$Cwd, [string]$Source = 'startup', [string]$Mode = 'ok', [string]$Path = $null, [string]$Profile = $profileDir, [switch]$KeepCache)
    $prev = @{ CLAUDE_HOME = $env:CLAUDE_HOME; PATH = $env:PATH; MODE = $env:FAKE_GCLOUD_MODE; ARGS = $env:FAKE_GCLOUD_ARGS }
    Remove-Item -LiteralPath $argsFile -Force -ErrorAction SilentlyContinue
    if (-not $KeepCache) { Remove-Item -LiteralPath $cacheDir -Recurse -Force -ErrorAction SilentlyContinue }
    $env:CLAUDE_HOME = $Profile
    $env:PATH = if ($Path) { $Path } else { "$bin;$($prev.PATH)" }
    $env:FAKE_GCLOUD_MODE = $Mode
    $env:FAKE_GCLOUD_ARGS = $argsFile
    try {
        $json = @{ cwd = $Cwd; source = $Source } | ConvertTo-Json -Compress
        $out = $json | & $pwshExe -NoProfile -ExecutionPolicy Bypass -File $hook 2>$null
    } finally {
        $env:CLAUDE_HOME = $prev.CLAUDE_HOME; $env:PATH = $prev.PATH
        $env:FAKE_GCLOUD_MODE = $prev.MODE; $env:FAKE_GCLOUD_ARGS = $prev.ARGS
    }
    return ($out -join "`n")
}

function Ctx {
    param([string]$Out)
    if ([string]::IsNullOrWhiteSpace($Out)) { return $null }
    try { return (ConvertFrom-Json $Out).hookSpecificOutput.additionalContext } catch { return $null }
}

# The probe verdict is exactly one line starting with `gcloud:` / `⚠ gcloud:`. Assertions
# about the verdict target this line only: the resident guidance block below the table
# repeats the same markers (`! firebase login --reauth`, «session control», …), so matching
# the whole context would pass even with an empty verdict.
function VerdictLine {
    param([string]$Context)
    if (-not $Context) { return $null }
    return @(($Context -split "`r?`n") | Where-Object { $_ -match '^(⚠ )?gcloud: ' }) | Select-Object -First 1
}

function Probed { return (Test-Path -LiteralPath $argsFile) }

function Assert-True {
    param([bool]$Cond, [string]$Name, [string]$Detail = '')
    if ($Cond) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else {
        $script:fail++
        $d = if ($Detail) { "`n        " + ($Detail.Substring(0, [Math]::Min(400, $Detail.Length)) -replace "`r?`n", ' ⏎ ') } else { '' }
        Write-Host "  FAIL  $Name$d" -ForegroundColor Red
    }
}
function Assert-Match { param([string]$Pattern, [string]$Actual, [string]$Name)
    Assert-True ([bool]($Actual -and $Actual -match $Pattern)) $Name "expected /$Pattern/ in: [$Actual]" }
function Assert-NotMatch { param([string]$Pattern, [string]$Actual, [string]$Name)
    Assert-True (-not ($Actual -and $Actual -match $Pattern)) $Name "unexpected /$Pattern/ in: [$Actual]" }

Write-Host "credentials-digest.ps1 — suite"
$gcp = Join-Path $repos 'gcp-app'

# --- table + probe: verdicts (asserted on the verdict line, not the whole context) ---
$c = Ctx (Invoke-Hook $gcp -Mode ok)
$v = VerdictLine $c
Assert-Match '\| аккаунт \| \*\*user@example\.com \(GitHub someone\)\*\* \|' $c 'table: account row printed as-is'
Assert-Match '\| GCP project \| proj-1 \|' $c 'table: gcp project row'
Assert-Match '^gcloud: сессия user@example\.com живая' $v 'ok -> «живая»'
Assert-Match '`! firebase login --reauth`' $v 'ok -> firebase hint on the verdict line'
Assert-True (Probed) 'ok -> gcloud was called'
$argv = if (Probed) { Get-Content -LiteralPath $argsFile -Raw } else { '' }
Assert-Match 'auth print-access-token --account=user@example\.com(\s|$)' $argv 'probe uses bare email from the cell'
Assert-NotMatch 'GitHub' $argv 'probe does not leak the "(GitHub …)" suffix'

$c = Ctx (Invoke-Hook $gcp -Mode reauth)
$v = VerdictLine $c
$lines = @($c -split "`r?`n")
Assert-Match '^⚠ gcloud: сессия user@example\.com ПРОСРОЧЕНА' $v 'reauth -> «ПРОСРОЧЕНА»'
Assert-Match 'session control' $v 'reauth -> names Workspace session control'
Assert-Match '`! gcloud auth login user@example\.com`' $v 'reauth -> exact gcloud login command'
Assert-Match '`! firebase login --reauth`' $v 'reauth -> exact firebase command'
Assert-Match 'Ретраи и личный аккаунт' $v 'reauth -> forbids retries / personal fallback'
Assert-NotMatch 'отозван' $v 'reauth is not reported as a revoked token'
Assert-True ($lines.Count -gt 1 -and $lines[0] -match '^КРЕДЫ ПРОЕКТА' -and $lines[1] -eq $v) 'verdict sits right under the header, before the table' "lines: [$($lines[0])] / [$($lines[1])]"

$c = Ctx (Invoke-Hook $gcp -Mode rapt)
$v = VerdictLine $c
Assert-Match 'ПРОСРОЧЕНА' $v 'rapt (invalid_grant + invalid_rapt) -> reauth wins over revoked'
Assert-NotMatch 'отозван' $v 'rapt -> not reported as a revoked token'

$c = Ctx (Invoke-Hook $gcp -Mode revoked)
$v = VerdictLine $c
Assert-Match '^⚠ gcloud: токен user@example\.com отозван' $v 'revoked -> «отозван»'
Assert-NotMatch 'ПРОСРОЧЕНА' $v 'revoked is not reported as session control'

$c = Ctx (Invoke-Hook $gcp -Mode nologin)
Assert-Match '^⚠ gcloud: аккаунт user@example\.com не залогинен' (VerdictLine $c) 'nologin -> «не залогинен»'

$c = Ctx (Invoke-Hook $gcp -Mode other)
Assert-Match 'не проверена \(ERROR: something else entirely\)' (VerdictLine $c) 'unknown error -> «не проверена» + first line'

# --- probe bounds: neither a hung gcloud nor an orphaned pipe-holder may stall the start ---
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$c = Ctx (Invoke-Hook $gcp -Mode hang)
$sw.Stop()
Assert-Match 'не проверена \(таймаут' (VerdictLine $c) 'hang -> «не проверена (таймаут …)»'
Assert-True ($sw.Elapsed.TotalSeconds -lt 18) 'hang -> hook returns within 18 s (12 s probe + spawn, below the 20 s hook timeout)' "took $([int]$sw.Elapsed.TotalSeconds) s"

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$c = Ctx (Invoke-Hook $gcp -Mode orphan)
$sw.Stop()
Assert-Match 'не проверена \(таймаут' (VerdictLine $c) 'orphan pipe-holder -> «не проверена (таймаут …)»'
Assert-True ($sw.Elapsed.TotalSeconds -lt 18) 'orphan pipe-holder -> one shared deadline, hook returns within 18 s' "took $([int]$sw.Elapsed.TotalSeconds) s"
Assert-Match '\| GCP project \| proj-1 \|' $c 'orphan pipe-holder -> table still printed'

# --- probe cache: a live verdict is remembered for 30 min, anything else clears it ---
$c = Ctx (Invoke-Hook $gcp -Mode ok)
Assert-True (Probed) 'cache: first ok run probes and writes the marker'
$marker = @(Get-ChildItem -LiteralPath $cacheDir -Filter *.ok -ErrorAction SilentlyContinue) | Select-Object -First 1
Assert-True ($null -ne $marker) 'cache: marker file exists under stats\credentials-probe' "dir: $cacheDir"
Assert-NotMatch 'user@example' ([string]$marker.Name) 'cache: marker name does not carry the e-mail'
$c = Ctx (Invoke-Hook $gcp -Mode reauth -KeepCache)
Assert-True (-not (Probed)) 'cache: second run within TTL -> no probe'
Assert-Match '^gcloud: сессия user@example\.com живая \(проверено в \d\d:\d\d, кеш 30 мин\)' (VerdictLine $c) 'cache: cached verdict names the probe time'
# Guarded: a broken cache path may already have removed the marker, and the suite must
# keep reporting instead of dying on Get-Item under $ErrorActionPreference = 'Stop'.
if ($marker -and (Test-Path -LiteralPath $marker.FullName)) { (Get-Item -LiteralPath $marker.FullName).LastWriteTimeUtc = [datetime]::UtcNow.AddMinutes(-31) }
$c = Ctx (Invoke-Hook $gcp -Mode reauth -KeepCache)
Assert-True (Probed) 'cache: expired marker -> probe runs'
Assert-Match 'ПРОСРОЧЕНА' (VerdictLine $c) 'cache: expired marker -> fresh verdict printed'
Assert-True ($marker -and -not (Test-Path -LiteralPath $marker.FullName)) 'cache: non-ok verdict removes the marker'
$c = Ctx (Invoke-Hook $gcp -Mode ok -KeepCache)
Assert-True (Probed) 'cache: after a non-ok verdict the next run probes again'

# --- probe gates ---
$c = Ctx (Invoke-Hook (Join-Path $repos 'plain') -Mode ok)
Assert-Match '\| аккаунт \| \*\*user@example\.com\*\* \|' $c 'plain row -> table printed'
Assert-True (-not (Probed)) 'plain row (no gcp/firebase) -> no probe'
Assert-True ($null -eq (VerdictLine $c)) 'plain row -> no verdict line'

$c = Ctx (Invoke-Hook $gcp -Source compact -Mode ok)
Assert-True (-not (Probed)) 'source=compact -> no probe'
Assert-Match '\| GCP project \| proj-1 \|' $c 'source=compact -> table still printed'

$c = Ctx (Invoke-Hook $gcp -Source resume -Mode ok)
Assert-True (Probed) 'source=resume -> probe runs'

$c = Ctx (Invoke-Hook (Join-Path $gcp '.claude\worktrees\t') -Mode reauth)
Assert-True (Probed) 'worktree under the repo -> matched row, probe runs'
Assert-Match 'ПРОСРОЧЕНА' (VerdictLine $c) 'worktree under the repo -> verdict printed'

$c = Ctx (Invoke-Hook $gcp -Mode ok -Path (Join-Path $fx 'empty'))
Assert-Match 'не проверена' (VerdictLine $c) 'gcloud not on PATH -> «не проверена», no crash'

# --- resident guidance text ---
$c = Ctx (Invoke-Hook $gcp -Mode ok)
Assert-Match 'только в трёх случаях' $c 'guidance: three cases'
Assert-Match 'Reauthentication failed' $c 'guidance: names the reauth marker'
Assert-Match 'invalid_rapt' $c 'guidance: names invalid_rapt'
Assert-Match 'Token has been expired or revoked' $c 'guidance: names the revoked marker'
Assert-Match 'Failed to authenticate' $c 'guidance: names the firebase not-logged-in marker'
Assert-Match 'credentials-guard дал deny' $c 'guidance: guard deny case'
Assert-Match 'Переключать конфигурации руками не нужно' $c 'guidance: no manual switching'

# --- other branches unchanged ---
$c = Ctx (Invoke-Hook (Join-Path $repos 'stranger') -Mode ok)
Assert-Match 'НЕ рабочий репозиторий' $c 'ignored repo -> warning'
Assert-True (-not (Probed)) 'ignored repo -> no probe'

$c = Ctx (Invoke-Hook (Join-Path $repos 'unknown') -Mode ok)
Assert-Match 'не заведён' $c 'git repo outside registry -> «не заведён»'
Assert-True (-not (Probed)) 'git repo outside registry -> no probe'

$o = Invoke-Hook (Join-Path $repos 'nogit') -Mode ok
Assert-True ([string]::IsNullOrWhiteSpace($o)) 'non-git dir outside registry -> silent'

$o = Invoke-Hook $gcp -Mode ok -Profile (Join-Path $fx 'empty')
Assert-True ([string]::IsNullOrWhiteSpace($o)) 'no registry -> silent'

$evt = try { (ConvertFrom-Json (Invoke-Hook $gcp -Mode ok)).hookSpecificOutput.hookEventName } catch { $null }
Assert-True ($evt -eq 'SessionStart') 'output hookEventName = SessionStart' "got [$evt]"

# --- teardown + summary ---
Remove-Item -LiteralPath $fx -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "`n$script:pass passed, $script:fail failed"
exit $script:fail
