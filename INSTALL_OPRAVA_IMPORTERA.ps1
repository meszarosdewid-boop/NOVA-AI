$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'website-import-v2.js'
$target = Join-Path (Get-Location) 'website-import-v2.js'

if (-not (Test-Path $source)) {
  throw "Nenasiel sa opraveny subor: $source. Rozbal ZIP a spusti skript z priecinka, kde je website-import-v2.js."
}
if (-not (Test-Path $target)) {
  throw "V aktualnom priecinku sa nenasiel aktivny website-import-v2.js. Spusti skript z korenoveho priecinka projektu NOVA AI."
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$target.before-return-contract-fix-$stamp.bak"
Copy-Item -LiteralPath $target -Destination $backup
Copy-Item -LiteralPath $source -Destination $target -Force

Write-Host "Zaloha vytvorena: $backup" -ForegroundColor Green
Write-Host "Opraveny website-import-v2.js bol nainstalovany." -ForegroundColor Green
Write-Host "Teraz spusti: node --check website-import-v2.js" -ForegroundColor Cyan
Write-Host "Potom otestuj: node test-gymbeam-active-importer.js" -ForegroundColor Cyan
Write-Host "server.js ani catalog.json sa nemenili." -ForegroundColor Yellow
