import { crawlWebsite } from "./website-import-v2.js";

const url = "https://gymbeam.sk/proteinove-latte-gymbeam.html";

console.log("NOVA AI - GYMBEAM ACTIVE IMPORTER TEST");
console.log("Importer: ./website-import-v2.js");
console.log("URL:", url);
console.log("Limit: 1 page");
console.log("Catalog writes: NONE\n");

try {
  const result = await crawlWebsite(url, { maxPages: 1 });

  const products = Array.isArray(result.products) ? result.products : [];

  const report = {
    url: result.url,
    pagesScanned: result.pagesScanned,
    totalProducts: products.length,
    stopReason: result.stopReason,
    errors: result.errors,
    diagnostics: result.diagnostics,
    products: products.map((p) => ({
      name: p.name ?? null,
      price: p.price ?? null,
      currency: p.currency ?? null,
      availability: p.availability ?? p.availabilityStatus ?? null,
      sku: p.sku ?? p.variantAttributes?.sku ?? null,
      gtin: p.gtin ?? p.variantAttributes?.gtin ?? null,
      variantName: p.variantName ?? null,
      variantAttributes: p.variantAttributes ?? null,
      isVariant: p.isVariant ?? null,
      variantGroupId: p.variantGroupId ?? null,
      url: p.url ?? p.sourceUrl ?? null
    })),
    pageSummary: (result.pages ?? []).map((page) => ({
      url: page.url,
      pageType: page.pageType ?? null,
      productsCount: page.products?.length ?? 0,
      error: page.error ?? null,
      extractionMethods: page.diagnostics?.extractionMethods ?? null
    }))
  };

  console.log(JSON.stringify(report, null, 2));

  const expected = [
    { sku: "122935", gtin: "8586028771471", label: "čokoláda" },
    { sku: "122929", gtin: "8586028771464", label: "káva" },
    { sku: "122932", gtin: "8586028771488", label: "matcha" }
  ];

  console.log("\n========== OČAKÁVANÉ VARIANTY ==========");
  for (const item of expected) {
    const found = products.find((p) => {
      const sku = String(p.sku ?? p.variantAttributes?.sku ?? "");
      const gtin = String(p.gtin ?? p.variantAttributes?.gtin ?? "");
      return sku === item.sku || gtin === item.gtin;
    });

    console.log(
      `${found ? "FOUND" : "MISSING"} | ${item.label} | SKU ${item.sku} | EAN ${item.gtin}`
    );
  }

  console.log("\nPoznámka: Tento skript iba načíta a vypíše výsledok crawlera.");
  console.log("Neschvaľuje import a nezapisuje do catalog.json.");
} catch (error) {
  console.error("\nTEST ERROR:", error?.stack || error?.message || error);
  process.exitCode = 1;
}
