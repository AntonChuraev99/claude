# PreToolUse hook for Claude Code: hint about graphify knowledge graph
# when about to grep/find raw files in a project that has graphify-out/.
#
# Handles two matchers:
#   - Bash: detects grep/rg/find/fd/ack/ag in the command string
#   - Grep: detects searches scoped to code file types (kt, kts, ts, tsx, py, go, etc.)
#
# Reads JSON from stdin. Outputs nothing OR a JSON
# {"hookSpecificOutput":{...,"additionalContext":"..."}} on stdout.

$ErrorActionPreference = 'SilentlyContinue'

$debug = $env:GRAPHIFY_HOOK_DEBUG -eq '1'
$logFile = "$env:USERPROFILE\.claude\graphify_hook_debug.log"
function Write-DebugLog($msg) {
    if ($debug) { "$(Get-Date -Format o): $msg" | Out-File -FilePath $logFile -Append -Encoding utf8 }
}

function Emit-Hint($context) {
    $payload = @{
        hookSpecificOutput = @{
            hookEventName     = 'PreToolUse'
            additionalContext = $context
        }
    }
    $payload | ConvertTo-Json -Compress -Depth 5
}

try {
    $inputJson = [Console]::In.ReadToEnd()
    Write-DebugLog "Input: $inputJson"

    if (-not $inputJson -or -not $inputJson.Trim()) { exit 0 }
    $data = $inputJson | ConvertFrom-Json -ErrorAction Stop

    $cwd = if ($data.cwd) { $data.cwd } else { (Get-Location).Path }
    $graphPath = Join-Path $cwd 'graphify-out\graph.json'
    if (-not (Test-Path -LiteralPath $graphPath)) {
        Write-DebugLog "No graph at $graphPath, silent"
        exit 0
    }

    $toolName = $data.tool_name
    $toolInput = $data.tool_input

    # ---- Bash matcher: detect search commands inside the shell line ----
    if ($toolName -eq 'Bash' -or (-not $toolName -and $toolInput.command)) {
        $cmd = if ($toolInput.command) { $toolInput.command } else { $data.command }
        if (-not $cmd) { exit 0 }

        # Suppress hint when command clearly operates on docs / config / memory / system paths
        # (analog of Grep matcher's docsLike guard — graphify only indexes project code, not these areas).
        $systemPaths = @(
            '~/\.claude',                      # POSIX-style ~/.claude/, ~/.claude-work/
            '~/\.claude-work',
            '/c/Users/[^/]+/\.claude',         # Git Bash absolute
            '/c/Users/[^/]+/\.claude-work',
            'C:\\\\Users\\\\[^\\\\]+\\\\\.claude',  # Windows absolute
            'C:\\\\Users\\\\[^\\\\]+\\\\AppData',
            '/c/Users/[^/]+/AppData',
            '/tmp/',
            '\$HOME/\.claude',
            '\bdocs/',                         # path argument like ~/.claude/improvements/, docs/solutions/
            '\bmemory/',
            '\bgraphify-out\b',
            '\bimprovements\b',
            '\bagent-memory\b'
        )
        foreach ($sp in $systemPaths) {
            if ($cmd -match $sp) {
                Write-DebugLog "Bash hint suppressed (system path) for cmd: $cmd"
                exit 0
            }
        }

        $patterns = @(
            '\bgrep\b', '\brg\b', '\bripgrep\b',
            '\bfind\b', '\bfd\b', '\back\b', '\bag\b'
        )
        foreach ($p in $patterns) {
            if ($cmd -match $p) {
                Emit-Hint 'graphify: Knowledge graph exists at graphify-out/graph.json. For cross-module code questions prefer `graphify query "<question>" --budget 800` or `graphify explain "<NodeName>"` over raw grep — 1 turn vs many.'
                Write-DebugLog "Bash hint emitted for cmd: $cmd"
                exit 0
            }
        }
        exit 0
    }

    # ---- Grep matcher: hint only when the search scope looks like source code ----
    if ($toolName -eq 'Grep') {
        $glob   = [string]$toolInput.glob
        $type   = [string]$toolInput.type
        $path   = [string]$toolInput.path
        $pat    = [string]$toolInput.pattern

        # Suppress hint when the user is clearly searching docs / config / memory
        $docsLike = $false
        if ($path) {
            foreach ($needle in @('docs', 'memory', '.claude', 'graphify-out')) {
                if ($path -match [regex]::Escape($needle)) { $docsLike = $true; break }
            }
        }
        if ($docsLike) { exit 0 }

        # Detect code-file scope by glob/type
        $codeTypes = @('kt','kts','java','ts','tsx','js','jsx','py','go','rs','swift','scala','rb','php','c','cpp','h','hpp','cs')
        $codeLike = $false
        if ($type -and ($codeTypes -contains $type.ToLower())) { $codeLike = $true }
        if ($glob -and ($glob -match '\.(kt|kts|java|ts|tsx|js|jsx|py|go|rs|swift|scala|rb|php|cs|cpp|c|h|hpp)(\b|\)|$)')) {
            $codeLike = $true
        }
        # Heuristic: pattern looks like a class/function identifier (PascalCase or camelCase with parens)
        if (-not $codeLike -and -not $glob -and -not $type) {
            if ($pat -match '^[A-Z][A-Za-z0-9]+([A-Z][A-Za-z0-9]+)+$' -or $pat -match '\bfun\s+\w+|\bclass\s+\w+|@HiltViewModel|@Composable') {
                $codeLike = $true
            }
        }

        if ($codeLike) {
            Emit-Hint 'graphify: Knowledge graph exists. For cross-module code questions prefer `graphify query "<question>" --budget 800` or `graphify explain "<NodeName>"` (1 turn ~600 tokens) before grepping source files. If pattern is too narrow for graph (e.g. specific string literal), continue with Grep.'
            Write-DebugLog "Grep hint emitted: pattern=$pat glob=$glob type=$type path=$path"
        }
        exit 0
    }

    exit 0
}
catch {
    Write-DebugLog "Error: $_"
    exit 0
}
