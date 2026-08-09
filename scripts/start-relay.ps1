[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$entry = Join-Path $projectRoot "dist\server\daemon.js"
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "Build output not found. Run npm run build first: $entry"
}

$existing = Get-NetTCPConnection -LocalPort 17322 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $existing) {
    Start-Process -FilePath (Get-Command node -ErrorAction Stop).Source `
        -ArgumentList $entry `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden
    Start-Sleep -Milliseconds 800
}

if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:17322"
}

Write-Output "SolFlash Relay: http://127.0.0.1:17322"
