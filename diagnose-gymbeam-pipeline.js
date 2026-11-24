import fs from "node:fs/promises";
import { crawlWebsite } from "./website-import-v2-diagnostic.js";

const url = process.argv[2] || "https://gymbeam.sk/proteinove-latte-gymbeam.html";
const output = "gymbeam-pipeline-diagnostic-report.json";

function decodeEntities(s) {
  return String(s ?? "").replace(/&quot;/g, '"').replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'");
}
function collectNodes(v, out = []) {
  if (!v || typeof v !== "object") return out;
  if (Array.isArray(v)) { for (const x of v) collectNodes(x, out); return out; }
  out.push(v);
  if (v["@graph"]) collectNodes(v["@graph"], out);
  if (v.itemListElement) collectNodes(v.itemListElement, out);
  return out;
}
function collectOffers(v, out = []) {
  if (!v) return out;
  for (const x of Array.isArray(v) ? v : [v]) {
    if (!x || typeof x !== "object") continue;
    if (x.offers) collectOffers(x.offers, out);
    else if (x.price != null || x.lowPrice != null) out.push(x);
  }
  return out;
}
function auditJsonLd(html, pageUrl) {
  const scripts = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)];
  const parsed = [], parseErrors = [];
  scripts.forEach((m, i) => {
    const raw = decodeEntities(m[1]).trim();
    try { parsed.push(JSON.parse(raw)); }
    catch (e) { parseErrors.push({ index: i, error: e.message, chars: raw.length }); }
  });
  const products = [];
  for (const block of parsed) for (const p of collectNodes(block)) {
    const types = Array.isArray(p["@type"]) ? p["@type"] : [p["@type"]];
    if (!types.some(t => String(t || "").toLowerCase().split("/").pop() === "product")) continue;
    const variants = collectOffers(p.offers).map(o => {
      let variantUrl = o.url || p.url || pageUrl;
      try { variantUrl = new URL(variantUrl, pageUrl).href; } catch {}
      return {
        name: o.name || o.itemOffered?.name || p.name || null,
        sku: o.sku || o.itemOffered?.sku || null,
        gtin: o.gtin13 || o.gtin || o.itemOffered?.gtin13 || o.itemOffered?.gtin || null,
        price: Number(o.price ?? o.lowPrice), currency: o.priceCurrency || null,
        availability: o.availability || null, url: variantUrl
      };
    }).filter(v => Number.isFinite(v.price) && v.price > 0);
    products.push({ name: p.name || null,
      brand: typeof p.brand === "string" ? p.brand : p.brand?.name || null,
      parentSku: p.sku || null, category: p.category || null,
      variantCount: variants.length, variants });
  }
  return { jsonLdScriptCount: scripts.length, parsedJsonLdBlocks: parsed.length,
    parseErrors, productNodesFound: products.length, products };
}

async function main() {
  const report = { testedUrl: url, generatedAt: new Date().toISOString() };
  try {
    const result = await crawlWebsite(url, { maxPages: 1 });
    report.importer = {
      status: "completed", importerVersion: result.diagnostics?.importerVersion || "unknown",
      productsFound: result.products?.length ?? 0,
      pagesVisited: result.diagnostics?.pagesVisited ?? result.pagesScanned ?? 0,
      pagesFailed: result.diagnostics?.pagesFailed ?? 0,
      responseAudits: result.diagnostics?.responseAudits || [], errors: result.errors || []
    };
  } catch (e) { report.importer = { status: "failed", error: e?.stack || String(e) }; }
  try {
    const response = await fetch(url, { redirect: "follow", headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }});
    const html = await response.text();
    report.independentJsonLdAudit = { httpStatus: response.status, finalUrl: response.url,
      contentType: response.headers.get("content-type"), htmlBytes: Buffer.byteLength(html, "utf8"),
      ...auditJsonLd(html, response.url) };
  } catch (e) { report.independentJsonLdAudit = { status: "failed", error: e?.stack || String(e) }; }
  const products = report.independentJsonLdAudit?.products || [];
  const variantCount = products.reduce((n, p) => n + p.variantCount, 0);
  const imported = report.importer?.productsFound ?? 0;
  report.conclusion = report.importer?.status !== "completed"
    ? "Importer diagnostic failed; inspect importer.error."
    : variantCount > 0 && imported === 0
      ? "JSON-LD contains priced variants, but the importer returned zero. Compare the preserved records with the importer pipeline."
      : variantCount > imported
        ? "Independent JSON-LD extraction found more priced variants than the importer returned."
        : "Compare importer output with independent JSON-LD records for completeness.";
  await fs.writeFile(output, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nReport saved to ${output}`);
}
main().catch(e => { console.error(e?.stack || e); process.exitCode = 1; });
