/**
 * Read-only diagnostic helper for NOVA AI V3.86.1.
 * Downloads a few public Euronics product detail pages, runs the currently
 * installed importer attribute parser, and saves raw HTML plus a summary.
 * It does not write to the catalog, approve imports, or modify project files.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractProductPageAttributesFromHtml } from '../website-import-v2.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(here, 'euronics-attribute-source-capture');
const targets = [
  {
    file: 'jbl-quantum-200.html',
    url: 'https://euronics.front.grandus.sk/produkt/jbl-quantum-200'
  },
  {
    file: 'tp-link-ms105.html',
    url: 'https://euronics.front.grandus.sk/produkt/tp-link-ms105'
  },
  {
    file: 'tp-link-ls1005.html',
    url: 'https://euronics.front.grandus.sk/produkt/tp-link-ls1005'
  },
  {
    file: 'trust-gxt-232-mantis.html',
    url: 'https://euronics.front.grandus.sk/produkt/trust-gxt-232-mantis-streaming-microphone'
  }
];

const headers = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'sk-SK,sk;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  'pragma': 'no-cache'
};

await mkdir(outputDir, { recursive: true });
const summary = {
  generatedAt: new Date().toISOString(),
  importerVersion: 'Expected installed local version: V3.86.1',
  readOnly: true,
  catalogWrite: false,
  results: []
};

for (const target of targets) {
  const entry = { url: target.url, file: target.file, ok: false };
  try {
    const response = await fetch(target.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });
    const html = await response.text();
    entry.httpStatus = response.status;
    entry.finalUrl = response.url;
    entry.contentType = response.headers.get('content-type');
    entry.htmlBytes = Buffer.byteLength(html, 'utf8');

    if (html && response.ok) {
      const filePath = path.join(outputDir, target.file);
      await writeFile(filePath, html, 'utf8');
      const parsed = extractProductPageAttributesFromHtml(html, target.url);
      entry.ok = true;
      entry.savedFile = target.file;
      entry.parserResult = parsed;
    } else {
      entry.error = `HTTP ${response.status}; page body was not saved as a valid sample.`;
      if (html) {
        const excerpt = html.replace(/\s+/g, ' ').slice(0, 1000);
        entry.responseExcerpt = excerpt;
      }
    }
  } catch (error) {
    entry.error = `${error?.name || 'Error'}: ${error?.message || String(error)}`;
  }
  summary.results.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'WARN'} ${target.url}`);
  if (entry.ok) {
    console.log(`  HTML: ${entry.htmlBytes} bytes; parser fields: ${Object.keys(entry.parserResult || {}).join(', ') || '(none)'}`);
  } else {
    console.log(`  ${entry.error}`);
  }
}

const summaryPath = path.join(outputDir, 'summary.json');
await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
console.log('\nCapture folder:');
console.log(outputDir);
console.log('\nNo catalog writes or import approvals were performed.');
console.log('If at least one page was saved, ZIP the folder and send it for inspection.');
