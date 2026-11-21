import fs from "node:fs/promises";
import { crawlWebsite } from "./website-import-v2-diagnostic.js";

const url = process.argv[2] || "https://gymbeam.sk/proteinove-latte-gymbeam.html";

try {
  const result = await crawlWebsite(url, { maxPages: 1 });
  const report = {
    testedUrl: url,
    generatedAt: new Date().toISOString(),
    importerVersion: result.diagnostics?.importerVersion || "unknown",
    summary: {
      pagesVisited: result.diagnostics?.pagesVisited ?? result.pagesScanned ?? 0,
      pagesFailed: result.diagnostics?.pagesFailed ?? 0,
      productsFound: result.products?.length ?? 0,
      totalBytes: result.totalBytes ?? 0,
      stopReason: result.stopReason ?? null
    },
    responseAudits: result.diagnostics?.responseAudits || [],
    pageErrors: result.errors || [],
    products: result.products || []
  };
  const output = "gymbeam-diagnostic-report.json";
  await fs.writeFile(output, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log("\nReport saved to " + output);
} catch (error) {
  console.error("GymBeam diagnostic failed:", error?.stack || error);
  process.exitCode = 1;
}
