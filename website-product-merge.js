// NOVA AI - stable website-product identity grouping
// Groups listing and product-detail extraction records without collapsing variants.

function normalizeIdentifier(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    url.hash = "";
    url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|gclid|fbclid|yclid|_ga|_gl)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    url.searchParams.sort();
    return url.href;
  } catch {
    return String(value).trim();
  }
}

function identityOf(item) {
  return {
    productId: normalizeIdentifier(item?.productId),
    gtin: normalizeIdentifier(item?.gtin || item?.ean),
    sku: normalizeIdentifier(item?.sku),
    mpn: normalizeIdentifier(item?.mpn),
    brand: normalizeName(item?.brand),
    name: normalizeName(item?.name),
    url: normalizeUrl(item?.url || item?.sourceUrl || item?.pageUrl)
  };
}

function identitiesConflict(a, b) {
  // Different GTINs are different sellable units, even if a storefront reuses
  // one parent productId or canonical page URL for several variants.
  if (a.gtin && b.gtin && a.gtin !== b.gtin) return true;

  const sameGtin = Boolean(a.gtin && b.gtin && a.gtin === b.gtin);
  const sameSku = Boolean(a.sku && b.sku && a.sku === b.sku);
  const sameMpn = Boolean(a.mpn && b.mpn && a.mpn === b.mpn);
  const sameProductId = Boolean(a.productId && b.productId && a.productId === b.productId);

  // A conflicting SKU/MPN must not be hidden by a shared title or parent URL.
  // An identical GTIN is the strongest evidence that both records are the same
  // sellable unit, even when the shop has more than one internal SKU alias.
  if (a.sku && b.sku && a.sku !== b.sku && !sameGtin) return true;
  if (a.mpn && b.mpn && a.mpn !== b.mpn && !sameGtin && !sameSku) return true;

  // Two different internal product IDs are kept apart unless a GTIN or SKU
  // independently proves that the records refer to the same sellable unit.
  if (a.productId && b.productId && a.productId !== b.productId && !sameGtin && !sameSku) {
    return true;
  }

  // A matching product ID does not override different explicitly identified
  // variants; the GTIN/SKU conflict checks above intentionally run first.
  return false;
}

function sameStrongIdentity(a, b) {
  if (identitiesConflict(a, b)) return false;
  if (a.gtin && b.gtin && a.gtin === b.gtin) return true;
  if (a.sku && b.sku && a.sku === b.sku && (!a.brand || !b.brand || a.brand === b.brand)) return true;
  if (a.productId && b.productId && a.productId === b.productId) return true;
  if (a.url && b.url && a.url === b.url && a.name && a.name === b.name) return true;
  if (!a.url && !b.url && a.name && a.name === b.name && (!a.brand || !b.brand || a.brand === b.brand)) return true;
  return false;
}

function getPathname(value) {
  try { return new URL(String(value || "")).pathname.toLowerCase(); }
  catch { return ""; }
}

function isCategoryListingRecord(item) {
  if (!item || item.detailPageVisited === true) return false;
  const pathname = getPathname(item.url || item.sourceUrl || item.pageUrl);
  return /\/(?:kategoria|category|categories|kolekcia|collection|collections|catalog|catalogue)(?:\/|$)/i.test(pathname);
}

function isVisitedProductDetailRecord(item) {
  if (!item || item.detailPageVisited !== true) return false;
  const pathname = getPathname(item.url || item.sourceUrl || item.pageUrl);
  return /\/(?:produkt|product|item|detail|p)(?:\/|$)/i.test(pathname) || /\.html?$/i.test(pathname);
}

function detailUrlSlugMatchesName(item) {
  const pathname = getPathname(item?.url || item?.sourceUrl || item?.pageUrl);
  const segment = pathname.split("/").filter(Boolean).at(-1) || "";
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch {}
  const slug = normalizeName(decoded);
  const name = normalizeName(item?.name);
  if (!slug || !name) return false;
  if (slug === name) return true;
  // Some stores append a numeric database ID to an otherwise exact product slug.
  return slug.startsWith(`${name} `) && /^\d{3,}$/.test(slug.slice(name.length + 1));
}

