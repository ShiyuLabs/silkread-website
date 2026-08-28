#Requires -Version 5.1
# Package Edge extension for Partner Center: whitelist files only.
# Run from repo root: powershell -ExecutionPolicy Bypass -File .\scripts\package-edge-extension.ps1

$ErrorActionPreference = 'Stop'
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$OutDir = Join-Path $ProjectRoot 'dist'

$Required = @(
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.js',
  'content.js',
  'auth-relay.js',
  'icon16.png',
  'icon32.png',
  'icon48.png',
  'icon128.png'
)

foreach ($f in $Required) {
  $p = Join-Path $ProjectRoot $f
  if (-not (Test-Path -LiteralPath $p)) {
    throw "Missing required file: $f at $p"
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$zipName = 'shiyu-translator-edge-' + $stamp + '.zip'
$zipPath = Join-Path $OutDir $zipName

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('edge-ext-pack-' + $stamp)
if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
  foreach ($f in $Required) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot $f) -Destination (Join-Path $temp $f)
  }
  if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -Path (Join-Path $temp '*') -DestinationPath $zipPath
}
finally {
  if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}

Write-Host ('Created ' + $zipPath)
