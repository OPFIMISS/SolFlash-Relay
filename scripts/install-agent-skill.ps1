[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetProject
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$source = Join-Path $projectRoot ".agents\skills\agent-adapter"
$targetRoot = (Resolve-Path -LiteralPath $TargetProject).Path
$target = Join-Path $targetRoot ".agents\skills\agent-adapter"

New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
Write-Output "Installed agent-adapter skill in $target"