function sameComparableOffer(a, b) {
  const priceA = Number(a?.packagePrice ?? a?.price);
  const priceB = Number(b?.packagePrice ?? b?.price);
  if (!Number.isFinite(priceA) || !Number.isFinite(priceB) || priceA <= 0 || priceB <= 0) return false;
  if (Math.abs(priceA - priceB) > 0.005) return false;
  const currencyA = String(a?.currency || "").trim().toUpperCase();
  const currencyB = String(b?.currency || "").trim().toUpperCase();
  return Boolean(currencyA && currencyB && currencyA === currencyB);
}

function variantMetadataConflicts(a, b) {
  const scalarKeys = ["variantName", "color", "size", "material", "pattern", "option"];
  for (const key of scalarKeys) {
    const left = normalizeName(a?.[key]);
    const right = normalizeName(b?.[key]);
    if (left && right && left !== right) return true;
  }
  const leftAttributes = a?.variantAttributes && typeof a.variantAttributes === "object" ? a.variantAttributes : {};
  const rightAttributes = b?.variantAttributes && typeof b.variantAttributes === "object" ? b.variantAttributes : {};
  for (const key of Object.keys(leftAttributes)) {
    if (rightAttributes[key] == null || rightAttributes[key] === "") continue;
    if (normalizeName(leftAttributes[key]) !== normalizeName(rightAttributes[key])) return true;
  }
  const leftGroup = normalizeIdentifier(a?.variantGroupId);
  const rightGroup = normalizeIdentifier(b?.variantGroupId);
  return Boolean(leftGroup && rightGroup && leftGroup !== rightGroup);
}

function isSafeListingDetailPair(listingGroup, detailGroup) {
  const listings = listingGroup.filter(entry => isCategoryListingRecord(entry.item));
  const details = detailGroup.filter(entry => isVisitedProductDetailRecord(entry.item));
  if (!listings.length || !details.length) return false;
  // Never use this fallback if either side already contains the opposite page
  // role. This fallback is specifically for one category-only group + one
  // product-detail group that the strong identifiers could not connect.
  if (listingGroup.some(entry => isVisitedProductDetailRecord(entry.item))) return false;
  if (detailGroup.some(entry => isCategoryListingRecord(entry.item))) return false;

  const listingNames = new Set(listingGroup.map(entry => normalizeName(entry.item.name)));
  const detailNames = new Set(detailGroup.map(entry => normalizeName(entry.item.name)));
  if (listingNames.size !== 1 || detailNames.size !== 1 || ![...listingNames][0] ||
      [...listingNames][0] !== [...detailNames][0]) return false;

  const listingBrands = new Set(listingGroup.map(entry => normalizeName(entry.item.brand)).filter(Boolean));
  const detailBrands = new Set(detailGroup.map(entry => normalizeName(entry.item.brand)).filter(Boolean));
  if (listingBrands.size > 1 || detailBrands.size > 1) return false;
  if (listingBrands.size && detailBrands.size && [...listingBrands][0] !== [...detailBrands][0]) return false;

  // All records must describe the same offer. Missing currency/price is not
  // enough evidence for this fallback; in that case the records stay separate.
  const listingOffer = listings[0].item;
  const detailOffer = details[0].item;
  if (!sameComparableOffer(listingOffer, detailOffer)) return false;
  if (listingGroup.some(entry => !sameComparableOffer(listingOffer, entry.item))) return false;
  if (detailGroup.some(entry => !sameComparableOffer(detailOffer, entry.item))) return false;

  // Product detail URL must agree with the exact title; this prevents a generic
  // product page or a similarly named recommendation from being attached.
  if (!details.some(entry => detailUrlSlugMatchesName(entry.item))) return false;

  for (const listing of listingGroup) {
    for (const detail of detailGroup) {
      if (identitiesConflict(listing.identity, detail.identity)) return false;
      if (variantMetadataConflicts(listing.item, detail.item)) return false;
    }
  }
  return true;
}

