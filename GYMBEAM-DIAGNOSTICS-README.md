# NOVA AI – GymBeam HTML diagnostics

This is an isolated diagnostic copy of the current V3.66 importer. It does not replace the production importer and does not change the `main` branch.

## Files

- `website-import-v2-diagnostic.js` – V3.66 importer with bounded HTTP/HTML response diagnostics.
- `diagnose-gymbeam.js` – one-page diagnostic runner for the GymBeam product URL.

## Run locally

1. Download both files and place them in the NOVA AI project root, next to the existing `website-import-v2.js` and `package.json`.
2. Do not rename or overwrite the existing production importer.
3. Open a terminal in that project folder.
4. Run:

```bash
node diagnose-gymbeam.js
```

To inspect another URL:

```bash
node diagnose-gymbeam.js "https://example.com/product.html"
```

The script writes `gymbeam-diagnostic-report.json` in the same folder and prints the report to the terminal.

## What is recorded

- HTTP status, final URL, content type and content encoding
- HTML title, Open Graph title, canonical URL and description
- counts of main elements, Astro islands, scripts, JSON-LD, forms and links
- bounded indicators for CAPTCHA, Cloudflare challenge, bot protection and JavaScript-required pages
- parsed JSON-LD blocks (bounded to 16,000 characters per block)
- `application/json` script contents and relevant product-related script snippets (bounded)
- HTML snippets around product-name, price, `priceCurrency`, `offers` and Product-schema markers
- a limited visible-text sample (up to 1,200 characters)
- product extraction results and crawl errors

The diagnostic does not save the full HTML response, cookies, authorization headers or other secret headers. Structured-data and HTML excerpts are deliberately length-limited; review the report before sharing it publicly.

## Safety

The original `website-import-v2.js` and `server.js` are not changed. This runner imports only the diagnostic copy and requests one page. It does not approve an import or write products to the NOVA AI catalog.

The diagnostic file has not been runtime-tested in this environment. Run it locally and share `gymbeam-diagnostic-report.json` for analysis before any production importer changes.
