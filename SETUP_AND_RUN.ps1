$ErrorActionPreference = "Stop"
$branch = "diagnostics/gymbeam-html-audit"
$source = "https://raw.githubusercontent.com/meszarosdewid-boop/NOVA-AI/$branch/website-import-v2-diagnostic.js"
$target = Join-Path $PSScriptRoot "website-import-v2-diagnostic.js"
Write-Host "Stahujem diagnosticky importer z izolovanej vetvy..."
Invoke-WebRequest -Uri $source -OutFile $target
Set-Location $PSScriptRoot
Write-Host "Spustam diagnostiku GymBeam..."
node .\diagnose-gymbeam-pipeline.js
