import assert from "node:assert/strict";
import { extractProductsFromHtml } from "../website-import-v2.js";

const fixtures = [
  {
    url: "https://euronics.front.grandus.sk/produkt/jbl-quantum-200",
    name: "JBL Quantum 200",
    sku: "QUANTUM200BLK",
    ean: "6925281969546",
    productId: "1461403",
    price: 39.9,
    quantity: 5,
    stores: [
      ["Zvolen TPD - Predajňa a výdajné miesto", 4],
      ["Žiar nad Hronom TPD - Predajňa a výdajné miesto", 1]
    ]
  },
  {
    url: "https://euronics.front.grandus.sk/produkt/tp-link-ls1005",
    name: "TP-Link LS1005",
    sku: "LS1005",
    ean: "6935364089061",
    productId: "1460485",
    price: 7.42,
    quantity: 2,
    stores: [["Trnava Elektromax - Predajňa zrušená", 2]]
  },
  {
    url: "https://euronics.front.grandus.sk/produkt/tp-link-ms105",
    name: "TP-Link MS105",
    sku: "MS105",
    ean: "6957939000363",
    productId: "1460392",
    price: 5.46,
    quantity: 1,
    stores: [["Senec Chlad Servis - Predajňa a výdajné miesto", 1]]
  },
  {
    url: "https://euronics.front.grandus.sk/produkt/trust-gxt-232-mantis-streaming-microphone",
    name: "Trust GXT 232 Mantis Streaming Microphone",
    sku: "22656",
    ean: "8713439226560",
    productId: "1459207",
    price: 21.52,
    quantity: 2,
    stores: [
      ["Zvolen TPD - Predajňa a výdajné miesto", 1],
      ["Žiar nad Hronom TPD - Predajňa a výdajné miesto", 1]
    ]
  }
];

function makeHtml(fixture, overrides = {}) {
  const storeData = fixture.stores.map(([storeName, storeCount]) => ({
    storeName,
    storeCount,
    storeDeliveryCount: null,
    storeDeliveryDate: null
  }));
  const product = {
    id: Number(fixture.productId),
    name: fixture.name,
    sku: fixture.sku,
    partNo: fixture.sku,
    ean: fixture.ean,
    brand: { name: fixture.name.startsWith("JBL") ? "JBL" : fixture.name.startsWith("TP-Link") ? "TP-Link" : "Trust" },
    priceData: { price: fixture.price, currency: "EUR" },
    finalPriceData: { price: fixture.price, currency: "EUR" },
    availability: true,
    storeStatus: { available: true, message: "Na sklade", messageAvailable: "Na sklade", messageUnavailable: "Na objednávku" },
    store: [{ name: "ks", count: fixture.quantity, weight: 0, isOrderable: true, storeData }],
    detailedParameters: [],
    ...overrides
  };
  const data = { props: { pageProps: { product } } };
  return `<!doctype html><html lang="sk"><head><title>${fixture.name}</title>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>
    </head><body><main><h1>${fixture.name}</h1></main></body></html>`;
}

for (const fixture of fixtures) {
  const html = makeHtml(fixture);
  const result = extractProductsFromHtml(html, fixture.url);
  const products = Array.isArray(result) ? result : result.products;
  const product = products.find(item => item.sku === fixture.sku || item.gtin === fixture.ean);
  assert.ok(product, `Product was not extracted: ${fixture.name}`);
  assert.equal(product.name, fixture.name);
  assert.equal(product.sku, fixture.sku);
  assert.equal(product.gtin, fixture.ean);
  assert.equal(product.productId, fixture.productId);
  assert.equal(product.brand, fixture.name.startsWith("JBL") ? "JBL" : fixture.name.startsWith("TP-Link") ? "TP-Link" : "Trust");
  assert.equal(product.price, fixture.price);
  assert.equal(product.currency, "EUR");
  assert.equal(product.availability, "InStock");
  assert.equal(product.availabilityText, "Na sklade");
  assert.equal(product.stockQuantity, fixture.quantity);
  assert.equal(product.stockQuantityUnit, "ks");
  assert.equal(product.stockLocations.length, fixture.stores.length);
  assert.ok(!("productWeight" in product), "store[].weight must not become productWeight");
  assert.ok(!("shippingWeight" in product), "store[].weight must not become shippingWeight");
  console.log(`PASS ${fixture.name}: SKU/EAN/price/availability/stock`);
}

const base = fixtures[0];
const unavailableHtml = makeHtml(base, {
  availability: false,
  storeStatus: { available: false, message: "Vypredané", messageAvailable: "Na sklade", messageUnavailable: "Na objednávku" },
  store: [{ name: "ks", count: 0, weight: 0, storeData: [] }]
});
const unavailableResult = extractProductsFromHtml(unavailableHtml, base.url);
const unavailableProducts = Array.isArray(unavailableResult) ? unavailableResult : unavailableResult.products;
const unavailable = unavailableProducts.find(item => item.sku === base.sku);
assert.ok(unavailable);
assert.equal(unavailable.availability, "OutOfStock");
assert.equal(unavailable.stockQuantity, 0);
console.log("PASS explicit false availability and zero stock");

const unknownHtml = makeHtml(base, {
  availability: null,
  storeStatus: null,
  store: []
});
const unknownResult = extractProductsFromHtml(unknownHtml, base.url);
const unknownProducts = Array.isArray(unknownResult) ? unknownResult : unknownResult.products;
const unknown = unknownProducts.find(item => item.sku === base.sku);
assert.ok(unknown);
assert.equal(unknown.availability, undefined);
assert.equal(unknown.stockQuantity, undefined);
console.log("PASS missing availability remains unknown");

console.log("ALL EURONICS NEXT_DATA REGRESSION TESTS PASSED.");
