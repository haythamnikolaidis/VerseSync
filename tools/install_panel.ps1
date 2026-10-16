# Installs the VerseSync panel for Premiere Pro (unsigned, debug-mode install).
# Idempotent: safe to run again; the destination is replaced each time.
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'panel'
$regFile = Join-Path $PSScriptRoot 'install_panel.reg'
$destination = Join-Path $env:APPDATA 'Adobe\CEP\extensions\VerseSync'

# Never deploy the development host stub.
$excludedFiles = @('js\lib\host-stub.js')

reg import $regFile
if ($LASTEXITCODE -ne 0) { throw "reg import failed for $regFile" }

if (Test-Path $destination) { Remove-Item -Recurse -Force $destination }
New-Item -ItemType Directory -Force -Path $destination | Out-Null

Get-ChildItem -Path $source -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($source.Length + 1)
    if ($excludedFiles -contains $relative) { return }
    $target = Join-Path $destination $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -Path $_.FullName -Destination $target -Force
}

Write-Host "VerseSync panel installed to $destination. Restart Premiere Pro."
