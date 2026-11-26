import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canMergePhysicalAttributes,
  groupImportProductsByIdentity
} from "./website-product-merge.js";

const product = overrides => ({
  name: "Test product",
  brand: "Example",
  price: 100,
  packagePrice: 100,
  currency: "EUR",
  productId: "parent-123",
  ...overrides
});

test("separates variants that share a parent productId but have different colors", () => {
  const groups = groupImportProductsByIdentity([
    product({ color: "Black", sourceUrl: "https://shop.test/product/test" }),
    product({ color: "White", sourceUrl: "https://shop.test/product/test" })
  ]);
  assert.equal(groups.length, 2);
});

test("separates conflicting values inside variantAttributes", () => {
  const groups = groupImportProductsByIdentity([
    product({ variantAttributes: { color: "Black" } }),
    product({ variantAttributes: { color: "White" } })
  ]);
  assert.equal(groups.length, 2);
});

test("variant attribute key matching is case-insensitive", () => {
  const groups = groupImportProductsByIdentity([
    product({ variantAttributes: { Color: "Black" } }),
    product({ variantAttributes: { color: "White" } })
  ]);
  assert.equal(groups.length, 2);
});

test("an identifier-free bridge record cannot merge two explicit variants", () => {
  const groups = groupImportProductsByIdentity([
    product({ color: "Black" }),
    product({}),
    product({ color: "White" })
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups.flat().length, 3);
});

test("an exact matching GTIN permits physical metadata transfer despite price differences", () => {
  const listing = product({ gtin: "4006381333931", price: 100, packagePrice: 100 });
  const detail = product({
    gtin: "4006381333931",
    price: 120,
    packagePrice: 120,
    productDimensions: { width: 20, height: 10, depth: 5, unit: "cm" }
  });
  assert.equal(canMergePhysicalAttributes(listing, detail), true);
});

test("an exact matching SKU permits physical metadata transfer when variant metadata agrees", () => {
  assert.equal(canMergePhysicalAttributes(
    product({ sku: "MODEL-01", price: 99 }),
    product({ sku: "MODEL-01", price: 105 })
  ), true);
});

test("a shared parent productId alone is not enough to transfer physical attributes", () => {
  assert.equal(canMergePhysicalAttributes(
    product({ productId: "parent-123" }),
    product({ productId: "parent-123" })
  ), false);
});

test("conflicting GTINs block physical metadata transfer and product grouping", () => {
  const left = product({ gtin: "4006381333931" });
  const right = product({ gtin: "4006381333948" });
  assert.equal(canMergePhysicalAttributes(left, right), false);
  assert.equal(groupImportProductsByIdentity([left, right]).length, 2);
});

test("the server uses a separate exact-identity candidate pool for physical facts", async () => {
  const server = await readFile(new URL("./server.js", import.meta.url), "utf8");
  assert.match(server, /canMergePhysicalAttributes\(preferred, item\)/);
  assert.match(server, /for \(const candidate of physicalCandidates\)/);
  assert.match(server, /const source = candidates\.find\(item => item\?\.\[field\]/);
  assert.ok(server.includes("...mergeImportPhysicalSpecs(item)"), "preview must forward physical specification fields");
});