function mergeUnambiguousListingDetailGroups(groups) {
  const edges = [];
  const degree = new Array(groups.length).fill(0);
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (isSafeListingDetailPair(groups[i], groups[j]) || isSafeListingDetailPair(groups[j], groups[i])) {
        edges.push([i, j]);
        degree[i]++;
        degree[j]++;
      }
    }
  }

  // Merge only mutual one-to-one matches. If one listing could match two
  // details (or vice versa), keep every group separate as an ambiguity guard.
  const partner = new Map();
  for (const [a, b] of edges) {
    if (degree[a] === 1 && degree[b] === 1) {
      partner.set(a, b);
      partner.set(b, a);
    }
  }
  const consumed = new Set();
  const output = [];
  for (let i = 0; i < groups.length; i++) {
    if (consumed.has(i)) continue;
    const j = partner.get(i);
    if (j != null && !consumed.has(j)) {
      output.push([...groups[i], ...groups[j]]);
      consumed.add(i);
      consumed.add(j);
    } else {
      output.push(groups[i]);
      consumed.add(i);
    }
  }
  return output;
}

/**
 * Group crawl records representing the same product.
 *
 * Strong identifiers (GTIN, SKU, productId) are preferred. URL+name is only a
 * fallback. A record is appended to a group only when it has exactly one safe
 * destination and it conflicts with none of that group's existing records.
 * This prevents a category record with no SKU/EAN from bridging two different
 * variants that share a parent productId.
 */
export function groupImportProductsByIdentity(records) {
  const items = (Array.isArray(records) ? records : [])
    .filter(item => item && typeof item === "object")
    .map((item, index) => ({ item, index, identity: identityOf(item) }));

  // Process the most informative records first. Identifier-free category
  // records are considered last and only attach when there is one safe match.
  const strength = entry =>
    (entry.identity.gtin ? 8 : 0) +
    (entry.identity.sku ? 4 : 0) +
    (entry.identity.productId ? 2 : 0) +
    (entry.identity.mpn ? 1 : 0);
  items.sort((a, b) => strength(b) - strength(a) || a.index - b.index);

  const groups = [];
  for (const entry of items) {
    const candidates = [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      const matches = group.some(existing => sameStrongIdentity(existing.identity, entry.identity));
      if (!matches) continue;
      const hasConflict = group.some(existing => identitiesConflict(existing.identity, entry.identity));
      if (!hasConflict) candidates.push(groupIndex);
    }

    if (candidates.length === 1) {
      groups[candidates[0]].push(entry);
    } else {
      // Zero matches means a new identity. More than one means an identifier-
      // incomplete record could belong to multiple variants; keep it separate.
      groups.push([entry]);
    }
  }

  // Secondary, tightly bounded fallback for shops where a category card uses
  // the category URL and the visited product detail exposes no shared SKU/EAN.
  // It requires exact title, exact price+currency, a matching detail URL slug,
  // compatible brand/variant metadata, no identifier conflicts and a unique
  // one-to-one candidate. Ambiguous or differently priced items stay separate.
  const finalGroups = mergeUnambiguousListingDetailGroups(groups);

  // Return group members in their original crawl order for predictable output.
  return finalGroups
    .sort((a, b) => Math.min(...a.map(entry => entry.index)) - Math.min(...b.map(entry => entry.index)))
    .map(group => group.sort((a, b) => a.index - b.index).map(entry => entry.item));
}



/**
 * Apply explicitly verified product titles by exact GTIN/EAN.
 *
 * A verified title may be copied to a brand-only category record sharing the
 * same productId only when the productId is unique to one GTIN, the brand and
 * offer match, identifiers do not conflict, and variant metadata is aligned.
 * No network lookup is performed and unlisted GTINs are never inferred.
 */
