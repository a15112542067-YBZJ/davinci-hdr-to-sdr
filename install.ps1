param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$pluginName = 'com.local.resolve.hdrtosdr'
$pluginRoot = Join-Path $env:PROGRAMDATA 'Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins'
$pluginTarget = Join-Path $pluginRoot $pluginName
$resolvedRoot = [IO.Path]::GetFullPath($pluginRoot)
$resolvedTarget = [IO.Path]::GetFullPath($pluginTarget)
if ($resolvedTarget -ne (Join-Path $resolvedRoot $pluginName)) { throw 'Invalid installation directory' }
if ($Uninstall) {
    if (Test-Path -LiteralPath $resolvedTarget) { Remove-Item -LiteralPath $resolvedTarget -Recurse -Force }
    Write-Host 'Plugin removed. Converted media files are retained.'
    exit
}
$nativeSource = Join-Path $env:PROGRAMDATA 'Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node'
if (!(Test-Path -LiteralPath $nativeSource)) { throw 'WorkflowIntegration.node not found. Install Resolve Studio first.' }
$sourceDir = Join-Path $PSScriptRoot 'ResolveHDRtoSDR'
New-Item -ItemType Directory -Path $resolvedTarget -Force | Out-Null
Get-ChildItem -LiteralPath $sourceDir -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $resolvedTarget -Force }
$nativeTarget = Join-Path $resolvedTarget 'WorkflowIntegration.node'
if (!(Test-Path -LiteralPath $nativeTarget) -or (Get-FileHash -LiteralPath $nativeSource).Hash -ne (Get-FileHash -LiteralPath $nativeTarget).Hash) {
    Copy-Item -LiteralPath $nativeSource -Destination $nativeTarget -Force
}
Write-Host ('Installed: ' + $resolvedTarget)
Write-Host 'Restart Resolve. Open Workspace > Workflow Integrations > HDR to SDR (Chinese name).'
