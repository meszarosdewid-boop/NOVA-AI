
import { crawlWebsite } from "./website-import-v2.js";

const url = "https://euronics.front.grandus.sk/kategoria/digestory";

try {
  const r = await crawlWebsite(url, { maxPages: 100 });

  console.log("\n========== SÚHRN IMPORTU ==========");
  console.log(JSON.stringify({
    diagnostics: r.diagnostics,
    productsCount: r.products?.length ?? 0,
    pagesCount: r.pages?.length ?? 0,
    firstProducts: (r.products ?? []).slice(0, 10).map(p => ({
      name: p.name,
      price: p.price,
      currency: p.currency,
      url: p.url
    })),
    pageSummary: (r.pages ?? []).map(p => ({
      url: p.url,
      productsCount: p.products?.length ?? 0,
      error: p.error ?? null
    }))
  }, null, 2));

} catch (error) {
  console.error("DIAGNOSTICKÁ CHYBA:", error);
}