export function applyVerifiedProductNameOverrides(records, config = {}) {
  const sourceRecords = Array.isArray(records) ? records : [];
  const cloned = sourceRecords.map(item => item && typeof item === "object" ? { ...item } : item);
  const configuredProducts = config && typeof config === "object"
    ? (config.products && typeof config.products === "object" ? config.products : config)
    : {};
  const overrides = new Map();

  for (const [rawGtin, rawOverride] of Object.entries(configuredProducts)) {
    if (!rawOverride || typeof rawOverride !== "object") continue;
    const gtin = normalizeIdentifier(rawGtin);
    const name = String(rawOverride.name || "").trim();
    const brand = String(rawOverride.brand || "").trim();
    if (!/^\d{8,14}$/.test(gtin) || !name || name.length < 3 || name.length > 250) continue;
    overrides.set(gtin, { gtin, name, brand, source: String(rawOverride.source || "verified-gtin").trim() });
  }

  const exactMatches = [];
  const distinctIdentifier = (item, keys) => [...new Set(keys
    .map(key => normalizeIdentifier(item?.[key]))
    .filter(Boolean))];
  const getGtin = item => {
    const values = distinctIdentifier(item, ["gtin", "ean", "ean13", "barcode", "gtin13", "gtin14"]);
    return values.length === 1 ? values[0] : "";
  };
  const mayReplaceTitle = item => {
    const currentName = String(item?.name || "").trim();
    if (!currentName) return true;
    if (normalizeName(currentName) === normalizeName(item?.brand)) return true;
    return false;
  };

  for (let index = 0; index < cloned.length; index++) {
    const item = cloned[index];
    if (!item || typeof item !== "object") continue;
    const gtin = getGtin(item);
    const override = gtin ? overrides.get(gtin) : null;
    if (!override || !mayReplaceTitle(item)) continue;
    if (override.brand && item.brand && normalizeName(override.brand) !== normalizeName(item.brand)) continue;
    item.name = override.name;
    exactMatches.push({ index, gtin, override });
  }

  let propagatedRecordCount = 0;
  const productIdGroups = new Map();
  for (let index = 0; index < cloned.length; index++) {
    const item = cloned[index];
    const productId = normalizeIdentifier(item?.productId || item?.productID || item?.product_id || item?.itemId || item?.item_id);
    if (!item || typeof item !== "object" || !productId) continue;
    if (!productIdGroups.has(productId)) productIdGroups.set(productId, []);
    productIdGroups.get(productId).push(index);
  }

  for (const [productId, indices] of productIdGroups) {
    const anchors = exactMatches.filter(entry => indices.includes(entry.index));
    if (!anchors.length) continue;
    const anchorGtinSet = new Set(anchors.map(entry => entry.gtin));
    const overrideNames = new Set(anchors.map(entry => normalizeName(entry.override.name)));
    if (anchorGtinSet.size !== 1 || overrideNames.size !== 1) continue;

    const anchorGtin = [...anchorGtinSet][0];
    const anchorOverride = anchors[0].override;
    const members = indices.map(index => cloned[index]);
    const allGtins = new Set(members.flatMap(item => distinctIdentifier(item, ["gtin", "ean", "ean13", "barcode", "gtin13", "gtin14"])));
    const allSkus = new Set(members.flatMap(item => distinctIdentifier(item, ["sku", "SKU", "articleNumber", "article_number", "itemNumber", "item_number"])));
    const allMpns = new Set(members.flatMap(item => distinctIdentifier(item, ["mpn", "MPN", "manufacturerPartNumber", "manufacturer_part_number"])));
    if (allGtins.size !== 1 || !allGtins.has(anchorGtin) || allSkus.size > 1 || allMpns.size > 1) continue;

    const anchorItems = anchors.map(entry => cloned[entry.index]);
    const reference = anchorItems[0];
    let groupIsSafe = true;
    for (const member of members) {
      if (anchorOverride.brand && member.brand && normalizeName(anchorOverride.brand) !== normalizeName(member.brand)) {
        groupIsSafe = false;
        break;
      }
      if (!sameComparableOffer(reference, member)) {
        groupIsSafe = false;
        break;
      }
      if (anchorItems.some(anchor => identitiesConflict(identityOf(anchor), identityOf(member)))) {
        groupIsSafe = false;
        break;
      }
      if (anchorItems.some(anchor => variantMetadataConflicts(anchor, member))) {
        groupIsSafe = false;
        break;
      }
    }
    if (!groupIsSafe) continue;

    for (const index of indices) {
      if (anchors.some(entry => entry.index === index)) continue;
      const item = cloned[index];
      if (!mayReplaceTitle(item)) continue;
      if (anchorOverride.brand && item.brand && normalizeName(anchorOverride.brand) !== normalizeName(item.brand)) continue;
      item.name = anchorOverride.name;
      propagatedRecordCount++;
    }
  }

  return {
    records: cloned,
    exactGtinMatches: exactMatches.length,
    propagatedRecordCount,
    appliedRecordCount: exactMatches.length + propagatedRecordCount
  };
}


