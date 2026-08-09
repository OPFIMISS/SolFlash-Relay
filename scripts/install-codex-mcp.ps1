[CmdletBinding()]
param(
    [string]$CodexConfig = (Join-Path $HOME ".codex\config.toml")
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $projectRoot "dist\server\mcp.js"
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "Build output not found. Run npm run build first: $entry"
}

$escapeToml = { param([string]$Value) $Value.Replace("\", "\\").Replace('"', '\"') }
$block = @"
# BEGIN sol-flash-relay
[mcp_servers.sol_flash_relay]
command = "$(& $escapeToml $node)"
args = ["$(& $escapeToml $entry)"]
cwd = "$(& $escapeToml $projectRoot)"
enabled = true
startup_timeout_sec = 15
tool_timeout_sec = 900
# END sol-flash-relay
"@

$directory = Split-Path -Parent $CodexConfig
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$current = if (Test-Path -LiteralPath $CodexConfig) {
    Get-Content -LiteralPath $CodexConfig -Raw -Encoding UTF8
} else {
    ""
}

$pattern = '(?ms)^# BEGIN sol-flash-relay\r?\n.*?^# END sol-flash-relay\r?\n?'
$next = [regex]::Replace($current, $pattern, "").TrimEnd()
if ($next) { $next += "`r`n`r`n" }
$next += $block.Trim() + "`r`n"
Set-Content -LiteralPath $CodexConfig -Value $next -Encoding UTF8

Write-Output "Installed sol_flash_relay in $CodexConfig"
