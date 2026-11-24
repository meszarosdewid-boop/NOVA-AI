$ErrorActionPreference = "Stop"

$activePath = Join-Path (Get-Location) "website-import-v2.js"
$diagnosticPath = Join-Path (Get-Location) "website-import-v2-diagnostic.js"

if (!(Test-Path $activePath)) { throw "Nenasiel som website-import-v2.js v aktualnom priecinku." }
if (!(Test-Path $diagnosticPath)) { throw "Nenasiel som website-import-v2-diagnostic.js v aktualnom priecinku." }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$active = [System.IO.File]::ReadAllText($activePath)
$diagnostic = [System.IO.File]::ReadAllText($diagnosticPath)

$startMarker = "function extractProductsFromJsonLdOfferVariants("
$endMarker = "export function extractProductsFromJsonLd("

function Get-FunctionBlock([string]$source, [string]$label) {
    $start = $source.IndexOf($startMarker, [System.StringComparison]::Ordinal)
    if ($start -lt 0) { throw "V subore $label sa nenasla zaciatocna funkcia." }

    $end = $source.IndexOf($endMarker, $start, [System.StringComparison]::Ordinal)
    if ($end -lt 0) { throw "V subore $label sa nenasiel koniec funkcie." }

    return @{
        Start = $start
        End = $end
        Block = $source.Substring($start, $end - $start)
    }
}

$activeBlock = Get-FunctionBlock $active "website-import-v2.js"
$diagnosticBlock = Get-FunctionBlock $diagnostic "website-import-v2-diagnostic.js"

foreach ($required in @("nameVariant", "gtin", "option")) {
    if ($diagnosticBlock.Block.IndexOf($required, [System.StringComparison]::Ordinal) -lt 0) {
        throw "Diagnosticka funkcia neobsahuje ocakavanu opravu: $required"
    }
}

if ($activeBlock.Block -eq $diagnosticBlock.Block) {
    Write-Host "Aktivny importer uz obsahuje rovnaku funkciu. Nic nemenim."
    exit 0
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = "$activePath.before-gymbeam-fix-$timestamp.bak"
[System.IO.File]::Copy($activePath, $backupPath, $false)
Write-Host "Zaloha povodneho importera: $backupPath"

$updated = $active.Substring(0, $activeBlock.Start) +
           $diagnosticBlock.Block +
           $active.Substring($activeBlock.End)

[System.IO.File]::WriteAllText($activePath, $updated, $utf8)

Write-Host "Preniesena bola iba funkcia na extrakciu JSON-LD variantov."
Write-Host "Kontrolujem syntax aktivneho importera..."

$checkOutput = & node --check $activePath 2>&1
$checkExit = $LASTEXITCODE
if ($checkOutput) { $checkOutput | ForEach-Object { Write-Host $_ } }

if ($checkExit -ne 0) {
    [System.IO.File]::Copy($backupPath, $activePath, $true)
    throw "Kontrola syntaxe zlyhala. Povodny importer bol automaticky obnoveny zo zalohy."
}

Write-Host ""
Write-Host "HOTOVO: syntax aktivneho importera je v poriadku."
Write-Host "Zaloha: $backupPath"
Write-Host "Ostatne casti importera, server.js a katalog.json sa nemenili."