/** Returns true when a listing title is only the manufacturer's brand. */
export function isBrandOnlyProductName(name, brand) {
  const normalizedName = normalizeName(name);
  const normalizedBrand = normalizeName(brand);
  return Boolean(normalizedName && normalizedBrand && normalizedName === normalizedBrand);
}

/**
 * Build a compact, non-mutating diagnostic record for products rejected only
 * because their title is not safe to import (for example, the title equals
 * the brand). This intentionally does not invent or promote a product name.
 */
export function summarizeRejectedImportNameRecords(records, isAcceptedName = () => false) {
  const scalar = (value, max = 180) => {
    if (value == null || typeof value === "object") return null;
    const text = String(value).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, max) : null;
  };
  const first = (item, keys, max = 180) => {
    for (const key of keys) {
      const value = scalar(item?.[key], max);
      if (value) return value;
    }
    return null;
  };
  const modelKeys = [
    "model", "modelName", "model_name", "modelNumber", "model_number",
    "manufacturerModel", "manufacturerModelNumber", "mpn",
    "manufacturerPartNumber", "manufacturer_part_number"
  ];
  const productTypeKeys = ["productType", "product_type", "categoryName", "category"];

  return (Array.isArray(records) ? records : [])
    .filter(item => item && typeof item === "object" && !isAcceptedName(item))
    .slice(0, 100)
    .map(item => {
      const name = scalar(item.name);
      const brand = scalar(item.brand);
      const modelCandidates = Object.fromEntries(modelKeys
        .map(key => [key, scalar(item[key], 120)])
        .filter(([, value]) => value));
      const identifiers = {
        sku: first(item, ["sku", "SKU", "articleNumber", "article_number", "itemNumber", "item_number"]),
        gtin: first(item, ["gtin", "ean", "ean13", "barcode", "gtin13", "gtin14"]),
        mpn: first(item, ["mpn", "MPN", "manufacturerPartNumber", "manufacturer_part_number"]),
        productId: first(item, ["productId", "productID", "product_id", "itemId", "item_id", "id"])
      };
      return {
        reason: isBrandOnlyProductName(name, brand) ? "brand-only-name" : "invalid-name",
        name,
        brand,
        price: Number.isFinite(Number(item.price)) ? Number(item.price) : null,
        currency: scalar(item.currency, 12),
        ...identifiers,
        modelCandidates,
        productTypeCandidate: first(item, productTypeKeys),
        descriptionCandidate: first(item, ["description", "shortDescription", "short_description"], 350),
        source: scalar(item.source, 100),
        sourceUrl: first(item, ["sourceUrl", "url", "pageUrl"], 500),
        detailPageVisited: item.detailPageVisited === true,
        hasStrongIdentifier: Boolean(identifiers.gtin || identifiers.sku || identifiers.mpn || identifiers.productId)
      };
    });
}

