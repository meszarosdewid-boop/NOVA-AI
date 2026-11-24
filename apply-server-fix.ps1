$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$serverPath = Join-Path $projectRoot 'server.js'
$importerPath = Join-Path $projectRoot 'website-import-v2.js'

if (!(Test-Path $serverPath)) { throw "Nenašiel sa server.js v: $projectRoot. Rozbaľ ZIP priamo do koreňového priečinka NOVA AI." }
if (!(Test-Path $importerPath)) { throw "Nenašiel sa website-import-v2.js v: $projectRoot." }

$node = Get-Command node -ErrorAction SilentlyContinue
if (!$node) { throw 'Node.js nie je dostupný v PATH. Server nebol zmenený.' }

$original = [System.IO.File]::ReadAllText($serverPath)
$updated = $original
$newCoverage = @'
const detailPagesQueued = Number(
  crawlerDiagnostics.productDetailUrlsQueued ?? 0
);
const detailPagesVisited = Number(crawlerDiagnostics.productDetailPagesVisited ?? 0);
const detailCoverageComplete = productDetailPagesFailed === 0 &&
  detailPagesVisited >= detailPagesQueued;
'@

# Runtime server versions that compared visited pages with every discovered
# candidate (including candidates deliberately excluded by the detail-page cap).
$oldCandidateCoverage = '(?s)const detailCoverageComplete\s*=\s*productDetailPagesFailed\s*===\s*0\s*&&\s*\(crawlerDiagnostics\.productDetailCandidatesDiscovered\s*==\s*null\s*\|\|\s*Number\(crawlerDiagnostics\.productDetailPagesVisited\s*\|\|\s*0\)\s*>=\s*Number\(crawlerDiagnostics\.productDetailCandidatesDiscovered\s*\|\|\s*0\)\s*\)\s*;'
$matches = [regex]::Matches($updated, $oldCandidateCoverage)
if ($matches.Count -eq 1) {
  $updated = [regex]::Replace($updated, $oldCandidateCoverage, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $newCoverage.TrimEnd() }, 1)
} elseif ($matches.Count -gt 1) {
  throw 'Našlo sa viacero blokov detailCoverageComplete. Z bezpečnostných dôvodov nebola vykonaná žiadna zmena.'
} else {
  # Older saved server version: no detail coverage check existed yet.
  $oldSimpleBlock = '(?s)const effectiveStopReason\s*=\s*result\.stopReason\s*\|\|\s*crawlerDiagnostics\.stopReason\s*\|\|\s*null\s*;\s*const categoryPagesFailed\s*=\s*Number\(crawlerDiagnostics\.categoryPagesFailed\s*\?\?\s*errorsCount\)\s*;\s*const crawlComplete\s*=\s*!effectiveStopReason\s*&&\s*categoryPagesFailed\s*===\s*0\s*&&\s*Number\(crawlerDiagnostics\.queueRemaining\s*\|\|\s*0\)\s*===\s*0\s*;'
  $simpleMatches = [regex]::Matches($updated, $oldSimpleBlock)
  if ($simpleMatches.Count -eq 1) {
    $replacement = @'
const effectiveStopReason = result.stopReason || crawlerDiagnostics.stopReason || null;
const categoryPagesFailed = Number(crawlerDiagnostics.categoryPagesFailed ?? errorsCount);
const productDetailPagesFailed = Number(crawlerDiagnostics.productDetailPagesFailed ?? 0);
'@ + $newCoverage + @'
const crawlComplete = !effectiveStopReason &&
  categoryPagesFailed === 0 &&
  detailCoverageComplete &&
  Number(crawlerDiagnostics.queueRemaining || 0) === 0;
'@
    $updated = [regex]::Replace($updated, $oldSimpleBlock, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $replacement.TrimEnd() }, 1)
  } else {
    throw 'Nenašiel sa jednoznačný známy blok vyhodnotenia dokončenia importu. Súbor server.js nebol zmenený.'
  }
}

if ($updated -eq $original) { throw 'Server už obsahuje opravu alebo sa nenašla potrebná zmena. Súbor server.js nebol zmenený.' }
if ($updated -notmatch 'detailPagesVisited\s*>=\s*detailPagesQueued') { throw 'Kontrola po úprave zlyhala. Server nebol zmenený.' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = "$serverPath.before-import-fix-$stamp.bak"
Copy-Item -LiteralPath $serverPath -Destination $backupPath
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($serverPath, $updated, $utf8NoBom)

try {
  & node --check $serverPath
  if ($LASTEXITCODE -ne 0) { throw 'node --check server.js zlyhal.' }
  & node --check $importerPath
  if ($LASTEXITCODE -ne 0) { throw 'node --check website-import-v2.js zlyhal.' }
} catch {
  Copy-Item -LiteralPath $backupPath -Destination $serverPath -Force
  throw "Kontrola syntaxe zlyhala. Pôvodný server.js bol obnovený zo zálohy: $backupPath. Detail: $_"
}

Write-Host 'Oprava serverovej kontroly dokončenia importu bola úspešne aplikovaná.' -ForegroundColor Green
Write-Host "Záloha pôvodného servera: $backupPath"
Write-Host 'Importér V3.52 je pripravený v tomto priečinku. Reštartuj NOVA AI server a vykonaj nový náhľad importu.'
