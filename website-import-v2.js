import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import ipaddr from "ipaddr.js";
import { load as loadHtml } from "cheerio";

// ==========================================
// NOVA AI - WEBSITE IMPORTER V3.86.5
// V3.86.5 keeps physical product/package weight and volume separate from sellable package contents.
// V3.86.4 reads Grandus/Euronics detailedParameters and preserves generic product attributes.
// Existing category/detail crawl limits, price validation, identifiers and safe merge rules are unchanged.
// Universal product import: multilingual variant discovery, product dimensions and per-parcel package breakdown
// V3.86 adds conservative PDP extraction for SKU, EAN/GTIN, product weight and explicit stock availability.
// V3.86.1 prevents generic availability headings (for example "Dostupnosť") from being interpreted as stock status.
// V3.86.2 extracts identifiers, availability and explicit stock data from embedded Next.js product JSON.
// V3.85 prioritizes explicit currency-qualified selling-price elements over mixed product-card text and records price provenance.
// V3.84.1 selects only the primary product from queued detail pages while preserving explicitly grouped variants.
// V3.82 adds a safe current-product fallback from page title/metadata when storefront dimensions are omitted from the raw HTTP HTML.
// V3.81 reads explicitly scoped assembled-product measurement panels independently from package accordions.
// V3.77 pairs split axis/value nodes and scopes page specs to the exact URL variant. V3.78 resolves repeated dimension-tab headings and explicitly pairs semantic measurement rows.
// Preserves V3.77 variant identity, parcel breakdown and prior GymBeam variants.
// Preserves V3.73 multilingual variants and the GymBeam JSON-LD offer-group fix.
// produktov a cien
// ==========================================

const MAX_BYTES = 8 * 1024 * 1024;
// 4home occasionally returns a larger AJAX HTML fragment than ordinary pages.
// Keep the normal-site cap unchanged and allow a bounded 16 MiB only for 4home.
const FOURHOME_MAX_BYTES = 32 * 1024 * 1024; // limit applies to decompressed HTML
const MAX_TOTAL_BYTES = 180 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_PAGES = 700;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 12000;
const HARD_REQUEST_TIMEOUT_MS = 20000;
const DNS_TIMEOUT_MS = 10000;
const MAX_TOTAL_TIME_MS = 20 * 60 * 1000;
const REQUEST_DELAY_MS = 350;
const PRODUCT_DETAIL_REQUEST_DELAY_MS = 900;
const MAX_QUEUE = 400;
const MAX_PAGINATION_LINKS_PER_PAGE = 40;
const MAX_PAGINATION_LINKS_TOTAL = 500;
const MAX_PRODUCTS_PER_PAGE = 1500;
const MAX_CATEGORY_DETAIL_PAGES = 650;

// 4home AJAX responses are cumulative (page N repeats products from earlier pages).
// Use tighter crawl budgets and deduplicate products as they are collected.
const FOURHOME_MAX_PAGES = 160;
const FOURHOME_MAX_VARIANT_PARENT_PAGES = 16;
const FOURHOME_MAX_TOTAL_TIME_MS = 6 * 60 * 1000;
const FOURHOME_MAX_TOTAL_BYTES = 220 * 1024 * 1024;

const USER_AGENT =
  "NOVA-AI-Website-Importer/3.0 (+https://nova-ai.sk)";

const BLOCKED_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4"
].map(value => ipaddr.parseCIDR(value));

const ALLOWED_IPV6 = ipaddr.parseCIDR("2000::/3");

const BLOCKED_IPV6 = [
  "::/128",
  "::1/128",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8"
].map(value => ipaddr.parseCIDR(value));

function isIPInRange(address, range) {
  try {
    const parsed = ipaddr.parse(address);
    return parsed.match(range);
  } catch {
    return false;
  }
}

export function isPublicIP(address) {
  if (!address || net.isIP(address) === 0) {
    return false;
  }

  const parsed = ipaddr.parse(address);

  if (parsed.kind() === "ipv4") {
    return !BLOCKED_IPV4.some(range =>
      parsed.match(range)
    );
  }

  if (parsed.kind() === "ipv6") {
    if (!parsed.match(ALLOWED_IPV6)) {
      return false;
    }

    return !BLOCKED_IPV6.some(range =>
      parsed.match(range)
    );
  }

  return false;
}

export function parseAndValidateUrl(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error("Neplatna URL adresa.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Povolene su iba HTTP a HTTPS adresy.");
  }

  if (url.username || url.password) {
    throw new Error("URL nesmie obsahovat prihlasovacie udaje.");
  }

  if (url.hostname.endsWith(".")) {
    url.hostname = url.hostname.slice(0, -1);
  }

  const hostname = url.hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Lokalne adresy nie su povolene.");
  }

  if (net.isIP(hostname)) {
    throw new Error("Priame IP adresy nie su povolene.");
  }

  const port = url.port;

  if (
    port &&
    !(
      (url.protocol === "http:" && port === "80") ||
      (url.protocol === "https:" && port === "443")
    )
  ) {
    throw new Error("Nestandardny port nie je povoleny.");
  }

  if (
    !hostname ||
    hostname.length > 253 ||
    !hostname.includes(".")
  ) {
    throw new Error("Neplatna domena.");
  }

  return url;
}

export async function resolvePublicAddresses(hostname) {
  let records;
  let dnsTimer;

  try {
    records = await Promise.race([
      dns.lookup(hostname, {
        all: true,
        verbatim: true
      }),
      new Promise((_, reject) => {
        dnsTimer = setTimeout(
          () => reject(new Error("DNS timeout")),
          DNS_TIMEOUT_MS
        );
      })
    ]);
  } catch {
    throw new Error("Domenu sa nepodarilo DNS prelozit.");
  } finally {
    if (dnsTimer) clearTimeout(dnsTimer);
  }

  if (!records || records.length === 0) {
    throw new Error("Domena nema DNS adresu.");
  }

  for (const record of records) {
    if (!isPublicIP(record.address)) {
      throw new Error(
        "Domena smeruje na nepovolenu alebo privatnu IP adresu."
      );
    }
  }

  return records;
}

function createPinnedLookup(records) {
  let index = 0;

  return (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }

    const lookupOptions =
      options && typeof options === "object"
        ? options
        : {};

    const family = lookupOptions.family || 0;

    let available = records;

    if (family === 4 || family === 6) {
      available = records.filter(
        record => record.family === family
      );
    }

    if (!available.length) {
      callback(
        new Error(
          "Pre domenu nie je dostupna pozadovana IP rodina."
        )
      );
      return;
    }

    if (lookupOptions.all === true) {
      callback(
        null,
        available.map(record => ({
          address: record.address,
          family: record.family
        }))
      );
      return;
    }

    const record = available[index % available.length];
    index++;

    callback(
      null,
      record.address,
      record.family
    );
  };
}

function getRequestModule(protocol) {
  return protocol === "https:" ? https : http;
}

function readResponseLimited(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    response.on("data", chunk => {
      total += chunk.length;

      if (total > maxBytes) {
        response.destroy(
          new Error("Odpoved prekrocila povolenu velkost.")
        );
        return;
      }

      chunks.push(chunk);
    });

    response.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    response.on("error", reject);
  });
}

async function requestOnce(url, records, maxBytes, extraHeaders = {}) {
  const module = getRequestModule(url.protocol);
  const lookup = createPinnedLookup(records);

  return new Promise((resolve, reject) => {
    let settled = false;
    let hardTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (error) reject(error);
      else resolve(value);
    };

    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      lookup,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "close",
        ...extraHeaders
      }
    };

    const request = module.request(options, async response => {
      try {
        const encoding = String(response.headers["content-encoding"] || "identity")
          .trim().toLowerCase();
        let responseStream = response;

        // 4home posiela niektoré produktové HTML ako veľmi veľké nekomprimované
        // dokumenty. Preferujeme prenos gzip/deflate/br a limit uplatňujeme až
        // po dekompresii, aby ochrana veľkosti odpovede zostala účinná.
        if (encoding === "gzip" || encoding === "x-gzip") {
          responseStream = response.pipe(createGunzip());
        } else if (encoding === "deflate") {
          responseStream = response.pipe(createInflate());
        } else if (encoding === "br") {
          responseStream = response.pipe(createBrotliDecompress());
        } else if (encoding !== "identity" && encoding !== "") {
          response.destroy();
          finish(new Error(`Nepodporovane komprimovanie odpovede: ${encoding}.`));
          return;
        }

        if (responseStream !== response) {
          response.on("error", error => {
            if (!responseStream.destroyed) responseStream.destroy(error);
          });
          responseStream.on("error", error => {
            if (!response.destroyed) response.destroy(error);
          });
        }

        const body = await readResponseLimited(
          responseStream,
          maxBytes
        );

        finish(null, {
          statusCode: response.statusCode || 0,
          headers: response.headers,
          body
        });
      } catch (error) {
        finish(error);
      }
    });

    hardTimer = setTimeout(() => {
      request.destroy(
        new Error("Prekroceny pevny casovy limit nacitania stranky (20 s).")
      );
    }, HARD_REQUEST_TIMEOUT_MS);

    request.setTimeout(TIMEOUT_MS, () => {
      request.destroy(
        new Error("Casovy limit pri nacitani stranky.")
      );
    });

    request.on("error", error => finish(error));
    request.end();
  });
}

export async function safeFetchWebsite(
  input,
  options = {}
) {
  let currentUrl = parseAndValidateUrl(input);
  const hostMaxBytes = /(^|\.)4home\.sk$/i.test(currentUrl.hostname)
    ? FOURHOME_MAX_BYTES
    : MAX_BYTES;
  const maxBytes = Math.min(
    Number(options.maxBytes) || hostMaxBytes,
    hostMaxBytes
  );
  const originalHost = currentUrl.hostname.replace(/^www\./i, "");

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount++
  ) {
    const records = await resolvePublicAddresses(
      currentUrl.hostname
    );

    // Temporary upstream/server failures (for example HTTP 503) must not
    // immediately mark an otherwise valid product page as failed. Retry the
    // same URL a bounded number of times with backoff. Permanent 4xx errors
    // are still returned immediately and crawl completeness remains strict.
    let response;
    let transientRetryCount = 0;
    while (true) {
      response = await requestOnce(
        currentUrl,
        records,
        maxBytes,
        options.headers || {}
      );

      const responseStatus = response.statusCode;
      const isTransientStatus = [408, 429, 500, 502, 503, 504].includes(responseStatus);
      if (!isTransientStatus || transientRetryCount >= 3) break;

      const retryDelaysMs = [1200, 2500, 5000];
      await new Promise(resolve => setTimeout(resolve, retryDelaysMs[transientRetryCount]));
      transientRetryCount++;
    }

    const status = response.statusCode;

    if (
      [301, 302, 303, 307, 308].includes(status)
    ) {
      const location = response.headers.location;

      if (!location) {
        throw new Error("Presmerovanie nema cielovu adresu.");
      }

      if (redirectCount === MAX_REDIRECTS) {
        throw new Error("Prekroceny limit presmerovani.");
      }

      const nextUrl = parseAndValidateUrl(
        new URL(location, currentUrl).href
      );

      const nextHost = nextUrl.hostname.replace(/^www\./i, "");
      if (nextHost !== originalHost) {
        throw new Error(
          "Presmerovanie na inu domenu nie je povolene."
        );
      }

      if (
        currentUrl.protocol === "https:" &&
        nextUrl.protocol !== "https:"
      ) {
        throw new Error(
          "Presmerovanie z HTTPS na HTTP nie je povolene."
        );
      }

      currentUrl = nextUrl;
      continue;
    }

    if (status < 200 || status >= 300) {
      throw new Error(
        `Web vratil HTTP status ${status}.`
      );
    }

    return {
      statusCode: status,
      headers: response.headers,
      body: response.body,
      url: currentUrl.href
    };
  }

  throw new Error("Stranku sa nepodarilo nacitat.");
}

// ==========================================
// VSEOBECNE POMOCNE FUNKCIE
// ==========================================

function cleanText(value, maxLength = 1000) {
  if (value == null) return "";

  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    )
    .replace(/&#([0-9]+);/g, (_, code) =>
      String.fromCodePoint(parseInt(code, 10))
    );
}

function normalizeCurrency(value) {
  const input = String(value || "").trim().toUpperCase();

  const currencies = {
    "€": "EUR",
    "EUR": "EUR",
    "EURO": "EUR",
    "EUROS": "EUR",
    "KČ": "CZK",
    "CZK": "CZK",
    "KČS": "CZK",
    "PLN": "PLN",
    "ZŁ": "PLN",
    "HUF": "HUF",
    "FT": "HUF",
    "FORINT": "HUF",
    "£": "GBP",
    "GBP": "GBP",
    "$": "USD",
    "USD": "USD",
    "CHF": "CHF"
  };

  return currencies[input] || null;
}

function parsePrice(value) {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0
      ? value
      : null;
  }

  let input = decodeEntities(String(value))
    .replace(/\u00a0/g, " ")
    .trim();

  input = input.replace(
    /(?:EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$)/gi,
    ""
  );

  input = input.replace(/[^\d.,\- ]/g, "").trim();

  if (!input || !/\d/.test(input)) {
    return null;
  }

  input = input.replace(/\s/g, "");

  const comma = input.lastIndexOf(",");
  const dot = input.lastIndexOf(".");

  if (comma >= 0 && dot >= 0) {
    if (comma > dot) {
      input = input.replace(/\./g, "").replace(",", ".");
    } else {
      input = input.replace(/,/g, "");
    }
  } else if (comma >= 0) {
    const decimals = input.length - comma - 1;

    if (decimals === 1 || decimals === 2) {
      input = input.replace(",", ".");
    } else {
      input = input.replace(/,/g, "");
    }
  } else if (dot >= 0) {
    const decimals = input.length - dot - 1;

    if (decimals !== 1 && decimals !== 2) {
      input = input.replace(/\./g, "");
    }
  }

  const price = Number(input);

  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }

  if (price > 100000000) {
    return null;
  }

  return Math.round(price * 100) / 100;
}

export function normalizeOptionalPositiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeProductUnit(value) {
  if (value == null) return null;

  const raw = cleanText(String(value), 80).toLowerCase()
    .replace(/\u00a0/g, " ")
    .trim();

  if (!raw) return null;

  const map = {
c62: "ks",
h87: "ks",
ea: "ks",
each: "ks",
piece: "ks",
    pieces: "ks",
    ks: "ks",
    kus: "ks",
    kusov: "ks",
    kusy: "ks",
    pc: "ks",
    pcs: "ks",
    mtk: "m²",
    mtq: "m³",
    mtr: "m",
    kgm: "kg",
    grm: "g",
    ltr: "l",
    dmq: "dm²",
    xpk: "balenie",
    pack: "balenie",
    package: "balenie",
    set: "set",
    pair: "pár",
    pr: "pár",
    capsule: "kapsula",
    capsules: "kapsula",
    kap: "kapsula",
    kaps: "kapsula",
    "kaps.": "kapsula",
    kapsula: "kapsula",
    kapsuly: "kapsula",
    kapsúl: "kapsula",
    kapsulu: "kapsula",
    tablet: "tableta",
    tablets: "tableta",
    tableta: "tableta",
    tablety: "tableta",
    tabliet: "tableta",
    tabletu: "tableta",
    serving: "dávka",
    servings: "dávka",
    dávka: "dávka",
    dávky: "dávka",
    dávok: "dávka",
    dávku: "dávka"
  };

  if (map[raw]) return map[raw];

  const normalized = raw
    .replace(/\s+/g, " ")
    .replace(/^kus(y|ov)?$/, "ks");

  const allowed = [
    "ks", "m²", "m2", "m³", "m3", "m", "cm", "mm",
    "kg", "g", "t", "l", "ml", "balenie", "bal", "set",
    "pár", "par", "hod", "deň", "mesiac", "kapsula", "tableta", "dávka"
  ];

  if (!allowed.includes(normalized)) return null;

  return ({
    m2: "m²",
    m3: "m³",
    bal: "balenie",
    par: "pár"
  })[normalized] || normalized;
}

function extractUnitFromText(value) {
  if (!value) return null;

  const text = decodeEntities(String(value))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const unitPattern =
    "(ks|kus(?:y|ov)?|piece|pieces|pc|pcs|ea|c62|h87|m²|m2|mtk|m³|m3|mtq|m|mtr|cm|mm|kg|kgm|g|grm|t|l|ltr|ml|balenie|bal|pack|package|set|pár|par|pair|pr|capsules?|kaps(?:ula|uly|ulu|ulov|úl)|kapsul|kap(?:s)?\.?|tablets?|tablet(?:a|y|u|iet)?|servings?|dávk(?:a|y|u|ov))";

  const boundary = "(?=$|[\\s.,;:)}\\]])";

  const salesUnitPatterns = [
    new RegExp(
      "(?:predajn[aá]\\s+jednotka|jednotka\\s+predaja|merna\\s+jednotka|mierna\\s+jednotka|sales\\s+unit|unit\\s+of\\s+sale)\\s*[:\\-]?\\s*" +
      unitPattern + boundary,
      "i"
    ),
    new RegExp(
      "(?:cena|price)\\s+za\\s+" +
      unitPattern + boundary,
      "i"
    )
  ];

  for (const pattern of salesUnitPatterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      const unit = normalizeProductUnit(match[1]);
      if (unit) return unit;
    }
  }

  const pricePatterns = [
    // Jednotku odvodzujeme iba z výslovného zápisu ceny za jednotku,
    // napr. "12,50 € / ks". Samotné "/m" môže byť súčasť URL,
    // technického označenia alebo iného nesúvisiaceho textu stránky.
    new RegExp(
      "(?:€|eur|czk|kč|pln|zł|ft|huf|usd|gbp|\\$|£|chf)\\s*\\/\\s*" +
      unitPattern + boundary,
      "i"
    ),
    new RegExp(
      "\\b(?:cena|price)\\s+za\\s+" + unitPattern + boundary,
      "i"
    )
  ];

  for (const pattern of pricePatterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      const unit = normalizeProductUnit(match[1]);
      if (unit) return unit;
    }
  }

  return null;
}

function extractStructuredUnit(...objects) {
  for (const object of objects) {
    if (!object || typeof object !== "object") continue;

    const candidates = [
      object.unitText,
      object.unitCode,
      object.unit,
      object.priceUnit,
      object.measurementUnit,
      object.unitOfMeasure,
      object.salesUnit,
      object.referenceQuantity?.unitCode,
      object.referenceQuantity?.unitText,
      object.eligibleQuantity?.unitCode,
      object.eligibleQuantity?.unitText
    ];

    for (const candidate of candidates) {
      // `typeof null === "object"` in JavaScript, so guard null before
      // reading structured unit properties from optional source fields.
      const unit = normalizeProductUnit(
        candidate !== null && typeof candidate === "object"
          ? candidate.name || candidate.value || candidate.code
          : candidate
      );
      if (unit) return unit;
    }

    const specification = object.priceSpecification;
    if (specification && typeof specification === "object") {
      const unit = extractStructuredUnit(specification);
      if (unit) return unit;
    }
  }

  return null;
}


// Package size is stored separately from the sales unit and from the
// reference price (e.g. EUR/kg). Only explicit structured fields or clearly
// labelled package-weight/content fields are accepted; product names are
// deliberately never parsed for a guessed package size.
function extractPackageMeasure(...objects) {
  // Only fields that explicitly describe sellable contents are accepted.
  // Physical product weight, gross/package weight and appliance capacity/volume
  // are handled by extractPhysicalSpecsFromStructured(), never as package quantity.
  const keys = ["netContent", "contentSize", "packageContent", "packageContents", "netQuantity", "packageQuantity"];
  for (const object of objects) {
    if (!object || typeof object !== "object") continue;
    for (const key of keys) {
      const raw = object[key];
      if (raw == null) continue;
      let quantity = null;
      let unit = null;
      if (typeof raw === "number" || typeof raw === "string") {
        const match = String(raw).trim().match(/^([0-9]+(?:[.,][0-9]+)?)\s*(kg|g|grm|kgm|l|ltr|ml|capsules?|kaps(?:ula|uly|ulu|ulov|úl)|kapsul|kap(?:s)?\.?|tablets?|tablet(?:a|y|u|iet)?|servings?|dávk(?:a|y|u|ov))$/i);
        if (match) {
          quantity = Number(match[1].replace(",", "."));
          unit = normalizeProductUnit(match[2]);
        }
      } else if (typeof raw === "object") {
        const rawValue = raw.value ?? raw.amount ?? raw.quantityValue;
        quantity = normalizeOptionalPositiveNumber(rawValue);
        unit = extractStructuredUnit(raw);
        if (quantity == null && typeof rawValue === "string") {
          const match = rawValue.trim().match(/^([0-9]+(?:[.,][0-9]+)?)\s*(kg|g|grm|kgm|l|ltr|ml|capsules?|kaps(?:ula|uly|ulu|ulov|úl)|kapsul|kap(?:s)?\.?|tablets?|tablet(?:a|y|u|iet)?|servings?|dávk(?:a|y|u|ov))$/i);
          if (match) {
            quantity = Number(match[1].replace(",", "."));
            unit = unit || normalizeProductUnit(match[2]);
          }
        }
      }
      quantity = normalizeOptionalPositiveNumber(quantity);
      if (quantity != null && unit && ["kg", "g", "l", "ml", "kapsula", "tableta", "dávka"].includes(unit)) {
        return { packageQuantity: quantity, packageUnit: unit, packageLabel: `${quantity} ${unit}`, packageMeasureSource: key };
      }
    }
  }
  // Absence is represented by absent fields, not null-valued sale quantities.
  return {};
}

function parseExplicitPackageLabel(value) {
  const text = decodeEntities(String(value || "")).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const multipack = text.match(/\b(\d{1,4})\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i);
  if (multipack) {
    const count = Number(multipack[1]);
    const amount = Number(multipack[2].replace(",", "."));
    const unit = normalizeProductUnit(multipack[3]);
    if (count > 0 && amount > 0 && unit) {
      const base = unit === "kg" || unit === "l" ? 1 : 1;
      return { packageQuantity: Math.round(count * amount * base * 1000) / 1000, packageUnit: unit, packageLabel: `${count} × ${amount} ${unit}`, packageMeasureSource: "dom:explicit-multipack" };
    }
  }
  const single = text.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|capsules?|kaps(?:ula|uly|ulu|ulov|úl)|kapsul|kap(?:s)?\.?|tablets?|tablet(?:a|y|u|iet)?|servings?|dávk(?:a|y|u|ov))\b/i);
  if (!single) return null;
  const quantity = Number(single[1].replace(",", "."));
  const unit = normalizeProductUnit(single[2]);
  if (!Number.isFinite(quantity) || quantity <= 0 || !unit) return null;
  return { packageQuantity: quantity, packageUnit: unit, packageLabel: `${quantity} ${unit}`, packageMeasureSource: "dom:explicit-package-label" };
}

export function extractExplicitNetPackageMeasureFromText(value) {
  const text = decodeEntities(String(value || ""))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  // Accept only explicit net-content/net-volume labels. Net/product weight
  // is a physical specification and is deliberately not a sales package size.
  const match = text.match(/(?:netto\s*(?:obsah|objem)|net\s*(?:content|volume)|čist(?:ý|y|á|a)\s*(?:obsah|objem)|obsah\s*balenia|package\s*content|content\s*of\s*(?:the\s*)?package)\s*(?:\((kg|g|ml|l)\))?\s*[:：-]?\s*(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)?\b/i);
  if (!match) return null;

  let quantity = Number(match[2].replace(",", "."));
  let unit = normalizeProductUnit(match[3] || match[1]);
  if (!Number.isFinite(quantity) || quantity <= 0 || !unit) return null;
  if (unit === "g" && quantity >= 1000 && quantity % 1000 === 0) {
    quantity /= 1000;
    unit = "kg";
  } else if (unit === "ml" && quantity >= 1000 && quantity % 1000 === 0) {
    quantity /= 1000;
    unit = "l";
  }
  return {
    packageQuantity: quantity,
    packageUnit: unit,
    packageLabel: `${quantity} ${unit}`,
    packageMeasureSource: "dom:explicit-net-package-label"
  };
}

// Physical product specifications are distinct from the sellable package content.
// Dimensions are normalized to centimetres, weights to kilograms and volume to litres;
// the original source text is retained for an accurate merchant-facing display.
const PHYSICAL_DIMENSION_AXES = ["width", "height", "depth", "length", "diameter", "thickness"];

function normalizePhysicalUnit(value) {
  const raw = cleanText(String(value || ""), 40).toLowerCase().replace(/\s+/g, "").replace(/\.$/, "");
  const map = {
    cmt: "cm", centimeter: "cm", centimetre: "cm", centimeters: "cm", centimetres: "cm",
    mmt: "mm", millimeter: "mm", millimetre: "mm", millimeters: "mm", millimetres: "mm",
    mtr: "m", meter: "m", metre: "m", meters: "m", metres: "m",
    inh: "in", inch: "in", inches: "in", in: "in", '"': "in",
    fot: "ft", foot: "ft", feet: "ft", ft: "ft",
    kgm: "kg", kilogram: "kg", kilograms: "kg", kilogramme: "kg", kilogrammes: "kg",
    grm: "g", gram: "g", grams: "g", milligram: "mg", milligrams: "mg", mg: "mg",
    lbr: "lb", pound: "lb", pounds: "lb", lb: "lb",
    ltr: "l", liter: "l", litre: "l", liters: "l", litres: "l",
    milliliter: "ml", millilitre: "ml", milliliters: "ml", millilitres: "ml"
  };
  return map[raw] || (["cm", "mm", "m", "in", "ft", "kg", "g", "mg", "lb", "l", "ml"].includes(raw) ? raw : null);
}

function parsePhysicalMeasurement(raw, unitHint = "", kind = "dimension") {
  let value = raw;
  let unit = unitHint;
  if (raw && typeof raw === "object") {
    value = raw.value ?? raw.amount ?? raw.quantityValue ?? raw.valueText ?? raw.text ?? raw.name;
    unit = raw.unitText || raw.unitCode || raw.unit || raw.measurementUnit || raw.unitOfMeasure || unitHint;
  }
  if (value == null || value === "") return null;
  const text = decodeEntities(String(value)).replace(/\u00a0/g, " ").trim();
  const match = text.match(/^\s*([+-]?\d+(?:[.,]\d+)?)\s*(mm|cm|m|inches?|inch|in|ft|feet|kg|g|mg|lb|lbs|l|ml)?\s*$/i);
  if (!match) return null;
  const number = Number(match[1].replace(",", "."));
  const sourceUnit = normalizePhysicalUnit(match[2] || unit);
  if (!Number.isFinite(number) || number <= 0 || !sourceUnit) return null;

  let normalized = number;
  let normalizedUnit = sourceUnit;
  if (kind === "dimension") {
    const factors = { mm: 0.1, cm: 1, m: 100, in: 2.54, ft: 30.48 };
    if (!(sourceUnit in factors)) return null;
    normalized = number * factors[sourceUnit];
    normalizedUnit = "cm";
  } else if (kind === "weight") {
    const factors = { kg: 1, g: 0.001, mg: 0.000001, lb: 0.45359237 };
    if (!(sourceUnit in factors)) return null;
    normalized = number * factors[sourceUnit];
    normalizedUnit = "kg";
  } else if (kind === "volume") {
    const factors = { l: 1, ml: 0.001 };
    if (!(sourceUnit in factors)) return null;
    normalized = number * factors[sourceUnit];
    normalizedUnit = "l";
  }
  return { value: Math.round(normalized * 10000) / 10000, unit: normalizedUnit };
}

function normalizePhysicalLabel(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l").replace(/ß/g, "ss")
    .replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function extractDimensionVariant(value) {
  const text = decodeEntities(String(value || "")).replace(/\u00a0/g, " ").trim();
  if (!text) return null;
  // Accept 2D and 3D dimensions, with the unit written once at the end
  // (e.g. 200x66x201 cm, 80 × 40 cm, 1200 x 800 x 25 mm).
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:mm|cm)?\s*[x×]\s*(\d+(?:[.,]\d+)?)(?:\s*(?:mm|cm)?\s*[x×]\s*(\d+(?:[.,]\d+)?))?\s*(mm|cm)\b/i);
  if (!match) return null;
  const unit = normalizePhysicalUnit(match[4]);
  const values = [match[1], match[2], match[3]].filter(Boolean).map(value => Number(value.replace(",", ".")));
  if (!unit || values.some(value => !Number.isFinite(value) || value <= 0)) return null;
  const factor = unit === "mm" ? 0.1 : 1;
  const cmValues = values.map(value => Math.round(value * factor * 10000) / 10000);
  const formattedValues = cmValues.map(value => Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, "").replace(/\.$/, ""));
  const size = `${formattedValues.join(" × ")} cm`;
  const dimensions = {
    width: cmValues[0] ?? null,
    height: null,
    depth: null,
    length: null,
    unit: "cm",
    raw: size,
    source: "dom:variant-size-selector"
  };
  if (cmValues.length === 2) dimensions.height = cmValues[1];
  if (cmValues.length === 3) {
    dimensions.depth = cmValues[1];
    dimensions.height = cmValues[2];
  }
  return { size, values: cmValues, unit: "cm", dimensions };
}

function normalizeVariantMarker(value) {
  return normalizePhysicalLabel(value).replace(/[：:]/g, " ").replace(/\s+/g, " ").trim();
}

function isExplicitSizeVariantMarker(value) {
  const text = normalizeVariantMarker(value);
  return /(?:\bvybrat(?:e)?\s+(?:si\s+)?(?:rozmer|rozmery|velkost|velkosti)\b|\bvyber(?:te|at)?\s+(?:si\s+)?(?:rozmer|rozmery|velkost|velkosti)\b|\bzvol(?:te|it)?\s+(?:rozmer|velkost)\b|rozmerove\s+varianty|velkostne\s+varianty|choose\s+(?:a\s+)?(?:size|dimension)|select\s+(?:a\s+)?(?:size|dimension)|size\s+variants|choose\s+size|select\s+size|groesse\s+waehlen|tailles?\s+a\s+choisir|choisir\s+la\s+taille|elegir\s+tama[nñ]o|scegli\s+la\s+misura|scegli\s+la\s+taglia|wybierz\s+rozmiar|kies\s+maat)/i.test(text);
}

function parsePhysicalAxisLine(value) {
  const text = decodeEntities(String(value || "")).replace(/\u00a0/g, " ").trim();
  const match = text.match(/^(.{2,36}?)\s*[:：-]?\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m|in|inch|ft)\s*$/i);
  if (!match) return null;
  const label = normalizePhysicalLabel(match[1]).replace(/[^a-z0-9 ]/g, "").trim();
  const axisMap = [
    ["width", /^(?:sirka|width|w|breite|largeur|larghezza|ancho|szerokosc)$/],
    ["height", /^(?:vyska|height|h|hoehe|hauteur|altezza|altura|wysokosc)$/],
    ["depth", /^(?:hlbka|hloubka|depth|tiefe|profondeur|profondita|profundidad|glebokosc)$/],
    ["length", /^(?:dlzka|length|l|laenge|longueur|lunghezza|dlugosc)$/]
  ];
  const axis = axisMap.find(([, pattern]) => pattern.test(label))?.[0];
  if (!axis) return null;
  const measurement = parsePhysicalMeasurement(`${match[2]} ${match[3]}`, "", "dimension");
  return measurement ? { axis, value: measurement.value, raw: text } : null;
}

function parsePhysicalAxisLabel(value) {
  const label = normalizePhysicalLabel(value)
    .replace(/[：:]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const axisMap = [
    ["width", /^(?:sirka|width|w|breite|largeur|larghezza|ancho|szerokosc)$/],
    ["depth", /^(?:hlbka|hloubka|depth|tiefe|profondeur|profondita|profundidad|glebokosc)$/],
    ["height", /^(?:vyska|height|h|hoehe|hauteur|altezza|altura|wysokosc)$/],
    ["length", /^(?:dlzka|length|l|laenge|longueur|lunghezza|dlugosc)$/]
  ];
  return axisMap.find(([, pattern]) => pattern.test(label))?.[0] || null;
}

function parsePackageWeightLabel(value) {
  const label = normalizePhysicalLabel(value).replace(/[：:]/g, " ").replace(/\s+/g, " ").trim();
  if (!/^(?:hmotnost|vaha|weight|gewicht|waga|poids|peso)(?:\s+(?:do|max(?:imum)?|up to|bis zu))?$/.test(label)) return null;
  return /\b(?:do|max(?:imum)?|up to|bis zu)\b/.test(label) ? "upper-bound" : "exact";
}

function parsePackageWeightLine(value) {
  const rawText = decodeEntities(String(value || "")).replace(/\u00a0/g, " ").trim();
  const text = normalizePhysicalLabel(rawText);
  const match = text.match(/(?:hmotnost|vaha|weight|gewicht|waga|poids|peso)\s*(?:(do|max(?:imum)?|up\s+to|bis\s+zu)\s*)?[:：-]?\s*(\d+(?:[.,]\d+)?)\s*(kg|g|lb|lbs)\b/i);
  if (!match) return null;
  const measurement = parsePhysicalMeasurement(`${match[2]} ${match[3]}`, "", "weight");
  if (!measurement) return null;
  return { value: measurement.value, unit: "kg", qualifier: match[1] ? "upper-bound" : "exact", raw: rawText };
}

function parseShippingPackageBlocks(inputBlocks) {
  const blocks = (Array.isArray(inputBlocks) ? inputBlocks : []).map(block =>
    typeof block === "string" ? { text: block, tag: "" } : { text: String(block?.text || ""), tag: String(block?.tag || "").toLowerCase() }
  ).filter(block => block.text.trim());
  const normalize = value => normalizePhysicalLabel(value).replace(/[：:]/g, " ").replace(/\s+/g, " ").trim();
  const packageHeading = /^(?:balenie|balenia|packages?|packaging|package details|package information|verpackung|pakete|opakowanie|opakowania|imballaggio|emballage|embalaje|colis)$/i;
  let start = blocks.findIndex(block => packageHeading.test(normalize(block.text)));
  if (start < 0) {
    start = blocks.findIndex(block => /^(?:tento vyrobok pozostava z|this product consists of|product consists of|dieses produkt besteht aus|ce produit comprend)\b/i.test(normalize(block.text)));
    if (start < 0) return {};
  }
  const section = blocks.slice(start + 1);
  const totalCountPattern = /(?:tento vyrobok|vyrobok|this product|product|dieses produkt|ce produit).{0,50}?(?:pozostava z|sa sklada z|consists of|includes|besteht aus|comprend)\s*(\d{1,3})\s*(?:balen[ií]|packages?|pakete|colis|opakowan)/i;
  let packageCount = null;
  for (const block of blocks.slice(start, Math.min(blocks.length, start + 45))) {
    const count = normalize(block.text).match(totalCountPattern);
    if (count) { packageCount = Number(count[1]); break; }
  }

  const packages = [];
  let group = null;
  let currentPackage = null;
  let sawExplicitPackageIndex = false;
  let pendingPackageAxis = null;
  let pendingPackageWeightQualifier = null;

  const flushPackage = () => {
    if (!currentPackage) return;
    const dims = currentPackage.dimensions;
    const hasDimensions = dims && [dims.width, dims.height, dims.depth, dims.length].some(value => Number(value) > 0);
    if (hasDimensions || Number(currentPackage.weight) > 0) {
      packages.push({
        component: currentPackage.component || group?.componentName || group?.componentCode || "Prepravné balenie",
        ...(group?.componentCode ? { componentCode: group.componentCode } : {}),
        ...(group?.sku ? { componentSku: group.sku } : {}),
        quantity: Number(currentPackage.quantity) > 0 ? Number(currentPackage.quantity) : 1,
        ...(Number(currentPackage.packageNo) > 0 ? { packageNo: Number(currentPackage.packageNo) } : {}),
        ...(hasDimensions ? { dimensions: { ...dims, unit: "cm", source: "dom:package-breakdown" } } : {}),
        ...(Number(currentPackage.weight) > 0 ? { weight: Number(currentPackage.weight), weightUnit: "kg", weightQualifier: currentPackage.weightQualifier || "exact", weightSource: "dom:package-breakdown" } : {})
      });
    }
    currentPackage = null;
  };
  const flushGroup = () => {
    flushPackage();
    group = null;
    sawExplicitPackageIndex = false;
    pendingPackageAxis = null;
    pendingPackageWeightQualifier = null;
  };
  const ensurePackage = () => {
    if (!group) group = { quantity: 1, componentCode: "", componentName: "", sku: "" };
    if (!currentPackage) {
      currentPackage = {
        quantity: group.quantity || 1,
        component: group.componentName || group.componentCode || "Prepravné balenie",
        dimensions: { width: null, height: null, depth: null, length: null, unit: "cm", raw: null }
      };
    }
    return currentPackage;
  };

  for (const block of section) {
    const raw = block.text.replace(/\u00a0/g, " ").trim();
    const text = normalize(raw);
    if (!text) continue;
    if (/^(?:tento vyrobok sa sklada z viacerych sucasti|tento vyrobok pozostava z tychto casti|this product is made up of several parts|this product consists of multiple parts|parts included|included components|components included|suciast[ií]|components)$/i.test(text)) break;

    const packageNo = text.match(/^(?:balenie|package|parcel|paket|colis)\s*(?:c\.?\s*)?(\d{1,3})\b/i);
    if (packageNo) {
      flushPackage();
      pendingPackageAxis = null;
      pendingPackageWeightQualifier = null;
      if (!group) group = { quantity: 1, componentCode: "", componentName: "", sku: "" };
      sawExplicitPackageIndex = true;
      currentPackage = {
        quantity: 1,
        packageNo: Number(packageNo[1]),
        component: group.componentName || group.componentCode || "Prepravné balenie",
        dimensions: { width: null, height: null, depth: null, length: null, unit: "cm", raw: null }
      };
      continue;
    }

    const groupMatch = raw.match(/^(\d{1,2})\s*[x×]\s*([\p{L}\p{N}_./-][\p{L}\p{N} _./-]{0,60})$/u);
    if (groupMatch && !extractDimensionVariant(raw)) {
      flushGroup();
      group = { quantity: Number(groupMatch[1]), componentCode: cleanText(groupMatch[2], 80), componentName: "", sku: "" };
      continue;
    }

    const skuOnly = raw.match(/^([A-Z0-9]{2,10}(?:[.-][A-Z0-9]{2,10}){1,3})$/i);
    if (skuOnly) {
      if (!group) group = { quantity: 1, componentCode: "", componentName: "", sku: "" };
      if (!group.sku) group.sku = skuOnly[1];
      continue;
    }

    const axis = parsePhysicalAxisLine(raw);
    if (axis) {
      const item = ensurePackage();
      item.dimensions[axis.axis] = axis.value;
      item.dimensions.raw = item.dimensions.raw ? `${item.dimensions.raw} × ${axis.raw}` : axis.raw;
      pendingPackageAxis = null;
      continue;
    }
    const axisLabel = parsePhysicalAxisLabel(raw);
    if (axisLabel) {
      pendingPackageAxis = axisLabel;
      pendingPackageWeightQualifier = null;
      continue;
    }
    const weight = parsePackageWeightLine(raw);
    if (weight) {
      const item = ensurePackage();
      item.weight = weight.value;
      item.weightQualifier = weight.qualifier;
      pendingPackageWeightQualifier = null;
      pendingPackageAxis = null;
      continue;
    }
    const weightQualifier = parsePackageWeightLabel(raw);
    if (weightQualifier) {
      pendingPackageWeightQualifier = weightQualifier;
      pendingPackageAxis = null;
      continue;
    }
    if (pendingPackageAxis) {
      const measurement = parsePhysicalMeasurement(raw, "cm", "dimension");
      if (measurement) {
        const item = ensurePackage();
        item.dimensions[pendingPackageAxis] = measurement.value;
        item.dimensions.raw = item.dimensions.raw
          ? `${item.dimensions.raw} × ${raw}`
          : `${pendingPackageAxis}: ${raw}`;
        pendingPackageAxis = null;
        continue;
      }
      pendingPackageAxis = null;
    }
    if (pendingPackageWeightQualifier) {
      const measurement = parsePhysicalMeasurement(raw, "kg", "weight");
      if (measurement) {
        const item = ensurePackage();
        item.weight = measurement.value;
        item.weightQualifier = pendingPackageWeightQualifier;
        pendingPackageWeightQualifier = null;
        continue;
      }
      pendingPackageWeightQualifier = null;
    }

    // The first descriptive line after a quantity/brand marker is the component name.
    // Other text (installation notes, materials, legal copy) is ignored.
    if (group && !group.componentName && !/^(?:balenie|package|parcel|paket|colis)\b/i.test(text) && raw.length <= 100 && !/\d{3}[.-]\d{3}[.-]\d{2,3}/.test(raw)) {
      group.componentName = cleanText(raw, 100);
      if (currentPackage && !currentPackage.component) currentPackage.component = group.componentName;
    }
  }
  flushGroup();
  if (!packages.length) return {};

  const inferredCount = packages.reduce((sum, item) => sum + (Number(item.quantity) > 0 ? Number(item.quantity) : 1), 0);
  packageCount = packageCount || inferredCount;
  // Never publish a sum based on only the subset of parcels that the page parser
  // happened to expose. IKEA-like pages may show a declared total count (e.g. 9)
  // while some nested parcel labels are rendered in leaf div/span elements.
  // A total is trustworthy only when the parsed parcel quantities cover the
  // declared count AND every parsed parcel has a weight.
  const parcelCountMatches = !packageCount || inferredCount === packageCount;
  const completeWeights = parcelCountMatches && packages.every(item => Number(item.weight) > 0);
  const totalWeight = completeWeights
    ? Math.round(packages.reduce((sum, item) => sum + Number(item.weight) * (Number(item.quantity) || 1), 0) * 10000) / 10000
    : null;
  const largest = packages
    .filter(item => item.dimensions && Number(item.dimensions.width) > 0 && Number(item.dimensions.height) > 0 && (Number(item.dimensions.depth) > 0 || Number(item.dimensions.length) > 0))
    .map(item => ({ item, volume: Number(item.dimensions.width) * Number(item.dimensions.height) * Number(item.dimensions.length || item.dimensions.depth) }))
    .sort((a, b) => b.volume - a.volume)[0]?.item;

  return {
    shippingPackages: packages.slice(0, 80),
    packageCount,
    packageCountSource: packageCount ? "dom:package-section" : null,
    shippingPackageSource: "dom:package-breakdown",
    ...(largest ? { shippingDimensions: { ...largest.dimensions, source: "dom:package-breakdown-largest", raw: largest.dimensions.raw || null } } : {}),
    ...(totalWeight != null ? {
      shippingWeight: totalWeight,
      shippingWeightUnit: "kg",
      shippingWeightQualifier: packages.some(item => item.weightQualifier === "upper-bound") ? "upper-bound" : "exact",
      shippingWeightSource: packages.some(item => item.weightQualifier === "upper-bound") ? "dom:package-breakdown-total-upper-bound" : "dom:package-breakdown-total"
    } : {})
  };
}

function extractProductDimensionsFromBlocks(inputBlocks) {
  const blocks = (Array.isArray(inputBlocks) ? inputBlocks : []).map(block =>
    typeof block === "string" ? { text: block, tag: "" } : { text: String(block?.text || ""), tag: String(block?.tag || "").toLowerCase() }
  );
  const normalize = value => normalizePhysicalLabel(value).replace(/[：:]/g, " ").replace(/\s+/g, " ").trim();
  const headingPattern = /^(?:rozmery|rozmery produktu|dimensions|product dimensions|measurements|abmessungen|misure|dimensiones)$/i;
  const packageBoundary = block => {
    const text = normalize(block.text);
    return /^(?:tento vyrobok|vyrobok|this product|product|dieses produkt|ce produit).{0,90}?(?:pozostava z|sa sklada z|consists of|includes|besteht aus|comprend)\s*\d{1,3}\s*(?:balen[ií]|packages?|pakete|colis|opakowan)/i.test(text) ||
      /^(?:balenie|balenia|packages?|packaging|package details|package information|verpackung|pakete|opakowanie|opakowania|imballaggio|emballage|embalaje|colis)(?:\s+(?:c\.?\s*)?\d{1,3})?$/i.test(text) ||
      /^(?:\d{1,2})\s*[x×]\s*[\p{L}\p{N}_./-]/u.test(text);
  };
  const axisNames = [
    ["width", /^(?:sirka|width|breite|largeur|larghezza|ancho|szerokosc)$/],
    ["depth", /^(?:hlbka|depth|tiefe|profondeur|profondita|glebokosc)$/],
    ["height", /^(?:vyska|height|hoehe|hauteur|altezza|altura|wysokosc)$/],
    ["length", /^(?:dlzka|length|laenge|longueur|lunghezza|dlugosc)$/]
  ];

  const parseFrom = (startIndex, headingMode) => {
    const result = { width: null, height: null, depth: null, length: null, diameter: null, thickness: null, unit: "cm", raw: null, source: "dom:dimensions-section" };
    let pendingAxis = null;
    let foundAxes = 0;
    let tupleFallback = null;

    for (let index = startIndex + 1; index < blocks.length; index++) {
      const block = blocks[index];
      const text = String(block.text || "").trim();
      const normalized = normalize(text);
      if (!normalized) continue;
      if (packageBoundary(block)) break;

      // Do not let an early navigation-tab label such as "Rozmery" terminate
      // discovery permanently. Each candidate heading is tested separately;
      // unrelated section headings only terminate the current candidate.
      if (headingMode && /^h[1-6]$/.test(block.tag) && !headingPattern.test(normalized)) break;

      const directAxisLine = parsePhysicalAxisLine(text);
      if (directAxisLine) {
        if (!(Number(result[directAxisLine.axis]) > 0)) {
          result[directAxisLine.axis] = directAxisLine.value;
          foundAxes++;
        }
        pendingAxis = null;
        if (foundAxes >= 3) break;
        continue;
      }

      const axis = axisNames.find(([, pattern]) => pattern.test(normalized))?.[0] || parsePhysicalAxisLabel(text);
      if (axis) {
        pendingAxis = axis;
        continue;
      }

      if (pendingAxis) {
        const measurement = parsePhysicalMeasurement(text, "cm", "dimension");
        if (measurement) {
          if (!(Number(result[pendingAxis]) > 0)) {
            result[pendingAxis] = measurement.value;
            foundAxes++;
          }
          pendingAxis = null;
          if (foundAxes >= 3) break;
          continue;
        }
        pendingAxis = null;
      }

      const tuple = parseDimensionTuple(text, "Rozmery produktu", "cm", "dom:dimensions-section");
      if (tuple && ["width", "height", "depth", "length"].filter(key => Number(tuple[key]) > 0).length >= 2 && !tupleFallback) {
        tupleFallback = tuple;
      }
    }

    if (tupleFallback) {
      for (const key of ["width", "height", "depth", "length"]) {
        if (!(Number(result[key]) > 0) && Number(tupleFallback[key]) > 0) result[key] = tupleFallback[key];
      }
    }

    const found = ["width", "height", "depth", "length"].filter(axis => Number(result[axis]) > 0).length;
    if (found < 2) return null;
    result.source = headingMode
      ? "dom:dimensions-section"
      : foundAxes >= 2 ? "dom:unheaded-product-dimension-rows" : "dom:unheaded-product-dimension-tuple";
    result.raw = [
      result.width ? `Š ${result.width} cm` : "",
      result.depth ? `H ${result.depth} cm` : "",
      result.height ? `V ${result.height} cm` : "",
      result.length ? `D ${result.length} cm` : ""
    ].filter(Boolean).join(" × ");
    return result;
  };

  // Modern storefronts often repeat the word "Dimensions" in their tab bar
  // before the real measurements panel. Try every matching heading and accept
  // only a candidate that actually yields at least two physical axes.
  const headingIndexes = [];
  blocks.forEach((block, index) => {
    if (headingPattern.test(normalize(block.text))) headingIndexes.push(index);
  });
  for (const headingIndex of headingIndexes) {
    const candidate = parseFrom(headingIndex, true);
    if (candidate) return candidate;
  }

  // Some stores have no dimensions heading at all. In that case keep the
  // first complete unheaded axis group before the package/component section.
  return parseFrom(-1, false);
}

function physicalUnitFromLabel(label) {
  const match = String(label || "").match(/\b(mm|cm|m|inches?|inch|ft|kg|g|mg|lb|l|ml)\b/i);
  return match ? match[1] : "";
}

function emptyPhysicalDimensions() {
  return { width: null, height: null, depth: null, length: null, diameter: null, thickness: null, unit: "cm", raw: null, source: null };
}

function parseDimensionTuple(value, label = "", unitHint = "", source = "") {
  if (value == null) return null;
  const raw = cleanText(String(value), 180).replace(/\u00a0/g, " ");
  const matches = [...raw.matchAll(/(\d+(?:[.,]\d+)?)\s*(mm|cm|m|inches?|inch|in|ft|feet|\")?/gi)];
  if (matches.length < 2 || matches.length > 6) return null;
  for (let i = 1; i < matches.length; i++) {
    const separator = raw.slice(matches[i - 1].index + matches[i - 1][0].length, matches[i].index);
    if (!/^[\s×xX*]+$/.test(separator)) return null;
  }
  const lastUnit = [...matches].reverse().find(item => item[2])?.[2] || unitHint || physicalUnitFromLabel(label);
  if (!lastUnit) return null;
  const parsed = matches.map(item => parsePhysicalMeasurement(`${item[1]} ${item[2] || lastUnit}`, "", "dimension"));
  if (parsed.some(item => !item)) return null;

  const result = emptyPhysicalDimensions();
  result.raw = raw;
  result.source = source || "dimensions-text";
  const normalizedLabel = normalizePhysicalLabel(label);
  const bracket = String(label || "").match(/[([]([^()[\]]{2,60}[x×][^()[\]]{2,60})[)\]]/);
  const orderText = normalizePhysicalLabel(bracket?.[1] || label);
  const axisAliases = [
    ["width", /^(?:width|w|s|sirka|szerokosc|breite|breite|largeur|larghezza|ancho)$/],
    ["height", /^(?:height|v|vyska|vysoka|wysokosc|hoehe|hauteur|altezza|altura)$/],
    ["depth", /^(?:depth|d|h|hlbka|hloubka|glebokosc|tiefe|profondeur|profondita|profundidad)$/],
    ["length", /^(?:length|l|dlzka|dlugosc|laenge|longueur|lunghezza|largo)$/]
  ];
  const parts = orderText.split(/[x×]/).map(part => part.replace(/[^a-z]/g, "").trim()).filter(Boolean);
  const order = parts.map(part => axisAliases.find(([, pattern]) => pattern.test(part))?.[0] || null);
  if (order.length === parsed.length && order.every(Boolean) && new Set(order).size === order.length) {
    parsed.forEach((item, index) => { result[order[index]] = item.value; });
  }
  result.unit = "cm";
  return result;
}

function hasPhysicalDimensionData(value) {
  return Boolean(value && (value.raw || PHYSICAL_DIMENSION_AXES.some(axis => Number(value[axis]) > 0)));
}

function mergePhysicalDimensionInfo(primary, fallback) {
  if (!hasPhysicalDimensionData(primary)) return hasPhysicalDimensionData(fallback) ? { ...fallback } : null;
  const merged = { ...fallback, ...primary };
  for (const axis of PHYSICAL_DIMENSION_AXES) {
    if (!(Number(merged[axis]) > 0)) merged[axis] = Number(fallback?.[axis]) > 0 ? Number(fallback[axis]) : null;
  }
  merged.raw = primary.raw || fallback?.raw || null;
  merged.source = primary.source || fallback?.source || null;
  merged.unit = "cm";
  return merged;
}

function mergePhysicalSpecFields(primary = {}, fallback = {}) {
  const merged = {};
  for (const key of ["productDimensions", "shippingDimensions"]) {
    const value = mergePhysicalDimensionInfo(primary?.[key], fallback?.[key]);
    if (value) merged[key] = value;
  }
  for (const prefix of ["productWeight", "shippingWeight", "productVolume", "shippingVolume"]) {
    const unitKey = `${prefix}Unit`;
    const sourceKey = `${prefix}Source`;
    const primaryValue = Number(primary?.[prefix]);
    const fallbackValue = Number(fallback?.[prefix]);
    const primarySource = String(primary?.[sourceKey] || "").toLowerCase();
    const fallbackSource = String(fallback?.[sourceKey] || "").toLowerCase();
    const primaryIsGenericWeight = prefix === "shippingWeight" && /json:weight-assumed-packed|json:weight$/.test(primarySource);
    const fallbackIsExplicit = /gross|brutto|shipping|package|dom:table-row|dom:definition-list|dom:labelled-specification|dom:labelled-weight|json:additionalproperty|json:detailedparameters|json:product-parameters|json:technical-parameters/.test(fallbackSource);
    const preferFallback = fallbackValue > 0 && fallbackIsExplicit && (primaryValue <= 0 || primaryIsGenericWeight);
    const value = preferFallback ? fallbackValue : primaryValue > 0 ? primaryValue : fallbackValue > 0 ? fallbackValue : null;
    if (value != null) {
      merged[prefix] = value;
      merged[unitKey] = (preferFallback ? fallback?.[unitKey] : primary?.[unitKey]) || primary?.[unitKey] || fallback?.[unitKey] || (prefix.endsWith("Volume") ? "l" : "kg");
      merged[sourceKey] = (preferFallback ? fallback?.[sourceKey] : primary?.[sourceKey]) || primary?.[sourceKey] || fallback?.[sourceKey] || null;
    }
  }
  return merged;
}

function applyPhysicalSpecPair(output, label, value, source = "dom:specification") {
  const labelText = cleanText(String(label || ""), 120);
  const structuredValue = value && typeof value === "object" ? value : null;
  const rawValue = structuredValue
    ? structuredValue.value ?? structuredValue.valueText ?? structuredValue.amount ?? structuredValue.quantityValue ?? structuredValue.text ?? structuredValue.name
    : value;
  const valueText = cleanText(String(rawValue ?? ""), 240);
  if (!labelText || !valueText) return;
  const normalized = normalizePhysicalLabel(labelText);
  const labelledMaximumPackageWeight = /(?:^|\b)(?:hmotnost|vaha|weight)\s+(?:do|max(?:imum)?|up\s+to|bis\s+zu)\b/.test(normalized);
  const shipping = labelledMaximumPackageWeight || /shipping|package|packaging|carton|box|preprav|balen|gross|brutto|logistic|logistika|karton|opak|wysylk|versand|verpack|emballage|expedition|envio|envase/.test(normalized);
  const unitHint = physicalUnitFromLabel(labelText) || (structuredValue?.unitText || structuredValue?.unitCode || structuredValue?.unit || "");
  const dimensionKey = shipping ? "shippingDimensions" : "productDimensions";
  const axisPatterns = [
    ["width", /(?:^|\b)(?:sirka|szerokosc|width|breite|largeur|larghezza|ancho)(?:\b|$)/],
    ["height", /(?:^|\b)(?:vyska|wysokosc|height|hoehe|hauteur|altezza|altura)(?:\b|$)/],
    ["depth", /(?:^|\b)(?:hlbka|hloubka|glebokosc|depth|tiefe|profondeur|profondita|profundidad)(?:\b|$)/],
    ["length", /(?:^|\b)(?:dlzka|dlugosc|length|laenge|longueur|lunghezza|largo)(?:\b|$)/],
    ["diameter", /(?:^|\b)(?:priemer|diameter|durchmesser)(?:\b|$)/],
    ["thickness", /(?:^|\b)(?:hrubka|thickness|staerke)(?:\b|$)/]
  ];
  if (/(?:rozmer(?:y|u|ov)?|rozmiar|wymiar|dimension|abmess|masse|product size|velkost produktu)/.test(normalized)) {
    const tuple = parseDimensionTuple(valueText, labelText, unitHint, source);
    if (tuple) output[dimensionKey] = mergePhysicalDimensionInfo(tuple, output[dimensionKey]);
  }
  for (const [axis, pattern] of axisPatterns) {
    if (!pattern.test(normalized)) continue;
    const measurement = parsePhysicalMeasurement(valueText, unitHint, "dimension");
    if (!measurement) continue;
    const current = output[dimensionKey] || emptyPhysicalDimensions();
    current[axis] = measurement.value;
    current.unit = "cm";
    current.source = source;
    current.raw = current.raw || null;
    output[dimensionKey] = current;
  }

  if (/(?:hmotnost|vaha|weight|massa|gewicht|waga|poids|peso)/.test(normalized)) {
    const measurement = parsePhysicalMeasurement(valueText, unitHint, "weight");
    if (measurement) {
      const prefix = shipping ? "shippingWeight" : "productWeight";
      output[prefix] = measurement.value;
      output[`${prefix}Unit`] = "kg";
      output[`${prefix}Source`] = source;
    }
  }
  if (/(?:objem|objetosc|volume|volumen|kapacita|capacity|capacidad|capacite)/.test(normalized)) {
    const measurement = parsePhysicalMeasurement(valueText, unitHint, "volume");
    if (measurement) {
      const prefix = shipping ? "shippingVolume" : "productVolume";
      output[prefix] = measurement.value;
      output[`${prefix}Unit`] = "l";
      output[`${prefix}Source`] = source;
    }
  }
}

function readStructuredParameterText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map(item => readStructuredParameterText(item)).filter(Boolean).join(", ").slice(0, 240);
  }
  if (typeof value === "object") {
    const nested = value.value ?? value.valueText ?? value.displayValue ?? value.text ?? value.amount ?? value.quantityValue ?? value.name ?? value.label ?? value.code ?? value.symbol;
    if (nested == null || nested === value) return "";
    const text = readStructuredParameterText(nested);
    const unitRaw = value.unitText ?? value.unitCode ?? value.unit ?? value.measurementUnit ?? value.unitOfMeasure ?? "";
    const unit = typeof unitRaw === "object"
      ? (unitRaw.symbol ?? unitRaw.abbreviation ?? unitRaw.name ?? unitRaw.code ?? unitRaw.value ?? "")
      : unitRaw;
    const unitText = cleanText(String(unit || ""), 30);
    return text && unitText && !text.toLowerCase().trimEnd().endsWith(unitText.toLowerCase())
      ? `${text} ${unitText}`.slice(0, 240)
      : text;
  }
  if (typeof value === "boolean") return value ? "Áno" : "Nie";
  return cleanText(String(value), 240);
}

function getStructuredProductAttributeEntries(object, defaultSource = "json:product-attributes") {
  if (!object || typeof object !== "object") return [];
  const arrayKeys = [
    "detailedParameters", "detailed_parameters", "productParameters", "product_parameters",
    "technicalParameters", "technical_parameters", "parameters", "specifications",
    "additionalProperty", "additionalProperties", "attributes", "features"
  ];
  const nestedKeys = [
    "parameterGroups", "parameter_groups", "groups", "parameters", "parameterValues", "parameter_values",
    "items", "children", "attributes", "specifications", "features", "properties",
    "detailedParameters", "detailed_parameters", "productParameters", "product_parameters", "values"
  ];
  const entries = [];
  const seen = new Set();
  const add = (rawLabel, rawValue, source) => {
    const label = cleanText(String(rawLabel ?? ""), 100);
    const value = readStructuredParameterText(rawValue);
    if (!label || !value || label.length > 100 || value.length > 240) return;
    const normalizedLabel = normalizePhysicalLabel(label).replace(/[^a-z0-9]+/g, " ").trim();
    if (!normalizedLabel || /^(?:parametre|vlastnosti|technicke udaje|technicke parametre|specifications|features|details)$/i.test(normalizedLabel)) return;
    const key = `${normalizedLabel}|${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ name: label, value, source: source || defaultSource });
  };

  const walk = (container, source, depth = 0) => {
    if (depth > 4 || !container || typeof container !== "object" || entries.length >= 160) return;
    if (Array.isArray(container)) {
      for (const item of container.slice(0, 160)) {
        if (!item || typeof item !== "object") continue;
        const nested = [item.parameter, item.attribute, item.specification, item.property, item.feature]
          .find(candidate => candidate && typeof candidate === "object" && !Array.isArray(candidate)) || {};
        const label = item.name ?? item.label ?? item.parameterName ?? item.parameter_name ?? item.title ??
          item.displayName ?? item.display_name ?? item.propertyName ?? item.property_name ?? item.caption ??
          item.key ?? item.code ?? (typeof item.parameter === "string" ? item.parameter : null) ??
          nested.name ?? nested.label ?? nested.title ?? nested.key ?? nested.code;
        const rawValue = item.value ?? item.parameterValue ?? item.parameter_value ?? item.valueText ??
          item.value_text ?? item.displayValue ?? item.display_value ?? item.text ?? item.content ??
          item.val ?? nested.value ?? nested.parameterValue ?? nested.text;
        const unitRaw = item.unitText ?? item.unitCode ?? item.unit ?? item.measurementUnit ?? item.unitOfMeasure ??
          nested.unitText ?? nested.unitCode ?? nested.unit ?? "";
        const unit = typeof unitRaw === "object"
          ? (unitRaw.symbol ?? unitRaw.abbreviation ?? unitRaw.name ?? unitRaw.code ?? unitRaw.value ?? "")
          : unitRaw;
        let combined = rawValue;
        if (combined != null && unit && typeof combined !== "object") {
          const text = String(combined).trim();
          if (text && !text.toLowerCase().endsWith(String(unit).toLowerCase())) combined = `${text} ${unit}`;
        } else if (combined && typeof combined === "object" && unit && !combined.unit && !combined.unitText && !combined.unitCode) {
          combined = { ...combined, unitText: unit };
        }
        add(label, combined, source);

        for (const childKey of nestedKeys) {
          const child = item[childKey];
          if (child && typeof child === "object") walk(child, `${source}.${childKey}`, depth + 1);
        }
      }
      return;
    }

    // Object maps and nested parameter-group containers are both used by
    // Grandus feeds. Keep this recursion limited to known attribute keys.
    let visitedNested = false;
    for (const childKey of nestedKeys) {
      const child = container[childKey];
      if (child && typeof child === "object") {
        visitedNested = true;
        walk(child, `${source}.${childKey}`, depth + 1);
      }
    }
    for (const [label, rawValue] of Object.entries(container).slice(0, 160)) {
      if (nestedKeys.includes(label) || rawValue == null || typeof rawValue === "function") continue;
      if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
        const hasValueField = ["value", "valueText", "displayValue", "text", "amount", "quantityValue"].some(key => rawValue[key] != null);
        if (hasValueField) add(label, rawValue, source);
        else if (!visitedNested) walk(rawValue, `${source}.${label}`, depth + 1);
      } else if (!Array.isArray(rawValue)) {
        add(label, rawValue, source);
      }
    }
  };

  for (const key of arrayKeys) {
    const value = object[key];
    if (value && typeof value === "object") walk(value, `json:${key}`);
  }
  return entries.slice(0, 160);
}

function mergeProductAttributes(primary = [], fallback = []) {
  const output = [];
  const seen = new Set();
  for (const entry of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(fallback) ? fallback : [])]) {
    if (!entry || typeof entry !== "object") continue;
    const name = cleanText(String(entry.name ?? entry.label ?? ""), 100);
    const value = cleanText(String(entry.value ?? entry.valueText ?? ""), 240);
    if (!name || !value) continue;
    const key = `${normalizePhysicalLabel(name)}|${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ name, value, ...(entry.source ? { source: cleanText(String(entry.source), 80) } : {}) });
    if (output.length >= 160) break;
  }
  return output;
}

function extractProductAttributesFromStructured(...objects) {
  const entries = [];
  for (const object of objects) entries.push(...getStructuredProductAttributeEntries(object));
  return mergeProductAttributes(entries);
}

function extractPackageMeasureFromParameterEntries(entries) {
  // Only infer sellable package contents from an explicit net-content label.
  // Physical product/package weight and appliance volume are stored separately
  // and must never become a unit-price denominator.
  const allowedLabels = /^(?:netto\s+(?:obsah|objem)|net\s+(?:content|volume)|cisty\s+(?:obsah|objem)|obsah\s+balenia|package\s+content|content\s+of\s+(?:the\s+)?package|package\s+quantity|net\s+quantity)$/;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const label = normalizePhysicalLabel(entry?.name || "").replace(/[^a-z0-9]+/g, " ").trim();
    if (!allowedLabels.test(label)) continue;
    const explicit = extractExplicitNetPackageMeasureFromText(`${entry.name}: ${entry.value}`);
    if (explicit) {
      explicit.packageMeasureSource = entry.source || "json:detailedParameters";
      return explicit;
    }
  }
  return null;
}

function extractPhysicalSpecsFromStructured(...objects) {
  const output = {};
  const addDimensionObject = (object, targetKey, sourceName) => {
    if (!object || typeof object !== "object") return;
    const dimensions = emptyPhysicalDimensions();
    const rawUnit = object.unitText || object.unitCode || object.unit || object.measurementUnit || object.unitOfMeasure || "";
    for (const axis of PHYSICAL_DIMENSION_AXES) {
      const raw = object[axis] ?? object[`${axis}Value`] ?? object[`${axis}_value`];
      if (raw == null) continue;
      const measurement = parsePhysicalMeasurement(raw, rawUnit || object[`${axis}Unit`] || object[`${axis}_unit`], "dimension");
      if (measurement) dimensions[axis] = measurement.value;
    }
    const hasAxes = PHYSICAL_DIMENSION_AXES.some(axis => Number(dimensions[axis]) > 0);
    if (hasAxes) {
      dimensions.raw = object.description || null;
      dimensions.source = sourceName;
      output[targetKey] = mergePhysicalDimensionInfo(dimensions, output[targetKey]);
    }
  };

  for (const object of objects) {
    if (!object || typeof object !== "object") continue;
    const directDimensions = object.dimensions ?? object.productDimensions ?? object.product_dimensions ?? null;
    if (typeof directDimensions === "string") {
      const parsed = parseDimensionTuple(directDimensions, "Rozmery produktu", object.dimensionUnit || object.unitText || "", "json:dimensions");
      if (parsed) output.productDimensions = mergePhysicalDimensionInfo(parsed, output.productDimensions);
    } else if (directDimensions && typeof directDimensions === "object") {
      addDimensionObject(directDimensions, "productDimensions", "json:dimensions");
      if (!output.productDimensions?.raw && directDimensions.raw) output.productDimensions.raw = cleanText(directDimensions.raw, 180);
    }
    const shippingDimensions = object.shippingDimensions ?? object.packageDimensions ?? object.shipping_dimensions ?? object.package_dimensions ?? null;
    if (typeof shippingDimensions === "string") {
      const parsed = parseDimensionTuple(shippingDimensions, "Rozmery balenia", object.dimensionUnit || "", "json:shipping-dimensions");
      if (parsed) output.shippingDimensions = mergePhysicalDimensionInfo(parsed, output.shippingDimensions);
    } else if (shippingDimensions && typeof shippingDimensions === "object") {
      addDimensionObject(shippingDimensions, "shippingDimensions", "json:shipping-dimensions");
    }
    addDimensionObject(object, "productDimensions", "json:product-dimensions");
    const shippingAxisObject = {};
    for (const axis of PHYSICAL_DIMENSION_AXES) {
      const raw = object[`shipping${axis[0].toUpperCase()}${axis.slice(1)}`] ?? object[`package${axis[0].toUpperCase()}${axis.slice(1)}`];
      if (raw != null) shippingAxisObject[axis] = raw;
    }
    if (Object.keys(shippingAxisObject).length) {
      shippingAxisObject.unitText = object.shippingDimensionUnit || object.packageDimensionUnit || object.dimensionUnit || "";
      addDimensionObject(shippingAxisObject, "shippingDimensions", "json:shipping-dimensions");
    }

    const productWeightRaw = object.productWeight ?? object.product_weight ?? object.netWeight ?? object.net_weight ?? null;
    if (productWeightRaw != null) {
      const measurement = parsePhysicalMeasurement(productWeightRaw, object.productWeightUnit || object.netWeightUnit || object.weightUnit || object.weight_unit || object.unitText || "", "weight");
      if (measurement) {
        output.productWeight = measurement.value;
        output.productWeightUnit = "kg";
        output.productWeightSource = object.netWeight != null || object.net_weight != null ? "json:netWeight" : "json:productWeight";
      }
    }
    // Generic Schema.org `weight` is often the packed/gross shipping weight in
    // shop feeds. Never label it as net product weight without an explicit field.
    const shippingWeightRaw = object.shippingWeight ?? object.packageWeight ?? object.grossWeight ?? object.shipping_weight ?? object.weight ?? null;
    if (shippingWeightRaw != null) {
      const measurement = parsePhysicalMeasurement(shippingWeightRaw, object.shippingWeightUnit || object.packageWeightUnit || object.grossWeightUnit || object.weightUnit || object.weight_unit || object.unitText || "", "weight");
      if (measurement) {
        output.shippingWeight = measurement.value;
        output.shippingWeightUnit = "kg";
        output.shippingWeightSource = object.grossWeight != null ? "json:grossWeight" : object.weight != null ? "json:weight-assumed-packed" : "json:shippingWeight";
      }
    }
    const volumeRaw = object.volume ?? object.productVolume ?? object.fluidVolume ?? null;
    if (volumeRaw != null) {
      const measurement = parsePhysicalMeasurement(volumeRaw, object.volumeUnit || object.unitText || "", "volume");
      if (measurement) {
        output.productVolume = measurement.value;
        output.productVolumeUnit = "l";
        output.productVolumeSource = "json:volume";
      }
    }
    const properties = getStructuredProductAttributeEntries(object);
    const hasExplicitGrossPackageWeight = properties.some(property => {
      const label = normalizePhysicalLabel(property?.name || "");
      const propertySource = String(property?.source || "").toLowerCase();
      // Preserve the established Schema.org logistics heuristic, but do not
      // move Grandus detailedParameters dimensions to shipping solely because
      // another row in the same technical tab mentions package weight.
      return /json:additionalproperties?/.test(propertySource) &&
        /(?:brutto|gross|shipping|package|packaging|preprav|balen|versand|verpack)/.test(label) &&
        /(?:hmotnost|vaha|weight|gewicht|waga|poids|peso)/.test(label);
    });
    for (const property of properties.slice(0, 160)) {
      if (!property || typeof property !== "object") continue;
      let label = property.name || "";
      const normalizedLabel = normalizePhysicalLabel(label);
      const genericDimensionLabel = /^(?:dlzka|sirka|vyska|hlbka|hloubka|length|width|height|depth|breite|hoehe|tiefe|largeur|hauteur|longueur)$/.test(normalizedLabel);
      // A generic width/height/depth row in the same spec group as explicit
      // packed/gross weight describes the shipping carton, not the product.
      if (hasExplicitGrossPackageWeight && genericDimensionLabel) label = `Shipping ${label}`;
      applyPhysicalSpecPair(output, label, property.value, property.source || "json:product-attributes");
      const packageCountMatch = normalizePhysicalLabel(label).match(/^(?:pocet baleni|pocet balikov|number of packages|package count|packages count)\s*$/);
      if (packageCountMatch) {
        const count = String(property.value || "").match(/\b(\d{1,3})\b/);
        if (count && Number(count[1]) > 0) {
          output.packageCount = Number(count[1]);
          output.packageCountSource = property.source || "json:product-attributes";
        }
      }
    }
    const explicitPackageMeasure = extractPackageMeasureFromParameterEntries(properties);
    if (explicitPackageMeasure && !output.packageQuantity) Object.assign(output, explicitPackageMeasure);
    const directPackageCount = object.packageCount ?? object.package_count ?? object.numberOfPackages ?? object.number_of_packages;
    if (output.packageCount == null && directPackageCount != null && Number.isFinite(Number(directPackageCount)) && Number(directPackageCount) > 0) {
      output.packageCount = Math.floor(Number(directPackageCount));
      output.packageCountSource = "json:packageCount";
    }
  }
  return output;
}

function extractPhysicalSpecsFromDom($, container) {
  if (!container || !container.length) return {};
  const output = {};
  const isExcludedHere = element => isExcludedProductAreaWithin($, element, container);
  let hasExplicitProductPhysicalLabel = false;
  const readText = node => cleanText($(node).text() || $(node).attr("content") || $(node).attr("value") || "", 300);

  const isShippingContext = node => {
    let current = $(node);
    for (let depth = 0; current && current.length && depth < 9; depth++, current = current.parent()) {
      const element = current.get(0);
      const marker = [
        current.attr("class"), current.attr("id"), current.attr("data-testid"),
        current.attr("aria-label"), current.attr("itemtype")
      ].filter(Boolean).join(" ").toLowerCase();

      // Stop at an explicit assembled-product dimensions section. Some stores
      // (notably IKEA) place the product-dimensions accordion and the package
      // breakdown inside one shared wrapper. Looking at that wrapper's full
      // text sees "This product consists of N packages" and incorrectly marks
      // the sibling product rows as shipping rows. This boundary must win
      // before the broader logistics-text fallback below.
      // Attributes are joined with spaces above, so the section token may be
      // preceded by whitespace (e.g. "... pipf-accordion__item measurements-tab-measurements").
      // Accept whitespace as a token boundary as well as hyphens/underscores.
      if (/(?:^|[\s_-])(?:measurements-tab-measurements|product-measurements|product-dimensions|assembled-dimensions)(?:$|[\s_-])/i.test(marker)) {
        return false;
      }

      if (/(?:logistic|logistika|shipping|delivery|transport|package|packaging|parcel|preprav|balen|versand|verpack|envio)/i.test(marker)) return true;

      const tag = String(element?.tagName || "").toLowerCase();
      if (["section", "article", "table", "dl", "fieldset", "div", "ul", "ol", "li"].includes(tag)) {
        const headingText = current.find("h1, h2, h3, h4, caption, legend, .title, .label").slice(0, 8)
          .map((_, item) => $(item).text()).get().join(" ");
        if (/(?:logistic|logistika|shipping|delivery|transport|package|packaging|parcel|preprav|balen|versand|verpack|envio)/i.test(headingText)) return true;
        const localText = normalizeWhitespace(current.text()).slice(0, 2200);
        const normalizedLocalText = normalizePhysicalLabel(localText);
        if (localText.length < 2200 && /(?:^|\b)(?:logistics|logistika|shipping information|package information|prepravne udaje|udaje o baleni)(?:\b|$)/i.test(normalizedLocalText)) return true;
        // Product-level packaging breakdowns are frequently nested in list
        // structures without any CSS class or visible "Shipping" heading.
        // Treat generic weight/dimension rows inside that bounded subtree as
        // parcel data; explicit net/product labels remain product attributes.
        if (/(?:tento vyrobok|this product|product|dieses produkt|ce produit).{0,90}(?:pozostava z|sa sklada z|consists of|includes|besteht aus|comprend)\s*\d{1,3}\s*(?:balen[ií]|packages?|pakete|colis|opakowan)/i.test(normalizedLocalText)) return true;
      }
      if (["main", "body", "html"].includes(tag)) break;
    }
    return false;
  };

  const addPair = (label, value, source, shippingContext = false) => {
    const labelText = normalizePhysicalLabel(label);
    const explicitProductLabel = /(?:product|produktu|netto|net weight|rozmery\s+produktu|product\s+dimensions|hmotnost\s+produktu)/i.test(labelText);
    if (explicitProductLabel) hasExplicitProductPhysicalLabel = true;
    const safeLabel = shippingContext && !/(?:product|produktu|netto|net weight)/i.test(String(label || ""))
      ? `Shipping ${label}` : label;
    applyPhysicalSpecPair(output, safeLabel, value, explicitProductLabel ? `${source}:explicit-product` : source);
  };

  container.find("tr").slice(0, 700).each((_, row) => {
    if (isExcludedHere(row)) return;
    const cells = $(row).find("th, td").toArray();
    if (cells.length < 2) return;
    const label = readText(cells[0]);
    const value = readText(cells[1]);
    if (label && value) addPair(label, value, "dom:table-row", isShippingContext(row));
  });

  container.find("dl").slice(0, 120).each((_, list) => {
    if (isExcludedHere(list)) return;
    const shippingContext = isShippingContext(list);
    $(list).children("dt").each((_, dt) => {
      const label = readText(dt);
      const value = readText($(dt).next("dd").first());
      if (label && value) addPair(label, value, "dom:definition-list", shippingContext || isShippingContext(dt));
    });
  });

  // Many modern product pages put the axis name and value in sibling spans
  // inside one semantic measurement row (e.g. "Šírka" + "200 cm"). Parse
  // these pairs directly as well as through the generic text-node walker below.
  // Shipping/package rows remain shipping data because their ancestor context
  // is checked before the pair is applied.
  const pairedMeasurementRows = container.find(
    "[class*='measurement-row'], [class*='dimension-row'], [data-testid*='measurement-row'], [data-testid*='dimension-row']"
  ).slice(0, 1200);
  pairedMeasurementRows.each((_, element) => {
    if (isExcludedHere(element)) return;
    const row = $(element);
    const labelNode = row.find(
      "[class*='measurement-name'], [class*='measurement-label'], [class*='dimension-name'], [class*='dimension-label'], [class*='attribute-name'], [class*='specification-name'], [class*='specification-label'], [class*='spec-label'], th, dt"
    ).first();
    const valueNode = row.find(
      "[class*='measurement-value'], [class*='dimension-value'], [class*='attribute-value'], [class*='specification-value'], [class*='spec-value'], td, dd"
    ).first();
    if (!labelNode.length || !valueNode.length) return;
    const label = readText(labelNode);
    const value = readText(valueNode);
    if (label && value) addPair(label, value, "dom:paired-measurement-row", isShippingContext(row));
  });

  container.find("li, .product-attribute, [class*='specification-row'], [class*='attribute-row'], [class*='spec-row']").slice(0, 1000).each((_, element) => {
    if (isExcludedHere(element)) return;
    const text = readText(element);
    const match = text.match(/^\s*([^:：]{2,70})\s*[:：]\s*(.{1,180})$/);
    if (match) addPair(match[1], match[2], "dom:labelled-specification", isShippingContext(element));
  });

  // Exclude recommendation/upsell areas before broad labelled-text fallbacks;
  // otherwise an accessory's weight or dimensions can leak into this product.
  const fullTextContainer = container.clone();
  fullTextContainer.find("*").toArray().reverse().forEach(element => {
    if (isExcludedProductAreaWithin($, element, fullTextContainer)) $(element).remove();
  });
  const fullText = fullTextContainer.text().replace(/\u00a0/g, " ").replace(/[\t\r]+/g, " ").replace(/\s+/g, " ");
  const combinedPatterns = [
    [/(?:rozmery\s+balenia|package\s+dimensions|shipping\s+dimensions|carton\s+dimensions|rozmery\s+prepravneho\s+obalu|wymiary\s+opakowania|rozmiar\s+opakowania|packmasse|verpackungsmass)\s*[:：-]\s*([^|;]{3,100})/gi, "Rozmery balenia"],
    [/(?:rozmery\s+produktu|product\s+dimensions|rozmery\s+produktu)\s*[:：-]\s*([^|;]{3,100})/gi, "Rozmery produktu"]
  ];
  for (const [pattern, label] of combinedPatterns) {
    let match;
    while ((match = pattern.exec(fullText)) !== null) addPair(label, match[1], "dom:labelled-dimensions");
  }

  // Full-text fallback accepts only explicit weight labels. Generic words such
  // as "weight" or "hmotnosť" are intentionally excluded: they may describe
  // nutrition values or logistics and must not be guessed as net product mass.
  const weightPattern = /(?:netto\s*(?:hmotnosť|váha|weight)|net\s+weight|product\s+weight|hmotnosť\s+produktu|hmotnost\s+produktu|shipping\s+weight|package\s+weight|gross\s+weight|brutto\s*(?:weight|hmotnosť|hmotnost|váha|vaha)|hmotnosť\s+balenia|hmotnost\s+balenia|váha\s+balenia|vaha\s+balenia|waga\s+produktu|waga\s+opakowania|poids\s+du\s+produit|peso\s+del\s+producto)\s*(?:\((kg|g|mg|lb)\))?\s*[:：-]?\s*(\d+(?:[.,]\d+)?\s*(?:kg|g|mg|lb)?)/gi;
  let weightMatch;
  while ((weightMatch = weightPattern.exec(fullText)) !== null) {
    const label = /shipping|package|gross|brutto|balen|preprav|opak|wysylk|versand|verpack|emballage|expedition|envio/i.test(weightMatch[0]) ? "Hmotnosť balenia" : "Hmotnosť produktu";
    addPair(label + (weightMatch[1] ? ` (${weightMatch[1]})` : ""), weightMatch[2], "dom:labelled-weight");
  }

  const volumePattern = /(?:objem\s+produktu|objem\s+balenia|objętość\s+produktu|objętość\s+opakowania|volume\s+of\s+product|package\s+volume|shipping\s+volume|product\s+volume|capacity|capacidad|capacité|kapacita)\s*(?:\((l|ml)\))?\s*[:：-]?\s*(\d+(?:[.,]\d+)?\s*(?:l|ml)?)/gi;
  let volumeMatch;
  while ((volumeMatch = volumePattern.exec(fullText)) !== null) {
    const label = /balen|shipping|package|opak|versand|verpack|emballage|envio/i.test(volumeMatch[0]) ? "Objem balenia" : "Objem produktu";
    addPair(label + (volumeMatch[1] ? ` (${volumeMatch[1]})` : ""), volumeMatch[2], "dom:labelled-volume");
  }

  // Some furniture and appliance stores publish the assembled product dimensions
  // as a heading followed by separate rows (Width / Depth / Height), not as one
  // labelled tuple. Read those rows independently from the later package section.
  const semanticBlocks = [];
  const primarySemanticTags = new Set([
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "dt", "dd",
    "tr", "legend", "caption", "button", "strong", "b", "small"
  ]);
  const normalizedSemanticText = value => normalizePhysicalLabel(value).replace(/[：:]/g, " ").replace(/\s+/g, " ").trim();
  const isStandalonePhysicalLine = text => {
    const normalized = normalizedSemanticText(text);
    if (!normalized || text.length > 160) return false;
    const isPackageIndex = /^(?:balenie|package|parcel|paket|colis)\s*(?:c\.?\s*)?\d{1,3}$/i.test(normalized);
    const isPackageHeading = /^(?:balenie|balenia|packages?|packaging|package details|package information|rozmery|rozmery produktu|dimensions|product dimensions)$/i.test(normalized);
    const isAxis = Boolean(parsePhysicalAxisLine(text));
    const isWeight = Boolean(parsePackageWeightLine(text));
    const isComponentGroup = /^(?:\d{1,2})\s*[x×]\s*[\p{L}\p{N}_./-]/u.test(text);
    const isComponentCode = /^[A-Z0-9]{2,10}(?:[.-][A-Z0-9]{2,10}){1,3}$/i.test(text);
    const isPackageCount = /^(?:tento vyrobok|vyrobok|this product|product|dieses produkt|ce produit).{0,70}?(?:pozostava z|sa sklada z|consists of|includes|besteht aus|comprend)\s*\d{1,3}\s*(?:balen[ií]|packages?|pakete|colis|opakowan)/i.test(normalized);
    const isPackageSectionEnd = /^(?:tento vyrobok sa sklada z viacerych sucasti|tento vyrobok pozostava z tychto casti|this product is made up of several parts|this product consists of multiple parts|parts included|included components|components included|suciast[ií]|components)$/i.test(normalized);
    return isPackageIndex || isPackageHeading || isAxis || isWeight || isComponentGroup || isComponentCode || isPackageCount || isPackageSectionEnd;
  };

  // Walk the DOM tree in document order instead of collecting only element
  // text. IKEA and similar shops place labels such as "Balenie 1", component
  // SKUs and component names in standalone text nodes between <p>/<ul> nodes.
  // A CSS selector cannot see those nodes; omitting them loses parcel
  // boundaries and makes the complete parcel-weight sum impossible.
  const walkPhysicalDomNode = element => {
    if (!element) return;
    const type = String(element.type || "").toLowerCase();
    if (type !== "text" && type !== "comment" && isExcludedHere(element)) return;
    if (type === "text" || element.nodeType === 3) {
      const raw = cleanText(decodeEntities(String(element.data ?? element.nodeValue ?? "")), 160);
      if (!raw || raw.length > 100) return;
      // Some templates concatenate a component group with its name, or a SKU
      // with a parcel marker, in one text node. Split those boundaries while
      // preserving the original document order.
      const groupAndName = raw.match(/^(\d{1,2}\s*[x×]\s*[\p{L}\p{N}_./-]+)\s+(.{1,100})$/u);
      if (groupAndName) {
        semanticBlocks.push({ tag: "text", text: groupAndName[1] });
        semanticBlocks.push({ tag: "text", text: groupAndName[2] });
        return;
      }
      // Split parcel markers first. Some IKEA templates concatenate a SKU
      // directly with the following text node ("705.215.39Balenie 1"). A
      // generic SKU regex can greedily consume the word "Balenie", so use
      // the explicit parcel marker as the primary boundary.
      const packageMarkerPattern = /(?:balenie|package|parcel|paket|colis)\s*(?:c\.?\s*)?\d{1,3}\b/gi;
      const packageMarkers = [...raw.matchAll(packageMarkerPattern)];
      const pushCodeAndText = value => {
        const valueText = cleanText(value, 100);
        if (!valueText) return;
        // Split a component's descriptive name from a SKU even when the
        // source omits whitespace between them.
        const codeMatch = valueText.match(/([A-Z0-9]{2,10}(?:[.-][A-Z0-9]{2,10}){1,3})$/i);
        if (codeMatch && codeMatch.index > 0) {
          const beforeCode = cleanText(valueText.slice(0, codeMatch.index), 100);
          if (beforeCode) semanticBlocks.push({ tag: "text", text: beforeCode });
          semanticBlocks.push({ tag: "text", text: codeMatch[1] });
        } else {
          semanticBlocks.push({ tag: "text", text: valueText });
        }
      };
      if (packageMarkers.length) {
        let cursor = 0;
        for (const marker of packageMarkers) {
          pushCodeAndText(raw.slice(cursor, marker.index));
          semanticBlocks.push({ tag: "text", text: cleanText(marker[0], 100) });
          cursor = marker.index + marker[0].length;
        }
        pushCodeAndText(raw.slice(cursor));
      } else {
        pushCodeAndText(raw);
      }
      return;
    }
    if (type === "comment" || element.nodeType === 8) return;

    const tag = String(element.tagName || element.name || "").toLowerCase();
    if (["script", "style", "noscript", "svg"].includes(tag)) return;
    const node = $(element);
    let text = "";
    if (tag === "tr") {
      text = node.find("th,td").toArray().map(cell => readText(cell)).filter(Boolean).join(" ");
    } else {
      text = readText(element);
    }
    if (!text) return;

    const children = Array.isArray(element.children)
      ? element.children
      : Array.isArray(element.childNodes)
        ? element.childNodes
        : node.contents().toArray();
    const hasElementChildren = children.some(child => {
      const childType = String(child?.type || "").toLowerCase();
      return childType !== "text" && child?.nodeType !== 3 && childType !== "comment" && child?.nodeType !== 8;
    });
    const normalized = normalizedSemanticText(text);
    const isPackageIndex = /^(?:balenie|package|parcel|paket|colis)\s*(?:c\.?\s*)?\d{1,3}$/i.test(normalized);
    const isPackageHeading = /^(?:balenie|balenia|packages?|packaging|package details|package information|rozmery|rozmery produktu|dimensions|product dimensions)$/i.test(normalized);
    const isAxisOrWeight = Boolean(parsePhysicalAxisLine(text) || parsePackageWeightLine(text));
    const isPackageCount = /^(?:tento vyrobok|vyrobok|this product|product|dieses produkt|ce produit).{0,70}?(?:pozostava z|sa sklada z|consists of|includes|besteht aus|comprend)\s*\d{1,3}\s*(?:balen[ií]|packages?|pakete|colis|opakowan)/i.test(normalized);
    const isPackageSectionEnd = /^(?:tento vyrobok sa sklada z viacerych sucasti|tento vyrobok pozostava z tychto casti|this product is made up of several parts|this product consists of multiple parts|parts included|included components|components included|suciast[ií]|components)$/i.test(normalized);
    const isComponentMarker = isStandalonePhysicalLine(text) && /^(?:\d{1,2}\s*[x×]|[A-Z0-9]{2,10}(?:[.-][A-Z0-9]{2,10}){1,3})/i.test(text);

    // Measurement rows can be emitted as a whole even when their value is
    // split across nested spans. Component markers, however, must be descended
    // into when they share an element with the component description.
    if ((isAxisOrWeight && !hasElementChildren) || isPackageIndex || isPackageHeading || (isPackageCount && !hasElementChildren) || isPackageSectionEnd || (isComponentMarker && !hasElementChildren)) {
      semanticBlocks.push({ tag, text });
      return;
    }

    // Preserve short semantic leaf rows (for example a component name), but
    // recurse through wrapper elements so direct text nodes keep their order.
    if (primarySemanticTags.has(tag) && !hasElementChildren && text.length <= 100) {
      semanticBlocks.push({ tag, text });
      return;
    }

    if (children.length) {
      for (const child of children) walkPhysicalDomNode(child);
    } else if (text.length <= 100) {
      semanticBlocks.push({ tag, text });
    }
  };

  const rootNode = container.get(0);
  if (rootNode) walkPhysicalDomNode(rootNode);
  const sectionDimensions = extractProductDimensionsFromBlocks(semanticBlocks);
  if (sectionDimensions) output.productDimensions = mergePhysicalDimensionInfo(sectionDimensions, output.productDimensions);

  // If the store puts the assembled dimensions directly in the product title
  // (e.g. "200x66x201 cm") but does not expose a separate dimensions block,
  // preserve that explicit source text as a lower-confidence product dimension.
  {
    const titleText = cleanText(getPrimaryProductTitleNode($).text() || container.find("h1").first().text() || "", 300);
    const titleDimensions = extractDimensionVariant(titleText);
    const existingSource = String(output.productDimensions?.source || "");
    const hasExplicitSectionDimensions = Boolean(sectionDimensions);
    const hasExplicitLabelledProductDimensions = /dom:labelled-dimensions|json:additionalproperty/.test(existingSource);
    // A title tuple is a reliable fallback for the assembled item. It must
    // replace generic axis rows that leaked from component/package lists,
    // but never override a dedicated dimensions section or explicit labelled
    // product-dimension field (which can contain more precise decimals).
    if (titleDimensions && titleDimensions.values.length === 3 && hasExplicitSectionDimensions) {
      // Fill only missing axes from the title; the dedicated DOM values keep
      // precedence because they can be more precise than rounded title text.
      output.productDimensions = mergePhysicalDimensionInfo(output.productDimensions, titleDimensions.dimensions);
    } else if (titleDimensions && titleDimensions.values.length === 3 &&
        !hasExplicitSectionDimensions && !hasExplicitLabelledProductDimensions) {
      output.productDimensions = {
        ...titleDimensions.dimensions,
        source: "dom:product-title-dimension"
      };
    } else if (!hasPhysicalDimensionData(output.productDimensions) && titleDimensions && titleDimensions.values.length === 3) {
      output.productDimensions = {
        ...titleDimensions.dimensions,
        source: "dom:product-title-dimension"
      };
    }
  }

  // A product may contain several shipping cartons. Preserve every component
  // and parcel as a structured array; do not let the final accessory row replace
  // the wardrobe's first/large parcel dimensions.
  const packageBreakdown = parseShippingPackageBlocks(semanticBlocks);
  if (packageBreakdown.shippingPackages?.length) {
    output.shippingPackages = packageBreakdown.shippingPackages;
    output.packageCount = packageBreakdown.packageCount;
    output.packageCountSource = packageBreakdown.packageCountSource;
    output.shippingPackageSource = packageBreakdown.shippingPackageSource;
    if (packageBreakdown.shippingDimensions) output.shippingDimensions = packageBreakdown.shippingDimensions;
    else { delete output.shippingDimensions; }
    if (packageBreakdown.shippingWeight != null) {
      output.shippingWeight = packageBreakdown.shippingWeight;
      output.shippingWeightUnit = packageBreakdown.shippingWeightUnit;
      output.shippingWeightQualifier = packageBreakdown.shippingWeightQualifier || "exact";
      output.shippingWeightSource = packageBreakdown.shippingWeightSource;
    } else {
      delete output.shippingWeight;
      delete output.shippingWeightUnit;
      delete output.shippingWeightQualifier;
      delete output.shippingWeightSource;
    }

    // When a page exposes a parcel/component breakdown, generic DOM labels
    // such as "Weight", "Width" or "Length" cannot safely be assumed to
    // describe the assembled product. Keep explicitly product/net-labelled
    // values; suppress unqualified DOM values unless the assembled dimensions
    // were independently read from the product section or explicit title.
    if (output.productWeightSource && !/explicit-product/.test(output.productWeightSource)) {
      delete output.productWeight;
      delete output.productWeightUnit;
      delete output.productWeightSource;
    }
    const dimensionsSource = String(output.productDimensions?.source || "");
    if (!sectionDimensions && !hasExplicitProductPhysicalLabel &&
        /^(?:dom:table-row|dom:definition-list|dom:labelled-specification|dom:labelled-dimensions)/.test(dimensionsSource)) {
      delete output.productDimensions;
    }
  }

  // Read assembled-product measurements from an explicitly identified
  // dimensions panel as a separate scope. IKEA's product measurements and
  // package breakdown can share outer accordion wrappers, so this final
  // scoped pass prevents package-context detection from discarding the
  // assembled product's own width/depth/height values.
  const explicitProductMeasurementSections = container.find(
    "[id='measurements-tab-measurements'], [id='SEC_measurements-tab-measurements'], " +
    "[id='product-measurements'], [id='product-dimensions'], [id='assembled-dimensions']"
  ).slice(0, 8);
  let scopedProductDimensions = null;
  explicitProductMeasurementSections.each((_, sectionElement) => {
    if (isExcludedHere(sectionElement)) return;
    const section = $(sectionElement);
    const sectionMarker = [
      section.attr("id"), section.attr("class"), section.attr("aria-label"),
      section.find("h1, h2, h3, h4, [role='heading']").first().text()
    ].filter(Boolean).join(" ").toLowerCase();
    if (/(?:package|packaging|shipping|parcel|balen|preprav|versand|verpack)/i.test(sectionMarker)) return;

    const rows = section.find(
      "[class*='measurement-row'], [class*='dimension-row'], " +
      "[data-testid*='measurement-row'], [data-testid*='dimension-row']"
    ).slice(0, 120);
    const dimensions = emptyPhysicalDimensions();
    const axisPatterns = [
      ["width", /^(?:sirka|width|w|breite|largeur|larghezza|ancho|szerokosc)$/],
      ["height", /^(?:vyska|height|hoehe|hauteur|altezza|altura|wysokosc)$/],
      ["depth", /^(?:hlbka|hloubka|depth|tiefe|profondeur|profondita|profundidad|glebokosc)$/],
      ["length", /^(?:dlzka|length|laenge|longueur|lunghezza|dlugosc)$/]
    ];
    rows.each((__, rowElement) => {
      if (isExcludedHere(rowElement)) return;
      const row = $(rowElement);
      const labelNode = row.find(
        "[class*='measurement-name'], [class*='measurement-label'], [class*='dimension-name'], " +
        "[class*='dimension-label'], [class*='attribute-name'], [class*='specification-name'], " +
        "[class*='specification-label'], th, dt"
      ).first();
      const valueNode = row.find(
        "[class*='measurement-value'], [class*='dimension-value'], [class*='attribute-value'], " +
        "[class*='specification-value'], td, dd"
      ).first();
      if (!labelNode.length || !valueNode.length) return;
      const label = normalizePhysicalLabel(readText(labelNode));
      const value = readText(valueNode);
      const axis = axisPatterns.find(([, pattern]) => pattern.test(label))?.[0];
      if (!axis) return;
      const measurement = parsePhysicalMeasurement(value, physicalUnitFromLabel(value) || "", "dimension");
      if (!measurement) return;
      dimensions[axis] = measurement.value;
    });

    const foundAxes = PHYSICAL_DIMENSION_AXES.filter(axis => Number(dimensions[axis]) > 0).length;
    if (foundAxes >= 2) {
      dimensions.unit = "cm";
      dimensions.source = "dom:explicit-product-measurements-section";
      scopedProductDimensions = mergePhysicalDimensionInfo(dimensions, scopedProductDimensions);
    }
  });
  if (scopedProductDimensions) {
    // The explicitly labelled assembled-product panel is more authoritative
    // than generic rows gathered from a shared product/package wrapper.
    output.productDimensions = mergePhysicalDimensionInfo(scopedProductDimensions, output.productDimensions);
  }

  return output;
}

function isNutritionMeasurementControl($, node) {
  // Nutrition-table selectors such as "100 g", "1 odmerka (30 g)" and
  // "Denná dávka (60 g)" are reference bases, not sale-package variants.
  // Do not let those controls override an explicit package/net-weight label.
  let current = node;
  for (let depth = 0; current && current.length && depth < 7; depth++, current = current.parent()) {
    const marker = [
      current.attr("class"), current.attr("id"), current.attr("aria-label"),
      current.attr("data-testid"), current.attr("role")
    ].filter(Boolean).join(" ").toLowerCase();
    if (/(?:nutrition|nutri|výživ|vyziv|nutritional|facts-table|nutrition-facts)/i.test(marker)) return true;

    // Some stores do not mark the nutrition section with semantic class names.
    // Check only the nearest section-like ancestors to avoid matching the whole page.
    const tag = String(current.get(0)?.tagName || "").toLowerCase();
    if (["section", "fieldset", "table", "[role=tabpanel]"].includes(tag)) {
      const sectionText = current.text().replace(/\s+/g, " ").slice(0, 700).toLowerCase();
      if (/(?:nutričné hodnoty|nutricne hodnoty|výživové hodnoty|vyzivove hodnoty|nutrition facts)/i.test(sectionText)) return true;
    }
  }
  return false;
}

function extractPackageMeasureFromDom($, container) {
  const fullTextForPackage = container.text().replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  // Supplement packages are most usefully identified by the explicit capsule
  // count (e.g. GymBeam's "Kapsuly: 120 kaps.") rather than shipping net weight.
  const capsuleCountLabel = fullTextForPackage.match(/(?:kapsuly|počet\s+kapsúl|capsules?)\s*:?\s*([^|;,]{1,40})/i);
  if (capsuleCountLabel) {
    const capsuleMeasure = parseExplicitPackageLabel(capsuleCountLabel[1]);
    if (capsuleMeasure?.packageUnit === "kapsula") {
      return { ...capsuleMeasure, packageMeasureSource: "dom:labelled-capsule-count", packageOptions: null };
    }
  }

  // Explicit net contents win over generic structured properties.
  // Physical/net product weight is not automatically a sellable package size.
  const explicitNetPackageMeasure = extractExplicitNetPackageMeasureFromText(fullTextForPackage);
  if (explicitNetPackageMeasure) {
    return { ...explicitNetPackageMeasure, packageOptions: null };
  }

  const selectors = [
    "[itemprop='netContent']", "[data-net-content]", ".net-content",
    ".product-net-content", "[data-content-size]", ".content-size"
  ];
  for (const selector of selectors) {
    const node = container.find(selector).first();
    if (!node.length) continue;
    const raw = node.attr("content") || node.attr("data-net-content") ||
      node.attr("data-content-size") || node.text();
    const measure = extractPackageMeasure({ netContent: {
      value: raw,
      unitCode: node.attr("data-unit-code") || node.attr("data-content-unit") || node.attr("data-unit"),
      unitText: node.attr("data-unit-text") || node.attr("data-content-unit") || node.attr("data-unit")
    } });
    if (measure.packageQuantity != null) return { ...measure, packageLabel: `${measure.packageQuantity} ${measure.packageUnit}`, packageMeasureSource: `dom:${selector}` };
  }

  // Explicit variant controls (buttons, options, radios and data attributes).
  // Never select an arbitrary first option when several are available.
  const optionSelector = "button, [role='radio'], [role='option'], option, input, label, a[href], [data-variant-id], [data-product-variant-id], [data-option-value], [data-value]";
  const options = [];
  container.find(optionSelector).each((_, element) => {
    const node = $(element);
    if (isNutritionMeasurementControl($, node)) return;
    // Ordinary product/recommendation links must never be interpreted as
    // package options. Anchors are accepted only inside an explicitly marked
    // variant, size, package, weight, volume or option control.
    if (node.is("a[href]")) {
      const marker = [node.attr("class"), node.attr("id"), node.attr("data-testid"), node.attr("role")]
        .filter(Boolean).join(" ").toLowerCase();
      if (!/(?:variant|size|package|weight|volume|option)/i.test(marker)) return;
    }
    const raw = [node.attr("data-option-value"), node.attr("data-value"), node.attr("value"), node.attr("aria-label"), node.attr("title"), node.text()]
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const parsed = parseExplicitPackageLabel(raw);
    if (!parsed) return;
    const optionClass = String(node.attr("class") || "");
    const classTokens = optionClass.split(/\s+/).filter(Boolean);
    const selectedByState = node.is(":checked") || node.attr("aria-pressed") === "true" ||
      node.attr("aria-checked") === "true" || node.attr("aria-selected") === "true" ||
      node.attr("data-selected") === "true" || node.attr("data-state") === "checked" ||
      node.attr("data-state") === "on" || node.attr("selected") != null ||
      /(?:^|\s)(?:active|selected|checked|current|is-active|is-selected)(?:\s|$)/i.test(optionClass);
    // Some component libraries expose selection only through a contrasting
    // utility-class pair (e.g. bg-black/text-white vs bg-white/text-black).
    const hasSelectedBackground = classTokens.some(token => /^bg-(?:black|primary|selected|active|[a-z]+-(?:800|900|950))$/i.test(token));
    const hasSelectedForeground = classTokens.some(token => /^text-(?:white|primary-foreground|selected-foreground)$/i.test(token));
    const selected = selectedByState || (hasSelectedBackground && hasSelectedForeground);
    const id = node.attr("data-variant-id") || node.attr("data-product-variant-id") || node.attr("data-id") || null;
    const href = node.attr("href") || node.attr("data-href") || node.attr("data-url") || null;
    const key = `${parsed.packageQuantity}|${parsed.packageUnit}|${id || href || raw}`;
    if (!options.some(item => item.key === key)) options.push({ ...parsed, selected, variantId: id, url: href, label: raw, key });
  });
  const publicOptions = options.slice(0, 40).map(({ key, ...item }) => item);
  const selectedOptions = options.filter(item => item.selected);
  if (selectedOptions.length === 1) {
    const selected = selectedOptions[0];
    return { packageQuantity: selected.packageQuantity, packageUnit: selected.packageUnit,
      packageLabel: selected.packageLabel, packageMeasureSource: "dom:selected-variant-option", packageOptions: publicOptions };
  }
  if (options.length === 1) {
    const only = options[0];
    return { packageQuantity: only.packageQuantity, packageUnit: only.packageUnit,
      packageLabel: only.packageLabel, packageMeasureSource: "dom:single-variant-option", packageOptions: publicOptions };
  }

  const labelledText = container.text().replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const labelMatch = labelledText.match(/(?:netto\s*(?:váha|hmotnosť)|čistá\s+hmotnosť|hmotnosť\s+produktu|obsah\s+balenia|net\s+weight|net\s+content|veľkosť\s+balenia|kapsuly|počet\s+kapsúl|capsules?)\s*:?\s*([^|;,]{1,60})/i);
  if (labelMatch) {
    const measure = parseExplicitPackageLabel(labelMatch[1]);
    if (measure) return { ...measure, packageMeasureSource: "dom:labelled-package-measure", packageOptions: publicOptions };
  }
  return { packageQuantity: null, packageUnit: null, packageLabel: null,
    packageMeasureSource: null, packageOptions: publicOptions.length ? publicOptions : null };
}

function extractUnitNearPrice($, container, expectedPrice = null) {
  // This field represents the unit of sale only. A reference price such as
  // "49,90 EUR/kg" belongs in unitPrice/unitPriceUnit and must never be
  // copied into the product's sales-unit field.
  const selectors = [
    "[itemprop='unitText']", "[itemprop='unitCode']", "[data-sales-unit]",
    "[data-unit-of-sale]", ".sales-unit", ".product-sales-unit"
  ];
  for (const selector of selectors) {
    const element = container.find(selector).first();
    if (!element.length) continue;
    const raw = element.attr("content") || element.attr("data-sales-unit") ||
      element.attr("data-unit-of-sale") || element.text();
    const unit = normalizeProductUnit(raw);
    if (unit) return unit;
  }
  const fullText = container.text().replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const labelled = fullText.match(/(?:predajn[aá]\s+jednotka|jednotka\s+predaja|sales\s+unit|unit\s+of\s+sale)\s*[:\-]?\s*(ks|kus(?:y|ov)?|piece|pieces|pc|pcs|kg|g|l|ml|m²|m2|m³|m3)\b/i);
  return labelled ? normalizeProductUnit(labelled[1]) : null;
}


// ==========================================
// JSON-LD EXTRAKCIA
// ==========================================

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isProductType(value) {
  const types = Array.isArray(value) ? value : [value];

  return types.some(type =>
    String(type || "")
      .toLowerCase()
      .split("/")
      .pop() === "product"
  );
}

function collectJsonLdNodes(data, output = []) {
  if (!data || typeof data !== "object") {
    return output;
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      collectJsonLdNodes(item, output);
    }
    return output;
  }

  output.push(data);

  if (data["@graph"]) {
    collectJsonLdNodes(data["@graph"], output);
  }

  if (data.itemListElement) {
    collectJsonLdNodes(data.itemListElement, output);
  }

  return output;
}



export function getOfferPrice(offers) {
  if (!offers) return null;

  const list = Array.isArray(offers) ? offers : [offers];
  const prices = [];

  for (const offer of list) {
    if (!offer || typeof offer !== "object") continue;

    const nested = offer.offers ? getOfferPrice(offer.offers) : null;
    if (nested) {
      prices.push(nested);
      continue;
    }

    const specifications = Array.isArray(offer.priceSpecification)
      ? offer.priceSpecification
      : offer.priceSpecification ? [offer.priceSpecification] : [];
    const unitSpecification = specifications.find(spec => {
      const types = Array.isArray(spec?.["@type"]) ? spec["@type"] : [spec?.["@type"]];
      return types.some(type => /unitpricespecification/i.test(String(type || ""))) ||
        Boolean(spec?.referenceQuantity || spec?.unitCode || spec?.unitText);
    });

    // An isolated UnitPriceSpecification is a reference/unit price, not proof
    // of the amount payable for the package. Never promote it to product.price.
    const rawPackagePrice = offer.price ?? offer.lowPrice;
    const rawPrice = rawPackagePrice ?? (!unitSpecification ? specifications[0]?.price : null);
    const price = parsePrice(rawPrice);
    if (price == null) continue;

    const currency = normalizeCurrency(
      offer.priceCurrency ??
      (rawPackagePrice != null ? specifications[0]?.priceCurrency : null) ??
      specifications[0]?.priceCurrency
    );
    const unitPrice = unitSpecification ? parsePrice(unitSpecification.price) : null;
    const unitPriceUnit = unitSpecification
      ? extractStructuredUnit(unitSpecification, unitSpecification.referenceQuantity)
      : null;
    const availabilityRaw = offer.availability || null;
    const availabilityInfo = normalizeAvailabilityStatus(availabilityRaw);
    const inventoryRaw = offer.inventoryLevel?.value ?? offer.inventoryLevel?.valueText ??
      offer.stockQuantity ?? offer.availableQuantity ?? offer.inventoryQuantity ?? null;
    const inventoryMatch = inventoryRaw == null ? null : String(inventoryRaw).replace(/\s/g, "").match(/^(\d{1,7})(?:[,.]0+)?(?:ks|pcs|pieces?)?$/i);
    const stockQuantity = inventoryMatch ? Number(inventoryMatch[1]) : null;

    prices.push({
      price,
      priceExtractionEvidence: { method: "json-ld-offer", rawPrice: rawPrice == null ? null : String(rawPrice), currency: currency || null },
      packagePrice: rawPackagePrice != null ? price : null,
      unitPrice: unitPrice != null && unitSpecification ? unitPrice : null,
      unitPriceUnit: unitPriceUnit || null,
      priceBasis: rawPackagePrice != null ? "offer-price" : "unspecified-price-specification",
      currency,
      availability: availabilityInfo?.availability || availabilityRaw,
      availabilityText: availabilityInfo?.availabilityText || availabilityRaw,
      availabilitySource: availabilityRaw ? "json-ld:offer.availability" : null,
      ...(stockQuantity != null ? { stockQuantity, stockQuantityUnit: "ks", stockSource: "json-ld:offer.inventoryLevel" } : {}),
      unit: rawPackagePrice != null
        ? extractStructuredUnit({ ...offer, priceSpecification: null })
        : null
    });
  }

  if (!prices.length) return null;
  const unique = new Map();
  for (const item of prices) {
    const key = `${item.price}|${item.currency || ""}|${item.priceBasis || ""}`;
    unique.set(key, item);
  }
  return unique.size === 1 ? [...unique.values()][0] : null;
}

// Normalize identifiers from common schema.org and storefront field names.
// Values are kept as strings to preserve leading zeroes and vendor formatting.
export function extractProductIdentifiers(value = {}) {
  if (!value || typeof value !== "object") return {};
  const scalar = (...values) => {
    for (const candidate of values) {
      if (candidate == null || typeof candidate === "object") continue;
      const text = cleanText(String(candidate), 160);
      if (text) return text;
    }
    return null;
  };
  const brandValue = value.brand?.name || value.brand || value.manufacturer?.name || value.manufacturer;
  const identifiers = {
    sku: scalar(value.sku, value.SKU, value.partNo, value.part_no, value.itemNumber, value.item_number, value.articleNumber, value.article_number, value.productCode, value.product_code, value.manufacturerCode, value.manufacturer_code, value.articleCode, value.article_code),
    gtin: scalar(value.gtin, value.gtin8, value.gtin12, value.gtin13, value.gtin14, value.ean, value.ean8, value.ean12, value.ean13, value.barcode, value.barCode),
    mpn: scalar(value.mpn, value.MPN, value.manufacturerPartNumber, value.manufacturer_part_number, value.manufacturerSku, value.manufacturer_sku),
    productId: scalar(value.productID, value.productId, value.product_id, value.id, value.itemId, value.item_id),
    brand: scalar(brandValue)
  };
  return Object.fromEntries(Object.entries(identifiers).filter(([, item]) => item));
}

function normalizeAvailabilityStatus(rawValue) {
  const raw = cleanText(String(rawValue ?? ""), 180);
  if (!raw) return null;
  const normalized = normalizePhysicalLabel(raw).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return null;

  // A generic field heading is not a stock status. Check this before any
  // positive token matching: "Dostupnosť" contains the stem "dostupn" but
  // does not tell us whether the product is available.
  if (/^(?:availability|product availability|dostupnost|dostupnost produktu|stav dostupnosti|stock|stock status|stav skladu|stav skladovych zasob)$/.test(normalized)) return null;

  // Negative states must be checked before generic "available" / "stock" tokens.
  if (/(?:out of stock|outofstock|sold out|soldout|unavailable|discontinued|vypredan|nedostupn|nie je skladom|momentalne nedostup|momentally unavailable)/.test(normalized)) {
    return { availability: "OutOfStock", availabilityText: raw };
  }
  if (/(?:pre order|preorder|predobjednavk)/.test(normalized)) {
    return { availability: "PreOrder", availabilityText: raw };
  }
  if (/(?:back order|backorder|na objednavku|objednavku|dodanie na objednavku)/.test(normalized)) {
    return { availability: "BackOrder", availabilityText: raw };
  }
  if (/(?:limited availability|limitedavailability|obmedzena dostupnost|posledne kusy)/.test(normalized)) {
    return { availability: "LimitedAvailability", availabilityText: raw };
  }
  if (/(?:in stock|instock|available|skladom|na sklade|dostupne|dostupny|ihned k odberu|ihned dostupn)/.test(normalized)) {
    return { availability: "InStock", availabilityText: raw };
  }
  // Keep explicit, short store status text even when it cannot safely be mapped
  // to a universal stock enum. Never infer an unknown state from page-wide copy.
  if (raw.length <= 120 && !/^https?:\/\//i.test(raw)) {
    return { availability: raw, availabilityText: raw };
  }
  return null;
}

function normalizeIdentifierValue(rawValue, kind) {
  const raw = cleanText(String(rawValue ?? ""), 160).replace(/^(?:SKU|EAN(?:[\s-]?(?:8|12|13|14))?|GTIN(?:[\s-]?(?:8|12|13|14))?|UPC|Barcode|Čiarový kód|Ciarovy kod)\s*[:#-]?\s*/i, "").trim();
  if (!raw) return null;
  if (kind === "gtin") {
    const digits = raw.replace(/[^0-9]/g, "");
    // GTIN-8/12/13/14 are numeric identifiers. Reject arbitrary model strings
    // rather than silently mislabelling them as EAN values.
    return [8, 12, 13, 14].includes(digits.length) ? digits : null;
  }
  return raw.length <= 100 ? raw : null;
}

function readProductAttributeNodeValue($, node) {
  const element = $(node);
  for (const attribute of [
    "content", "value", "data-value", "data-sku", "data-product-sku", "data-product-code", "data-article-number",
    "data-ean", "data-gtin", "data-barcode", "data-stock-status",
    "data-availability", "data-stock-quantity", "data-stock-count"
  ]) {
    const value = element.attr(attribute);
    if (value != null && String(value).trim()) return cleanText(String(value), 180);
  }
  const href = element.attr("href");
  if (href && /itemprop=["']availability/i.test(String(element.attr("itemprop") || ""))) return cleanText(href, 180);
  return cleanText(element.text(), 180);
}

function collectProductLabelValuePairs($, root) {
  const pairs = [];
  const seen = new Set();
  const isExcludedHere = node => isExcludedProductAreaWithin($, node, root);
  const push = (label, value, node) => {
    const labelText = cleanText(String(label || ""), 100);
    const valueText = cleanText(String(value || ""), 180);
    if (!labelText || !valueText || labelText.length > 90 || valueText.length > 180) return;
    if (isExcludedHere(node)) return;
    const key = `${normalizePhysicalLabel(labelText)}|${valueText}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ label: labelText, value: valueText, node });
  };

  root.find("tr").slice(0, 900).each((_, row) => {
    const cells = $(row).find("th,td").toArray();
    if (cells.length >= 2) push(readProductAttributeNodeValue($, cells[0]), readProductAttributeNodeValue($, cells[1]), row);
  });
  root.find("dl").slice(0, 180).each((_, list) => {
    $(list).children("dt").each((_, dt) => {
      const dd = $(dt).next("dd").first();
      if (dd.length) push(readProductAttributeNodeValue($, dt), readProductAttributeNodeValue($, dd), list);
    });
  });

  const rowSelector = [
    "[class*='specification-row' i]", "[class*='attribute-row' i]", "[class*='product-attribute' i]",
    "[class*='spec-row' i]", "[class*='detail-row' i]", "[data-testid*='specification' i]",
    "[data-testid*='attribute' i]", "[class*='key-value' i]"
  ].join(",");
  root.find(rowSelector).slice(0, 1200).each((_, row) => {
    const rowNode = $(row);
    const labelNode = rowNode.find("th,dt,[class*='label' i],[class*='name' i],[class*='key' i],strong,b,label").first();
    const valueNode = rowNode.find("td,dd,[class*='value' i],[class*='content' i],[class*='val' i]").first();
    if (labelNode.length && valueNode.length) push(readProductAttributeNodeValue($, labelNode), readProductAttributeNodeValue($, valueNode), row);
  });

  // Compact rows such as "EAN: 1234567890123" are common in less semantic themes.
  root.find("li,p,div,span,td,dd").slice(0, 4000).each((_, element) => {
    const node = $(element);
    if (node.children().length > 4) return;
    const text = cleanText(node.text(), 260);
    const match = text.match(/^\s*([^:：]{2,80})\s*[:：]\s*(.{1,160})\s*$/);
    if (match) push(match[1], match[2], element);
  });

  // A label and value can be adjacent sibling spans without a common row class.
  const labelPattern = /^(?:sku|product sku|kod produktu|kod tovaru|cislo produktu|cislo vyrobku|product code|article number|article no|item number|item no|product number|catalog(?:ue)? number|part number|p\/n|artikelnummer|kod artiklu|cislo artiklu|ean(?: ?(?:8|12|13|14))?|ean kod|kod ean|gtin(?: ?(?:8|12|13|14))?|gtin kod|ean gtin|upc|barcode|bar code|ciarovy kod|carovy kod|hmotnost|vaha|weight|net weight|product weight|hmotnost produktu|hmotnost balenia|gross weight|shipping weight|dostupnost|availability|stock status|stav skladu|skladom|stock quantity|available quantity|quantity in stock|pocet kusov skladom|mnozstvo skladom)$/;
  root.find("th,dt,strong,b,label,span,[class*='label' i],[class*='name' i]").slice(0, 2500).each((_, element) => {
    const node = $(element);
    const label = cleanText(node.text(), 90);
    const normalizedLabel = normalizePhysicalLabel(label).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!labelPattern.test(normalizedLabel) || isExcludedHere(element)) return;
    let valueNode = node.next();
    if (!valueNode.length) valueNode = node.parent().children().filter((__, child) => child !== element).first();
    if (valueNode.length) push(label, readProductAttributeNodeValue($, valueNode), element);
  });
  return pairs;
}

function isShippingProductAttributeContext($, node) {
  let current = $(node);
  for (let depth = 0; current.length && depth < 8; depth++, current = current.parent()) {
    const marker = [current.attr("class"), current.attr("id"), current.attr("data-testid"), current.attr("aria-label")]
      .filter(Boolean).join(" ").toLowerCase();
    if (/(?:shipping|delivery|logistic|package|packaging|parcel|carton|preprav|balen|versand|verpack|transport|expedition)/i.test(marker)) return true;
    const heading = current.children("h1,h2,h3,h4,caption,legend").slice(0, 4).text();
    if (/(?:shipping|delivery|logistic|package|packaging|parcel|carton|preprav|balen|versand|verpack|transport)/i.test(heading)) return true;
    const tag = String(current.get(0)?.tagName || "").toLowerCase();
    if (["main", "body", "html"].includes(tag)) break;
  }
  return false;
}

function extractCurrentProductPageAttributes($, pageUrl, productArea = null) {
  let parsedUrl;
  try { parsedUrl = new URL(pageUrl); } catch { return {}; }
  const pathname = parsedUrl.pathname;
  if (/\/(?:kategoria|category|categories|collection|collections|catalog|catalogue)(?:\/|$)/i.test(pathname)) return {};
  const titleNode = getPrimaryProductTitleNode($);
  const title = cleanProductTitle(titleNode.text() || $("meta[property='og:title']").attr("content") || $("title").first().text());
  if (!title || !isLikelyRealProductName(title)) return {};

  const root = productArea && productArea.length ? productArea : ($("main").first().length ? $("main").first() : $("body"));
  const pairs = collectProductLabelValuePairs($, root);
  const isExcludedHere = node => isExcludedProductAreaWithin($, node, root);
  const readFirst = (selectors, attributes = ["content", "value", "data-value", "data-sku", "data-ean", "data-gtin", "data-barcode"]) => {
    for (const selector of selectors) {
      const nodes = root.find(selector).add($(selector).filter("meta"));
      let found = null;
      nodes.each((_, node) => {
        if (found || (!String(node.tagName || "").toLowerCase().startsWith("meta") && isExcludedHere(node))) return;
        const el = $(node);
        for (const attribute of attributes) {
          const value = el.attr(attribute);
          if (value != null && String(value).trim()) { found = cleanText(String(value), 180); break; }
        }
        if (!found && !/^(?:meta|link)$/i.test(String(node.tagName || ""))) found = readProductAttributeNodeValue($, node);
      });
      if (found) return found;
    }
    return null;
  };

  let sku = normalizeIdentifierValue(readFirst([
    "[itemprop='sku']", "[data-sku]", "[data-product-sku]", "[data-product-code]", "[data-article-number]", "meta[name='sku']",
    "meta[property='product:retailer_item_id']", "meta[property='product:sku']", "meta[name='product_code']", "meta[name='productcode']"
  ]), "sku");
  let gtin = normalizeIdentifierValue(readFirst([
    "[itemprop='gtin']", "[itemprop='gtin8']", "[itemprop='gtin12']", "[itemprop='gtin13']", "[itemprop='gtin14']",
    "[data-ean]", "[data-gtin]", "[data-barcode]", "meta[name='ean']", "meta[name='gtin']",
    "meta[name='barcode']", "meta[property='product:gtin13']", "meta[property='product:ean']", "meta[name='product:ean']"
  ]), "gtin");
  let mpn = readFirst(["[itemprop='mpn']", "meta[name='mpn']", "meta[property='product:mpn']"]);

  let availabilityRaw = readFirst([
    "[itemprop='availability']", "[data-availability]", "[data-stock-status]",
    "[data-testid*='availability' i]", "[data-testid*='stock' i]",
    "[class*='product-availability' i]", "[class*='availability-status' i]", "[class*='stock-status' i]",
    "[class*='product-stock' i]", "[class*='stock-availability' i]", "[class*='stock-info' i]",
    "meta[property='product:availability']", "meta[name='availability']"
  ], ["href", "content", "value", "data-availability", "data-stock-status", "data-value"]);
  if (availabilityRaw && !normalizeAvailabilityStatus(availabilityRaw)) availabilityRaw = null;

  let stockQuantity = null;
  let stockSource = null;
  const stockQuantitySelectors = [
    "[itemprop='inventoryLevel'] [itemprop='value']", "[itemprop='inventoryLevel']", "[data-stock-quantity]", "[data-stock-count]",
    "[data-inventory-quantity]", "[data-available-quantity]", "[data-quantity-in-stock]", "meta[name='stock-quantity']"
  ];
  const rawStockQuantity = readFirst(stockQuantitySelectors, ["content", "value", "data-stock-quantity", "data-stock-count", "data-inventory-quantity", "data-available-quantity"]);
  if (rawStockQuantity) {
    const match = rawStockQuantity.replace(/\s/g, "").match(/^(\d{1,7})(?:[,.]0+)?(?:ks|pcs|pieces?)?$/i);
    if (match) { stockQuantity = Number(match[1]); stockSource = "dom:explicit-stock-quantity"; }
  }

  for (const pair of pairs) {
    const label = normalizePhysicalLabel(pair.label).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!sku && /(?:^|\b)(?:sku|product sku|kod produktu|kod tovaru|cislo produktu|cislo vyrobku|product code|article number|article no|item number|item no|product number|catalog(?:ue)? number|part number|p n|artikelnummer|kod artiklu|cislo artiklu)(?:\b|$)/.test(label) && !/(?:ean|gtin|barcode)/.test(label)) {
      sku = normalizeIdentifierValue(pair.value, "sku");
    }
    if (!gtin && /(?:^|\b)(?:ean|gtin|upc|barcode|bar code|ciarovy kod|carovy kod)(?:\b|$)/.test(label)) {
      gtin = normalizeIdentifierValue(pair.value, "gtin");
    }
    if (!mpn && /^(?:mpn|manufacturer part number|vyrobne cislo|cislo dielu)$/.test(label)) mpn = cleanText(pair.value, 120);

    const isAvailabilityLabel = /^(?:dostupnost|availability|stock status|stav skladu|stav zasob|skladom)$/.test(label);
    // Visible PDP stock copy is more useful than a generic Schema.org URI;
    // prefer it so an explicit "Skladom 8 ks" can supply both status and count.
    if (isAvailabilityLabel && (!availabilityRaw || /schema\.org\//i.test(availabilityRaw))) availabilityRaw = pair.value;

    if (stockQuantity == null && /^(?:stock quantity|available quantity|quantity in stock|inventory quantity|inventory level|stock level|pocet kusov skladom|mnozstvo skladom|dostupne mnozstvo)$/.test(label)) {
      const match = pair.value.replace(/\s/g, "").match(/^(\d{1,7})(?:[,.]0+)?(?:ks|pcs|pieces?)?$/i);
      if (match) { stockQuantity = Number(match[1]); stockSource = "dom:labelled-stock-quantity"; }
    }
    if (stockQuantity == null && isAvailabilityLabel) {
      const stockMatch = pair.value.match(/(?:skladom|in stock|available)\s*[:,-]?\s*(\d{1,7})\s*(?:ks|pcs|pieces?)/i);
      if (stockMatch) { stockQuantity = Number(stockMatch[1]); stockSource = "dom:availability-quantity"; }
    }

    // A generic "Weight/Hmotnosť" row is accepted only as a labelled value
    // inside the product detail's specification area and never inside a
    // shipping/logistics/package subtree. Explicit product/net labels remain
    // valid wherever they occur in the product page.
    if (/(?:hmotnost|vaha|weight|massa|gewicht|waga|poids|peso)/.test(label)) {
      const explicitProductWeight = /(?:product|produktu|netto|net weight)/.test(label);
      const shippingContext = isShippingProductAttributeContext($, pair.node) || /(?:balen|package|shipping|gross|brutto|preprav|versand|verpack)/.test(label);
      const genericWeightInSpecs = /^(?:hmotnost|vaha|weight|gewicht|waga|poids|peso)$/.test(label) && !shippingContext;
      if ((explicitProductWeight && !shippingContext) || genericWeightInSpecs) {
        // Preserve the actual page label as evidence while explicitly classifying
        // an unqualified technical-specification row as product weight.
        const physicalLabel = genericWeightInSpecs ? "Hmotnosť produktu" : pair.label;
        const physical = extractPhysicalSpecsFromDom($, root);
        applyPhysicalSpecPair(physical, physicalLabel, pair.value, "dom:product-attribute-row");
        pair.physical = physical;
      }
    }

    if (!availabilityRaw) {
      const stockMatch = pair.value.match(/(?:skladom|in stock|dostupne)\s*[:,-]?\s*(\d{1,7})\s*(?:ks|pcs|pieces?)/i);
      if (stockMatch) { stockQuantity = Number(stockMatch[1]); stockSource = "dom:availability-quantity"; availabilityRaw = pair.value; }
    }
  }

  // A quantity explicitly embedded in the availability line is also a valid
  // stock count (for example "Skladom 4 ks"). Do not derive counts from vague
  // phrases such as "available" or from page-wide text.
  if (stockQuantity == null && availabilityRaw) {
    const quantityMatch = availabilityRaw.match(/(?:skladom|in stock|available)?\s*[:,-]?\s*(\d{1,7})\s*(?:ks|pcs|pieces?)/i) ||
      availabilityRaw.match(/(?:skladom|in stock|available)\s+(\d{1,7})/i);
    if (quantityMatch) { stockQuantity = Number(quantityMatch[1]); stockSource = "dom:availability-quantity"; }
  }
  // Explicit stock quantity is useful availability evidence when the shop does
  // not expose a separate status string; zero means out of stock, positive means
  // stock exists. A status without a count is never converted into a quantity.
  if (!availabilityRaw && stockQuantity != null) availabilityRaw = stockQuantity > 0 ? "Skladom" : "Nedostupné";
  const availabilityInfo = normalizeAvailabilityStatus(availabilityRaw);
  const physicalSpecs = extractPhysicalSpecsFromDom($, root);
  for (const pair of pairs) {
    if (pair.physical?.productWeight > 0 && !(physicalSpecs.productWeight > 0)) {
      Object.assign(physicalSpecs, pair.physical);
    }
  }
  if (stockQuantity != null && stockSource == null) stockSource = "dom:explicit-stock-quantity";

  const productAttributes = mergeProductAttributes(pairs
    .filter(pair => !/^(?:cena|price|dostupnost|availability|stock|stav skladu|dostupnost produktu|doprava|delivery|shipping|skladom)$/i.test(normalizePhysicalLabel(pair.label)))
    .map(pair => ({ name: pair.label, value: pair.value, source: "dom:product-attribute-row" })));

  return {
    ...(sku ? { sku } : {}),
    ...(gtin ? { gtin } : {}),
    ...(mpn ? { mpn } : {}),
    ...(productAttributes.length ? { productAttributes } : {}),
    ...physicalSpecs,
    ...(availabilityInfo ? {
      availability: availabilityInfo.availability,
      availabilityText: availabilityInfo.availabilityText,
      availabilitySource: availabilityInfo.availabilityText === availabilityRaw ? "dom:product-availability" : "dom:product-availability-normalized"
    } : {}),
    ...(stockQuantity != null ? { stockQuantity, stockQuantityUnit: "ks", stockSource } : {})
  };
}

export function extractProductPageAttributesFromHtml(html, pageUrl, existingRoot = null) {
  const $ = existingRoot || loadHtml(html);
  const productArea = $("main").first().length ? $("main").first() : $("body");
  return extractCurrentProductPageAttributes($, pageUrl, productArea);
}

function extractProductFromJsonLd(node, pageUrl) {
  if (!node || !isProductType(node["@type"])) {
    return null;
  }

  const name = cleanText(
    node.name ||
    node.headline ||
    "",
    300
  );

  if (!name || name.length < 2) {
    return null;
  }

  const offer = getOfferPrice(node.offers);

  if (!offer) return null;

  let productUrl = node.url || pageUrl;

  try {
    productUrl = new URL(productUrl, pageUrl).href;
  } catch {
    productUrl = pageUrl;
  }

  const imageValue = Array.isArray(node.image)
    ? node.image[0]
    : node.image;

  const image =
    typeof imageValue === "string"
      ? imageValue
      : imageValue?.url || null;

  return {
    name,
    price: offer.price,
    packagePrice: offer.packagePrice ?? offer.price,
    unitPrice: offer.unitPrice ?? null,
    unitPriceUnit: offer.unitPriceUnit || null,
    priceBasis: offer.priceBasis || "offer-price",
    currency: offer.currency,
    availability: offer.availability,
    availabilityText: offer.availabilityText || offer.availability || null,
    availabilitySource: offer.availabilitySource || null,
    ...(offer.stockQuantity != null ? { stockQuantity: offer.stockQuantity, stockQuantityUnit: offer.stockQuantityUnit || "ks", stockSource: offer.stockSource || null } : {}),
    unit: offer.unit || null,
    ...extractPackageMeasure(node, offer),
    ...extractPhysicalSpecsFromStructured(node, offer),
    productAttributes: extractProductAttributesFromStructured(node, offer),
    url: productUrl,
    image,
    ...extractProductIdentifiers(node),
    source: "json-ld",
    priceExtractionEvidence: offer.priceExtractionEvidence || null
  };
}

function isProductGroupType(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some(type => String(type || "").toLowerCase().split("/").pop() === "productgroup");
}

function getVariantAttributes(variant) {
  const attributes = {};
  for (const key of ["size", "color", "material", "pattern", "model", "sku", "gtin", "gtin13", "gtin14"]) {
    const value = variant?.[key];
    if (value != null && typeof value !== "object" && String(value).trim()) {
      attributes[key] = String(value).trim().slice(0, 120);
    }
  }
  const additional = Array.isArray(variant?.additionalProperty) ? variant.additionalProperty : [];
  for (const property of additional.slice(0, 20)) {
    const name = cleanText(property?.name || property?.propertyID || "", 80);
    const value = cleanText(property?.value || "", 120);
    if (name && value) attributes[name] = value;
  }
  return attributes;
}

function getJsonLdOfferList(offers, output = []) {
  if (!offers) return output;
  const list = Array.isArray(offers) ? offers : [offers];
  for (const offer of list) {
    if (!offer || typeof offer !== "object") continue;
    if (Array.isArray(offer.offers) || (offer.offers && typeof offer.offers === "object")) {
      getJsonLdOfferList(offer.offers, output);
      continue;
    }
    if (offer.price != null || offer.lowPrice != null) output.push(offer);
  }
  return output;
}

function getJsonLdOfferUnitPrice(offer) {
  const specs = Array.isArray(offer?.priceSpecification)
    ? offer.priceSpecification
    : offer?.priceSpecification ? [offer.priceSpecification] : [];
  const spec = specs.find(item => item && typeof item === "object" &&
    (item.unitPrice != null || item.referenceQuantity || item.unitCode || item.unitText)) || specs[0] || null;
  if (!spec) return { unitPrice: null, unitPriceUnit: null };
  const rawUnitPrice = spec.unitPrice ?? spec.price;
  const unitPrice = parsePrice(rawUnitPrice);
  const unitPriceUnit = extractStructuredUnit(spec, spec.referenceQuantity);
  return { unitPrice, unitPriceUnit };
}

function extractPackageMeasureFromImageAssets(...objects) {
  const found = new Map();
  for (const object of objects) {
    if (!object || typeof object !== "object") continue;
    const rawImages = object.image ?? object.images ?? object.photo ?? object.photos ?? [];
    const images = Array.isArray(rawImages) ? rawImages : [rawImages];
    for (const image of images.slice(0, 40)) {
      const candidates = typeof image === "string"
        ? [image]
        : image && typeof image === "object"
          ? [image.url, image.contentUrl, image.name, image.caption, image.alt, image.description].filter(Boolean)
          : [];
      for (const candidate of candidates) {
        const text = decodeEntities(String(candidate)).replace(/%20/gi, " ");
        // Only accept explicit quantities embedded in a product image's own
        // filename/alt text. Do not infer anything from image dimensions.
        const matches = [...text.matchAll(/(?:^|[^a-z0-9])(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)(?=$|[^a-z])/gi)];
        for (const match of matches) {
          let quantity = Number(match[1].replace(",", "."));
          let unit = String(match[2]).toLowerCase();
          if (!Number.isFinite(quantity) || quantity <= 0) continue;
          if (unit === "g" && quantity >= 1000 && quantity % 1000 === 0) {
            quantity /= 1000;
            unit = "kg";
          } else if (unit === "ml" && quantity >= 1000 && quantity % 1000 === 0) {
            quantity /= 1000;
            unit = "l";
          }
          const key = `${quantity}|${unit}`;
          found.set(key, { quantity, unit });
        }
      }
    }
  }
  // If product imagery advertises conflicting package sizes (e.g. 500 g and
  // 1 kg variants), do not choose one automatically.
  if (found.size !== 1) return null;
  const value = [...found.values()][0];
  return {
    packageQuantity: value.quantity,
    packageUnit: value.unit,
    packageLabel: `${value.quantity} ${value.unit}`,
    packageMeasureSource: "json-ld:image-filename",
    packageMeasureDerived: true
  };
}

function extractProductsFromJsonLdOfferVariants(node, pageUrl) {
  const offers = getJsonLdOfferList(node?.offers);
  if (offers.length < 2) return [];

  const baseName = cleanText(node.name || node.headline || "", 300);
  if (!baseName) return [];
  let productUrl = node.url || pageUrl;
  try { productUrl = new URL(productUrl, pageUrl).href; } catch { productUrl = pageUrl; }
  const imageValue = Array.isArray(node.image) ? node.image[0] : node.image;
  const baseImage = typeof imageValue === "string" ? imageValue : imageValue?.url || null;
  const records = [];
  const seen = new Set();

  for (const offer of offers) {
    const price = parsePrice(offer.price ?? offer.lowPrice);
    const currency = normalizeCurrency(offer.priceCurrency);
    if (price == null || !currency) continue;

    const itemOffered = offer.itemOffered && typeof offer.itemOffered === "object" ? offer.itemOffered : {};
    const offerName = cleanText(offer.name || itemOffered.name || "", 300);
    const rawSize = offer.size || itemOffered.size || offer.packageSize || itemOffered.packageSize || "";
    const nameSize = offerName.match(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|capsules?|kaps(?:ula|uly|ulu|ulov|úl)|tablets?)\b/i)?.[0] || "";
    const sizeText = cleanText(rawSize || nameSize, 100);
    const packageMeasure = (sizeText ? parseExplicitPackageLabel(sizeText) : null) || extractPackageMeasureFromImageAssets(node, itemOffered, offer);
    const color = cleanText(offer.color?.name || offer.color || itemOffered.color?.name || itemOffered.color || "", 120);
    // A variant offer may identify its option only in its own name (e.g.
    // "Protein Latte - GymBeam čokoláda"). Preserve that option explicitly;
    // do not require a size/color field to recognize a real variant.
    const nameVariant = offerName && normalizeProductName(offerName) !== normalizeProductName(baseName)
      ? cleanText(offerName.slice(baseName.length).replace(/^\s*[-–—,:|\/]\s*/, ""), 120)
      : "";
    const sku = cleanText(offer.sku || offer.SKU || offer.productID || itemOffered.sku || itemOffered.SKU || itemOffered.productID || "", 160);
    const gtin = cleanText(offer.gtin || offer.gtin8 || offer.gtin12 || offer.gtin13 || offer.gtin14 || offer.ean || offer.ean13 ||
      itemOffered.gtin || itemOffered.gtin8 || itemOffered.gtin12 || itemOffered.gtin13 || itemOffered.gtin14 || itemOffered.ean || itemOffered.ean13 || "", 160);
    const variantLabel = [sizeText, color, nameVariant].filter(Boolean).join(" / ");
    const name = offerName || (variantLabel ? `${baseName} — ${variantLabel}` : baseName);
    const signature = [sku, gtin, sizeText, color, nameVariant, price, currency].join("|").toLowerCase();
    if (seen.has(signature)) continue;
    seen.add(signature);

    const { unitPrice, unitPriceUnit } = getJsonLdOfferUnitPrice(offer);
    let url = offer.url || itemOffered.url || productUrl;
    try { url = new URL(url, pageUrl).href; } catch { url = productUrl; }
    const imageCandidate = Array.isArray(itemOffered.image) ? itemOffered.image[0] : itemOffered.image;
    const image = typeof imageCandidate === "string" ? imageCandidate : imageCandidate?.url || baseImage;
    const identifiers = extractProductIdentifiers({ ...node, ...itemOffered, ...offer });
    // Physical metadata is optional enrichment. If a shop exposes malformed or
    // unusual specification data, it must never discard an otherwise valid
    // sellable variant offer.
    let physicalSpecs = {};
    try {
      physicalSpecs = extractPhysicalSpecsFromStructured(node, itemOffered, offer);
    } catch {
      physicalSpecs = {};
    }
    const groupId = cleanText(node.productGroupID || node.sku || productUrl, 300);
    const inferredNetWeight = packageMeasure && ["kg", "g"].includes(packageMeasure.packageUnit)
      ? (packageMeasure.packageUnit === "g" ? packageMeasure.packageQuantity / 1000 : packageMeasure.packageQuantity)
      : null;
    const inferredNetVolume = packageMeasure && ["l", "ml"].includes(packageMeasure.packageUnit)
      ? (packageMeasure.packageUnit === "ml" ? packageMeasure.packageQuantity / 1000 : packageMeasure.packageQuantity)
      : null;
    const variantAvailabilityRaw = offer.availability || itemOffered.availability || node.availability || null;
    const variantAvailability = normalizeAvailabilityStatus(variantAvailabilityRaw);
    const variantInventoryRaw = offer.inventoryLevel?.value ?? offer.inventoryLevel?.valueText ??
      offer.stockQuantity ?? offer.availableQuantity ?? offer.inventoryQuantity ?? null;
    const variantInventoryMatch = variantInventoryRaw == null ? null : String(variantInventoryRaw).replace(/\s/g, "").match(/^(\d{1,7})(?:[,.]0+)?(?:ks|pcs|pieces?)?$/i);
    const variantStockQuantity = variantInventoryMatch ? Number(variantInventoryMatch[1]) : null;

    records.push({
      name,
      price,
      priceExtractionEvidence: { method: "json-ld-variant-offer", rawPrice: offer.price ?? offer.lowPrice ?? null, currency },
      packagePrice: price,
      currency,
      priceBasis: "json-ld-variant-offer",
      unitPrice,
      unitPriceUnit: unitPriceUnit || null,
      availability: variantAvailability?.availability || variantAvailabilityRaw,
      availabilityText: variantAvailability?.availabilityText || variantAvailabilityRaw,
      availabilitySource: variantAvailabilityRaw ? "json-ld:variant-offer.availability" : null,
      ...(variantStockQuantity != null ? { stockQuantity: variantStockQuantity, stockQuantityUnit: "ks", stockSource: "json-ld:variant-offer.inventoryLevel" } : {}),
      unit: extractStructuredUnit(offer),
      ...physicalSpecs,
      ...(inferredNetWeight != null && !(Number(physicalSpecs.productWeight) > 0) ? {
        productWeight: inferredNetWeight,
        productWeightUnit: "kg",
        productWeightSource: `${packageMeasure.packageMeasureSource || "json-ld:offer-size"}-net-content`
      } : {}),
      ...(inferredNetVolume != null && !(Number(physicalSpecs.productVolume) > 0) ? {
        productVolume: inferredNetVolume,
        productVolumeUnit: "l",
        productVolumeSource: `${packageMeasure.packageMeasureSource || "json-ld:offer-size"}-net-content`
      } : {}),
      ...(packageMeasure ? {
        packageQuantity: packageMeasure.packageQuantity,
        packageUnit: packageMeasure.packageUnit,
        packageLabel: packageMeasure.packageLabel,
        packageMeasureSource: "json-ld:offer-size"
      } : {}),
      url,
      image,
      ...identifiers,
      isVariant: true,
      variantGroupId: groupId,
      variantGroupName: baseName,
      variantName: variantLabel || offerName || `variant ${records.length + 1}`,
      variantAttributes: {
        ...(sizeText ? { size: sizeText } : {}),
        ...(color ? { color } : {}),
        ...(nameVariant ? { option: nameVariant } : {}),
        ...(sku ? { sku } : {}),
        ...(gtin ? { gtin } : {})
      },
      source: "json-ld-offer-variant"
    });
  }

  // Do not expand a collection of ordinary offers unless at least two offers
  // carry explicit variant identity. This prevents price tiers from becoming variants.
  const identifiable = records.filter(item => item.packageQuantity != null ||
    Object.keys(item.variantAttributes || {}).length > 1 ||
    item.variantAttributes?.sku || item.variantAttributes?.gtin || item.variantAttributes?.option);
  return identifiable.length >= 2 ? records : [];
}

export function extractProductsFromJsonLd(html, pageUrl, existingRoot = null) {
  const $ = existingRoot || loadHtml(html);
  const products = [];

  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).contents().text();
    const parsed = parseJsonSafe(raw);

    if (!parsed) return;

    const nodes = collectJsonLdNodes(parsed);

    for (const node of nodes) {
      if (isProductGroupType(node?.["@type"])) {
        const groupName = cleanText(node.name || node.productGroupID || "", 300);
        const groupId = cleanText(node.productGroupID || node.url || groupName, 300);
        const variants = Array.isArray(node.hasVariant) ? node.hasVariant : node.hasVariant ? [node.hasVariant] : [];
        for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
          const variant = variants[variantIndex];
          const product = extractProductFromJsonLd(variant, pageUrl);
          if (!product) continue;
          const attributes = getVariantAttributes(variant);
          const variantLabel = Object.values(attributes).slice(0, 3).join(" / ") || `variant ${variantIndex + 1}`;
          product.variantGroupId = groupId || groupName;
          product.variantGroupName = groupName || product.name;
          product.variantAttributes = attributes;
          product.variantName = variantLabel;
          // Ak varianty zdieľajú rovnaký názov a nemajú vlastnú URL, pridáme
          // ich explicitné atribúty do názvu, aby ich URL+name deduplikácia nesliala.
          if (variants.length > 1 && normalizeProductName(product.name) === normalizeProductName(groupName)) {
            product.name = `${groupName} — ${variantLabel}`;
          }
          product.isVariant = true;
          // This function only parses JSON-LD and has no crawler response context.
          // Crawl metadata is attached later by crawlWebsite(); referencing
          // currentIsProductPage/response here caused a ReferenceError for ProductGroup pages.
          products.push(product);
        }
        continue;
      }

      const offerVariants = isProductType(node?.["@type"])
        ? extractProductsFromJsonLdOfferVariants(node, pageUrl)
        : [];
      if (offerVariants.length) {
        products.push(...offerVariants);
        continue;
      }

      const product = extractProductFromJsonLd(node, pageUrl);
      if (product) {
        // Keep schema variant attributes until sibling Product nodes have been
        // compared. Some shops publish one Product node per option instead of
        // a single ProductGroup/hasVariant or Product/offers array.
        product.variantAttributes = getVariantAttributes(node);
        products.push(product);
      }
    }
  });

  // A number of storefronts publish sibling schema.org Product nodes for
  // each selectable option. They can share the same canonical URL and title,
  // which would otherwise make the ordinary URL+name deduplicator collapse
  // them. Promote only groups with distinct stable identifiers to variants.
  const siblingGroups = new Map();
  for (const product of products) {
    if (!product || product.isVariant === true) continue;
    const identityUrl = normalizeProductUrl(product.url || pageUrl);
    const identityName = normalizeProductName(product.name || "");
    const stableId = [product.sku, product.gtin, product.mpn, product.productId]
      .map(value => normalizeProductName(value || ""))
      .filter(Boolean)
      .join("|");
    if (!identityUrl || !identityName || !stableId) continue;
    const key = `${identityUrl}|${identityName}`;
    if (!siblingGroups.has(key)) siblingGroups.set(key, []);
    siblingGroups.get(key).push({ product, stableId });
  }

  for (const [groupId, entries] of siblingGroups) {
    const uniqueIds = new Set(entries.map(entry => entry.stableId));
    if (entries.length < 2 || uniqueIds.size < 2) continue;
    const groupName = entries[0].product.name;
    for (const { product } of entries) {
      const attributes = product.variantAttributes && typeof product.variantAttributes === "object"
        ? { ...product.variantAttributes }
        : {};
      const descriptiveAttributes = Object.entries(attributes)
        .filter(([key, value]) => !/^(?:sku|gtin|gtin8|gtin12|gtin13|gtin14)$/i.test(key) && String(value || "").trim());
      const stableLabel = descriptiveAttributes.map(([key, value]) => `${key}: ${value}`).join(" / ") ||
        (product.sku ? `SKU ${product.sku}` : product.gtin ? `EAN ${product.gtin}` : product.mpn || product.productId || "variant");
      product.isVariant = true;
      product.variantGroupId = groupId;
      product.variantGroupName = groupName;
      product.variantName = stableLabel;
      product.variantAttributes = attributes;
      product.name = `${groupName} — ${stableLabel}`;
    }
  }

  return deduplicateProducts(products).slice(
    0,
    MAX_PRODUCTS_PER_PAGE
  );
}

// ==========================================
// MICRODATA A RDFa
// ==========================================

function getMetaValue($, selectors) {
  for (const selector of selectors) {
    const value = $(selector).first().attr("content") ||
      $(selector).first().attr("value") ||
      $(selector).first().text();

    if (value && String(value).trim()) {
      return cleanText(value, 500);
    }
  }

  return null;
}

function extractMicrodataProducts($, pageUrl) {
  const products = [];

  $("[itemtype]").each((_, element) => {
    const type = $(element).attr("itemtype") || "";

    if (!/schema\.org\/Product/i.test(type)) {
      return;
    }

    const root = $(element);

    const name = cleanText(
      root.find("[itemprop='name']").first().text() ||
      root.find("[itemprop='name']").first().attr("content"),
      300
    );

  const priceElement = root.find(
      "[itemprop='price']"
    ).first();

    const rawPrice =
      priceElement.attr("content") ||
      priceElement.attr("value") ||
      priceElement.text();

    const price = parsePrice(rawPrice);

    if (!name || price == null) return;

    const currency =
      normalizeCurrency(
        root.find("[itemprop='priceCurrency']")
          .first()
          .attr("content") ||
        root.find("[itemprop='priceCurrency']")
          .first()
          .text()
      );

    const link =
      root.find("[itemprop='url']").first().attr("href") ||
      root.find("a[href]").first().attr("href") ||
      pageUrl;

    let productUrl = pageUrl;

    try {
      productUrl = new URL(link, pageUrl).href;
    } catch {
      productUrl = pageUrl;
    }

    const imageValue =
      root.find("[itemprop='image']").first().attr("src") ||
      root.find("[itemprop='image']").first().attr("content");

    let image = null;

    if (imageValue) {
      try {
        image = new URL(imageValue, pageUrl).href;
      } catch {
        image = null;
      }
    }

    const unit = extractUnitNearPrice($, root, price);
    const weightNode = root.find("[itemprop='weight']").first();
    const netWeightNode = root.find("[itemprop='netWeight']").first();
    const netContentNode = root.find("[itemprop='netContent']").first();
    const packageMeasure = extractPackageMeasure(
      { weight: { value: weightNode.attr("content") || weightNode.text(), unitCode: weightNode.attr("data-unit-code"), unitText: weightNode.attr("data-unit-text") } },
      { netWeight: { value: netWeightNode.attr("content") || netWeightNode.text(), unitCode: netWeightNode.attr("data-unit-code"), unitText: netWeightNode.attr("data-unit-text") } },
      { netContent: { value: netContentNode.attr("content") || netContentNode.text(), unitCode: netContentNode.attr("data-unit-code"), unitText: netContentNode.attr("data-unit-text") } }
    );

    const microdataIdentifiers = {};
    for (const [field, itempropNames] of Object.entries({
      sku: ["sku"], gtin: ["gtin", "gtin8", "gtin12", "gtin13", "gtin14"],
      mpn: ["mpn"], productId: ["productID", "productId"]
    })) {
      for (const itemprop of itempropNames) {
        const node = root.find(`[itemprop="${itemprop}"]`).first();
        const value = node.attr("content") || node.attr("value") || node.text();
        if (value && String(value).trim()) { microdataIdentifiers[field] = cleanText(value, 160); break; }
      }
    }
    const brandNode = root.find("[itemprop='brand'] [itemprop='name'], [itemprop='brand']").first();
    if (brandNode.length) microdataIdentifiers.brand = cleanText(brandNode.attr("content") || brandNode.text(), 160);

    products.push({
      name, price,
      priceExtractionEvidence: { method: "microdata-itemprop-price", rawPrice: rawPrice == null ? null : String(rawPrice), currency: currency || null },
      currency, availability: null, unit, ...packageMeasure, ...extractPhysicalSpecsFromDom($, root), ...extractPhysicalSpecsFromStructured({
        weight: { value: weightNode.attr("content") || weightNode.text(), unitCode: weightNode.attr("data-unit-code"), unitText: weightNode.attr("data-unit-text") },
        width: { value: root.find("[itemprop='width']").first().attr("content") || root.find("[itemprop='width']").first().text(), unitCode: root.find("[itemprop='width']").first().attr("unitCode"), unitText: root.find("[itemprop='width']").first().attr("data-unit-text") },
        height: { value: root.find("[itemprop='height']").first().attr("content") || root.find("[itemprop='height']").first().text(), unitText: root.find("[itemprop='height']").first().attr("data-unit-text") },
        depth: { value: root.find("[itemprop='depth']").first().attr("content") || root.find("[itemprop='depth']").first().text(), unitText: root.find("[itemprop='depth']").first().attr("data-unit-text") },
        length: { value: root.find("[itemprop='length']").first().attr("content") || root.find("[itemprop='length']").first().text(), unitText: root.find("[itemprop='length']").first().attr("data-unit-text") }
      }), url: productUrl, image,
      ...microdataIdentifiers, source: "microdata"
    });
  });

  return products;
}

// ==========================================
// OPEN GRAPH A PRODUKTOVE META TAGY
// ==========================================

function extractMetadataProduct($, pageUrl) {
  const name = getMetaValue($, [
    "meta[property='og:title']",
    "meta[name='twitter:title']",
    "meta[property='product:name']"
  ]);

  const rawPrice = getMetaValue($, [
    "meta[property='product:price:amount']",
    "meta[property='og:price:amount']",
    "meta[itemprop='price']"
  ]);

  const price = parsePrice(rawPrice);

  if (!name || price == null) {
    return [];
  }

  const currency = normalizeCurrency(
    getMetaValue($, [
      "meta[property='product:price:currency']",
      "meta[property='og:price:currency']",
      "meta[itemprop='priceCurrency']"
    ])
  );

  const rawUrl = getMetaValue($, [
    "meta[property='og:url']"
  ]);

  let productUrl = pageUrl;

  if (rawUrl) {
    try {
      productUrl = new URL(rawUrl, pageUrl).href;
    } catch {
      productUrl = pageUrl;
    }
  }

  const rawImage = getMetaValue($, [
    "meta[property='og:image']",
    "meta[name='twitter:image']"
  ]);

  let image = null;

  if (rawImage) {
    try {
      image = new URL(rawImage, pageUrl).href;
    } catch {
      image = null;
    }
  }

  return [{
    name,
    price,
    priceExtractionEvidence: { method: "product-price-metadata", rawPrice: rawPrice == null ? null : String(rawPrice), currency: currency || null },
    currency,
    availability: null,
    unit: extractStructuredUnit({
      unitText: getMetaValue($, [
        "meta[property='product:price:unit']",
        "meta[property='product:unit']",
        "meta[itemprop='unitText']"
      ]),
      unitCode: getMetaValue($, [
        "meta[itemprop='unitCode']"
      ])
    }) || extractUnitNearPrice($, $("body"), price),
    url: productUrl,
    image,
    ...extractProductIdentifiers({
      sku: getMetaValue($, ["meta[property='product:retailer_item_id']", "meta[name='sku']", "meta[property='product:sku']"]),
      gtin: getMetaValue($, ["meta[property='product:gtin13']", "meta[name='gtin']", "meta[name='ean']"]),
      mpn: getMetaValue($, ["meta[name='mpn']", "meta[property='product:mpn']"]),
      productId: getMetaValue($, ["meta[name='product-id']", "meta[property='product:id']"])
    }),
    source: "metadata"
  }];
}

// ==========================================
// VLOZENE JSON DATA
// ==========================================


function parseEmbeddedStockCount(rawValue) {
  if (typeof rawValue === "number") {
    return Number.isSafeInteger(rawValue) && rawValue >= 0 && rawValue <= 10000000
      ? rawValue
      : null;
  }
  if (typeof rawValue !== "string") return null;
  const value = rawValue.trim();
  if (!/^\d{1,7}(?:[,.]0+)?$/.test(value)) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// Read availability only from explicit product-level structured fields.
// Storefronts may encode the status as text, as a boolean, or both.
function extractEmbeddedAvailability(value) {
  const candidates = [
    ["storeStatus.message", value?.storeStatus?.message],
    ["availabilityText", value?.availabilityText],
    ["stockStatus", value?.stockStatus],
    ["availabilityStatus", value?.availabilityStatus],
    ["availability", typeof value?.availability === "string" ? value.availability : null],
    ["status", typeof value?.status === "string" ? value.status : null]
  ];

  for (const [field, raw] of candidates) {
    const text = cleanText(String(raw ?? ""), 180);
    if (!text || /^(?:true|false|null|undefined|0|1)$/i.test(text)) continue;
    const normalized = normalizeAvailabilityStatus(text);
    if (normalized) {
      return {
        availability: normalized.availability,
        availabilityText: normalized.availabilityText,
        availabilitySource: `embedded-json:${field}`
      };
    }
  }

  const flag = typeof value?.availability === "boolean"
    ? value.availability
    : typeof value?.storeStatus?.available === "boolean"
      ? value.storeStatus.available
      : typeof value?.isInStock === "boolean"
        ? value.isInStock
        : typeof value?.inStock === "boolean"
          ? value.inStock
          : null;

  if (flag != null) {
    return {
      availability: flag ? "InStock" : "OutOfStock",
      availabilityText: flag ? "In stock (structured boolean)" : "Out of stock (structured boolean)",
      availabilitySource: typeof value?.availability === "boolean"
        ? "embedded-json:availability-boolean"
        : typeof value?.storeStatus?.available === "boolean"
          ? "embedded-json:storeStatus.available"
          : typeof value?.isInStock === "boolean"
            ? "embedded-json:isInStock"
            : "embedded-json:inStock"
    };
  }

  return {};
}

// Store summaries and per-location quantities are separate from product
// physical weight. In particular, a store-unit field named "weight" must
// never be interpreted as the product's weight.
function extractEmbeddedStock(value) {
  const storeEntries = Array.isArray(value?.store)
    ? value.store.filter(item => item && typeof item === "object")
    : [];

  const summaries = storeEntries.map((entry, index) => ({
    index,
    count: parseEmbeddedStockCount(
      entry.count ?? entry.stockQuantity ?? entry.availableQuantity ?? entry.quantity
    ),
    unit: cleanText(String(entry.name || entry.unitName || entry.unit || ""), 60)
  })).filter(item => item.count != null);

  let stockQuantity = null;
  let stockQuantityUnit = null;
  let stockSource = null;

  // A single explicit summary row is unambiguous. Multiple rows may represent
  // different package units, so do not add them together without clear evidence.
  if (summaries.length === 1) {
    stockQuantity = summaries[0].count;
    stockQuantityUnit = summaries[0].unit || null;
    stockSource = `embedded-json:product.store[${summaries[0].index}].count`;
  } else if (summaries.length === 0) {
    const rootQuantity = parseEmbeddedStockCount(
      value?.stockQuantity ??
      value?.availableQuantity ??
      value?.quantityInStock ??
      value?.inventoryQuantity ??
      value?.inventoryLevel?.value
    );
    if (rootQuantity != null) {
      stockQuantity = rootQuantity;
      stockQuantityUnit = cleanText(String(
        value?.stockQuantityUnit || value?.quantityUnit || value?.unit || ""
      ), 60) || null;
      stockSource = "embedded-json:explicit-stock-quantity";
    }
  }

  const stockLocations = [];
  for (const entry of storeEntries) {
    const unit = cleanText(String(entry.name || entry.unitName || entry.unit || ""), 60);
    const locations = Array.isArray(entry.storeData) ? entry.storeData : [];
    for (const location of locations) {
      if (!location || typeof location !== "object") continue;
      const name = cleanText(String(
        location.storeName || location.name || location.locationName || location.store || ""
      ), 160);
      const quantity = parseEmbeddedStockCount(
        location.storeCount ?? location.count ?? location.stockQuantity ?? location.quantity
      );
      if (!name || quantity == null) continue;
      stockLocations.push({ name, quantity, ...(unit ? { unit } : {}) });
    }
  }

  return {
    ...(stockQuantity != null ? {
      stockQuantity,
      ...(stockQuantityUnit ? { stockQuantityUnit } : {}),
      stockSource
    } : {}),
    ...(stockLocations.length ? {
      stockLocations,
      stockLocationsSource: "embedded-json:product.store[].storeData[]"
    } : {})
  };
}

function findEmbeddedProducts(value, pageUrl, output = []) {
  if (!value || typeof value !== "object") {
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findEmbeddedProducts(item, pageUrl, output);
    }

    return output;
  }

  const name =
    value.name ||
    value.productName ||
    value.product_name ||
    value.title;

  const defaultPrice =
    value.defaultPrice &&
    typeof value.defaultPrice === "object"
      ? value.defaultPrice
      : null;
  const nestedPrice = value.price && typeof value.price === "object" ? value.price : null;

  const structuredPriceData = value.finalPriceData || value.priceData || value.standardPriceData || null;
  const rawPrice =
    defaultPrice?.price ??
    nestedPrice?.value ??
    value.product_final_price ??
    value.product_base_price ??
    value.price ??
    value.finalPrice ??
    value.salePrice ??
    value.currentPrice ??
    value.finalPriceData?.price ??
    value.priceData?.price ??
    value.standardPriceData?.price;

  const price = parsePrice(rawPrice);
  const typeText = Array.isArray(value["@type"])
    ? value["@type"].join(" ")
    : String(value["@type"] || "");
  const explicitProductType = /(?:^|\s|\/)Product(?:$|\s)/i.test(typeText);
  const hasProductIdentifier = Boolean(
    value.sku || value.partNo || value.part_no || value.productCode || value.product_code ||
    value.manufacturerCode || value.manufacturer_code || value.articleCode || value.article_code ||
    value.gtin || value.ean || value.barcode || value.productId || value.product_id ||
    (value.id && (value.product_variants || value.product_images || value.categories || value.attributes || value.detailedParameters))
  );
  const hasOffer = Boolean(value.offers && getOfferPrice(value.offers));
  const hasCurrency = Boolean(normalizeCurrency(
    defaultPrice?.currencyCode ||
    defaultPrice?.currency ||
    nestedPrice?.currency ||
    structuredPriceData?.currencyCode ||
    structuredPriceData?.currency ||
    value.priceCurrency ||
    value.currency
  ));
  const explicitProductUrl = typeof (value.url || value.link) === "string" &&
    /(?:^|\/)(?:p|product|produkt|item|dp)\//i.test(value.url || value.link);
  const hasProductImage = Boolean(
    value.image || value.image_url || value.images?.length || value.mainImage || value.product_images?.length
  );

  // Embedded state objects often contain technical attributes with their own
  // `name`, `id` and numeric `value`/`price`. An `id` by itself is not proof
  // that an object is a product. Require a product-specific signal so values
  // such as energy consumption (e.g. 66 kWh/100 cycles) cannot become prices.
  const productEvidence =
    explicitProductType ||
    hasProductIdentifier ||
    hasOffer ||
    (hasCurrency && (hasProductImage || explicitProductUrl || Boolean(defaultPrice)));

  const productLike =
    typeof name === "string" &&
    name.trim().length >= 2 &&
    isLikelyRealProductName(name) &&
    price != null &&
    productEvidence;

  if (productLike) {
    let productUrl = value.url || value.link || pageUrl;

    try {
      productUrl = new URL(productUrl, pageUrl).href;
    } catch {
      productUrl = pageUrl;
    }

    const rawImage =
      value.image?.url ||
      value.image ||
      value.image_url ||
      value.images?.[0] ||
      value.product_images?.[0]?.url ||
      value.mainImage?.url ||
      null;

    let image = null;

    if (typeof rawImage === "string") {
      try {
        image = new URL(rawImage, pageUrl).href;
      } catch {
        image = null;
      }
    }

    output.push({
      name: cleanText(name, 300),
      price,
      priceExtractionEvidence: { method: "embedded-json", rawPrice: rawPrice == null ? null : String(rawPrice), currency: normalizeCurrency(defaultPrice?.currencyCode || defaultPrice?.currency || nestedPrice?.currency || structuredPriceData?.currencyCode ||
    structuredPriceData?.currency || value.priceCurrency || value.currency) },
      currency: normalizeCurrency(
        defaultPrice?.currencyCode ||
        defaultPrice?.currency ||
        nestedPrice?.currency ||
        structuredPriceData?.currencyCode ||
    structuredPriceData?.currency ||
        value.priceCurrency ||
        value.currency
      ),
      ...extractEmbeddedAvailability(value),
      ...extractEmbeddedStock(value),
      unit: extractStructuredUnit(value, defaultPrice),
      ...extractPackageMeasure(value, defaultPrice),
      ...extractPhysicalSpecsFromStructured(value, defaultPrice),
      productAttributes: extractProductAttributesFromStructured(value, defaultPrice),
      url: productUrl,
      image,
      ...extractProductIdentifiers(value),
      source: "embedded-json"
    });
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");

    // These branches describe a product; they are not independent products.
    // Do not recursively interpret their numeric attributes as prices.
    const isTechnicalBranch =
      /(?:specification|attribute|feature|parameter|technical|characteristic|energy_label|energy_consumption|energy_class|properties)/i.test(normalizedKey);

    if (
      ["offers", "image", "images", "brand", "seller", "product_variants", "product_images"].includes(normalizedKey) ||
      isTechnicalBranch
    ) {
      continue;
    }

    if (child && typeof child === "object") {
      findEmbeddedProducts(child, pageUrl, output);
    }
  }

  return output;
}
  

function extractProductsFromAppData(data, pageUrl) {
  if (!data || typeof data !== "object") return [];
  const product = data.product || data.productData || data.product_data || null;
  if (!product || typeof product !== "object") return [];

  const priceObject = product.price && typeof product.price === "object" ? product.price : {};
  const rawPrice = priceObject.value ?? product.product_final_price ?? product.product_base_price ?? product.final_price ?? product.price;
  const price = parsePrice(rawPrice);
  const currency = normalizeCurrency(priceObject.currency || product.priceCurrency || product.currency || data.currency || "EUR");
  const name = cleanProductTitle(product.name || product.product_name || product.productName || product.title || "");
  if (!name || !isLikelyRealProductName(name) || price == null || !currency) return [];

  let productUrl = product.url || product.product_url || pageUrl;
  try { productUrl = new URL(productUrl, pageUrl).href; } catch { productUrl = pageUrl; }
  const rawImage = product.image_url || product.image?.url || product.image || product.product_images?.[0]?.url || null;
  let image = null;
  if (typeof rawImage === "string") { try { image = new URL(rawImage, pageUrl).href; } catch {} }

  const rawVariants = Array.isArray(product.product_variants) ? product.product_variants : [];
  const optionMap = new Map();
  for (const variant of rawVariants) {
    if (!variant || typeof variant !== "object") continue;
    const attributes = Array.isArray(variant.attributes) ? variant.attributes : [];
    for (const attribute of attributes) {
      const label = cleanText(attribute?.name || attribute?.label || attribute?.code || "", 100);
      let value = cleanText(attribute?.value || attribute?.label || "", 120);
      if (!label || !value) continue;
      // Translate common flavour values while preserving all unknown source values.
      const normalized = value.toLowerCase();
      if (normalized === "coffee" || normalized === "kava") value = "Káva";
      else if (normalized === "chocolate" || normalized === "cokolada" || normalized === "čokoláda") value = "Čokoláda";
      const key = `${label.toLowerCase()}|${value.toLowerCase()}`;
      if (!optionMap.has(key)) {
        let variantUrl = variant.url || variant.product_url || null;
        if (variantUrl) { try { variantUrl = new URL(variantUrl, pageUrl).href; } catch { variantUrl = null; } }
        optionMap.set(key, {
          label,
          value,
          selected: normalizeProductUrl(variantUrl || "") === normalizeProductUrl(pageUrl),
          source: "embedded-json:product-variant",
          ...(variantUrl ? { url: variantUrl } : {}),
          ...(variant.id != null ? { variantId: String(variant.id) } : {}),
          ...(variant.sku ? { sku: String(variant.sku) } : {})
        });
      }
    }
  }
  const variantOptions = [...optionMap.values()];

  const productRecord = {
    name,
    price,
    priceExtractionEvidence: { method: "embedded-app-data", rawPrice: rawPrice == null ? null : String(rawPrice), currency },
    packagePrice: price,
    currency,
    priceType: "bežná predajná cena",
    availability: product.available_in_stock === true || product.is_available === true ? "InStock" : null,
    unit: "neuvedené",
    ...extractPhysicalSpecsFromStructured(product, priceObject),
    productAttributes: extractProductAttributesFromStructured(product, priceObject),
    url: productUrl,
    image,
    ...(product.sku || product.product_sku ? { sku: product.sku || product.product_sku } : {}),
    ...(product.id != null || product.product_id != null ? { productId: String(product.id ?? product.product_id) } : {}),
    ...(product.brand?.name || product.brand ? { brand: product.brand?.name || product.brand } : {}),
    ...(variantOptions.length >= 2 ? { variantOptions, variantCount: variantOptions.length } : {}),
    source: "embedded-app-data"
  };
  return [productRecord];
}

function extractProductsFromEmbeddedJson($, pageUrl) {
  const products = [];

  function extractJsonObject(text, startIndex) {
    const start = text.indexOf("{", startIndex);

    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const char = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;

        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }

    return null;
  }

  const stateNames = [
    "__INITIAL_STATE__",
    "__PRELOADED_STATE__",
    "__NEXT_DATA__",
    "__ARTICLE_DETAIL_APOLLO_STATE__",
    "__APP_DATA__"
  ];

  $("script").each((_, element) => {
    const scriptNode = $(element);
    const childText = Array.isArray(element.children)
      ? element.children.map(child => typeof child.data === "string" ? child.data : "").join("")
      : "";
    const raw = String(scriptNode.contents().text() || childText || scriptNode.html() || "").trim();

    if (!raw || raw.length > MAX_BYTES) return;

    const parsed = parseJsonSafe(raw);

    if (parsed) {
      findEmbeddedProducts(parsed, pageUrl, products);
      return;
    }

    for (const stateName of stateNames) {
      const marker = "window." + stateName;
      const markerIndex = raw.indexOf(marker);

      if (markerIndex === -1) continue;

      const jsonText = extractJsonObject(
        raw,
        markerIndex + marker.length
      );

      if (!jsonText) continue;

      const embedded = parseJsonSafe(jsonText);

      if (embedded) {
        if (stateName === "__APP_DATA__") {
          products.push(...extractProductsFromAppData(embedded, pageUrl));
        }
        findEmbeddedProducts(
          embedded,
          pageUrl,
          products
        );
      }
    }
  });

  return products;
}


// ==========================================
// HTML PRODUKTOVE KARTY
// ==========================================

// Reject common non-catalog recommendation/sidebar blocks. This is deliberately
// generic and based on semantic markers, not on any single shop's CSS.
function isExcludedProductArea($, element) {
  let node = $(element);
  for (let depth = 0; depth < 8 && node.length; depth++) {
    const marker = [node.attr("class"), node.attr("id"), node.attr("data-testid"),
      node.attr("aria-label"), node.attr("role")].filter(Boolean).join(" ").toLowerCase();
    if (/(?:recommend|related|similar|suggest|popular|top[-_ ]?10|best[-_ ]?seller|bestseller|sidebar|side[-_ ]?bar|cross[-_ ]?sell|upsell|promo|advert|widget)/i.test(marker)) return true;
    // Inspect only the section heading itself or its direct heading child.
    // Searching every descendant heading is unsafe: a page-level wrapper can
    // contain a recommendation heading somewhere below it and would then
    // incorrectly exclude the entire main product listing.
    const ownTag = String(node[0]?.tagName || "").toLowerCase();
    const ownHeading = /^(?:h1|h2|h3|h4|h5)$/.test(ownTag) ? node.text() : "";
    const directHeading = node.children("h1,h2,h3,h4,h5").first().text();
    const heading = `${ownHeading} ${directHeading}`.toLowerCase();
    if (/(?:top\s*10|top\s*produk|odpor[uú]čan|s[uú]visiaci|podobn[eé]|najpred[aá]van)/i.test(heading)) return true;
    node = node.parent();
  }
  return false;
}

function isExcludedProductAreaWithin($, element, scope) {
  const stopNode = $(scope).get(0);
  let node = $(element);
  for (let depth = 0; depth < 10 && node.length; depth++) {
    const marker = [node.attr("class"), node.attr("id"), node.attr("data-testid"),
      node.attr("aria-label"), node.attr("role")].filter(Boolean).join(" ").toLowerCase();
    if (/(?:recommend|related|similar|suggest|popular|top[-_ ]?10|best[-_ ]?seller|bestseller|sidebar|side[-_ ]?bar|cross[-_ ]?sell|upsell|promo|advert|widget)/i.test(marker)) return true;
    const ownTag = String(node[0]?.tagName || "").toLowerCase();
    const ownHeading = /^(?:h1|h2|h3|h4|h5)$/.test(ownTag) ? node.text() : "";
    const directHeading = node.children("h1,h2,h3,h4,h5").first().text();
    const heading = `${ownHeading} ${directHeading}`.toLowerCase();
    if (/(?:top\s*10|top\s*produk|odpor[uú]čan|s[uú]visiaci|podobn[eé]|najpred[aá]van)/i.test(heading)) return true;
    if (stopNode && node.get(0) === stopNode) break;
    node = node.parent();
  }
  return false;
}

function isLikelyProductContainer($, element) {
  const node = $(element);

  const marker = [
    node.attr("class"),
    node.attr("id"),
    node.attr("data-testid"),
    node.attr("data-product"),
    node.attr("itemtype"),
    node.attr("data-testid")
  ].filter(Boolean).join(" ").toLowerCase();

  if (/product|produkt|article|item-card|product-card|product-tile|catalog-item|catalogue-item/.test(marker) ||
      /schema\.org\/Product/i.test(marker) || node.attr("data-product-id") || node.attr("data-sku")) {
    return true;
  }

  // Fallback for stores with opaque/generated CSS classes: only accept a
  // compact element that contains a real title, an image and a currency price.
  const text = cleanText(node.text(), 2200);
  const hasImage = node.find("img").length > 0;
  const hasTitle = node.find("h1, h2, h3, h4, [itemprop='name'], a[title], [class*='title'], [class*='name']").length > 0;
  const hasPrice = node.find("[itemprop='price'], [data-price], [class*='price'], [class*='Price']").length > 0 ||
    extractPriceFromProductCardText(text) != null;

  return text.length >= 8 && text.length <= 1800 && hasImage && hasTitle && hasPrice;
}

function extractCardName($, container) {
  const selectors = [
    "[itemprop='name']",
    ".product-title",
    ".product-name",
    ".product__title",
    ".product-card__title",
    ".name",
    "h2",
    "h3",
    "h4",
    "a[title]"
  ];

  for (const selector of selectors) {
    const element = container.find(selector).first();

    const value =
      element.attr("content") ||
      element.attr("title") ||
      element.attr("data-name") ||
      element.text();

    const name = cleanText(value, 300);

    if (
      name &&
      name.length >= 3 &&
      name.length <= 250
    ) {
      return name;
    }
  }

  return null;
}

function extractCurrencyPriceCandidates(value) {
  const text = decodeEntities(String(value || ""))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ");
  // Podpora oboch beznych zapisov: "1 299,00 €" aj "€ 1 299,00".
  // Pôvodná verzia poznala iba menu za sumou, preto na niektorých e-shopoch
  // nevedela nájsť cenu ani vtedy, keď bola viditeľná priamo v karte produktu.
  const number = String.raw`(?:\d{1,3}(?:[ .\u00a0]\d{3})+(?:[,.]\d{1,2})?|\d+(?:[,.]\d{1,2})?)`;
  const currency = String.raw`(?:EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$)`;
  const pattern = new RegExp(String.raw`(?:(${currency})\s*(${number})|(${number})\s*(${currency}))`, "gi");
  const found = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const rawPrice = match[2] || match[3];
    const rawCurrency = match[1] || match[4];
    const price = parsePrice(rawPrice);
    const normalizedCurrency = normalizeCurrency(rawCurrency);
    if (price != null && normalizedCurrency) found.push({ price, currency: normalizedCurrency });
  }
  return found;
}

export function selectPrimaryCurrencyPrice(value) {
  const text = decodeEntities(String(value || ""))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const number = String.raw`(?:\d{1,3}(?:[ .\u00a0]\d{3})+(?:[,.]\d{1,2})?|\d+(?:[,.]\d{1,2})?)`;
  const currency = String.raw`(?:EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$)`;
  const unit = String.raw`(?:kg|kgm|g|grm|l|ltr|ml|ks|kus|kusy|kusov|pc|pcs|m²|m2|m³|m3|balenie|bal|capsules?|kaps(?:ula|uly|ulu|ulov|úl)|kapsul|kap(?:s)?\.?|tablets?|tablet(?:a|y|u|iet)?|servings?|dávk(?:a|y|u|ov))`;
  const pattern = new RegExp(String.raw`(?:(${currency})\s*(${number})|(${number})\s*(${currency}))`, "gi");
  const candidates = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const rawPrice = match[2] || match[3];
    const rawCurrency = match[1] || match[4];
    const price = parsePrice(rawPrice);
    const normalizedCurrency = normalizeCurrency(rawCurrency);
    if (price == null || !normalizedCurrency) continue;
    const before = text.slice(Math.max(0, match.index - 90), match.index).toLowerCase();
    const after = text.slice(pattern.lastIndex, Math.min(text.length, pattern.lastIndex + 90)).toLowerCase();
    const couponPrice = /(?:s\s*(?:kup[oó]nom|k[oó]dom)|kup[oó]n(?:ov[aá])?\s*cena|zadajte\s*k[oó]d|pri\s*k[oó]de|promo\s*code|with\s*(?:coupon|code))[^€£$]{0,55}$/.test(before) ||
      /^\s*(?:s\s*(?:kup[oó]nom|k[oó]dom)|kup[oó]n(?:ov[aá])?\s*cena|po\s*zadan[ií]\s*k[oó]du)/.test(after);
    const referencePrice = /p[oô]vodn[aá]\s+cena\s*:?\s*$/.test(before) ||
      /^(?:\s*(?:p[oô]vodn[aá]\s+cena|before|was)\b)/.test(after) ||
      /^\s*bez\s*dph/.test(after);
    const afterUnit = after.match(new RegExp(String.raw`^\s*(?:\/|za\s+|per\s+)\s*(${unit})\b`, "i"));
    const beforeUnit = before.match(new RegExp(String.raw`\b(?:za|per)\s+(${unit})\s*$`, "i"));
    const unitReferencePrice = Boolean(afterUnit || beforeUnit);
    const unitPriceUnit = normalizeProductUnit(afterUnit?.[1] || beforeUnit?.[1] || "");
    candidates.push({ price, currency: normalizedCurrency, index: match.index, referencePrice, couponPrice, unitReferencePrice, unitPriceUnit });
  }
  const hasReferencePrice = candidates.some(item => item.referencePrice);
  const unitPriceCandidates = candidates.filter(item => item.unitReferencePrice && !item.couponPrice);
  const ordinary = candidates.filter(item => !item.couponPrice && !item.referencePrice && !item.unitReferencePrice);
  const pool = ordinary;
  if (!pool.length) return null;
  const unitCandidate = unitPriceCandidates[unitPriceCandidates.length - 1] || null;
  return {
    ...pool[pool.length - 1],
    hasReferencePrice,
    couponPriceDetected: candidates.some(item => item.couponPrice),
    unitPrice: unitCandidate?.price ?? null,
    unitPriceUnit: unitCandidate?.unitPriceUnit || null,
    priceBasis: unitCandidate ? "package-and-unit-reference" : "package-price"
  };
}

function extractCardPriceDetails($, container) {
  const selectors = [
    "[itemprop='price']",
    "[data-testid*='price-current' i]",
    ".price-current", ".current-price", "[class*='price-current' i]",
    "[class*='price-default' i]", ".product-card__price-new",
    ".product-price", ".product__price", ".product-card__price",
    ".price-value", "[data-price]", ".price"
  ];

  const nonSellingMarker = /(?:old|original|was|unit|per-unit|reference|strike|coupon|voucher|shipping|delivery|installment)/i;
  const cardText = normalizeWhitespace(container.text());

  for (const selector of selectors) {
    const elements = container.find(selector).toArray();
    for (const node of elements) {
      if (isHiddenProductPriceNode($, node) || isExcludedProductArea($, node)) continue;
      const element = $(node);
      const marker = [element.attr("class"), element.attr("id"), element.attr("data-testid"), element.attr("aria-label")]
        .filter(Boolean).join(" ").toLowerCase();
      if (nonSellingMarker.test(marker)) continue;

      const raw = element.attr("content") || element.attr("data-price") || element.attr("value") || element.text();
      if (!raw || !String(raw).trim()) continue;

      // A currency-qualified value inside a semantic selling-price element is
      // stronger evidence than a number assembled from the entire card text.
      // The latter can contain model numbers, weights, dimensions or other
      // metadata adjacent to the visible price.
      const direct = selectPrimaryCurrencyPrice(raw);
      if (direct && direct.currency && !direct.unitReferencePrice) {
        return {
          ...direct,
          evidence: {
            method: "explicit-price-element",
            selector,
            marker: marker.slice(0, 160),
            rawValue: String(raw).slice(0, 240),
            scopeText: normalizeWhitespace(element.parent().text()).slice(0, 320)
          }
        };
      }

      // Some shops split amount and currency into adjacent elements. In that
      // case accept the closest parent only when its currency-qualified price
      // exactly matches the numeric amount stored on the semantic price node.
      const bareAmount = parsePrice(raw);
      if (bareAmount != null && !/(?:EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$)/i.test(String(raw))) {
        let scope = element.parent();
        for (let depth = 0; depth < 3 && scope.length; depth++, scope = scope.parent()) {
          const scopeText = normalizeWhitespace(scope.text());
          if (!scopeText || scopeText.length > 700) continue;
          const scoped = selectPrimaryCurrencyPrice(scopeText);
          if (scoped && Math.abs(scoped.price - bareAmount) <= 0.01 && scoped.currency) {
            return {
              ...scoped,
              evidence: {
                method: "semantic-price-amount-plus-neighbour-currency",
                selector,
                marker: marker.slice(0, 160),
                rawValue: String(raw).slice(0, 240),
                scopeText: scopeText.slice(0, 320)
              }
            };
          }
        }
      }
    }
  }

  // Last resort for stores without semantic price elements. Only values that
  // explicitly include a recognized currency can be selected; bare numbers,
  // weights and technical attributes are never promoted to a selling price.
  const fallback = selectPrimaryCurrencyPrice(cardText);
  return fallback ? {
    ...fallback,
    evidence: {
      method: "currency-qualified-card-text-fallback",
      selector: null,
      marker: null,
      rawValue: cardText.slice(0, 320),
      scopeText: cardText.slice(0, 320)
    }
  } : null;
}

function extractCardPrice($, container) {
  return extractCardPriceDetails($, container)?.price ?? null;
}

function extractPriceFromProductCardText(value) {
  return selectPrimaryCurrencyPrice(value);
}

function isGenericProductLinkLabel(value) {
  const text = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[.!…]+$/g, "")
    .trim();

  // Odkazy na akcie v karte (Kúpiť, Do košíka, Porovnať...) nie sú
  // ďalšie produktové URL. Ak sa započítajú, kontrola viacerých cieľov
  // nesprávne zahodí celú kartu produktu.
  return !text || /^(?:detail|zobraziť\s+detail|zobrazit\s+detail|viac|viac\s+info|more|view|view\s+details|product|produkt|image|obrázok|obrazok|kúpiť|kupit|kúpiť\s+teraz|kupit\s+teraz|buy|buy\s+now|add\s+to\s+cart|do\s+košíka|do\s+kosika|vložiť\s+do\s+košíka|vlozit\s+do\s+kosika|porovnať|porovnat|compare|obľúbené|oblubene|wishlist|quick\s*view|rýchly\s+náhľad|rychly\s+nahled|zdieľať|zdielat|share)$/i.test(text);
}

function extractLinkedProductCardProducts($, pageUrl, existingProducts = []) {
  const products = [];
  const existingUrls = new Set(
    existingProducts.map(item => {
      try { return new URL(item.url, pageUrl).href; } catch { return item.url; }
    })
  );

  $("a[href]").each((_, element) => {
    if (products.length >= MAX_PRODUCTS_PER_PAGE) return;
    if (isExcludedProductArea($, element)) return;

    const anchor = $(element);
    const href = anchor.attr("href");
    let productUrl;

    try {
      productUrl = new URL(href, pageUrl);
    } catch {
      return;
    }

    // Do not require a platform-specific /product/ or /p/ path. Many stores
    // use opaque or SEO-slug detail URLs. The URL is accepted only after the
    // ancestor-card checks below find a compact card with a real name and price.
    const pathParts = productUrl.pathname.split("/").filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1] || "";
    if (!lastPart || /^(?:cart|kosik|checkout|account|login|register|search|wishlist|compare|kontakt|contact|blog|news|category|categories|kategoria|znacka|brand)$/i.test(lastPart)) {
      return;
    }
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|pdf|zip|css|js|xml)$/i.test(lastPart)) return;

    productUrl.hash = "";
    if (existingUrls.has(productUrl.href)) return;

    const image = anchor.find("img").first();
    const anchorName = cleanText(
      anchor.attr("title") ||
      anchor.attr("aria-label") ||
      anchor.text() ||
      image.attr("alt"),
      300
    );

    let best = null;
    let card = anchor;

    // Only accept the nearest compact card. A page-wide wrapper can contain
    // unrelated products/footer links and used to lend their price to this link.
    for (let depth = 0; depth < 8 && card.length; depth++) {
      const candidateText = cleanText(card.text(), 1800);
      const hasImage = card.find("img").length > 0;
      const titleElement = card.find(
        "h1, h2, h3, h4, [itemprop='name'], [class*='title'], [class*='name'], a[title]"
      ).first();
      const explicitTitle = cleanText(
        titleElement.attr("content") || titleElement.attr("title") || titleElement.text(),
        300
      );
      // Preserve stores where the product name is plain anchor text without
      // a heading/title attribute; the strict name and card checks still apply.
      const titleText = explicitTitle || (
        isLikelyRealProductName(anchorName) && !isGenericProductLinkLabel(anchorName)
          ? anchorName
          : ""
      );
      const distinctTitles = new Set();
      card.find("h1, h2, h3, h4, [itemprop='name'], [class*='title'], [class*='name']").each((_, titleNode) => {
        const candidateName = cleanText($(titleNode).attr("content") || $(titleNode).text(), 300);
        if (candidateName && isLikelyRealProductName(candidateName)) {
          distinctTitles.add(normalizeProductName(candidateName));
        }
      });

      // A real card normally has one unique product destination, even if its
      // image, title and detail button repeat that same href.
      const productDestinations = new Set();
      card.find("a[href]").each((_, linkNode) => {
        const link = $(linkNode);
        let destination;
        try {
          const parsedDestination = new URL(link.attr("href"), pageUrl);
          parsedDestination.search = "";
          parsedDestination.hash = "";
          destination = normalizeProductUrl(parsedDestination.href);
        } catch { return; }
        const linkLabel = cleanText(
          link.attr("title") || link.attr("aria-label") || link.text() || link.find("img").first().attr("alt"),
          300
        );
        if (destination && isLikelyRealProductName(linkLabel) && !isGenericProductLinkLabel(linkLabel)) {
          productDestinations.add(destination);
        }
      });

      if (
        candidateText && candidateText.length <= 700 && hasImage &&
        titleText && isLikelyRealProductName(titleText) &&
        distinctTitles.size <= 1 && productDestinations.size <= 1 &&
        /(?:EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$)/i.test(candidateText)
      ) {
        const explicitCardPrice = extractCardPriceDetails($, card);
        const selectedTextPrice = selectPrimaryCurrencyPrice(candidateText);
        const parsed = explicitCardPrice || selectedTextPrice;

        if (parsed && titleText.length >= 3 && titleText.length <= 250 &&
            !isGenericProductLinkLabel(titleText)) {
          best = { name: titleText, parsed, cardText: candidateText, card };
          break;
        }
      }

      card = card.parent();
    }

    if (!best) return;

    // Ak má karta pomenovaný odkaz na produkt, nedovoľ spárovať cenu/názov
    // s inou URL (napr. odkazom na susedný variant).
    const matchingDestinations = new Set();
    best.card.find("a[href]").each((_, linkNode) => {
      const link = $(linkNode);
      const label = cleanText(
        link.attr("title") || link.attr("aria-label") || link.text() ||
        link.find("img").first().attr("alt"),
        300
      );
      if (!label || normalizeProductName(label) !== normalizeProductName(best.name)) return;
      try {
        matchingDestinations.add(normalizeProductUrl(new URL(link.attr("href"), pageUrl).href));
      } catch {}
    });
    if (matchingDestinations.size > 0 && !matchingDestinations.has(normalizeProductUrl(productUrl.href))) return;

    const rawImage =
      best.card.find("img").first().attr("src") ||
      best.card.find("img").first().attr("data-src") ||
      best.card.find("img").first().attr("data-lazy-src");

    let imageUrl = null;
    if (rawImage) {
      try { imageUrl = new URL(rawImage, pageUrl).href; } catch { imageUrl = null; }
    }

    products.push({
      name: best.name,
      price: best.parsed.price,
      priceExtractionEvidence: best.parsed.evidence || {
        method: "linked-card-currency-text",
        rawValue: best.cardText.slice(0, 320)
      },
      currency: best.parsed.currency,
      priceType: best.parsed.hasReferencePrice ? "akciová cena bez kupónu" : "bežná predajná cena",
      couponPriceDetected: Boolean(best.parsed.couponPriceDetected),
      packagePrice: best.parsed.price,
      unitPrice: best.parsed.unitPrice ?? null,
      unitPriceUnit: best.parsed.unitPriceUnit || null,
      priceBasis: best.parsed.priceBasis || "package-price",
      availability: /na sklade|skladom|in stock/i.test(best.cardText) ? "InStock" : null,
      unit: extractUnitNearPrice($, best.card, best.parsed.price),
      ...extractPackageMeasureFromDom($, best.card),
      ...extractPhysicalSpecsFromDom($, best.card),
      url: productUrl.href,
      image: imageUrl,
      ...extractProductIdentifiers({
        sku: best.card.attr("data-sku") || best.card.find("[itemprop='sku'], [data-sku]").first().attr("content") || best.card.find("[itemprop='sku'], [data-sku]").first().attr("data-sku"),
        productId: best.card.attr("data-product-id") || best.card.attr("data-productid") || best.card.find("[data-product-id]").first().attr("data-product-id"),
        gtin: best.card.attr("data-gtin") || best.card.find("[itemprop='gtin13'], [itemprop='gtin']").first().attr("content"),
        mpn: best.card.find("[itemprop='mpn']").first().attr("content")
      }),
      source: "linked-product-card"
    });

    existingUrls.add(productUrl.href);
  });

  return products;
}

function hasMultipleProductDestinations($, container, pageUrl) {
  const destinations = new Set();
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return false; }
  // Early exit is critical for large listing wrappers: only two distinct
  // product destinations are needed to prove this is not a single-product card.
  container.find("a[href]").each((_, element) => {
    if (destinations.size > 1) return false;
    const anchor = $(element);
    const href = anchor.attr("href");
    if (!href) return;
    let parsed;
    try { parsed = new URL(href, pageUrl); } catch { return; }
    if (parsed.origin !== origin) return;
    const path = parsed.pathname.toLowerCase();
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|pdf|zip|css|js|xml)$/i.test(path)) return;
    if (/(?:cart|kosik|checkout|account|login|register|search|wishlist|compare|quick.?view|kontakt|contact|blog|news|category|categories|kategoria|znacka|brand|facebook|instagram|youtube)/i.test(path)) return;

    const labels = [
      anchor.attr("title"), anchor.attr("aria-label"), anchor.text(),
      anchor.find("img").first().attr("alt")
    ].map(value => cleanText(value, 300)).filter(Boolean);
    if (labels.some(label => isLikelyRealProductName(label) && !isGenericProductLinkLabel(label))) {
      parsed.search = "";
      parsed.hash = "";
      destinations.add(normalizeProductUrl(parsed.href));
      if (destinations.size > 1) return false;
    }
  });
  return destinations.size > 1;
}

// 4home category cards use article.products-list-item.product-thumbnail.
// The title, image, current price and ecommerce JSON are not in the older
// product-card__* structure, so extract from the real 4home markup directly.
function extract4homeCardProducts($, pageUrl) {
  const cards = $(
    "article.products-list-item.product-thumbnail, article.product-thumbnail, .product-thumbnail, article.product-card, .product-card, article[data-ax-catalog-code]"
  );
  const products = [];
  const seen = new Set();
  const origin = new URL(pageUrl).origin;

  cards.each((_, element) => {
    if (products.length >= MAX_PRODUCTS_PER_PAGE) return false;
    const card = $(element);
    const cardText = cleanText(card.text(), 4000);
    const nameNode = card.find(
      ".product-thumbnail__name, .product-card__title a, .product-card__title, h2, h3, h4, [itemprop='name']"
    ).first();
    const name = cleanText(
      card.attr("data-name") || nameNode.attr("title") || nameNode.text(),
      300
    );
    if (!name || !isLikelyRealProductName(name)) return;

    // 4home embeds reliable product data on the add-to-cart element. It is
    // used only as a fallback; visible gross price is preferred when present.
    let productInfo = null;
    const productInfoRaw = card.find("[data-productinfo]").first().attr("data-productinfo");
    if (productInfoRaw) {
      try {
        const parsed = JSON.parse(productInfoRaw);
        if (parsed && typeof parsed === "object") productInfo = parsed;
      } catch { /* malformed tracking JSON must not break card extraction */ }
    }

    const priceNode = card.find(
      ".product-card__price-new, .product-thumbnail__actual-price, .product-thumbnail-price-wrap .regular-price, .product-card__price, [itemprop='price'], [data-price], .price-current, .current-price, .price"
    ).first();
    const visiblePriceText = cleanText(priceNode.text() || cardText, 500);

    // Current 4home template: the normal (non-coupon) gross price is stored
    // in data-price, while the visible text may show only the coupon price.
    // Prefer this explicit data value so a coupon cannot replace the normal
    // catalog price or cause the whole card to be rejected.
    const rawDataPrice = priceNode.attr("data-price") || card.attr("data-price") || "";
    const numericDataPrice = parsePrice(rawDataPrice);
    let priceCandidate = Number.isFinite(numericDataPrice) && numericDataPrice > 0
      ? {
          price: numericDataPrice,
          currency: "EUR",
          hasReferencePrice: false,
          couponPriceDetected: /s\s*(?:kup[oó]nom|k[oó]dom)|kup[oó]n/i.test(cardText) || card.find(".cupon-info").length > 0
        }
      : selectPrimaryCurrencyPrice(visiblePriceText) || selectPrimaryCurrencyPrice(cardText);

    if (!priceCandidate && productInfo) {
      const grossPrice = Number(productInfo.priceData?.price);
      const fallbackPrice = Number.isFinite(grossPrice) && grossPrice > 0
        ? grossPrice
        : Number(productInfo.price);
      if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
        priceCandidate = {
          price: fallbackPrice,
          currency: "EUR",
          hasReferencePrice: false,
          couponPriceDetected: /s\s*(?:kup[oó]nom|k[oó]dom)|kup[oó]n/i.test(cardText)
        };
      }
    }
    if (!priceCandidate || !Number.isFinite(priceCandidate.price) || priceCandidate.price <= 0) return;

    const productLink =
      priceNode.attr("data-url") ||
      card.find("a.product-card__title[href], a.product-thumbnail__link[href]").first().attr("href") ||
      card.find(".product-thumbnail__name").first().closest("a[href]").attr("href") ||
      card.find("[data-parenturl]").first().attr("data-parenturl") ||
      card.find("a.product-card__link[href], .product-card__title a[href]").first().attr("href") ||
      card.find("a[href][title]").filter((__, anchorNode) => {
        const anchor = $(anchorNode);
        return normalizeProductName(anchor.attr("title")) === normalizeProductName(name);
      }).first().attr("href");
    if (!productLink) return;

    let productUrl;
    try {
      const parsed = new URL(productLink, pageUrl);
      if (parsed.origin !== origin || parsed.pathname === new URL(pageUrl).pathname) return;
      parsed.hash = "";
      productUrl = parsed.href;
    } catch {
      return;
    }

    const key = `${normalizeProductUrl(productUrl)}|${normalizeProductName(name)}`;
    if (seen.has(key)) return;
    seen.add(key);

    const imageNode = card.find(".product-thumbnail__photo, .product-card__img-wrapper img, img").first();
    const rawImage = imageNode.attr("src") || imageNode.attr("data-src") ||
      imageNode.attr("data-lazy-src") || imageNode.attr("data-original") || imageNode.attr("data-hover-src");
    let image = null;
    if (rawImage) {
      try { image = new URL(rawImage, pageUrl).href; } catch { image = null; }
    }

    const stockStatus = cleanText(
      productInfo?.available || card.attr("data-stock-status") || card.find(".product-thumbnail__availability, .product-card__stock-status").text(),
      100
    );
    const sizeLabelNode = card.find(".product-thumbnail-size-label").first();
    const sizeLabel = cleanText(`${sizeLabelNode.attr("title") || ""} ${sizeLabelNode.text()}`, 200);
    const variantCountSignal = /(?:\d+\s*(?:veľkost[ií]|velkost[ií]|sizes?|variant(?:y|ov)?)|(?:veľkost[ií]|velkost[ií]|sizes?|variant(?:y|ov)?)\s*\(?\s*\d+)/i.test(`${sizeLabel} ${cardText}`);
    const startsAtPrice = /^od\s+/i.test(visiblePriceText) || /\bod\s+\d+[,.]\d{2}\s*(?:€|EUR)/i.test(cardText);
    const trackingVariant = cleanText(productInfo?.variant || "", 100);

    products.push({
      name,
      price: priceCandidate.price,
      currency: priceCandidate.currency || "EUR",
      priceType: priceCandidate.hasReferencePrice ? "akciová cena bez kupónu" : "bežná predajná cena",
      couponPriceDetected: Boolean(priceCandidate.couponPriceDetected),
      packagePrice: priceCandidate.price,
      unitPrice: priceCandidate.unitPrice ?? null,
      unitPriceUnit: priceCandidate.unitPriceUnit || null,
      priceBasis: priceCandidate.priceBasis || "package-price",
      availability: /onstore|na sklade|skladom|in stock/i.test(`${stockStatus} ${cardText}`) ? "InStock" : stockStatus || null,
      unit: extractUnitNearPrice($, card, priceCandidate.price),
      ...extractPackageMeasureFromDom($, card),
      url: productUrl,
      image,
      source: "4home-card-v332",
      productId: priceNode.attr("data-product-id") || card.attr("data-ax-catalog-code") || card.attr("data-product-id") || productInfo?.id || null,
      sku: productInfo?.sku || card.attr("data-sku") || null,
      listedVariant: trackingVariant || null,
      variantDiscoveryCandidate: startsAtPrice || variantCountSignal
    });
  });

  return products;
}

function extractHtmlCardProducts($, pageUrl) {
  const products = [];

  const selectors = [
    "[itemtype*='schema.org/Product']",
    "[class*='product-card']",
    "[class*='product-item']",
    "[class*='product-tile']",
    "[class*='product-box']",
    "[data-product-id]",
    "[data-sku]",
    "[data-testid*='product' i]",
    "[class*='catalog-item']",
    "[class*='catalogue-item']",
    "[class*='product']",
    "[class*='item-card']",
    "[class*='tile']",
    "[role='listitem']",
    "article"
  ];

  const candidates = new Set();

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      candidates.add(element);
    });
  }

  for (const element of candidates) {
    if (isExcludedProductArea($, element)) continue;
    if (!isLikelyProductContainer($, element)) {
      continue;
    }

    const container = $(element);

    // Do not treat a product-list/grid wrapper as one product. That used to
    // pair the first title in the wrapper with the last price in the wrapper.
    if (hasMultipleProductDestinations($, container, pageUrl)) continue;

    const name = extractCardName($, container);
    const priceDetails = extractCardPriceDetails($, container);
    const price = priceDetails?.price ?? null;

    if (!name || price == null) {
      continue;
    }

    const titleSelectors = [
      "[itemprop='name']", ".product-title", ".product-name",
      ".product__title", ".product-card__title", ".name", "h2", "h3", "h4", "a[title]"
    ];
    let titleNode = null;
    for (const selector of titleSelectors) {
      const candidate = container.find(selector).first();
      const candidateText = cleanText(
        candidate.attr("content") || candidate.attr("title") || candidate.text(),
        300
      );
      if (candidateText && normalizeProductName(candidateText) === normalizeProductName(name)) {
        titleNode = candidate;
        break;
      }
    }

    // Uprednostni URL priamo naviazanú na názov produktu, nie prvý odkaz v karte.
    let link = titleNode?.attr("href") || titleNode?.closest("a[href]").attr("href") || null;
    if (!link) {
      container.find("a[href]").each((_, anchorNode) => {
        if (link) return;
        const anchor = $(anchorNode);
        const label = cleanText(
          anchor.attr("title") || anchor.attr("aria-label") || anchor.text() ||
          anchor.find("img").first().attr("alt"),
          300
        );
        if (label && normalizeProductName(label) === normalizeProductName(name)) {
          link = anchor.attr("href");
        }
      });
    }
    if (!link) {
      const imageAnchor = container.find("a[href]").filter((_, anchorNode) =>
        $(anchorNode).find("img").length > 0
      ).first();
      link = imageAnchor.attr("href") || null;
    }
    // Jedna neúplná karta nesmie ukončiť extrakciu celej stránky.
    if (!link) continue;

    let productUrl;
    try {
      const parsedProductUrl = new URL(link, pageUrl);
      if (parsedProductUrl.origin !== new URL(pageUrl).origin) continue;
      productUrl = parsedProductUrl.href;
    } catch {
      continue;
    }

    const rawImage =
      container.find("img").first().attr("src") ||
      container.find("img").first().attr("data-src") ||
      container.find("img").first().attr("data-lazy-src");

    let image = null;

    if (rawImage) {
      try {
        image = new URL(rawImage, pageUrl).href;
      } catch {
        image = null;
      }
    }

    const currency = priceDetails?.currency || normalizeCurrency(
      container.text().match(
        /EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$/i
      )?.[0]
    );

    products.push({
      name,
      price,
      priceExtractionEvidence: priceDetails?.evidence || null,
      packagePrice: price,
      unitPrice: priceDetails?.unitPrice ?? null,
      unitPriceUnit: priceDetails?.unitPriceUnit || null,
      priceBasis: priceDetails?.price === price ? (priceDetails.priceBasis || "package-price") : "attribute-price",
      currency,
      availability: null,
      unit: extractUnitNearPrice($, container, price),
      ...extractPackageMeasureFromDom($, container),
      url: productUrl,
      image,
      ...extractProductIdentifiers({
        sku: container.attr("data-sku") || container.find("[itemprop='sku'], [data-sku]").first().attr("content") || container.find("[data-sku]").first().attr("data-sku"),
        productId: container.attr("data-product-id") || container.attr("data-productid") || container.find("[data-product-id]").first().attr("data-product-id"),
        gtin: container.attr("data-gtin") || container.find("[itemprop='gtin13'], [itemprop='gtin']").first().attr("content"),
        mpn: container.find("[itemprop='mpn']").first().attr("content")
      }),
      source: "html-card"
    });

    if (products.length >= MAX_PRODUCTS_PER_PAGE) {
      break;
    }
  }

  // Fallback for shops whose product cards do not expose recognizable
  // product-card class names (the listing still links to /p/... detail pages).
  products.push(
    ...extractLinkedProductCardProducts($, pageUrl, products)
  );
  return deduplicateProducts(products).slice(0, MAX_PRODUCTS_PER_PAGE);
}
// Generic primary product buy-box extraction. This handles product pages whose
// SEO URL does not contain /product/, /p/ or a numeric SKU, and whose visible
// product title/price are rendered in a buy-box rather than JSON-LD/microdata.
// It deliberately anchors on an add-to-cart form and never scans recommendation
// cards or the entire page for a convenient nearby price.
function isHiddenProductPriceNode($, element) {
  let current = $(element);
  for (let depth = 0; current.length && depth < 7; depth++, current = current.parent()) {
    const style = String(current.attr("style") || "").toLowerCase().replace(/\s+/g, "");
    const classes = String(current.attr("class") || "").toLowerCase().split(/\s+/);
    if (current.attr("hidden") != null || current.attr("aria-hidden") === "true" ||
        /display:none|visibility:hidden/.test(style) ||
        classes.some(value => /^(?:hidden|invisible|is-hidden|d-none)$/.test(value))) {
      return true;
    }
  }
  return false;
}

function extractPrimaryProductBuyBox($, pageUrl) {
  const cartForm = $(
    "form[action*='cart' i], form[id*='cart' i], form[class*='cart' i], form[id*='addtocart' i], form[class*='add-to-cart' i], form[action*='basket' i]"
  ).first();
  if (!cartForm.length) return [];

  let buyBox = null;
  let current = cartForm;
  for (let depth = 0; current.length && depth < 9; depth++, current = current.parent()) {
    const marker = [current.attr("class"), current.attr("id"), current.attr("data-testid")]
      .filter(Boolean).join(" ").toLowerCase();
    const hasSellingPrice = current.find(".price, [itemprop='price'], [data-price]").length > 0;
    if (hasSellingPrice && /(?:product-info|product-detail|product-main|product-buy|product-summary|product-view)/i.test(marker)) {
      buyBox = current;
      break;
    }
  }
  if (!buyBox) {
    // Fallback to the nearest bounded ancestor that contains the cart form and
    // a currency-qualified selling price. Never accept an oversized page wrapper.
    current = cartForm;
    for (let depth = 0; current.length && depth < 7; depth++, current = current.parent()) {
      const text = normalizeWhitespace(current.text());
      if (text.length > 12000) continue;
      if (current.find(".price, [itemprop='price'], [data-price]").length &&
          /(?:€|EUR|CZK|PLN|HUF|GBP|USD|CHF|Kč|zł|Ft|£|\$)/i.test(text)) {
        buyBox = current;
        break;
      }
    }
  }
  if (!buyBox || !buyBox.length) return [];

  const title = cleanProductTitle(
    $("meta[property='og:title']").attr("content") ||
    $("meta[name='twitter:title']").attr("content") ||
    $("title").first().text() ||
    buyBox.find("h1, [itemprop='name'], [class*='product-name'], [class*='product-title']").first().text()
  );
  if (!title || !isLikelyRealProductName(title)) return [];

  const priceNode = buyBox.find("[itemprop='price'], .price:not(.price-unit), [class~='price']")
    .filter((_, element) => !isHiddenProductPriceNode($, element)).first();
  const unitPriceNode = buyBox.find(".price-unit, [class*='unit-price'], [class*='price-per-unit']")
    .filter((_, element) => !isHiddenProductPriceNode($, element)).first();
  const priceText = [
    priceNode.attr("content"), priceNode.attr("data-price"), priceNode.text(),
    unitPriceNode.text()
  ].filter(Boolean).join(" ");
  const priceDetails = selectPrimaryCurrencyPrice(priceText || buyBox.text());
  if (!priceDetails || !Number.isFinite(priceDetails.price) || priceDetails.price <= 0) return [];

  const packageMeasure = extractPackageMeasureFromDom($, buyBox);
  const imageNode = buyBox.find("img").first();
  const rawImage = imageNode.attr("src") || imageNode.attr("data-src") || imageNode.attr("data-lazy-src") ||
    $("meta[property='og:image']").attr("content");
  let image = null;
  if (rawImage) { try { image = new URL(rawImage, pageUrl).href; } catch {} }

  const identifiers = extractProductIdentifiers({
    sku: buyBox.find("[itemprop='sku'], [data-sku]").first().attr("content") || buyBox.find("[itemprop='sku'], [data-sku]").first().attr("data-sku"),
    productId: buyBox.attr("data-product-id") || buyBox.find("[data-product-id], [data-productid]").first().attr("data-product-id") || buyBox.find("[data-productid]").first().attr("data-productid"),
    gtin: buyBox.find("[itemprop='gtin13'], [itemprop='gtin'], [itemprop='gtin8'], [itemprop='gtin14']").first().attr("content"),
    mpn: buyBox.find("[itemprop='mpn']").first().attr("content")
  });

  return [{
    name: title,
    price: priceDetails.price,
    priceExtractionEvidence: { method: "primary-product-buybox", rawPrice: priceText.slice(0, 320), currency: priceDetails.currency || null },
    packagePrice: priceDetails.price,
    currency: priceDetails.currency,
    priceType: priceDetails.hasReferencePrice ? "akciová cena" : "bežná predajná cena",
    unitPrice: priceDetails.unitPrice ?? null,
    unitPriceUnit: priceDetails.unitPriceUnit || null,
    priceBasis: priceDetails.priceBasis || "package-price",
    unit: extractUnitNearPrice($, buyBox, priceDetails.price) || "neuvedené",
    ...packageMeasure,
    availability: /na sklade|skladom|in stock/i.test(buyBox.text()) ? "InStock" : null,
    url: pageUrl,
    image,
    ...identifiers,
    source: "primary-product-buybox"
  }];
}

// Resolve the visible product title across common storefront implementations.
// Some modern storefronts render the PDP title as a button/div instead of H1.
function getPrimaryProductTitleNode($) {
  const selectors = [
    "h1",
    "[itemprop='name']",
    "[data-testid*='product-title' i]",
    "[class~='page-title']",
    "[class*='page-title']",
    "main [class*='product-title']",
    "main [class*='product-name']"
  ];
  for (const selector of selectors) {
    const node = $(selector).filter((_, element) => {
      const value = cleanProductTitle($(element).text());
      return value && isLikelyRealProductName(value);
    }).first();
    if (node.length) return node;
  }

  // Some headless/SSR storefronts (including Astro-based product pages)
  // render the visible product name as a plain paragraph or span rather than
  // an H1 or a class named product-title. In that case, match the exact
  // cleaned document/OG title to a short leaf node inside <main>. This keeps
  // the fallback anchored to the actual PDP title instead of a description
  // paragraph or a recommendation card.
  const pageTitle = cleanProductTitle(
    $("meta[property='og:title']").attr("content") ||
    $("meta[name='twitter:title']").attr("content") ||
    $("title").first().text()
  );
  if (pageTitle && isLikelyRealProductName(pageTitle)) {
    const titleKeys = new Set([normalizeProductName(pageTitle)]);
    const firstTitlePart = cleanProductTitle(pageTitle).split(/\s+(?:-|–|—|\|)\s+/)[0];
    if (firstTitlePart && normalizeProductName(firstTitlePart).length >= 5) {
      titleKeys.add(normalizeProductName(firstTitlePart));
    }
    const searchRoot = $("main").first().length ? $("main").first() : $("body");
    const exactTextNode = searchRoot.find("*").filter((_, element) => {
      const node = $(element);
      if (node.children().length > 0) return false;
      const text = cleanProductTitle(node.text());
      return text.length > 2 && text.length <= 180 &&
        titleKeys.has(normalizeProductName(text)) && isLikelyRealProductName(text);
    }).first();
    if (exactTextNode.length) return exactTextNode;
  }
  return $([]);
}

// ==========================================
// FALLBACK PRE DETAIL PRODUKTU (AJ SHOPTEC)
// ==========================================
function hasProductPurchaseSignal($, scope) {
  if (!scope || !scope.length) return false;
  const text = normalizeWhitespace(scope.text());
  const actionText = /(?:pridať|pridat|vložiť|vlozit)?\s*(?:do\s+košíka|do\s+kosika|košík|kosik|add\s+to\s+cart|buy\s+now|kúpiť|kúpit|objednať|objednat|basket)/i.test(text);
  const actionControls = scope.find(
    "form[action*='cart' i], form[id*='cart' i], form[class*='cart' i], form[action*='basket' i], " +
    "button[class*='cart' i], button[class*='basket' i], button[data-testid*='cart' i], " +
    "[data-testid*='add-to-cart' i], [aria-label*='add to cart' i], [aria-label*='do košíka' i]"
  ).length > 0;
  // Some modern shops render the buy action outside the title block, but the
  // bounded product panel still contains quantity and variant controls.
  const purchaseConfiguration = scope.find(
    "input[type='number'], input[name*='qty' i], input[name*='quantity' i], " +
    "select:not([name*='quantity' i]):not([id*='quantity' i]):not([name*='qty' i]), " +
    "[class*='variant-selector' i], [class*='option-selector' i]"
  ).length > 0;
  return actionText || actionControls || purchaseConfiguration;
}

function extractDetailPageFallback($, pageUrl) {
  const path = (() => { try { return new URL(pageUrl).pathname; } catch { return ""; } })();
  const looksLikeProductUrl = /(?:produkt|product|item|detail|\/p\/)/i.test(path) || /[a-z].*[-_](?:[a-z]*\d{3,}|\d{3,})/i.test(path) || /\.html?$/i.test(path);
  const titleNode = getPrimaryProductTitleNode($);
  const h1 = cleanProductTitle(titleNode.text() || $("meta[property='og:title']").attr("content") || $("title").first().text());
  if (!looksLikeProductUrl || !h1 || !isLikelyRealProductName(h1)) return [];

  const bodyText = normalizeWhitespace($("body").text());
  // For .html product URLs, locate the smallest bounded block containing the
  // page H1, a purchase action and a currency price. This avoids taking a
  // bestseller/recommendation price from the global header before the real
  // product buy-box.
  let productScope = null;
  let headingNode = titleNode;
  // The nearest common ancestor of the product title and purchase controls is
  // preferred. Modern PDPs may use a button for the title and a button (not a
  // form) for add-to-cart, so both semantic and text-based signals are used.
  for (let depth = 0; depth < 12 && headingNode.length; depth++, headingNode = headingNode.parent()) {
    const scopeText = normalizeWhitespace(headingNode.text());
    if (scopeText.length > 24000) continue;
    const hasCurrencyPrice = Boolean(selectPrimaryCurrencyPrice(scopeText));
    const hasPurchaseAction = hasProductPurchaseSignal($, headingNode);
    // A product detail page can expose a compact price/title summary without
    // a conventional cart form or an explicit add-to-cart button in the same
    // DOM branch. If the exact title node and a currency-qualified price are
    // already inside a small ancestor, accept that bounded summary. The URL
    // and exact title-node match are required, so this does not enable a
    // page-wide arbitrary-price fallback on category pages.
    const compactTitlePriceScope = scopeText.length <= 12000 &&
      headingNode.find(titleNode[0]).length > 0;
    if (hasCurrencyPrice && (hasPurchaseAction || compactTitlePriceScope)) {
      productScope = headingNode;
      break;
    }
  }
  const priceSearchRoot = productScope && productScope.length ? productScope : $.root();
  const labelPatterns = [
    /(?:po\s+zľave\s+s\s+DPH|po\s+zlave\s+s\s+DPH)\s*[:：]?\s*((?:\d{1,3}(?:[ .\u00a0]\d{3})*|\d+)(?:[,.]\d{1,2})?)\s*(€|EUR)/i,
    /(?:predajn[aá]\s+cena|aktu[aá]lna\s+cena|cena\s+s\s+DPH)\s*[:：]?\s*((?:\d{1,3}(?:[ .\u00a0]\d{3})*|\d+)(?:[,.]\d{1,2})?)\s*(€|EUR)/i
  ];

  let match = null;
  const productLabelText = productScope ? normalizeWhitespace(productScope.text()) : bodyText;
  for (const pattern of labelPatterns) {
    match = productLabelText.match(pattern);
    if (match) break;
  }

  // If the shop does not label the discounted price consistently, use
  // an explicit current-price element, never an arbitrary number from specs.
  let price = match ? parsePrice(match[1]) : null;
  let currency = match ? normalizeCurrency(match[2]) : null;
  let priceExtractionEvidence = match ? {
    method: "labelled-product-price",
    label: match[0].slice(0, 160),
    rawValue: match[1],
    currency: currency || null
  } : null;
  let priceType = "bežná predajná cena";
  let couponPriceDetected = false;

  // 4home separates the payable price from the coupon block in the DOM.
  // Read the normal price node directly so the coupon value is never selected.
  if (/4home\.sk$/i.test(new URL(pageUrl).hostname)) {
    const normalPriceNode = $(".pricing-wrap .normal-price .priceValue, .pricing-wrap .normal-price strong.priceValue, .pricing-wrap .normal-price").first();
    const normalPriceText = cleanText(normalPriceNode.text(), 120);
    const normalPriceCandidate = selectPrimaryCurrencyPrice(normalPriceText);
    if (normalPriceCandidate) {
      price = normalPriceCandidate.price;
      currency = normalPriceCandidate.currency;
      priceExtractionEvidence = { method: "4home-normal-price", rawValue: normalPriceText.slice(0, 240), currency: currency || null };
      priceType = normalPriceCandidate.hasReferencePrice ? "akciová cena bez kupónu" : "bežná predajná cena";
      couponPriceDetected = $(".pricing-wrap .cupon-info").length > 0;
    }
  }

  if (price == null) {
    const selectedVariantPriceNode = $(
      "[aria-label*='price of selected variant' i], [data-testid*='selected-variant-price' i], [class*='selected-variant-price']"
    ).first();
    if (selectedVariantPriceNode.length) {
      const selectedVariantPrice = selectPrimaryCurrencyPrice(selectedVariantPriceNode.text());
      if (selectedVariantPrice) {
        price = selectedVariantPrice.price;
        currency = selectedVariantPrice.currency;
        priceExtractionEvidence = { method: "selected-variant-price-element", rawValue: selectedVariantPriceNode.text().slice(0, 240), currency: currency || null };
        priceType = selectedVariantPrice.hasReferencePrice ? "akciová cena bez kupónu" : "bežná predajná cena";
      }
    }
  }

  if (price == null) {
    const selectors = [
      "[itemprop='price']", "meta[property='product:price:amount']",
      "meta[property='og:price:amount']", "[class~='price-default']",
      "[class*='price-default']", "[class*='price-current']",
      "[data-testid*='price' i]", "[data-price]", ".current-price",
      ".product-price", ".product__price", ".price"
    ];
    const candidates = [];
    const seenPriceNodes = new Set();
    const mainRoot = $("main").first();
    const pageHasPurchaseSignal = mainRoot.length > 0 && hasProductPurchaseSignal($, mainRoot);
    for (const selector of selectors) {
      priceSearchRoot.find(selector).each((_, node) => {
        if (seenPriceNodes.has(node) || isHiddenProductPriceNode($, node)) return;
        seenPriceNodes.add(node);
        const el = $(node);
        const marker = [el.attr("class"), el.attr("id"), el.attr("data-testid")].filter(Boolean).join(" ").toLowerCase();
        if (/(?:old|original|was|regular|unit|per-unit|reference|strike|coupon|voucher)/i.test(marker)) return;
        if (isExcludedProductArea($, node)) return;

        // Many modern storefronts split the numeric amount and currency into
        // sibling elements (for example <span class="price-default">45,95</span>
        // followed by a separate EUR symbol). Parsing only the price node then
        // returns null even though the visible offer is complete. Inspect a
        // small, bounded sequence of ancestors and keep the closest scope that
        // contains an explicit currency-qualified amount.
        const raw = el.attr("content") || el.attr("data-price") || el.attr("value") || el.text();
        let parsed = extractPriceFromProductCardText(raw) || selectPrimaryCurrencyPrice(raw);
        let chosenScopeText = cleanText(el.parent().text(), 500);
        let ancestor = el;
        let titleDistance = 999;
        for (let depth = 0; depth < 14 && ancestor.length; depth++, ancestor = ancestor.parent()) {
          if (titleNode.length && ancestor.find(titleNode[0]).length) titleDistance = Math.min(titleDistance, depth);
          if (depth > 0 && !parsed) {
            const scopeText = normalizeWhitespace(ancestor.text());
            if (scopeText.length <= 2400) {
              const scoped = selectPrimaryCurrencyPrice(scopeText);
              if (scoped) {
                parsed = scoped;
                chosenScopeText = scopeText;
              }
            }
          }
          if (depth >= 7) break;
        }
        if (!parsed || !Number.isFinite(parsed.price) || parsed.price <= 0) return;

        const nearestText = normalizeWhitespace(el.parent().parent().text());
        const productAction = /(?:košík|kosik|kúpiť|kúpit|pridať|pridat|buy now|add to cart)/i.test(nearestText) ||
          /(?:košík|kosik|kúpiť|kúpit|pridať|pridat|buy now|add to cart)/i.test(chosenScopeText);
        const semantic = /(?:price-default|price-current|product-price|selling-price|final-price)/i.test(marker);
        const inMain = el.closest("main").length > 0;

        // A page-level purchase action is a safe secondary anchor when the
        // title, price and cart button live in separate React components. The
        // candidate must still be in <main>, on a product-detail URL, outside
        // recommendation areas, and expose a semantic price element.
        if (titleDistance === 999 && !(pageHasPurchaseSignal && inMain && semantic && looksLikeProductUrl)) return;
        candidates.push({
          parsed, distance: titleDistance, productAction, semantic, inMain,
          textLength: chosenScopeText.length,
          rawValue: String(raw).slice(0, 240),
          selector,
          scopeText: chosenScopeText.slice(0, 320)
        });
      });
    }
    candidates.sort((a, b) =>
      (a.distance - b.distance) || Number(b.productAction) - Number(a.productAction) ||
      Number(b.semantic) - Number(a.semantic) || Number(b.inMain) - Number(a.inMain) ||
      a.textLength - b.textLength
    );
    if (candidates.length) {
      const best = candidates[0].parsed;
      price = best.price;
      currency = best.currency;
      priceExtractionEvidence = {
        method: "semantic-price-node-or-bounded-ancestor",
        rawValue: best.rawValue || null,
        selector: best.selector || null,
        scopeText: best.scopeText || null,
        currency: best.currency || null
      };
      priceType = best.hasReferencePrice ? "akciová cena bez kupónu" : "bežná predajná cena";
      couponPriceDetected = Boolean(best.couponPriceDetected);
    }
  }

  if ((price == null || !currency) && productScope) {
    const scopedPrice = selectPrimaryCurrencyPrice(productScope.text());
    if (scopedPrice) {
      price = scopedPrice.price;
      currency = scopedPrice.currency;
      priceType = scopedPrice.hasReferencePrice ? "akciová predajná cena" : "bežná predajná cena";
    }
  }

  if (price == null || !currency) return [];
  const rawImage = $("meta[property='og:image']").attr("content") ||
    $("meta[name='twitter:image']").attr("content") ||
    $("main img").first().attr("src") || $("main img").first().attr("data-src") || null;
  let productImage = null;
  if (rawImage) { try { productImage = new URL(rawImage, pageUrl).href; } catch {} }
  return [{
    name: h1,
    price,
    priceExtractionEvidence: priceExtractionEvidence || {
      method: "product-detail-price-fallback",
      rawValue: null,
      currency: currency || null
    },
    currency,
    availability: null,
    unit: "neuvedené",
    url: pageUrl,
    image: productImage,
    source: "detail-page-fallback",
    priceType,
    couponPriceDetected
  }];
}

// ==========================================
// SPOLOCNE ODSTRANENIE DUPLIKATOV
// ==========================================

function normalizeProductName(value) {
  return cleanText(value, 300)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isLikelyRealProductName(value) {
  const name = cleanText(value, 300);
  if (!name) return false;

  const normalized = normalizeProductName(name);

  // Contact details, phone numbers and account/navigation links are never
  // product titles. These often inherit a nearby price from a page wrapper.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) return false;
  if (/^\+?[\d\s()./-]{7,}$/.test(name)) return false;
  if (/^(?:\d{2,}[\s/-]+){2,}\d{2,}$/.test(name)) return false;

  const genericNavigation = new Set([
    "kupit", "sledovanie zasielky", "zabudnute heslo", "zalozit novy ucet",
    "moj ucet", "prehlad objednavok", "vydajne miesta", "spôsoby platby",
    "sposoby platby", "spôsoby a ceny dopravy", "sposoby a ceny dopravy",
    "ako objednat", "reklamacia", "odstupenie od kupnej zmluvy",
    "ochrana osobnych udajov", "nastavenie cookies", "affiliate program",
    "facebook", "instagram", "youtube", "prihlasit sa",
    "prihlasit sa cez ucet facebook", "prihlasit sa cez ucet google",
    "0 oblubene", "bytovy textil", "nabytok", "doplnky a dekoracie",
    "kuchyna a jedalen", "zahrada a hobby", "upratovanie", "krasa a zdravie",
    "pre deti", "vypredaj", "nenech to byt whistleblowing",
    "starostlivost o bielizen", "caste otazky", "pravidla spracovania recenzii",
    "heureka sk overene zakaznikmi", "apek certifikovany obchod",
    "nenech to byt", "whistleblowing", "preco nakupovat u nas",
    "zakaznicka podpora", "kontaktujte nas", "kontaktujte nás"
  ]);
  if (genericNavigation.has(normalized)) return false;

  // A single colour/variant label is not a standalone product.
  if (/^(?:biela|biely|biele|cierna|cierny|hneda|hnedy|siva|sivy|sive|bezova|bezovy|cervena|modra|zelena|zlata|strieborna|prirodna|tmavohneda|white|black|grey|gray|brown|beige|red|blue|green)$/.test(normalized)) return false;

  // Ignore generic information/navigation sections and recommendation headings.
  // These can sit inside a product-card ancestor and accidentally inherit its price.
  const genericLabels = new Set([
    "uzitocne informacie",
    "uzitocne odkazy",
    "uzitocne tipy",
    "informacie",
    "dalsie informacie",
    "viac informacii",
    "o produkte",
    "parametre produktu",
    "technicke parametre",
    "technicke udaje",
    "prislusenstvo",
    "odporucane produkty",
    "podobne produkty",
    "suvisiace produkty",
    "zakaznici tiez kupili",
    "najpredavanejsie produkty",
    "related products",
    "recommended products",
    "you may also like",
    "customers also bought",
    "useful information",
    "useful links",
    "product information",
    "product details",
    "specifications",
    "spotreba energie",
    "spotreba elektrickej energie",
    "energy consumption",
    "power consumption",
    "energeticka trieda",
    "energy efficiency class",
    "rocna spotreba energie",
    "annual energy consumption",
    "prikon",
    "vykon",
    "kapacita",
    "funkcie",
    "funkcia",
    "celý popis",
    "cely popis",
    "popis",
    "parametre",
    "vlastnosti",
    "dostupnosť",
    "dostupnost",
    "euronics sk",
    "euronics"
  ]);

  if (genericLabels.has(normalized)) return false;

  if (/^(?:novinky|akcie|kontakt|o nas|poradna|blog|doprava a platba|obchodne podmienky|reklamacie|faq)$/i.test(name)) {
    return false;
  }

  // Ignore review widgets, accessibility/navigation text and product
  // attributes that can be mistaken for a product title on detail pages.
  if (/\b(priemern[eé] hodnotenie|hodnotenie\s*:|z\s*\d\s*hviezdi[cč]iek|pre[cč][ií]ta[tť]\s+si\s+\d+\s+hodnoten|read\s+reviews?|customer\s+reviews?)\b/i.test(name)) {
    return false;
  }

  // A bare specification such as "Dĺžka 50 m" is not a product name.
  if (/^(?:d[lĺ][žz]ka|[sš][ií]rka|v[yý][sš]ka|hr[uú]bka|rozmer|farba|hmotnos[tť]|objem|[sš]írka)\s*[:：-]?\s*\d+(?:[.,]\d+)?\s*(?:mm|cm|m|km|g|kg|ml|l|m2|m²|ks)?$/i.test(name)) {
    return false;
  }

  if (/^(?:prejs[tť]\s+na\s+obsah|presko[cč]i[tť]\s+na\s+obsah|otvori[tť]\s+menu)$/i.test(name)) {
    return false;
  }

  return true;
}

function normalizeProductUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.replace(/^www\./i, "");
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

// Register a category-discovered detail URL exactly once. URLs beyond the
// configured cap are recorded separately, so repeated links do not inflate
// the skipped count and diagnostics can report the real discovered total.
export function registerCategoryProductDetailCandidate(
  rawUrl,
  admittedUrls,
  skippedUrls,
  limit = MAX_CATEGORY_DETAIL_PAGES
) {
  if (!(admittedUrls instanceof Set) || !(skippedUrls instanceof Set)) {
    throw new TypeError("admittedUrls and skippedUrls must be Set instances");
  }

  const normalizedUrl = normalizeProductUrl(rawUrl);
  if (!normalizedUrl || admittedUrls.has(normalizedUrl) || skippedUrls.has(normalizedUrl)) {
    return { status: "duplicate", url: normalizedUrl };
  }

  const safeLimit = Number.isFinite(Number(limit))
    ? Math.max(0, Math.floor(Number(limit)))
    : MAX_CATEGORY_DETAIL_PAGES;

  if (admittedUrls.size >= safeLimit) {
    skippedUrls.add(normalizedUrl);
    return { status: "limit", url: normalizedUrl };
  }

  admittedUrls.add(normalizedUrl);
  return { status: "admitted", url: normalizedUrl };
}

// Canonicalize explicit first-page pagination aliases before they enter the
// crawl queue. A category root and ?p=1 (or ?page=1) are the same HTTP page;
// only remove a recognized page parameter when its value is exactly 1 and
// there are no unknown query parameters. Other query strings remain untouched.
export function normalizeCrawlPageUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return String(value || "").trim(); }
  const pageParam = getPaginationParam(url);
  if (!pageParam) return url.href;
  const pageKey = [...url.searchParams.keys()].find(key => key.toLowerCase() === pageParam);
  const rawPage = pageKey ? url.searchParams.get(pageKey) : null;
  if (rawPage !== "1") return url.href;
  const allowedKeys = [...url.searchParams.keys()].every(key =>
    PAGINATION_PRIMARY_PARAMS.has(key.toLowerCase()) ||
    PAGINATION_AUX_PARAMS.has(key.toLowerCase()) || TRACKING_PARAMS.test(key)
  );
  if (!allowedKeys) return url.href;
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

function cleanProductTitle(value) {
  let name = cleanText(value, 300);
  // Common page-title formats: "Shop | Product" and "Product | Shop.sk".
  if (/\.(?:sk|cz|hu|pl|com|eu)\s*\|/i.test(name)) {
    name = name.split("|").slice(1).join("|").trim();
  } else {
    name = name.replace(/\s*\|\s*[^|]+\.(?:sk|cz|hu|pl|com|eu)\s*$/i, "").trim();
  }
  return name;
}

// Infer package quantity only when the same offer exposes both a package
// selling price and an explicit reference price per kg/g/l/ml. Never infer it
// from the product title or from a generic nutrition-table quantity.
function inferPackageMeasureFromUnitPrice(product) {
  if (!product || typeof product !== "object") return product;
  let normalized = product;
  if (normalized.packageQuantity == null) {
    const unit = normalizeProductUnit(normalized.unitPriceUnit);
    if (["kg", "g", "l", "ml"].includes(unit)) {
      const packagePrice = normalizeOptionalPositiveNumber(normalized.packagePrice ?? normalized.price);
      const unitPrice = normalizeOptionalPositiveNumber(normalized.unitPrice);
      if (packagePrice != null && unitPrice != null) {
        const quantity = packagePrice / unitPrice;
        if (Number.isFinite(quantity) && quantity > 0 && quantity <= 1000) {
          const rounded = Math.round(quantity * 1000) / 1000;
          if (rounded > 0) {
            normalized = {
              ...normalized,
              packageQuantity: rounded,
              packageUnit: unit,
              packageLabel: `${rounded} ${unit}`,
              packageMeasureSource: "calculated:package-price-divided-by-explicit-unit-price",
              packageMeasureDerived: true
            };
          }
        }
      }
    }
  }

  // If the package size is confirmed but the store omitted the comparison
  // price, calculate it from the package price. Mass and volume are converted
  // to the canonical kg/l basis; count-based packages are never guessed.
  const packageQuantity = normalizeOptionalPositiveNumber(normalized.packageQuantity);
  const packageUnit = normalizeProductUnit(normalized.packageUnit);
  const packagePrice = normalizeOptionalPositiveNumber(normalized.packagePrice ?? normalized.price);
  const hasPackagePrice = packagePrice != null && normalized.priceBasis !== "unit-price-only";
  if (packageQuantity != null && packageUnit && hasPackagePrice &&
      normalizeOptionalPositiveNumber(normalized.unitPrice) == null) {
    let baseQuantity = null;
    let baseUnit = null;
    if (packageUnit === "kg") { baseQuantity = packageQuantity; baseUnit = "kg"; }
    else if (packageUnit === "g") { baseQuantity = packageQuantity / 1000; baseUnit = "kg"; }
    else if (packageUnit === "l") { baseQuantity = packageQuantity; baseUnit = "l"; }
    else if (packageUnit === "ml") { baseQuantity = packageQuantity / 1000; baseUnit = "l"; }
    if (baseQuantity != null && baseQuantity > 0) {
      const calculatedUnitPrice = packagePrice / baseQuantity;
      if (Number.isFinite(calculatedUnitPrice) && calculatedUnitPrice > 0) {
        normalized = {
          ...normalized,
          unitPrice: Math.round(calculatedUnitPrice * 100) / 100,
          unitPriceUnit: baseUnit,
          unitPriceDerived: true,
          unitPriceSource: "calculated:package-price-divided-by-confirmed-package-measure"
        };
      }
    }
  }

  // For a product with a confirmed package measure and a confirmed package
  // selling price, the sale unit is one package. Do not confuse it with the
  // comparison-price unit (kg/l), which remains in unitPriceUnit.
  if ((!normalized.unit || normalized.unit === "neuvedené") && packageQuantity != null && packageUnit && hasPackagePrice) {
    normalized = { ...normalized, unit: "balenie", saleUnitSource: "inferred:confirmed-package-measure" };
  }

  // Some stores expose a clear package price but omit schema.org priceType.
  // A normal selling price is the safe default unless the source explicitly
  // identified a promotional/coupon price or an ambiguous offer.
  if ((!normalized.priceType || normalized.priceType === "neuvedené") && hasPackagePrice &&
      !normalized.ambiguousPrice && !normalized.ambiguousCurrency && normalized.couponPriceDetected !== true) {
    normalized = { ...normalized, priceType: "bežná predajná cena", priceTypeSource: "inferred:confirmed-package-price" };
  }
  return normalized;
}

function deduplicateProducts(products) {
  const result = [];
  const byIdentity = new Map();
  const sourceRank = item => {
    const value = String(item?.source || "");
    const evidence = item?.priceExtractionEvidence || {};
    // The visible, selected purchase offer is the authoritative current price
    // for the exact package selected in the main buy box.
    let rank = value.includes("primary-product-buybox") ? 150 :
      value.includes("json-ld") ? 100 :
      value.includes("microdata") ? 95 :
      value.includes("embedded-json") ? 90 :
      value.includes("html-card") ? 80 :
      value.includes("linked-product-card") ? 75 :
      value.includes("detail-page-fallback") ? 65 :
      value.includes("metadata") ? 40 : 10;

    // A visible currency-qualified amount in a semantic current-price element
    // is stronger than a conflicting value copied into broad structured data.
    // Do not apply this bonus to generic whole-page text fallbacks.
    if (evidence.method === "explicit-price-element") rank += 35;
    if (evidence.method === "semantic-price-node-or-bounded-ancestor" && evidence.selector) rank += 35;
    return rank;
  };

  for (const rawProduct of products) {
    if (!rawProduct) continue;
    const product = { ...rawProduct, name: cleanProductTitle(rawProduct.name) };
    if (!product.name || !isLikelyRealProductName(product.name) ||
        !Number.isFinite(product.price) || product.price <= 0) continue;

    const url = normalizeProductUrl(product.url || product.sourceUrl || "");
    // Variant records can share one canonical product URL and even one visible
    // title while representing different sellable options (for example taste
    // variants with separate SKU/EAN values). Include their strongest stable
    // identifier in the identity key so deduplication merges extraction methods
    // for the same variant without collapsing sibling variants into one item.
    let variantIdentity = "";
    if (product.isVariant === true) {
      const identifiers = [
        product.sku && `sku:${normalizeProductName(product.sku)}`,
        product.gtin && `gtin:${normalizeProductName(product.gtin)}`,
        product.mpn && `mpn:${normalizeProductName(product.mpn)}`,
        product.productId && `id:${normalizeProductName(product.productId)}`
      ].filter(Boolean);
      if (identifiers.length) {
        variantIdentity = identifiers.join("|");
      } else {
        const attributes = product.variantAttributes && typeof product.variantAttributes === "object"
          ? Object.keys(product.variantAttributes).sort().map(key => `${normalizeProductName(key)}:${normalizeProductName(product.variantAttributes[key])}`).join("|")
          : "";
        variantIdentity = attributes || normalizeProductName(product.variantName || "");
      }
    }
    // Keep distinct items on a category URL, but merge conflicting extraction
    // methods for the same product URL/title/variant identity.
    const key = `${url}|${normalizeProductName(product.name)}${variantIdentity ? `|variant:${variantIdentity}` : ""}`;
    const existingIndex = byIdentity.get(key);
    if (existingIndex !== undefined) {
      const existing = result[existingIndex];
      const previousSource = existing.source || "";
      if (sourceRank(product) > sourceRank(existing)) {
        const merged = { ...existing, ...product, ...mergePhysicalSpecFields(product, existing) };
        merged.productAttributes = mergeProductAttributes(product.productAttributes, existing.productAttributes);
        if (!product.currency && existing.currency) merged.currency = existing.currency;
        if ((!product.unit || product.unit === "neuvedené") && existing.unit) merged.unit = existing.unit;
        if (!product.image && existing.image) merged.image = existing.image;
        if (!product.availability && existing.availability) merged.availability = existing.availability;
        for (const field of ["availabilityText", "availabilitySource", "stockQuantity", "stockQuantityUnit", "stockSource", "stockLocations", "stockLocationsSource"]) {
          if (product[field] == null && existing[field] != null) merged[field] = existing[field];
        }
        for (const field of ["unitPrice", "unitPriceUnit", "packagePrice", "packageQuantity", "packageUnit", "packageLabel", "packageMeasureSource", "sku", "gtin", "mpn", "productId"]) {
          if (product[field] == null && existing[field] != null) merged[field] = existing[field];
        }
        if ((!Array.isArray(product.packageOptions) || !product.packageOptions.length) && Array.isArray(existing.packageOptions) && existing.packageOptions.length) {
          merged.packageOptions = existing.packageOptions;
        }
        if (existing.packageMeasureDerived === true && product.packageMeasureDerived !== true && product.packageQuantity != null) {
          merged.packageQuantity = product.packageQuantity;
          merged.packageUnit = product.packageUnit;
          merged.packageLabel = product.packageLabel;
          merged.packageMeasureSource = product.packageMeasureSource;
          delete merged.packageMeasureDerived;
        }
        merged.source = [previousSource, product.source].filter(Boolean).join("+");
        result[existingIndex] = merged;
      } else {
        Object.assign(existing, mergePhysicalSpecFields(existing, product));
        existing.productAttributes = mergeProductAttributes(existing.productAttributes, product.productAttributes);
        if ((!existing.currency || existing.currency === "NEZNAMA") && product.currency) existing.currency = product.currency;
        if ((!existing.unit || existing.unit === "neuvedené") && product.unit && product.unit !== "neuvedené") existing.unit = product.unit;
        if (!existing.image && product.image) existing.image = product.image;
        if (!existing.availability && product.availability) existing.availability = product.availability;
        for (const field of ["availabilityText", "availabilitySource", "stockQuantity", "stockQuantityUnit", "stockSource", "stockLocations", "stockLocationsSource"]) {
          if (existing[field] == null && product[field] != null) existing[field] = product[field];
        }
        for (const field of ["unitPrice", "unitPriceUnit", "packagePrice", "packageQuantity", "packageUnit", "packageLabel", "packageMeasureSource", "sku", "gtin", "mpn", "productId"]) {
          if (existing[field] == null && product[field] != null) existing[field] = product[field];
        }
        if (Array.isArray(product.packageOptions) && product.packageOptions.length && (!Array.isArray(existing.packageOptions) || !existing.packageOptions.length)) {
          existing.packageOptions = product.packageOptions;
        }
        if (Array.isArray(product.shippingPackages) && product.shippingPackages.length && (!Array.isArray(existing.shippingPackages) || !existing.shippingPackages.length)) {
          existing.shippingPackages = product.shippingPackages;
          existing.packageCount = product.packageCount ?? existing.packageCount ?? null;
          existing.packageCountSource = product.packageCountSource || existing.packageCountSource || null;
          existing.shippingPackageSource = product.shippingPackageSource || existing.shippingPackageSource || null;
          existing.shippingWeightQualifier = product.shippingWeightQualifier || existing.shippingWeightQualifier || null;
        }
        if (existing.packageMeasureDerived === true && product.packageMeasureDerived !== true && product.packageQuantity != null) {
          existing.packageQuantity = product.packageQuantity;
          existing.packageUnit = product.packageUnit;
          existing.packageLabel = product.packageLabel;
          existing.packageMeasureSource = product.packageMeasureSource;
          delete existing.packageMeasureDerived;
        }
        if (product.source && existing.source && !String(existing.source).includes(product.source)) existing.source += "+" + product.source;
      }
      continue;
    }

    byIdentity.set(key, result.length);
    result.push(product);
  }
  return result;
}

function extract4homeDetailProduct($, pageUrl) {
  const name = cleanText($("h1").first().text() || $("meta[property='og:title']").attr("content") || $("title").first().text(), 300);
  if (!name || !isLikelyRealProductName(name)) return [];

  // Current 4home product detail template: .price-old is the regular gross
  // selling price; .price-new inside .cupon-info is the coupon-only price.
  // Keep these separate and never import the coupon amount as the catalog price.
  const regularNode = $(".product-price .price-old, .product-detail .price-old, .price-old").first();
  const fallbackNode = $(".pricing-wrap .normal-price .priceValue, .product-price [itemprop='price'], [itemprop='price']").first();
  const regularText = cleanText(regularNode.text() || fallbackNode.attr("content") || fallbackNode.attr("data-price") || fallbackNode.text(), 160);
  const regular = selectPrimaryCurrencyPrice(regularText);
  if (!regular || !Number.isFinite(regular.price) || regular.price <= 0) return [];

  const couponNode = $(".cupon-info .price-new, .product-price .price-new, .price-new").first();
  const coupon = selectPrimaryCurrencyPrice(couponNode.text());
  const stock = cleanText($(".product-availability .availability-text, .availability-text").first().text(), 120);
  const imageNode = $(".product-detail img, .product-main-info img, meta[property='og:image']").first();
  const rawImage = imageNode.attr("content") || imageNode.attr("src") || imageNode.attr("data-src") || imageNode.attr("data-lazy-src");
  let image = null;
  if (rawImage) { try { image = new URL(rawImage, pageUrl).href; } catch {} }
  const sizeLinks = extractSizeVariantLinks($, pageUrl);
  const product = {
    name,
    price: regular.price,
    currency: regular.currency || "EUR",
    priceType: regular.hasReferencePrice ? "akciová cena bez kupónu" : "bežná predajná cena",
    couponPriceDetected: Boolean(coupon || $(".cupon-info").length),
    ...(coupon ? { couponPrice: coupon.price } : {}),
    availability: stock || null,
    url: pageUrl,
    image,
    ...extractPhysicalSpecsFromDom($, $("main").first().length ? $("main").first() : $("body")),
    source: "4home-detail-fast-v333",
    productId: $("[data-product-id]").first().attr("data-product-id") || $("[data-productinfo]").first().attr("data-product-id") || null
  };
  return sizeLinks.length >= 2 ? [applyDetectedSizeVariant(product, sizeLinks)] : [product];
}

// Astro product pages can render their purchase panel inside <astro-island>
// without JSON-LD, microdata, a cart form, or semantic price classes. The
// fallback is deliberately strict: product-detail URL, a named product,
// quantity/variant controls, and the same currency-qualified price repeated
// in the compact purchase island. This avoids importing shipping thresholds,
// recommendation prices, nutrition values, or unrelated page-wide numbers.
function extractAstroProductIslandFallback($, pageUrl) {
  let parsedUrl;
  try { parsedUrl = new URL(pageUrl); } catch { return []; }
  if (!/\.html?$/i.test(parsedUrl.pathname)) return [];
  const main = $("main").first();
  if (!main.length) return [];

  const ogTitle = cleanText(
    $("meta[property='og:title']").attr("content") ||
    $("meta[name='twitter:title']").attr("content") ||
    $("title").first().text(), 300
  );
  const siteName = cleanText($("meta[property='og:site_name']").attr("content") || "", 120);
  const titleNode = getPrimaryProductTitleNode($);
  let productName = cleanProductTitle(titleNode.text() || ogTitle);
  if (siteName && productName) {
    const suffix = productName.match(/\s+[-–—]\s+(.+)$/);
    if (suffix) {
      const brandToken = normalizeProductName(suffix[1]);
      const siteToken = normalizeProductName(siteName).replace(/\b(?:sk|cz|hu|pl|com|eu)\b/g, " ").trim();
      if (brandToken && siteToken && (siteToken.includes(brandToken) || brandToken.includes(siteToken))) {
        productName = productName.slice(0, suffix.index).trim();
      }
    }
  }
  productName = cleanProductTitle(productName);
  if (!productName || !isLikelyRealProductName(productName)) return [];

  // IMPORTANT: modern Astro storefronts split the PDP into sibling islands.
  // The title, variant picker and price therefore do not have to coexist in
  // one island. Anchor the extraction to the product-detail URL + main title,
  // then inspect all purchase islands together instead of rejecting each one
  // independently.
  const islands = main.find("astro-island");
  if (!islands.length) return [];
  const mainText = normalizeWhitespace(main.text());
  if (mainText.length < 40 || mainText.length > 150000) return [];

  let hasQuantityControl = /(?:množstvo|mnozstvo|quantity|počet kusov)/i.test(mainText);
  let hasVariantControl = false;
  let hasPurchaseAction = /(?:do\s+košíka|do\s+kosika|pridať\s+do\s+košíka|add\s+to\s+cart|kúpiť\s+teraz|buy\s+now)/i.test(mainText);
  islands.each((_, element) => {
    const island = $(element);
    if (island.find("input[type='number'], input[name*='qty' i], input[name*='quantity' i]").length) hasQuantityControl = true;
    if (island.find("select option").length >= 2 || island.find("[role='radio'], [role='option'], [class*='variant' i], [data-variant-id]").length >= 2) hasVariantControl = true;
    if (island.find("button, [role='button']").length) hasPurchaseAction = hasPurchaseAction || /(?:košík|kosik|kúpiť|buy|cart)/i.test(island.text());
  });
  if (!hasQuantityControl && !hasVariantControl && !hasPurchaseAction) return [];

  // Prefer prices repeated in the main purchase area. A semantic current-price
  // node is also accepted once, because some Astro versions render the price
  // only once in SSR HTML and duplicate it only after client hydration.
  const counts = new Map();
  for (const candidate of extractCurrencyPriceCandidates(mainText)) {
    const key = `${candidate.currency}|${candidate.price.toFixed(2)}`;
    const current = counts.get(key) || { ...candidate, count: 0 };
    current.count++;
    counts.set(key, current);
  }

  const semanticPriceNodes = main.find(
    "[itemprop='price'], [class~='price-default'], [class*='price-current'], [class*='selling-price'], [data-testid*='price' i], [data-price]"
  );
  semanticPriceNodes.each((_, element) => {
    const node = $(element);
    if (isHiddenProductPriceNode($, element) || isExcludedProductArea($, element)) return;
    const raw = node.attr("content") || node.attr("data-price") || node.attr("value") || node.text();
    const parentText = normalizeWhitespace(node.parent().text());
    const parsed = selectPrimaryCurrencyPrice(raw) || selectPrimaryCurrencyPrice(parentText);
    if (!parsed) return;
    const key = `${parsed.currency}|${parsed.price.toFixed(2)}`;
    const current = counts.get(key) || { ...parsed, count: 0, semantic: true };
    current.count = Math.max(current.count, 1);
    current.semantic = true;
    counts.set(key, current);
  });

  const ranked = [...counts.values()].filter(item => item.count >= 2 || item.semantic)
    .sort((a, b) => Number(Boolean(b.semantic)) - Number(Boolean(a.semantic)) || b.count - a.count);
  const best = ranked[0];
  if (!best || !Number.isFinite(best.price) || best.price <= 0) return [];

  const rawImage = $("meta[property='og:image']").attr("content") || $("meta[name='twitter:image']").attr("content") || main.find("img").first().attr("src") || main.find("img").first().attr("data-src");
  let image = null;
  if (rawImage) { try { image = new URL(rawImage, pageUrl).href; } catch {} }
  return [{
    name: productName,
    price: best.price,
    priceExtractionEvidence: { method: "astro-product-main-islands", rawPriceCandidates: [...counts.values()].map(item => ({ price: item.price, currency: item.currency, count: item.count, semantic: Boolean(item.semantic) })).slice(0, 12) },
    packagePrice: best.price,
    currency: best.currency,
    priceType: "bežná predajná cena",
    availability: /skladom|na sklade|in stock/i.test(mainText) ? "InStock" : null,
    unit: "neuvedené",
    url: pageUrl,
    image,
    source: "astro-product-main-islands",
    extractionEvidence: {
      islandTag: "astro-island",
      islandCount: islands.length,
      repeatedPriceCount: best.count,
      semanticPrice: Boolean(best.semantic),
      quantityControl: hasQuantityControl,
      variantControl: hasVariantControl,
      purchaseAction: hasPurchaseAction
    }
  }];
}

export function extractProductsFromHtml(html, pageUrl, existingRoot = null) {
  const $ = existingRoot || loadHtml(html);
  const is4homeHost = /(^|\.)4home\.sk$/i.test(new URL(pageUrl).hostname);
  if (is4homeHost && $(".size-selector, .size-variant, #size-variant-blurable").length) {
    return extract4homeDetailProduct($, pageUrl);
  }

  const jsonLd = extractProductsFromJsonLd(
    html,
    pageUrl,
    $
  );

  const jsonLdVariantSet = jsonLd.filter(product => product.isVariant === true &&
    product.source === "json-ld-offer-variant");
  const pagePathForVariantCheck = new URL(pageUrl).pathname;
  const looksLikeCategoryForVariantCheck = /\/(?:kategoria|category|categories|kolekcia|collection|collections|catalog|catalogue)\//i.test(pagePathForVariantCheck) ||
    $("[class*='product-card'], [class*='product-item'], [class*='product-tile']").length >= 4;
  if (jsonLdVariantSet.length >= 2 && $("h1").length > 0 && !looksLikeCategoryForVariantCheck) {
    // Keep the same return contract as the normal extraction path.
    // extractWebsiteContent() expects { products, diagnostics }; returning a
    // bare array here caused valid JSON-LD variants to disappear in the crawler.
    // DOM-only physical specifications must still be read before this fast return.
    const productArea = $("main").first().length ? $("main").first() : $("body");
    const pageTitle = cleanProductTitle(getPrimaryProductTitleNode($).text() || $("h1").first().text());
    // The first SKU-like string on an ecommerce page can belong to a child
    // component (for example an IKEA shelf or clothes rail). Resolve the
    // current variant from the product URL, and only accept it if it matches
    // exactly one structured JSON-LD variant.
    const pageSku = resolveCurrentVariantSkuFromPage(jsonLdVariantSet, pageUrl, $, productArea);
    const pagePhysicalSpecs = extractPhysicalSpecsFromDom($, productArea);
    const variantProducts = applyCurrentPageMetadataDimensionFallback(
      enrichJsonLdVariantsWithPhysicalSpecs(
        deduplicateProducts(jsonLdVariantSet), pageUrl, pageTitle, pageSku, pagePhysicalSpecs
      ).slice(0, MAX_PRODUCTS_PER_PAGE),
      $, pageUrl
    );
    return {
      products: variantProducts,
      diagnostics: {
        jsonLd: jsonLd.length,
        microdata: 0,
        metadata: 0,
        embeddedJson: 0,
        htmlCards: 0,
        fourhomeCards: 0,
        detailFallback: 0,
        astroProductIslandFallback: 0,
        primaryProductBuyBox: false,
        jsonLdVariantFastPath: true,
        total: variantProducts.length
      }
    };
  }

  const microdata = extractMicrodataProducts(
    $,
    pageUrl
  );

  // Metadata na kategoriovych strankach casto obsahuje iba najnizsiu
  // cenu z celej kategorie. Nie je to samostatny produkt, preto ich ignorujeme.
  const pathname = new URL(pageUrl).pathname;
  const isCategoryPath = /\/(?:kategoria|category|categories|kolekcia|collection|collections|catalog|catalogue)\//i.test(pathname);
  const cardCount = $("[class*='product-card'], [class*='product-item'], [class*='product-tile'], [data-product-id], [itemtype*='schema.org/Product']").length;
  const isCategoryPage = isCategoryPath || cardCount >= 2;

  const metadata = isCategoryPage
    ? []
    : extractMetadataProduct($, pageUrl);

  const embedded = extractProductsFromEmbeddedJson(
    $,
    pageUrl
  );

  const is4homeListing = /(^|\.)4home\.sk$/i.test(new URL(pageUrl).hostname) &&
    $(".size-selector").length === 0 &&
    $("article.product-card, .product-card, article[data-ax-catalog-code], article.products-list-item, .product-thumbnail, article[class*='product-thumbnail'], article[class*='products-list-item']").length > 0;
  // Detect a real purchase form before scanning generic card selectors. On
  // product details this prevents recommendation cards from being mistaken
  // for the page's main item and avoids expensive full-DOM card traversal.
  const primaryBuyBoxProducts = is4homeListing ? [] : extractPrimaryProductBuyBox($, pageUrl);
  const htmlCards = is4homeListing
    ? extract4homeCardProducts($, pageUrl)
    : primaryBuyBoxProducts.length
      ? []
      : extractHtmlCardProducts($, pageUrl);

  // On 4home listings, the targeted card extractor is the authoritative
  // listing source. The generic detail fallback is intentionally skipped to
  // avoid re-scanning the large listing DOM.
  const detailFallback = is4homeListing ? [] : primaryBuyBoxProducts.length
    ? primaryBuyBoxProducts
    : extractDetailPageFallback($, pageUrl);

  const initialProducts = [
    ...jsonLd,
    ...microdata,
    ...embedded,
    ...metadata,
    ...htmlCards,
    ...detailFallback
  ];
  // Keep 4home's dedicated detail/listing paths untouched. This fallback is
  // only attempted when every established universal extractor found nothing.
  const astroIslandFallback = !is4homeHost && initialProducts.length === 0
    ? extractAstroProductIslandFallback($, pageUrl)
    : [];
  let products = deduplicateProducts([
    ...initialProducts,
    ...astroIslandFallback
  ]);

  // Generic product-detail pages often keep the selected package size and
  // variant controls outside the compact price/name card. Read the full body
  // only when the page is unambiguously a single-product detail.
  const detailSignals = !isCategoryPath && products.length > 0 && !primaryBuyBoxProducts.length
    ? getProductPageSignals(html, pageUrl, products, $)
    : { isDetail: false };
  // A detail page can yield multiple extraction records (e.g. JSON-LD plus
  // microdata, or multiple offers for the same product). Do not classify it as
  // a listing solely because products.length/cardCount is greater than one.
  // Require both the extracted product URL and its name to identify the H1
  // product before using page-wide package data.
  const pageUrlIdentity = normalizeProductUrl(pageUrl);
  const pageHeadingIdentity = normalizeProductName(getPrimaryProductTitleNode($).text() || $("meta[property='og:title']").attr("content") || "");
  const primaryPageProductIndexes = new Set();
  if (!isCategoryPath && pageHeadingIdentity && pageUrlIdentity) {
    const headingTokens = pageHeadingIdentity.split(/\s+/).filter(token => token.length > 1);
    products.forEach((product, index) => {
      const productUrl = normalizeProductUrl(product.url || product.sourceUrl || "");
      const productName = normalizeProductName(product.name);
      if (productUrl !== pageUrlIdentity || !productName || !headingTokens.length) return;
      const productTokens = new Set(productName.split(/\s+/).filter(token => token.length > 1));
      const matchedHeadingTokens = headingTokens.filter(token => productTokens.has(token)).length;
      const headingMatch = matchedHeadingTokens / headingTokens.length >= 0.5 ||
        productName.includes(pageHeadingIdentity) || pageHeadingIdentity.includes(productName);
      if (headingMatch) primaryPageProductIndexes.add(index);
    });
  }
  const isSingleProductDetail = !isCategoryPath && getPrimaryProductTitleNode($).length > 0 && products.length > 0 && products.length <= 30 &&
    (cardCount < 2 || detailSignals.isDetail === true || primaryPageProductIndexes.size > 0);
  if (isSingleProductDetail) {
    const productArea = $("main").first().length ? $("main").first() : $("body");
    const bodyMeasure = extractPackageMeasureFromDom($, productArea);
    const bodyPhysicalSpecs = extractPhysicalSpecsFromDom($, productArea);
    const pageAttributes = extractCurrentProductPageAttributes($, pageUrl, productArea);
    const shouldEnrichPageAttributes = primaryPageProductIndexes.size > 0 || products.length === 1;
    if (((bodyMeasure && (bodyMeasure.packageQuantity != null || Array.isArray(bodyMeasure.packageOptions))) || Object.keys(bodyPhysicalSpecs).length || Object.keys(pageAttributes).length) && shouldEnrichPageAttributes) {
      products = products.map((product, index) => {
        // When the page identity is available, update only the matching main
        // product record(s), never unrelated recommendations on the page.
        if (primaryPageProductIndexes.size > 0 && !primaryPageProductIndexes.has(index)) return product;
        return {
          ...product,
          ...mergePhysicalSpecFields(product, bodyPhysicalSpecs),
          ...mergePhysicalSpecFields(product, pageAttributes),
          productAttributes: mergeProductAttributes(product.productAttributes, pageAttributes.productAttributes),
          ...(pageAttributes.sku && !product.sku ? { sku: pageAttributes.sku } : {}),
          ...(pageAttributes.gtin && !product.gtin ? { gtin: pageAttributes.gtin } : {}),
          ...(pageAttributes.mpn && !product.mpn ? { mpn: pageAttributes.mpn } : {}),
          ...(pageAttributes.availability ? {
            availability: pageAttributes.availability,
            availabilityText: pageAttributes.availabilityText || pageAttributes.availability,
            availabilitySource: pageAttributes.availabilitySource || null
          } : {}),
          ...(pageAttributes.stockQuantity != null ? {
            stockQuantity: pageAttributes.stockQuantity,
            stockQuantityUnit: pageAttributes.stockQuantityUnit || "ks",
            stockSource: pageAttributes.stockSource || null
          } : {}),
          ...(bodyMeasure?.packageQuantity != null ? {
            packageQuantity: bodyMeasure.packageQuantity,
            packageUnit: bodyMeasure.packageUnit,
            packageLabel: bodyMeasure.packageLabel || `${bodyMeasure.packageQuantity} ${bodyMeasure.packageUnit}`,
            packageMeasureSource: bodyMeasure.packageMeasureSource
          } : {}),
          ...(bodyMeasure?.packageOptions?.length ? { packageOptions: bodyMeasure.packageOptions } : {}),
          ...(Array.isArray(bodyPhysicalSpecs.shippingPackages) && bodyPhysicalSpecs.shippingPackages.length ? {
            shippingPackages: bodyPhysicalSpecs.shippingPackages,
            packageCount: bodyPhysicalSpecs.packageCount ?? product.packageCount ?? null,
            packageCountSource: bodyPhysicalSpecs.packageCountSource || null,
            shippingPackageSource: bodyPhysicalSpecs.shippingPackageSource || null,
            shippingWeightQualifier: bodyPhysicalSpecs.shippingWeightQualifier || product.shippingWeightQualifier || null
          } : {})
        };
      });
    }
  }

  // On 4home detail pages the normal selling price and coupon price are in
  // separate nodes. Normalize every extracted representation to the normal
  // price node so JSON-LD cannot accidentally override it with a coupon value.
  if (!is4homeListing && /(^|\.)4home\.sk$/i.test(new URL(pageUrl).hostname)) {
    const normalPriceNode = $(".pricing-wrap .normal-price .priceValue, .pricing-wrap .normal-price strong.priceValue, .pricing-wrap .normal-price").first();
    const normalPriceCandidate = selectPrimaryCurrencyPrice(normalPriceNode.text());
    if (normalPriceCandidate && products.length) {
      const hasCouponPrice = $(".pricing-wrap .cupon-info").length > 0;
      products = products.map(product => ({
        ...product,
        price: normalPriceCandidate.price,
        currency: normalPriceCandidate.currency,
        priceType: normalPriceCandidate.hasReferencePrice ? "akciová cena bez kupónu" : "bežná predajná cena",
        couponPriceDetected: hasCouponPrice || Boolean(product.couponPriceDetected)
      }));
    }
  }

  const sizeVariantLinks = extractSizeVariantLinks($, pageUrl);
  if (sizeVariantLinks.length >= 2) {
    products = products.map(product => applyDetectedSizeVariant(product, sizeVariantLinks));
  }

  // Named flavour/colour/model options are distinct from package weights.
  // Preserve them separately so a flavour selector is not misreported as kg/g.
  const namedVariantOptions = extractNamedProductVariantOptions($);
  if (namedVariantOptions.length >= 2) {
    products = products.map(product => ({
      ...product,
      variantOptions: namedVariantOptions,
      variantCount: Math.max(Number(product.variantCount) || 0, namedVariantOptions.length)
    }));
  }

  // Reject a lone weakly-extracted foreign-currency card on an otherwise
  // single-currency listing. Do not silently relabel HUF/CZK as EUR.
  const currencyCounts = new Map();
  for (const product of products) {
    if (product.currency) currencyCounts.set(product.currency, (currencyCounts.get(product.currency) || 0) + 1);
  }
  const dominantCurrency = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (products.length >= 5 && dominantCurrency && dominantCurrency[1] / products.length >= 0.8) {
    const maxOutliers = Math.max(1, Math.floor(products.length * 0.05));
    products = products.filter(product => {
      if (!product.currency || product.currency === dominantCurrency[0]) return true;
      const weakHtmlSource = /html-card|linked-product-card/.test(String(product.source || ""));
      const currencyCount = currencyCounts.get(product.currency) || 0;
      return !(weakHtmlSource && currencyCount <= maxOutliers);
    });
  }

  // Last, page-identity-safe fallback for sites that publish the size tuple
  // in the product title/metadata while leaving the dimension accordion out of
  // the raw HTML response. This is applied after all normal extractors and
  // variant detection so only the active product receives the fallback.
  products = applyCurrentPageMetadataDimensionFallback(products, $, pageUrl);

  return {
    products: products.slice(
      0,
      MAX_PRODUCTS_PER_PAGE
    ),
    diagnostics: {
      jsonLd: jsonLd.length,
      microdata: microdata.length,
      metadata: metadata.length,
      embeddedJson: embedded.length,
      htmlCards: htmlCards.length,
      fourhomeCards: is4homeListing ? htmlCards.length : 0,
      detailFallback: detailFallback.length,
      astroProductIslandFallback: astroIslandFallback.length,
      primaryProductBuyBox: primaryBuyBoxProducts.length > 0,
      total: products.length
    }
  };
}

// Finds size-option links only inside a clearly labelled size-variant
// selector. This avoids merging colour siblings, recommendations or models.
function collectSizeVariantAnchorCandidates($, scope, pageUrl) {
  const candidates = [];
  scope.find("a[href]").each((_, anchorNode) => {
    const anchor = $(anchorNode);
    const href = String(anchor.attr("href") || "").trim();
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return;
    let parsed;
    try { parsed = new URL(href, pageUrl); } catch { return; }
    let origin;
    try { origin = new URL(pageUrl).origin; } catch { return; }
    if (parsed.origin !== origin || /\.(?:jpg|jpeg|png|gif|webp|svg|pdf|zip)$/i.test(parsed.pathname)) return;
    let pathname = parsed.pathname;
    try { pathname = decodeURIComponent(pathname); } catch {}
    const label = cleanText([
      anchor.attr("title"), anchor.attr("aria-label"), anchor.attr("data-size"),
      anchor.attr("data-dimension"), anchor.attr("data-variant"), anchor.attr("data-value"),
      anchor.text(), anchor.find("img").first().attr("alt")
    ].filter(Boolean).join(" "), 240);
    const sizeInfo = extractDimensionVariant(`${label} ${pathname} ${href}`);
    if (!sizeInfo) return;
    parsed.hash = "";
    candidates.push({ url: parsed.href, size: sizeInfo.size, dimensions: sizeInfo.dimensions, label: label || sizeInfo.size });
  });
  return candidates;
}

function addCurrentProductSizeOption(options, pageUrl, currentTitle) {
  const sizeInfo = extractDimensionVariant(currentTitle);
  if (!sizeInfo) return options;
  let current;
  try { current = new URL(pageUrl); } catch { return options; }
  const normalized = normalizeProductUrl(current.href);
  if (!options.some(option => normalizeProductUrl(option.url) === normalized)) {
    options.push({ url: current.href, size: sizeInfo.size, dimensions: sizeInfo.dimensions, label: cleanText(currentTitle, 180), selected: true });
  }
  return options;
}

// Generic multilingual size/measurement selector discovery. Crucially, it adds
// the currently-open product URL as an option when the page shows its own size
// but only links the other sizes. This is common on IKEA-style product pages.
function extractSizeVariantLinks($, pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return []; }
  const currentTitle = cleanText(
    getPrimaryProductTitleNode($).text() ||
    $("h1").first().text() ||
    $("meta[property='og:title']").attr("content") ||
    $("title").first().text(),
    300
  );
  const results = new Map();
  const addAll = options => {
    for (const option of options) {
      const key = normalizeProductUrl(option.url);
      if (key && !results.has(key)) results.set(key, option);
    }
  };

  // Known semantic class selectors across common storefront templates.
  const explicitScopes = $(".size-selector, .size-variant, #size-variant-blurable, [class*='size-selector' i], [class*='dimension-selector' i], [data-testid*='size-selector' i], [data-testid*='dimension-selector' i]");
  explicitScopes.each((_, element) => {
    const scope = $(element);
    const options = collectSizeVariantAnchorCandidates($, scope, pageUrl);
    addCurrentProductSizeOption(options, pageUrl, currentTitle);
    if (options.length >= 2) addAll(options);
  });
  if (results.size >= 2) return [...results.values()];

  const markerSelector = "p,div,span,h2,h3,h4,strong,b,legend,label,button,[role='heading']";
  $(markerSelector).each((_, markerNode) => {
    const marker = $(markerNode);
    const markerText = cleanText(marker.text(), 180);
    if (!isExplicitSizeVariantMarker(markerText)) return;

    let scope = marker;
    for (let depth = 0; depth < 5 && scope.length; depth++) {
      scope = scope.parent();
      if (!scope.length) break;
      const scopeText = cleanText(scope.text(), 4200);
      if (scopeText.length > 4200) continue;
      const options = collectSizeVariantAnchorCandidates($, scope, pageUrl);
      addCurrentProductSizeOption(options, pageUrl, currentTitle);
      const unique = [...new Map(options.map(option => [normalizeProductUrl(option.url), option])).values()];
      if (unique.length >= 2 && unique.length <= 20) {
        addAll(unique);
        return false;
      }
    }
  });

  return results.size >= 2 ? [...results.values()].slice(0, 40) : [];
}

function extractNamedProductVariantOptions($) {
  const titleNode = getPrimaryProductTitleNode($);
  if (!titleNode.length) return [];

  let scope = titleNode;
  let bestScope = null;
  for (let depth = 0; depth < 12 && scope.length; depth++, scope = scope.parent()) {
    const text = normalizeWhitespace(scope.text());
    if (text.length > 24000) continue;
    const hasPrice = Boolean(selectPrimaryCurrencyPrice(text));
    const hasPurchaseAction = hasProductPurchaseSignal($, scope);
    if (hasPrice && hasPurchaseAction) {
      bestScope = scope;
      break;
    }
  }
  if (!bestScope) {
    // Modern stores may render title, price and option buttons in sibling
    // components; the title's common ancestor need not contain the cart action.
    // Use the smallest ancestor containing an explicit price node, then main.
    let candidate = titleNode;
    for (let depth = 0; depth < 14 && candidate.length; depth++, candidate = candidate.parent()) {
      const text = normalizeWhitespace(candidate.text());
      if (text.length > 24000) continue;
      if (candidate.find(".price-default, [class*='price-current'], [itemprop='price'], [data-price]").length &&
          selectPrimaryCurrencyPrice(text)) {
        bestScope = candidate;
        break;
      }
    }
    if (!bestScope) {
      const main = $("main").first();
      const mainText = normalizeWhitespace(main.text());
      if (main.length && mainText.length <= 30000 && selectPrimaryCurrencyPrice(mainText)) bestScope = main;
    }
  }
  const hasBoundedBuyBoxScope = Boolean(bestScope && bestScope.length);
  if (!hasBoundedBuyBoxScope) {
    // React/Vue shops may render the title, price, cart action and variant
    // buttons in separate sibling components. Keep generic scanning disabled
    // in that case, but allow the explicitly named variant containers below.
    bestScope = $("main").first();
    if (!bestScope.length || !hasProductPurchaseSignal($, bestScope)) return [];
  }

  const results = [];
  const seen = new Set();
  const addOption = (label, value, selected = false, source = "dom:variant-control") => {
    label = cleanText(label, 100);
    value = String(value || label || "").trim();
    if (!label || !value || label.length > 80 || value.length > 180) return;
    if (/^(?:vyberte|zvoľte|select|choose|--|načítavam|loading)$/i.test(label)) return;
    if (/^(?:\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l))$/i.test(label)) return;
    if (/^(?:1|2|3|4|5|10|20|30|60|90|100)$/.test(label.trim())) return;
    if (/(?:pridať|vložiť|do košíka|rýchly nákup|add to cart|buy now|množstvo|quantity|qty|100\s*g|odmerka|denná dávka|zloženie|popis|recenzie|otázky)/i.test(label)) return;
    const key = `${label.toLowerCase()}|${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ label, value, selected: Boolean(selected), source });
  };

  if (hasBoundedBuyBoxScope) {
    // Standard select controls (flavour, colour, model, etc.). Exclude quantity.
    bestScope.find("select").each((_, selectNode) => {
      const select = $(selectNode);
      const marker = [select.attr("name"), select.attr("id"), select.attr("class"), select.attr("aria-label")]
        .filter(Boolean).join(" ").toLowerCase();
      if (/(?:quantity|množstvo|počet|qty)/i.test(marker)) return;
      select.find("option").each((__, optionNode) => {
        const option = $(optionNode);
        addOption(option.attr("label") || option.text(), option.attr("value"), option.attr("selected") != null, "dom:select-option");
      });
    });

    // Generic controls are safe only inside the bounded buy-box.
    const controlSelector = "[role='radio'], [role='option'], [role='button'], [data-option-value], [data-variant-value], [aria-pressed], input[type='radio'], input[type='checkbox'], button, label";
    bestScope.find(controlSelector).each((_, element) => {
      const node = $(element);
      const label = cleanText(node.text() || node.attr("data-option-label") || node.attr("title") || node.attr("aria-label") || node.attr("data-option-value") || node.attr("data-value") || node.find("img").first().attr("alt"), 100);
      const value = node.attr("value") || node.attr("data-option-value") || node.attr("data-variant-value") || node.attr("data-value") || label;
      if (!label || !value) return;
      const marker = [node.attr("class"), node.attr("id"), node.attr("name"), node.attr("aria-label"), node.attr("data-testid"), node.attr("role")]
        .filter(Boolean).join(" ").toLowerCase();
      if (/(?:cart|buy|quantity|qty|review|tab|nutrition|serving|daily-dose|menu|navigation|product-filter-item-label)/i.test(marker)) return;
      const text = normalizeWhitespace(node.text());
      if (text.length > 100) return;
      const checked = node.attr("aria-checked") === "true" || node.attr("aria-selected") === "true" ||
        node.attr("checked") != null || node.attr("data-state") === "checked" || node.attr("aria-pressed") === "true";
      addOption(label, value, checked, "dom:button-or-radio");
    });
  }

  // Some stores render the open variant menu in a portal outside the buy-box.
  // Only inspect elements inside explicitly named variant/option containers.
  $("[data-test*='variant' i] button, [data-testid*='variant' i] button, " +
    "[class*='variant-flavor-buttons'] button, button[class*='variant-flavor-buttons__button'], " +
    "[class*='variant-selector'] button, [data-variant-value], [data-option-value]").each((_, element) => {
    if (isExcludedProductArea($, element)) return;
    const node = $(element);
    const marker = [node.attr("class"), node.attr("id"), node.attr("name"), node.attr("aria-label"), node.attr("data-testid"), node.attr("role")]
      .filter(Boolean).join(" ").toLowerCase();
    if (/(?:cart|buy|quantity|qty|review|tab|navigation)/i.test(marker)) return;
    const label = cleanText(node.text() || node.attr("data-option-label") || node.attr("title") || node.attr("aria-label") || node.attr("data-option-value") || node.attr("data-value") || node.find("img").first().attr("alt"), 100);
    const value = node.attr("value") || node.attr("data-option-value") || node.attr("data-variant-value") || node.attr("data-value") || label;
    const checked = node.attr("aria-checked") === "true" || node.attr("aria-selected") === "true" ||
      node.attr("checked") != null || node.attr("data-state") === "checked" || node.attr("aria-pressed") === "true";
    addOption(label, value, checked, "dom:explicit-variant-container");
  });

  // Do not accept a random pair of buttons (e.g. gallery controls). A product
  // selector should expose at least two distinct, short labels in the PDP buybox.
  const uniqueLabels = new Set(results.map(item => item.label.toLowerCase()));
  if (uniqueLabels.size < 2) return [];
  return results.slice(0, 40);
}

function applyDetectedSizeVariant(product, variantLinks) {
  if (!product || !Array.isArray(variantLinks) || variantLinks.length < 2) return product;
  const matchingOption = variantLinks.find(option => normalizeProductUrl(option.url) === normalizeProductUrl(product.url));
  const titleSize = extractDimensionVariant(`${product.name || ""} ${product.url || ""}`);
  if (!matchingOption && !titleSize) return product;
  const sizeInfo = matchingOption || titleSize;
  const size = sizeInfo.size;
  const baseName = cleanText(String(product.name || "").replace(/[ ,\s-]*\d+(?:[.,]\d+)?\s*(?:mm|cm)?\s*[x×]\s*\d+(?:[.,]\d+)?(?:\s*(?:mm|cm)?\s*[x×]\s*\d+(?:[.,]\d+)?)?\s*(?:mm|cm)\s*$/i, ""), 250);
  if (!baseName || normalizeProductName(baseName).length < 5) return product;
  const matchingCurrentUrl = variantLinks.some(option => normalizeProductUrl(option.url) === normalizeProductUrl(product.url));
  if (!matchingCurrentUrl) return product;
  // The normalized base product name is stable across different SKU/slug suffixes.
  // Do not derive the group from URL slugs: IKEA-like sibling variants use separate IDs.
  const groupId = `size:${normalizeProductName(baseName)}`;
  const dimensions = matchingOption?.dimensions || titleSize?.dimensions || null;
  return {
    ...product,
    isVariant: true,
    variantGroupId: groupId,
    variantGroupName: baseName,
    variantName: size,
    variantAttributes: { ...(product.variantAttributes || {}), size, ...(dimensions ? { dimensions } : {}) },
    ...(dimensions && !product.productDimensions && dimensions.width && dimensions.height ? {
      productDimensions: { ...dimensions, source: "dom:variant-size-selector" }
    } : {}),
    variantCount: variantLinks.length
  };
}

// Enrich a JSON-LD variant fast-path with page-level physical specifications.
// The optimization preserves explicit variant records, but must not bypass
// DOM-only dimensions and multi-parcel data exposed outside JSON-LD.
function resolveCurrentVariantSkuFromUrl(variants, pageUrl) {
  let pathname = "";
  try { pathname = new URL(pageUrl).pathname; } catch { return null; }
  const candidates = [...pathname.matchAll(/(?:^|[^a-z0-9])s?(\d{8,14})(?=$|[^a-z0-9])/gi)]
    .map(match => String(match[1] || "").replace(/[^a-z0-9]/gi, "").toLowerCase())
    .filter(Boolean);
  const normalizedCandidates = [...new Set(candidates)];
  const matchingSkus = new Set();
  for (const candidate of normalizedCandidates) {
    for (const product of variants) {
      const sku = String(product?.sku || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (sku && sku === candidate) matchingSkus.add(sku);
    }
  }
  return matchingSkus.size === 1 ? [...matchingSkus][0] : null;
}

// Some product pages expose assembled dimensions in the rendered measurement
// accordion, but omit that accordion from the first raw HTTP response. IKEA
// still publishes the active product's 3D size in its title / OG title / meta
// description. Use that tuple only as a fallback and attach it only to the
// product whose SKU is encoded in the current detail URL (or to a single,
// unambiguous product record). Never copy the active page's dimensions to
// sibling variants or unrelated recommendation cards.
function extractProductPageMetadataDimensions($) {
  const candidates = [];
  const add = (source, value) => {
    const text = cleanText(String(value || ""), 1200);
    if (text) candidates.push({ source, text });
  };

  try {
    const heading = getPrimaryProductTitleNode($);
    add("heading", heading.text());
    heading.find("[aria-label]").each((_, element) => add("heading-aria-label", $(element).attr("aria-label")));
  } catch {}
  try { add("og-title", $("meta[property='og:title']").first().attr("content")); } catch {}
  try { add("twitter-title", $("meta[name='twitter:title']").first().attr("content")); } catch {}
  try { add("document-title", $("title").first().text()); } catch {}
  try { add("description", $("meta[name='description']").first().attr("content")); } catch {}
  try { add("og-description", $("meta[property='og:description']").first().attr("content")); } catch {}

  for (const candidate of candidates) {
    const parsed = extractDimensionVariant(candidate.text);
    if (!parsed || parsed.values.length !== 3) continue;
    return {
      ...parsed.dimensions,
      raw: parsed.size,
      source: `dom:product-page-metadata-size:${candidate.source}`
    };
  }
  return null;
}

function applyCurrentPageMetadataDimensionFallback(products, $, pageUrl) {
  if (!Array.isArray(products) || !products.length) return products;
  const fallbackDimensions = extractProductPageMetadataDimensions($);
  if (!fallbackDimensions) return products;

  let selectedIndex = -1;
  const currentSku = resolveCurrentVariantSkuFromUrl(products, pageUrl);
  if (currentSku) {
    const skuMatches = products.map((product, index) => ({ product, index }))
      .filter(({ product }) => String(product?.sku || "").replace(/[^a-z0-9]/gi, "").toLowerCase() === currentSku);
    if (skuMatches.length === 1) selectedIndex = skuMatches[0].index;
  }

  if (selectedIndex < 0) {
    const pageIdentity = normalizeProductUrl(pageUrl);
    const pageMatches = products.map((product, index) => ({ product, index }))
      .filter(({ product }) => normalizeProductUrl(product?.url || product?.sourceUrl || "") === pageIdentity);
    if (pageMatches.length === 1) selectedIndex = pageMatches[0].index;
  }
  if (selectedIndex < 0 && products.length === 1) selectedIndex = 0;
  if (selectedIndex < 0) return products;

  const output = [...products];
  const selected = output[selectedIndex];
  output[selectedIndex] = {
    ...selected,
    productDimensions: mergePhysicalDimensionInfo(selected.productDimensions, fallbackDimensions)
  };
  return output;
}

function resolveCurrentVariantSkuFromPage(variants, pageUrl, $, productArea) {
  const fromUrl = resolveCurrentVariantSkuFromUrl(variants, pageUrl);
  if (fromUrl) return fromUrl;

  // Some shops keep a stable parent URL for every option. In that case use
  // only explicit product-SKU metadata or product buy-box data attributes;
  // never search the full page text where accessory/recommended-item SKUs can
  // appear before the active product's SKU.
  const candidates = new Set();
  const addCandidate = value => {
    const normalized = String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (normalized) candidates.add(normalized);
  };
  const collect = collection => {
    try {
      collection?.each?.((_, element) => {
        const node = $(element);
        for (const value of [
          node.attr("content"), node.attr("data-product-sku"), node.attr("data-sku"),
          node.attr("value"), node.text()
        ]) addCandidate(value);
      });
    } catch {}
  };

  try {
    collect($("meta[property='product:retailer_item_id'], meta[name='sku'], meta[itemprop='sku']"));
  } catch {}
  try {
    collect(productArea?.find?.("[itemprop='sku'], [data-product-sku], [data-sku], input[name='sku']"));
  } catch {}

  const matched = new Set();
  for (const product of variants) {
    const sku = String(product?.sku || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (sku && candidates.has(sku)) matched.add(sku);
  }
  return matched.size === 1 ? [...matched][0] : null;
}

function enrichJsonLdVariantsWithPhysicalSpecs(variants, pageUrl, pageTitle, currentSku, pagePhysicalSpecs) {
  const pageUrlIdentity = normalizeProductUrl(pageUrl);
  const normalizedCurrentSku = String(currentSku || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const skuMatches = normalizedCurrentSku
    ? variants.map((product, index) => ({ product, index }))
        .filter(({ product }) => String(product?.sku || "").replace(/[^a-z0-9]/gi, "").toLowerCase() === normalizedCurrentSku)
    : [];
  let selectedVariantIndex = skuMatches.length === 1 ? skuMatches[0].index : -1;

  // A current-page URL is a safe identity only when exactly one JSON-LD record
  // points to it. Several offers may share the parent page URL; in that case
  // applying one page's package breakdown to all siblings is unsafe.
  if (selectedVariantIndex < 0) {
    const urlMatches = variants.map((product, index) => ({ product, index }))
      .filter(({ product }) => normalizeProductUrl(product?.url || product?.sourceUrl || "") === pageUrlIdentity);
    if (urlMatches.length === 1) selectedVariantIndex = urlMatches[0].index;
  }

  return variants.map((product, index) => {
    const matchesCurrentPage = index === selectedVariantIndex;
    let enriched = { ...product };

    if (matchesCurrentPage && pagePhysicalSpecs && typeof pagePhysicalSpecs === "object") {
      enriched = {
        ...enriched,
        ...mergePhysicalSpecFields(enriched, pagePhysicalSpecs)
      };
      if (Array.isArray(pagePhysicalSpecs.shippingPackages) && pagePhysicalSpecs.shippingPackages.length) {
        enriched.shippingPackages = pagePhysicalSpecs.shippingPackages;
        enriched.packageCount = pagePhysicalSpecs.packageCount ?? enriched.packageCount ?? null;
        enriched.packageCountSource = pagePhysicalSpecs.packageCountSource || enriched.packageCountSource || null;
        enriched.shippingPackageSource = pagePhysicalSpecs.shippingPackageSource || enriched.shippingPackageSource || null;
        enriched.shippingWeightQualifier = pagePhysicalSpecs.shippingWeightQualifier || enriched.shippingWeightQualifier || null;
      }
    }

    // A sibling size variant may be listed in JSON-LD even though the current
    // page contains another size's parcel breakdown. Its own dimensional title
    // is safe to use, but never copy the current variant's shipping data to it.
    const variantSize = extractDimensionVariant(product?.name || "");
    const currentTitleSize = matchesCurrentPage ? extractDimensionVariant(pageTitle || "") : null;
    const dimension = variantSize || currentTitleSize;
    if (dimension?.dimensions) {
      enriched.productDimensions = mergePhysicalDimensionInfo(enriched.productDimensions, dimension.dimensions);
      enriched.variantAttributes = {
        ...(enriched.variantAttributes && typeof enriched.variantAttributes === "object" ? enriched.variantAttributes : {}),
        size: dimension.size,
        dimensions: dimension.dimensions
      };
    }
    return enriched;
  });
}

// ==========================================
// EXTRAKCIA TEXTOVEHO OBSAHU WEBU
// ==========================================

export function extractWebsiteContent(html, pageUrl, existingRoot = null) {
  const $ = existingRoot || loadHtml(html);

  // 4home detail pages can contain very large embedded application scripts.
  // Cloning the entire Cheerio tree and then querying every heading made the
  // generic text-cleanup path take several minutes. The detail extractor only
  // needs the product title, short description, headings and bounded body text.
  if (/(^|\.)4home\.sk$/i.test(new URL(pageUrl).hostname) && $(".size-selector, .size-variant, #size-variant-blurable").length) {
    const products = extractProductsFromHtml(html, pageUrl, $);
    const title = cleanText($("title").first().text() || $("h1").first().text(), 300);
    const description = cleanText($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "", 1000);
    const headings = [];
    $("h1, h2, h3").each((_, element) => {
      if (headings.length < 40) {
        const value = cleanText($(element).text(), 200);
        if (value) headings.push(value);
      }
    });
    const text = cleanText($("body").text(), 12000);
    return { url: pageUrl, title, description, headings, text, products, diagnostics: { fourhomeDetailFastPath: true, total: products.length } };
  }

  // Extract product data before preparing a text-only clone. The original
  // shared DOM stays intact for link discovery and page-type detection.
  const extracted = extractProductsFromHtml(html, pageUrl, $);
  const contentRoot = $.root().clone();
  contentRoot.find("script, style, noscript, svg, iframe, header, footer, nav").remove();

  const title = cleanText(
    contentRoot.find("title").first().text() ||
    contentRoot.find("h1").first().text(),
    300
  );

  const description = cleanText(
    contentRoot.find("meta[name='description']").attr("content") ||
    contentRoot.find("meta[property='og:description']").attr("content") ||
    "",
    1000
  );

  const headings = [];

  contentRoot.find("h1, h2, h3").each((_, element) => {
    const value = cleanText(contentRoot.find(element).text(), 200);

    if (value && headings.length < 100) {
      headings.push(value);
    }
  });

  const text = cleanText(
    contentRoot.find("body").text() || contentRoot.text(),
    50000
  );

  return {
    url: pageUrl,
    title,
    description,
    headings,
    text,
    products: extracted.products,
    diagnostics: extracted.diagnostics
  };
}

// ==========================================
// EXTRAKCIA ODKAZOV
// ==========================================

// Canonical path comparison for pagination only. It deliberately does not
// erase arbitrary category segments: /category/flavour is not page 2 of /category.
export function normalizePaginationPath(pathname) {
  return String(pathname || "/")
    .replace(/\/(?:page|strana|seite|pagina|p)\/\d+\/?$/i, "")
    .replace(/\/+$/, "") || "/";
}

export function isSamePaginationPath(candidatePath, currentPath) {
  return normalizePaginationPath(candidatePath) === normalizePaginationPath(currentPath);
}

const PAGINATION_PRIMARY_PARAMS = new Set([
  "page", "p", "pageno", "pageindex", "currentpage", "offset", "pg",
  "strana", "seite", "pagina"
]);
const PAGINATION_AUX_PARAMS = new Set([
  "perpage", "pagesize", "itemsperpage"
]);
const TRACKING_PARAMS = /^(?:utm_.+|gclid|fbclid|yclid)$/i;

// A pagination URL may contain exactly one page-number parameter and only
// known pagination auxiliaries. Unknown query parameters (facets, filters,
// sorting, search, etc.) are never accepted as pagination.
export function getPaginationParam(urlInput) {
  let url;
  try { url = urlInput instanceof URL ? urlInput : new URL(String(urlInput)); }
  catch { return null; }
  const keys = [...url.searchParams.keys()]
    .filter(key => !TRACKING_PARAMS.test(key))
    .map(key => key.toLowerCase());
  const primary = keys.filter(key => PAGINATION_PRIMARY_PARAMS.has(key));
  if (primary.length !== 1) return null;
  if (keys.some(key => !PAGINATION_PRIMARY_PARAMS.has(key) && !PAGINATION_AUX_PARAMS.has(key) && key !== "skip" && key !== "ajax_loading")) {
    return null;
  }
  return primary[0];
}

export function isSafePaginationUrl(candidateInput, currentInput, options = {}) {
  let candidate;
  let current;
  try {
    candidate = candidateInput instanceof URL ? new URL(candidateInput.href) : new URL(String(candidateInput), String(currentInput));
    current = currentInput instanceof URL ? currentInput : new URL(String(currentInput));
  } catch { return false; }
  if (candidate.origin !== current.origin || !isSamePaginationPath(candidate.pathname, current.pathname)) return false;

  for (const key of [...candidate.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) candidate.searchParams.delete(key);
  }

  const queryKeys = [...candidate.searchParams.keys()].map(key => key.toLowerCase());
  if (queryKeys.length === 0) {
    return /\/(?:page|strana|seite|pagina|p)\/\d+\/?$/i.test(candidate.pathname);
  }

  const param = getPaginationParam(candidate);
  if (!param) return false;
  const raw = candidate.searchParams.get([...candidate.searchParams.keys()].find(key => key.toLowerCase() === param));
  const pageNumber = Number(raw);
  if (!raw || !Number.isInteger(pageNumber) || pageNumber < 2 || pageNumber > 5000) return false;

  const is4home = options.is4home === true || /(^|\.)4home\.sk$/i.test(candidate.hostname);
  for (const key of queryKeys) {
    if (PAGINATION_PRIMARY_PARAMS.has(key) || PAGINATION_AUX_PARAMS.has(key)) continue;
    if (is4home && key === "skip") continue;
    if (is4home && key === "ajax_loading" && candidate.searchParams.get("ajax_loading") === "rewrite") continue;
    return false;
  }
  for (const key of [...candidate.searchParams.keys()]) {
    if (PAGINATION_AUX_PARAMS.has(key.toLowerCase())) {
      const value = Number(candidate.searchParams.get(key));
      if (!Number.isInteger(value) || value < 1 || value > 500) return false;
    }
  }
  return true;
}

export function extractWebsiteLinks(html, pageUrl, options = {}) {
  const $ = options.root || loadHtml(html);
  const paginationLinks = new Set();
  const productLinks = new Set();
  const otherLinks = new Set();

  let origin;
  let current;

  try {
    current = new URL(pageUrl);
    origin = current.origin;
  } catch {
    return options.returnMeta
      ? { links: [], paginationLinks: [], productLinks: [], otherLinks: [] }
      : [];
  }

  const isProductPath = pathname =>
    /\/(?:p|product|products|produkt|produkte|item|items|detail|dp)\//i.test(pathname) ||
    /\/dp\//i.test(pathname);

  // A link may sit inside a visually product-like tile (image + price + title)
  // without being a purchasable product. Do not queue known navigation,
  // category, account or basket routes as product-detail candidates.
  // This is intentionally segment-based: a product slug containing a word
  // such as "category" as part of a longer word is not rejected.
  const nonProductRouteSegments = new Set([
    "cart", "kosik", "basket", "checkout",
    "wishlist", "favorites", "favourites",
    "compare", "porovnanie",
    "account", "login", "prihlasenie", "register", "registration",
    "search", "vyhladavanie",
    "category", "categories", "kategoria", "kategorie", "katalog", "catalog", "catalogue",
    "collection", "collections", "kolekcia",
    "brand", "brands", "znacka", "manufacturer", "manufacturers",
    "blog", "news", "kontakt", "contact"
  ]);
  const isClearlyNonProductRoute = pathname => {
    const segments = String(pathname || "")
      .split("/")
      .map(segment => segment.trim().toLowerCase())
      .filter(Boolean);
    if (!segments.length) return true;
    return segments.some(segment => nonProductRouteSegments.has(segment));
  };

  // Pagination must stay inside the current listing path. Without this guard,
  // faceted category URLs such as /category/flavour?p=2 were mistaken for
  // page 2 of /category and expanded into hundreds of irrelevant crawl jobs.
  // Path-based pagination (/page/2, /strana/2, ...) is normalized before compare.
  const samePaginationPath = candidate =>
    isSamePaginationPath(candidate.pathname, current.pathname);

  // Univerzalne rozpoznanie produktovej karty.
  // Nespoliehame sa iba na CSS triedy typu .product-card: vlastne e-shopy
  // casto pouzivaju nahodne triedy alebo samostatny odkaz na obrazok/nazov.
  const isInsideProductCard = $link => {
    const anchorText = cleanText(
      $link.attr("title") ||
      $link.attr("aria-label") ||
      $link.text() ||
      $link.find("img").first().attr("alt"),
      300
    );
    const anchorHasImage = $link.find("img").length > 0;
    const genericAction = /^(?:detail|zobrazit detail|zobrazi[tť] detail|viac|viac info|more|view|view details|quick view|compare|porovna[tť]|ob[aá]l|do ko[sš][ií]ka|add to cart)$/i.test(anchorText);

    // Neberieme samostatne odkazy na znacku, akciu alebo navigaciu vnutri karty.
    if (!anchorHasImage && (anchorText.length < 5 || genericAction)) {
      return false;
    }

    let node = $link[0];

    for (let depth = 0; node && depth < 9; depth++, node = node.parent) {
      const $node = $(node);
      const className = String($node.attr("class") || "").toLowerCase();
      const itemType = String($node.attr("itemtype") || "").toLowerCase();
      const marker = `${className} ${String($node.attr("id") || "").toLowerCase()} ${String($node.attr("data-testid") || "").toLowerCase()}`;
      const text = cleanText($node.text(), 2200);
      const hasProductData = Boolean(
        $node.attr("data-product-id") ||
        $node.attr("data-product") ||
        $node.attr("data-sku") ||
        $node.find("[itemprop='price'], [data-price], [itemprop='sku']").length
      );
      const hasPrice = Boolean(
        $node.find("[itemprop='price'], [data-price], [class*='price'], [class*='Price']").length ||
        extractPriceFromProductCardText(text)
      );
      const hasImage = $node.find("img").length > 0;
      const hasProductSemantics = /product|produkt|article|item-card|product-card|product-tile|productbox|product-box|catalog-item|catalogue-item/.test(marker) ||
        itemType.includes("product");

      // Najsilnejsie signaly: Schema.org/data-product alebo semanticka karta.
      if (hasProductSemantics && (hasProductData || hasPrice || hasImage)) {
        return true;
      }

      // Fallback pre vlastne sablony: kompaktna oblast obsahuje obrazok,
      // realnu cenu a text nazvu. Limit dlzky brani tomu, aby sa za kartu
      // povazoval cely obsah stranky alebo hlavna navigacia.
      if (
        depth >= 1 &&
        text.length >= 8 &&
        text.length <= 1800 &&
        hasImage &&
        hasPrice &&
        (hasProductData || $node.find("h1, h2, h3, h4, [itemprop='name'], a[title], [class*='title'], [class*='name']").length > 0)
      ) {
        return true;
      }
    }

    return false;
  };

  const addLink = (href, preferred = false, productContext = false) => {
    if (!href) return;

    try {
      const url = new URL(href, pageUrl);

      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
        return;
      }

      // Niektore e-shopy pouzivaju fragmenty #2, #3... iba ako JavaScriptove
      // ovladanie. Fragment sa pri HTTP poziadavke neposiela. 4home vsak pri
      // kliknuti na #N realne odosiela XHR na ?skip=&p=N&ajax_loading=rewrite.
      // Preto pre 4home mapujeme fragment priamo na overeny AJAX endpoint.
      const hashPageMatch = String(url.hash || "").match(/^#(?:page[-_=]?)?(\d{1,4})$/i);
      const hashPageNumber = hashPageMatch ? Number(hashPageMatch[1]) : 0;
      const is4home = /(^|\.)4home\.sk$/i.test(url.hostname);
      url.hash = "";

      // A pagination candidate must remain on this listing path and may only
      // contain one recognised page parameter plus pagination auxiliaries.
      // This blocks GymBeam-style facet URLs such as ?p=2&trademark_ingredient=...
      // and conflicting aliases such as ?p=2&page=2.
      if (preferred && hashPageNumber < 2 && !isSafePaginationUrl(url, current, { is4home })) return;

      if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|rar|css|js|xml)$/i.test(url.pathname)) {
        return;
      }

      // Zachovaj parametre strankovania, odstran iba bezne tracking parametre.
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_.+|gclid|fbclid|yclid)$/i.test(key)) {
          url.searchParams.delete(key);
        }
      }

      // Facets, sorting and search combinations are not pagination. These URLs
      // can explode into thousands of near-identical category pages on large shops.
      const queryKeys = [...url.searchParams.keys()].map(key => key.toLowerCase());
      const hasFacetOrSort = queryKeys.some(key =>
        /^(?:filter|filter_|attribute|attributes|brand|manufacturer|category|categories|sort|order|orderby|dir|q|query|search|min_price|max_price|price_min|price_max|color|colour|size|rating|availability|stock|page_size|limit|view|display)$/.test(key) ||
        /^(?:filter|facet|attribute|spec|refine|sort|search|query)_/.test(key)
      );
      if (hasFacetOrSort) return;

      if (hashPageNumber >= 2 && hashPageNumber <= 1000) {
        const pageUrl = new URL(url.href);
        if (is4home) {
          pageUrl.searchParams.set("skip", "");
          pageUrl.searchParams.set("p", String(hashPageNumber));
          pageUrl.searchParams.set("ajax_loading", "rewrite");
        } else {
          pageUrl.searchParams.set("page", String(hashPageNumber));
        }
        const pageValue = pageUrl.href;
        if (pageValue !== current.href) paginationLinks.add(pageValue);
        return;
      }

      const value = url.href;
      if (value === current.href) return;

      if (preferred) {
        paginationLinks.add(value);
      } else if (isProductPath(url.pathname)) {
        // Explicit product routes are strong evidence. Keep them even when
        // the store's product slug happens to contain a reserved-looking word.
        productLinks.add(value);
      } else if (productContext && !isClearlyNonProductRoute(url.pathname)) {
        // Generic SEO product slugs remain supported, but category/navigation
        // tiles can no longer be mistaken for product pages.
        productLinks.add(value);
      } else {
        otherLinks.add(value);
      }
    } catch {
      // Neplatny odkaz preskocime.
    }
  };

  // Explicitne rel=next a odkazy oznacene ako dalsia strana.
  $("a[rel~='next'][href], link[rel~='next'][href]").each((_, element) => {
    addLink($(element).attr("href"), true);
  });

  $("a[href]").each((_, element) => {
    const $element = $(element);
    const href = $element.attr("href");
    const label = [
      $element.text(),
      $element.attr("aria-label"),
      $element.attr("title"),
      $element.attr("data-testid")
    ].filter(Boolean).join(" ").toLowerCase();

    const candidateUrl = (() => {
      try { return new URL(href, pageUrl); } catch { return null; }
    })();
    const sameListingPath = Boolean(candidateUrl && samePaginationPath(candidateUrl));
    const candidateQueryKeys = candidateUrl ? [...candidateUrl.searchParams.keys()] : [];
    const hasPaginationParam = sameListingPath && candidateQueryKeys.length > 0 &&
      isSafePaginationUrl(candidateUrl, current, { is4home: /(^|\.)4home\.sk$/i.test(current.hostname) });
    const hasPaginationPath = sameListingPath && /\/(?:page|strana|seite|pagina|p)\/\d+(?:\/|$)/i.test(href || "") &&
      isSafePaginationUrl(candidateUrl, current, { is4home: /(^|\.)4home\.sk$/i.test(current.hostname) });
    const looksLikeNext = /next|dals|ďal|nasledu|ďalej|weiter|suivant|›|»|→/i.test(label);
    const looksLikePageNumber = /^\s*\d{1,4}\s*$/.test($element.text());
    const inPaginationContainer = $element.parents(
      "[class*='pagination'], [id*='pagination'], [class*='pager'], [id*='pager'], nav[aria-label*='page' i], [data-testid*='pagination'], [class*='paging'], [class*='pages']"
    ).length > 0;

    // Niektore e-shopy (napr. 4home) maju ciselne odkazy stranok
    // bez standardnej CSS triedy pagination/pager. Rozpoznaj ich podla
    // spolocneho maleho kontajnera s viacerymi cislami a elipsou.
    // Tým sa vyhneme tomu, aby sa bezne cisla z filtrov alebo produktov
    // povazovali za strankovanie.
    let inNumericPaginationGroup = false;
    if (looksLikePageNumber) {
      let parent = $element.parent()[0];
      for (let depth = 0; parent && depth < 6; depth++, parent = parent.parent) {
        const group = $(parent);
        const groupText = normalizeWhitespace(group.text());
        const numericAnchors = group.find("a[href]").filter((_, item) =>
          /^\s*\d{1,4}\s*$/.test(cleanText($(item).text(), 30))
        ).length;
        const hasEllipsis = /(?:…|\.\.\.)/.test(groupText);

        if (
          numericAnchors >= 3 &&
          numericAnchors <= 30 &&
          groupText.length <= 500 &&
          (hasEllipsis || numericAnchors >= 5)
        ) {
          inNumericPaginationGroup = true;
          break;
        }
      }
    }

    const hasPageData = Boolean(
      $element.attr("data-page") ||
      $element.attr("data-page-number") ||
      $element.attr("aria-current") ||
      $element.attr("data-testid")?.toLowerCase().includes("page")
    );
    const isPagination = sameListingPath && (hasPaginationParam || hasPaginationPath || looksLikeNext ||
      (inPaginationContainer && (looksLikePageNumber || hasPageData || $element.is("a"))) ||
      (looksLikePageNumber && hasPageData) ||
      inNumericPaginationGroup);

    const is4homeListing = /(^|\.)4home\.sk$/i.test(current.hostname);
    addLink(href, isPagination, !is4homeListing && !isPagination && isInsideProductCard($element));
  });

  // 4home: stránkovanie #2, #3... je obslúžené JavaScriptom a kliknutie
  // vytvára XHR ?skip=&p=N&ajax_loading=rewrite. Niektoré šablóny nemajú
  // klasický pagination wrapper, preto číselné fragmenty zbierame explicitne.
  if (/(^|\.)4home\.sk$/i.test(current.hostname)) {
    $("a[href]").each((_, element) => {
      const $link = $(element);
      const href = String($link.attr("href") || "").trim();
      const label = cleanText($link.text(), 30);
      if (/^\d{1,3}$/.test(label) && /^#\d{1,3}$/.test(href)) {
        addLink(href, true);
      }
    });
  }

  // Podpora stránkovania ovládaného JavaScriptom. Niektoré obchody
  // používajú tlačidlá namiesto klasických <a href> odkazov; ak poskytujú
  // explicitnú cieľovú URL v dátovom atribúte, zaradíme ju do fronty stránok.
  $("[data-next-url], [data-page-url], [data-load-more-url], [data-href], [data-url]").each((_, element) => {
    const node = $(element);
    const label = [node.text(), node.attr("aria-label"), node.attr("title"), node.attr("class")]
      .filter(Boolean).join(" ").toLowerCase();
    const target = node.attr("data-next-url") || node.attr("data-page-url") ||
      node.attr("data-load-more-url") || node.attr("data-href") || node.attr("data-url");
    if (target && /next|dals|ďal|nasledu|ďalej|load.?more|na[cč][ií]ta[tť]|page|pagination|pager/i.test(label)) {
      addLink(target, true);
    }
  });

  const variantLinks = extractSizeVariantLinks($, pageUrl);
  // Bound pagination candidates per page. Keep the closest/first discovered
  // links; product links are not affected by this cap.
  const pagination = [...paginationLinks].slice(0, MAX_PAGINATION_LINKS_PER_PAGE);
  const products = [...productLinks];
  const others = [...otherLinks];
  const links = options.categoryOnly
    ? [...pagination, ...products]
    : [...pagination, ...products, ...others];

  // Predvolene ostava zachovane povodne API (pole URL). Crawler si moze
  // vyziadat aj rozdelene skupiny, aby vedel spravne spracovat URL produktov.
  return options.returnMeta
    ? { links, paginationLinks: pagination, productLinks: products, variantLinks: variantLinks.map(option => option.url), otherLinks: others }
    : links;
}

// ==========================================
// ROBOTS.TXT
// ==========================================

export function parseRobotsTxt(content) {
  const groups = [];
  let current = null;

  const lines = String(content || "")
    .split(/\r?\n/)
    .map(line => line.split("#")[0].trim())
    .filter(Boolean);

  for (const line of lines) {
    const separator = line.indexOf(":");

    if (separator < 0) continue;

    const key = line.slice(0, separator)
      .trim()
      .toLowerCase();

    const value = line.slice(separator + 1).trim();

    if (key === "user-agent") {
      if (
        !current ||
        current.rules.length > 0
      ) {
        current = {
          agents: [],
          rules: []
        };

        groups.push(current);
      }

      current.agents.push(value.toLowerCase());
      continue;
    }

    if (
      (key === "allow" || key === "disallow") &&
      current
    ) {
      current.rules.push({
        type: key,
        path: value
      });
    }
  }

  return groups;
}

export function isAllowedByRobots(
  robots,
  url,
  userAgent = "nova-ai-website-importer"
) {
  if (!robots || !Array.isArray(robots)) {
    return false;
  }

  const agent = userAgent.toLowerCase();
  const pathname = new URL(url).pathname +
    new URL(url).search;

  const matchingGroups = robots.filter(group =>
    Array.isArray(group?.agents) && group.agents.some(value =>
      value === "*" || agent.includes(value)
    )
  );

  if (!matchingGroups.length) {
    return true;
  }

  const specificGroups = matchingGroups.filter(group =>
    Array.isArray(group.agents) && group.agents.some(value => value !== "*")
  );

  const groupsToUse = specificGroups.length
    ? specificGroups
    : matchingGroups;

  const rules = groupsToUse.flatMap(group => Array.isArray(group?.rules) ? group.rules : []);

  let selected = null;

  for (const rule of rules) {
    if (!rule.path) continue;

    let matches = false;

    try {
      const escaped = rule.path
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, ".*");

      matches = new RegExp("^" + escaped).test(pathname);
    } catch {
      matches = pathname.startsWith(rule.path);
    }

    if (!matches) continue;

    if (
      !selected ||
      rule.path.length > selected.path.length ||
      (
        rule.path.length === selected.path.length &&
        rule.type === "allow"
      )
    ) {
      selected = rule;
    }
  }

  return !selected || selected.type === "allow";
}

async function loadRobotsTxt(baseUrl) {
  const origin = new URL(baseUrl).origin;
  const robotsUrl = new URL("/robots.txt", origin);

  try {
    const response = await safeFetchWebsite(
      robotsUrl.href,
      {
        maxBytes: MAX_ROBOTS_BYTES
      }
    );

    const text = response.body.toString("utf8");

    return {
      available: true,
      rules: parseRobotsTxt(text)
    };
  } catch (error) {
    const message = String(error.message || "");

    if (
      message.includes("HTTP status 404") ||
      message.includes("HTTP status 410")
    ) {
      return {
        available: false,
        rules: []
      };
    }

    return {
      available: false,
      rules: null,
      error: message
    };
  }
}

// ==========================================
// POMOCNE FUNKCIE CRAWLERA
// ==========================================

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function isHtmlResponse(headers) {
  const contentType = String(
    headers["content-type"] || ""
  ).toLowerCase();

  return (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml")
  );
}

function scoreProductPage(url) {
  const value = url.toLowerCase();
  let score = 0;

  // Kategoriove a strankovacie URL musia mat prednost pred detailmi,
  // inak crawler moze minut dalsie strany zoznamu produktov.
  if (/\/c\/|\/category|\/kategoria|\/catalog|\/kolekcia/.test(value)) {
    score += 8;
  }

  if (/[?&](page|p|pageno|pageindex|currentpage|offset|pg|strana|seite|pagina)=/i.test(value) ||
      /\/(?:page|strana|seite|pagina)\/\d+(?:\/|$)/i.test(value)) {
    score += 20;
  }

  if (/\/p\/|\/produkt|\/product|\/item|\/detail|\/shop\//.test(value)) {
    score += 5;
  }

  if (/cart|kosik|checkout|login|account|register|wishlist|search/.test(value)) {
    score -= 20;
  }

  return score;
}

// Rozlisenie detailu produktu od kategorie. Pri detaile sa nesmu
// prehladavat odkazy na odporucane/suvisiace produkty.
function getProductPageSignals(html, pageUrl, products, existingRoot = null) {
  const $ = existingRoot || loadHtml(html);
  let pathname = "";
  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    return { isDetail: false, heading: "", path: "" };
  }

  const heading = normalizeProductName(
    getPrimaryProductTitleNode($).text() ||
    $("meta[property='og:title']").attr("content") ||
    $("title").first().text() ||
    ""
  );
  const path = normalizeProductName(pathname);
  const categoryPath = /\/(kategoria|category|categories|kategorie|kategorija|catalog|catalogue|kolekcia|collection|collections)(\/|$)/i
    .test(pathname);

  const hasProductType =
    String($("meta[property='og:type']").attr("content") || "").toLowerCase() === "product";
  const detailContainerMarker = $(
    "[class*='product-detail'], [class*='product-detail__'], [id*='product-detail']"
  ).length > 0;
  const productCardCount = $(
    "[class*='product-card'], [class*='product-item'], [class*='product-tile'], [data-product-id], [itemtype*='schema.org/Product']"
  ).length;

  // Najprv zisťujeme katalógové signály. Jeden itemprop=offers alebo
  // cart form sa môže objaviť aj v kategórii a nesmie zastaviť crawler.
  const listingLinks = extractWebsiteLinks(html, pageUrl, { returnMeta: true, root: $ });
  const listingProductLinks = (listingLinks.productLinks || []).length;
  const hasListingEvidence = products.length >= 2 ||
    listingProductLinks >= 2 ||
    productCardCount >= 3 ||
    $("[class*='product-list'], [class*='product-grid'], [class*='products-grid'], [id*='product-list'], [data-testid*='product-list']").length > 0 &&
      $("a[href]").filter((_, el) => {
        const href = String($(el).attr("href") || "");
        return href && href !== "#" && !/^javascript:/i.test(href);
      }).length >= 4;

  // Explicitný kontajner detailu je silný signál. Všeobecné metadáta
  // og:type/Offer/cart prijímame až vtedy, keď stránka nevyzerá ako katalóg.
  if (categoryPath) {
    return { isDetail: false, heading, path, isListing: hasListingEvidence };
  }
  if (detailContainerMarker) {
    return { isDetail: true, heading, path, bestScore: 1 };
  }
  if (hasListingEvidence || !products.length) {
    return { isDetail: false, heading, path, isListing: Boolean(hasListingEvidence) };
  }

  const cartFormDetailMarker = $("form[action*='cart']").length > 0 && productCardCount <= 1;
  const offersCount = $("[itemprop='offers']").length;
  const singleProductOffers = offersCount === 1 &&
    $("[itemtype*='schema.org/Product']").length <= 1;
  if (hasProductType || cartFormDetailMarker || singleProductOffers) {
    return { isDetail: true, heading, path, bestScore: 1 };
  }

  const headingTokens = new Set(heading.split(/\s+/).filter(token => token.length > 1));
  const pathTokens = new Set(path.split(/\s+/).filter(token => token.length > 1));
  let bestScore = 0;

  for (const product of products) {
    const name = normalizeProductName(product.name);
    const nameTokens = new Set(name.split(/\s+/).filter(token => token.length > 1));
    const overlapScore = tokens => {
      if (!tokens.size || !nameTokens.size) return 0;
      let hits = 0;
      for (const token of nameTokens) {
        if (tokens.has(token)) hits++;
      }
      return hits / nameTokens.size;
    };
    bestScore = Math.max(
      bestScore,
      overlapScore(headingTokens),
      overlapScore(pathTokens)
    );
  }

  return {
    isDetail: hasProductType || detailContainerMarker || bestScore >= 0.34,
    heading,
    path,
    bestScore
  };
}

function selectDirectProductRecords(products, signals) {
  if (!Array.isArray(products) || !products.length) return [];

  // A product detail page can expose multiple real, purchasable offers for
  // flavours/sizes. selectMainProduct() is deliberately single-record logic;
  // applying it to a complete variant family silently dropped sibling offers.
  const groups = new Map();
  for (const product of products) {
    if (product?.isVariant !== true || !product.variantGroupId) continue;
    const key = String(product.variantGroupId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }
  const heading = normalizeProductName(signals?.heading || "");
  const path = normalizeProductName(signals?.path || "");
  const scoredGroups = [...groups.values()].filter(group => group.length >= 2).map(group => {
    const groupName = normalizeProductName(group[0]?.variantGroupName || group[0]?.name || "");
    const tokens = [...new Set(groupName.split(/\s+/).filter(token => token.length > 1))];
    const overlap = text => {
      const source = new Set(String(text || "").split(/\s+/).filter(token => token.length > 1));
      return tokens.length ? tokens.filter(token => source.has(token)).length / tokens.length : 0;
    };
    return { group, score: Math.max(overlap(heading) * 1.25, overlap(path)) };
  }).sort((a, b) => b.score - a.score || b.group.length - a.group.length);

  if (scoredGroups[0]?.score >= 0.20) return scoredGroups[0].group;
  return selectMainProduct(products, signals);
}

// Category crawls visit product detail pages to refresh the exact price. A
// detail page may expose recommendation/cross-sell records that inherit the
// current page URL. Select the H1/URL-matching product, but keep explicit
// JSON-LD variant groups (e.g. GymBeam flavours) intact. If the page identity
// is too weak to choose confidently, retain the URL-matched candidates.
export function selectPrimaryProductRecords(products, signals = {}) {
  if (!Array.isArray(products) || !products.length) return [];
  // Accept both the normalized signals produced internally by
  // getProductPageSignals() and raw signals passed by regression tests or
  // other callers. Normalizing here prevents case and URL-hyphen differences
  // from making every candidate score zero.
  const normalizedSignals = {
    ...signals,
    heading: normalizeProductName(signals?.heading || ""),
    path: normalizeProductName(signals?.path || "")
  };
  const selected = selectDirectProductRecords(products, normalizedSignals);
  return selected.length ? selected : products;
}

function selectMainProduct(products, signals) {
  if (!products.length) return [];

  // Always normalize signals at the scoring boundary. Most internal callers
  // already pass normalized values, but the exported selection helper can
  // also receive a raw H1 and a hyphenated URL path.
  const headingText = normalizeProductName(signals?.heading || "");
  const pathText = normalizeProductName(signals?.path || "");
  const headingTokens = new Set(headingText.split(/\s+/).filter(token => token.length > 1));
  const pathTokens = new Set(pathText.split(/\s+/).filter(token => token.length > 1));

  const scoreProduct = product => {
    const name = normalizeProductName(product.name);
    const tokens = [...new Set(name.split(/\s+/).filter(token => token.length > 1))];
    if (!tokens.length) return 0;

    const overlap = source => {
      if (!source.size) return 0;
      return tokens.filter(token => source.has(token)).length / tokens.length;
    };

    let score = Math.max(overlap(headingTokens) * 1.25, overlap(pathTokens));
    // Token overlap alone ties a base model with a longer related model
    // (e.g. "Forze" vs. "Forze-B"). Give an exact H1 or URL identity a
    // decisive bonus so recommendations cannot win merely by source type.
    if (headingText && name === headingText) score += 0.35;
    if (pathText && name === pathText) score += 0.25;
    if (product.source === "metadata") score += 0.08;
    if (product.source === "microdata") score += 0.04;
    return score;
  };

  const ranked = products
    .map((product, index) => ({ product, index, score: scoreProduct(product) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // A direct-product request must never fall back to the first arbitrary card
  // on the page. If no extracted record matches the H1/URL, return no product
  // rather than importing a bestseller or recommendation by mistake.
  const best = ranked[0];
  if (!best || best.score < 0.20) return [];

  // RESTORED FROM GITHUB main / fix/gymbeam-preserve-jsonld-variants.
  // A Product/AggregateOffer can contain several sellable variants. Once the
  // best match is one of those verified JSON-LD offers, retain every sibling
  // offer from the same explicit group instead of collapsing to one flavour.
  if (best.product.isVariant === true &&
      best.product.source === "json-ld-offer-variant" &&
      best.product.variantGroupId) {
    const group = products.filter(product =>
      product.isVariant === true &&
      product.source === "json-ld-offer-variant" &&
      product.variantGroupId === best.product.variantGroupId
    );
    if (group.length >= 2) return group;
  }

  return [best.product];
}

function sortQueue(queue) {
  return queue.sort(
    (a, b) => scoreProductPage(b) - scoreProductPage(a)
  );
}
// Niektore e-shopy (vratane Grandus) vykreslia cisla stran ako JS ovladacie
// prvky namiesto beznych <a href> odkazov. Ak HTML obsahuje rozsah
// "zobrazenych 1 - 32 z celkoveho poctu 473", vieme bezpecne dopoctat
// dalsie strany cez skutocny query parameter, ktory stranka pouziva.
function discoverRangeBasedPagination(html, pageUrl, existingRoot = null) {
  const $ = existingRoot || loadHtml(html);
  const text = normalizeWhitespace($.root().text());

  // Podporujeme viacero tvarov počítadla produktov:
  // "Zobrazených 1 - 40 z 509", "1–40 z 509" aj pôvodný
  // "Zobrazených 1 - 40 z celkového počtu 509".
  // 4home môže vrátiť AJAX fragment bez stránkovania, preto musíme
  // všetky ďalšie strany odvodiť už z prvej kategóriovej stránky.
  const rangePatterns = [
    /(?:zobrazen(?:ych|\u00fdch|o|e|\u00e9)?\s*)?([\d]{1,3}(?:\s[\d]{3})*)\s*[-–]\s*([\d]{1,3}(?:\s[\d]{3})*)\s+z\s+(?:celkov[e\u00e9]ho\s+po[c\u010d]tu\s+)?([\d]{1,3}(?:\s[\d]{3})*)/i,
    /(?:showing|displaying)\s+([\d]{1,3}(?:\s[\d]{3})*)\s*[-–]\s*([\d]{1,3}(?:\s[\d]{3})*)\s+of\s+([\d]{1,3}(?:\s[\d]{3})*)/i
  ];

  let match = null;
  for (const pattern of rangePatterns) {
    match = text.match(pattern);
    if (match) break;
  }

  if (!match) return [];

  const toInt = value => Number(String(value).replace(/\s/g, ""));
  const first = toInt(match[1]);
  const last = toInt(match[2]);
  const total = toInt(match[3]);
  const pageSize = last - first + 1;

  if (
    !Number.isInteger(first) || first < 1 ||
    !Number.isInteger(last) || last < first ||
    !Number.isInteger(total) || total <= last ||
    !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500
  ) {
    return [];
  }

  let current;
  try { current = new URL(pageUrl); } catch { return []; }

  const is4home = /(^|\.)4home\.sk$/i.test(current.hostname);
  const hasUnsupportedCurrentQuery = [...current.searchParams.keys()].some(key =>
    !TRACKING_PARAMS.test(key) &&
    !PAGINATION_PRIMARY_PARAMS.has(key.toLowerCase()) &&
    !PAGINATION_AUX_PARAMS.has(key.toLowerCase()) &&
    !(is4home && ["skip", "ajax_loading"].includes(key.toLowerCase()))
  );
  if (!is4home && hasUnsupportedCurrentQuery) return [];

  const pageParamFromCurrent = getPaginationParam(current);
  let pageParam = pageParamFromCurrent;
  let perPageParam = [...current.searchParams.keys()].find(key => PAGINATION_AUX_PARAMS.has(key.toLowerCase())) || null;

  // If the first page has no page parameter, inspect actual pagination links.
  // Reuse the parameter the store exposes (GymBeam uses `p`); never invent a
  // second alias (`page`) when the page already advertises `p`.
  if (!is4home && !pageParam) {
    $("a[href], link[rel~='next'][href]").each((_, element) => {
      if (pageParam) return;
      let candidate;
      try { candidate = new URL($(element).attr("href"), current.href); } catch { return; }
      if (!isSafePaginationUrl(candidate, current)) return;
      pageParam = getPaginationParam(candidate);
      if (pageParam) {
        const auxiliary = [...candidate.searchParams.keys()].find(key => PAGINATION_AUX_PARAMS.has(key.toLowerCase()));
        if (auxiliary) perPageParam = auxiliary;
      }
    });
  }

  if (!pageParam) pageParam = "page"; // generic fallback only when no query mechanism exists

  const currentPageRaw = current.searchParams.get(pageParam);
  const currentPageValue = Number(currentPageRaw) || 0;
  const currentPage = pageParam === "offset"
    ? Math.max(1, Math.floor(currentPageValue / pageSize) + 1)
    : Math.max(1, currentPageValue || 1);
  const pageCount = Math.ceil(total / pageSize);
  const urls = [];

  for (let page = currentPage + 1; page <= pageCount; page++) {
    const next = new URL(current.origin + current.pathname);
    if (is4home) {
      // Presný XHR endpoint potvrdený v Chrome DevTools používateľa:
      // ?skip=&p=N&ajax_loading=rewrite
      next.searchParams.set("skip", "");
      next.searchParams.set("p", String(page));
      next.searchParams.set("ajax_loading", "rewrite");
    } else {
      next.searchParams.set(pageParam, String(pageParam === "offset" ? (page - 1) * pageSize : page));
      if (perPageParam) next.searchParams.set(perPageParam, String(pageSize));
    }
    urls.push(next.href);
  }

  return urls;
}

// ==========================================
// HLAVNY CRAWLER
// ==========================================

export async function crawlWebsite(inputUrl, options = {}) {
  const startedAt = Date.now();

  // Podpora oboch volani: crawlWebsite(url, 15) aj crawlWebsite(url, { maxPages: 15 }).
  if (typeof options === "number") {
    options = { maxPages: options };
  } else if (!options || typeof options !== "object") {
    options = {};
  }

  const startUrl = parseAndValidateUrl(inputUrl);
  const isFourhomeStart = /(^|\.)4home\.sk$/i.test(startUrl.hostname);
  const crawlTimeLimitMs = isFourhomeStart ? FOURHOME_MAX_TOTAL_TIME_MS : MAX_TOTAL_TIME_MS;

  // Rozlisime priamy produkt, kategoriu a vseobecnu vstupnu URL.
  // Pri kategorii sa nesmie crawler rozbehnut cez navigaciu do celeho e-shopu.
  // Pluralne /products/ casto oznacuje kategoriu, nie detail produktu.
  // Detail sa pri takych URL potvrdi az podla obsahu prvej nacitanej stranky.
  let isDirectProductUrl = /\/(?:p|product|produkt|produkte|item|items|detail|dp)(?:\/|$)/i.test(
    startUrl.pathname
  ) || /\.html?$/i.test(startUrl.pathname);
  // Bezpecny rozsah: ak pouzivatel zada konkretnu podstranku (nie homepage),
  // crawler zostane v jej produktovom/kategoriovom kontexte. Nie kazdy e-shop
  // pouziva slova category/catalog v URL (napr. DAV.sk /chladenie/).
  // Rozsah sa uvolni iba ak prva stranka potvrdi priamy detail produktu.
  const isNonRootStartUrl = startUrl.pathname.replace(/\/+$/, "") !== "";
  let isCategoryScopedCrawl = isNonRootStartUrl || /\/(?:kategoria|category|categories|product-category|product_category|kolekcia|collection|collections|catalog|catalogue|katalog|c|shop)\//i.test(
    startUrl.pathname
  ) || /[?&](?:category|cat|kategoria|collection)=/i.test(startUrl.search);

  const requestedMaxPages = Math.min(
    Math.max(Number(options.maxPages) || MAX_PAGES, 1),
    isFourhomeStart ? FOURHOME_MAX_PAGES : MAX_PAGES
  );
  let maxPages = isDirectProductUrl ? 1 : requestedMaxPages;

  const requestedTotalBytes = Number(options.maxTotalBytes) ||
    (isFourhomeStart ? FOURHOME_MAX_TOTAL_BYTES : MAX_TOTAL_BYTES);
  const maxTotalBytes = Math.min(
    requestedTotalBytes,
    isFourhomeStart ? FOURHOME_MAX_TOTAL_BYTES : MAX_TOTAL_BYTES
  );

  // 4home category crawl stays on its starting category for listing pages.
  // Only product detail URLs discovered from a product card or explicit size
  // selector are also allowed; unrelated navigation remains blocked.
  const fourhomeCategoryPath = isFourhomeStart
    ? startUrl.pathname.replace(/\/+$/, "") || "/"
    : null;

  const canonicalStartUrl = normalizeCrawlPageUrl(startUrl.href);
  const queue = [canonicalStartUrl];
  const queued = new Set(queue);
  const visited = new Set();
  const discoveredProductUrls = new Set();
  // These sets describe real crawl state, not merely discovered links.
  // A detail URL enters queuedCategoryDetailUrls only when it is already in
  // the queue/visited set or is successfully admitted to the queue.
  const queuedCategoryDetailUrls = new Set();
  const visitedCategoryDetailUrls = new Set();
  const candidateProductDetailUrls = new Set();
  const skippedProductDetailUrls = new Set();
  let productDetailLimitReached = false;

  const pages = [];
  const products = [];
  const collectedProductKeys = new Set();
  const detailPageRecordSelection = [];

  let totalBytes = 0;
  let failedPages = 0;
  let failedCategoryPages = 0;
  let failedProductDetailPages = 0;
  let paginationUrlsDiscovered = 0;
  let paginationUrlsQueued = 0;
  let paginationLimitReached = false;
  let ajaxPaginationRequests = 0;

  const robots = await loadRobotsTxt(startUrl.href);

  if (robots.rules === null) {
    throw new Error(
      "Nepodarilo sa overit robots.txt. Import bol z bezpecnostnych dovodov zastaveny."
    );
  }

  while (
    queue.length > 0 &&
    visited.size < maxPages &&
    Date.now() - startedAt < crawlTimeLimitMs &&
    totalBytes < maxTotalBytes
  ) {
    sortQueue(queue);

    const currentUrl = queue.shift();

    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }

    if (isFourhomeStart) {
      let candidateUrl;
      try { candidateUrl = new URL(currentUrl); } catch { continue; }
      const candidatePath = candidateUrl.pathname.replace(/\/+$/, "") || "/";
      const isApprovedProductDetail = discoveredProductUrls.has(normalizeProductUrl(candidateUrl.href));
      if (
        !/(^|\.)4home\.sk$/i.test(candidateUrl.hostname) ||
        (candidatePath !== fourhomeCategoryPath && !isApprovedProductDetail)
      ) {
        continue;
      }
    }

    visited.add(currentUrl);

    const currentIsQueuedProductDetail = isCategoryScopedCrawl &&
      queuedCategoryDetailUrls.has(normalizeProductUrl(currentUrl));
    if (currentIsQueuedProductDetail) {
      // Count a real attempt as visited even when robots, HTTP or extraction
      // subsequently rejects the page. Failures are tracked separately.
      visitedCategoryDetailUrls.add(normalizeProductUrl(currentUrl));
    }

    if (!isAllowedByRobots(robots.rules, currentUrl)) {
      // A product detail excluded by robots is explicitly counted as an
      // incomplete detail scan; it must not disappear from diagnostics.
      if (currentIsQueuedProductDetail) {
        failedPages++;
        failedProductDetailPages++;
        pages.push({ url: currentUrl, error: "robots.txt disallowed product detail", pageType: "product-detail", products: [] });
      } else {
        failedPages++;
        failedCategoryPages++;
        pages.push({ url: currentUrl, error: "robots.txt disallowed page", pageType: "category-or-pagination", products: [] });
      }
      continue;
    }

    try {
      const remainingBytes = maxTotalBytes - totalBytes;

      const requestUrl = new URL(currentUrl);
      const is4homeAjaxPage = /(^|\.)4home\.sk$/i.test(requestUrl.hostname) &&
        requestUrl.searchParams.get("ajax_loading") === "rewrite" &&
        requestUrl.searchParams.has("p");
      if (is4homeAjaxPage) ajaxPaginationRequests++;
      const response = await safeFetchWebsite(
        currentUrl,
        {
          maxBytes: Math.min(
            is4homeAjaxPage ? FOURHOME_MAX_BYTES : MAX_BYTES,
            remainingBytes
          ),
          headers: is4homeAjaxPage ? {
            "Accept": "text/html, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": `${requestUrl.origin}${requestUrl.pathname}`
          } : {}
        }
      );

      totalBytes += response.body.length;

      if (!isHtmlResponse(response.headers)) {
        failedPages++;
        if (currentIsQueuedProductDetail) failedProductDetailPages++;
        else failedCategoryPages++;
        pages.push({
          url: response.url || currentUrl,
          error: "non-HTML response",
          pageType: currentIsQueuedProductDetail ? "product-detail" : "category-or-pagination",
          products: []
        });
        continue;
      }

      const html = response.body.toString("utf8");

      // Parse HTML once and share the DOM across all page-level operations.
      const htmlParseStartedAt = Date.now();
      const pageRoot = loadHtml(html);
      const htmlParseMs = Date.now() - htmlParseStartedAt;
      const pageExtractStartedAt = Date.now();
      const page = extractWebsiteContent(
        html,
        response.url,
        pageRoot
      );
      if (!page || typeof page !== "object") {
        throw new Error("Page extractor returned an invalid result object");
      }
      if (!Array.isArray(page.products)) page.products = [];
      const productExtractionMs = Date.now() - pageExtractStartedAt;

      // Rozpoznaj aj produktove URL bez standardnej cesty /produkt/,
      // napr. /tlakomer-eta-e4297-90000. Kategoriu explicitne chranime.
      const pageSignals = pages.length === 0
        ? getProductPageSignals(html, response.url, page.products, pageRoot)
        : { isDetail: false };

      // A user-supplied .html URL is an explicit single-product intent even when
      // the store omits Product JSON-LD or the buy-box markup is non-standard.
      // Do not let recommendation cards turn that URL into a category crawl.
      const isDirectProductPage = pages.length === 0 && (pageSignals.isDetail || isDirectProductUrl);

      if (isDirectProductPage) {
        page.products = selectDirectProductRecords(page.products, pageSignals);
        if (page.products.length === 1 && page.products[0]) {
          // Keep a single-product canonical URL for ordinary products.
          page.products[0].url = response.url;
        } else {
          // Preserve variant-specific URLs (often canonical URL + #SKU) for
          // each selectable offer. Only fill in a URL when the source omitted it.
          for (const product of page.products) product.url = product.url || response.url;
        }
        isDirectProductUrl = true;
        isCategoryScopedCrawl = false;
        maxPages = 1;
        page.diagnostics = {
          ...(page.diagnostics || {}),
          productPageMode: "single-product"
        };
      }

      // Ak URL nema standardny nazov kategorie, odhalime vypis produktov
      // podla produktovych kariet a odkazov. To pokryva aj vlastne e-shopy.
      const linkExtractionStartedAt = Date.now();
      const hasCompleteJsonLdVariantSet = page.products.some(product =>
        product.isVariant === true && product.source === "json-ld-offer-variant"
      );
      const skipNonEssentialDetailLinks = currentIsQueuedProductDetail && !isFourhomeStart;
      const linkInfo = hasCompleteJsonLdVariantSet || skipNonEssentialDetailLinks
        ? {
            links: [], paginationLinks: [], productLinks: [],
            variantLinks: skipNonEssentialDetailLinks ? extractSizeVariantLinks(pageRoot, response.url) : [],
            otherLinks: []
          }
        : extractWebsiteLinks(
            html,
            response.url,
            { returnMeta: true, root: pageRoot }
          );
      const linkExtractionMs = Date.now() - linkExtractionStartedAt;
      page.diagnostics = {
        ...(page.diagnostics || {}),
        performance: {
          htmlParseMs,
          productExtractionMs,
          linkExtractionMs
        }
      };

      if (!isDirectProductUrl && pages.length === 0 && !isCategoryScopedCrawl) {
        const pagePath = new URL(response.url).pathname.replace(/\/+$/, "");
        const hasProductForCurrentPage = page.products.some(product => {
          try {
            const productUrl = new URL(product.url || product.sourceUrl || response.url, response.url);
            return productUrl.origin === new URL(response.url).origin &&
              productUrl.pathname.replace(/\/+$/, "") === pagePath;
          } catch {
            return false;
          }
        });

        // Neznama URL (napr. /znacka/ alebo /vyrobca/) moze byt katalog.
        // Ak z nej vedu aspon dva nezavisle odkazy z produktovych kariet,
        // obmedzime crawler na strankovanie a detaily tychto produktov.
        // Jedna produktova stranka sa tymto pravidlom nesmie zmenit na katalog.
        const hasListingEvidence =
          linkInfo.productLinks.length >= 2 ||
          page.products.length >= 2 ||
          (linkInfo.productLinks.length >= 1 && linkInfo.paginationLinks.length >= 1);

        if (!hasProductForCurrentPage && hasListingEvidence) {
          isCategoryScopedCrawl = true;
        }
      }

      // Doplnkove zistenie stranok z rozsahu "zobrazenych X - Y z N".
      // Kategoriu najprv rozpoznajeme podla obsahu prvej stranky, az potom
      // dopoctime dalsie stranky. Predchadzajuce poradie tento krok pri
      // SEO URL typu /ulozny-nabytok/ preskocilo.
      const inferredPaginationLinks = isCategoryScopedCrawl
        ? discoverRangeBasedPagination(html, response.url, pageRoot)
        : [];
      const paginationLinks = [...new Set([
        ...linkInfo.paginationLinks,
        ...inferredPaginationLinks
      ])].slice(0, MAX_PAGINATION_LINKS_TOTAL);
      paginationUrlsDiscovered += paginationLinks.length;
      for (const productUrl of linkInfo.productLinks) {
        discoveredProductUrls.add(normalizeProductUrl(productUrl));
      }
      for (const variantUrl of (linkInfo.variantLinks || [])) {
        discoveredProductUrls.add(normalizeProductUrl(variantUrl));
      }

      // A direct product URL normally needs one page. If its page exposes an
      // explicit size selector, allow a bounded visit to the sibling size URLs.
      if (isDirectProductUrl && (linkInfo.variantLinks || []).length > 1) {
        maxPages = Math.min(FOURHOME_MAX_PAGES, 1 + linkInfo.variantLinks.length);
      }

      pages.push(page);

      // Pri importe kategórie navštevujeme aj detaily kvôli presnej mene/cene,
      // ale z detailu preberieme iba samotný produkt danej URL. Odporúčané a
      // súvisiace produkty z detailu sa nesmú pridať do výsledku kategórie.
      const currentPageUrl = new URL(response.url);
      // A URL explicitly queued from a verified product card is a product
      // detail visit even when its slug has no conventional product marker or
      // the server redirects it to a canonical URL. Use the queue as the
      // authoritative signal so coverage counters cannot undercount visits.
      const currentIsProductPage = isDirectProductPage || currentIsQueuedProductDetail ||
        /\/(?:p|product|produkt|produkte|item|items|detail|dp)\//i.test(
          currentPageUrl.pathname
        ) || discoveredProductUrls.has(normalizeProductUrl(response.url)) ||
        discoveredProductUrls.has(normalizeProductUrl(currentPageUrl.href));

      if (currentIsProductPage && isCategoryScopedCrawl) {
        page.diagnostics = { ...(page.diagnostics || {}), productDetailPage: true };
      }

      const pageProducts = (isCategoryScopedCrawl || isDirectProductUrl) && currentIsProductPage
        ? (() => {
            const currentPath = currentPageUrl.pathname.replace(/\/+$/, "");
            const urlMatchedProducts = page.products.filter(product => {
              try {
                const candidate = new URL(
                  product.url || product.sourceUrl || response.url,
                  response.url
                );
                const candidatePath = candidate.pathname.replace(/\/+$/, "");
                return candidate.origin === currentPageUrl.origin &&
                  candidatePath === currentPath;
              } catch {
                return false;
              }
            });
            if (urlMatchedProducts.length <= 1) return urlMatchedProducts;
            const detailSignals = getProductPageSignals(
              html, response.url, urlMatchedProducts, pageRoot
            );
            const selectedProducts = selectPrimaryProductRecords(urlMatchedProducts, detailSignals);
            if (selectedProducts.length < urlMatchedProducts.length) {
              const selectedSet = new Set(selectedProducts);
              const filteredProducts = urlMatchedProducts.filter(product => !selectedSet.has(product));
              detailPageRecordSelection.push({
                url: response.url,
                extractedCandidates: urlMatchedProducts.length,
                retainedCandidates: selectedProducts.length,
                filteredCandidates: filteredProducts.map(product => ({
                  name: product.name || null,
                  source: product.source || null,
                  sku: product.sku || null,
                  gtin: product.gtin || null,
                  price: Number.isFinite(product.price) ? product.price : null,
                  currency: product.currency || null
                }))
              });
            }
            return selectedProducts;
          })()
        : page.products;

      for (const product of pageProducts) {
        // 4home AJAX listing is cumulative. Keep raw page diagnostics intact,
        // but only append each URL+normalized title once during the crawl.
        const identityUrl = normalizeProductUrl(product.url || product.sourceUrl || response.url);
        const identityName = normalizeProductName(product.name || "");
        const identityKey = `${identityUrl}|${identityName}`;
        if (isFourhomeStart && collectedProductKeys.has(identityKey)) continue;
        collectedProductKeys.add(identityKey);
        products.push({
          ...product,
          detailPageVisited: currentIsProductPage ? true : product.detailPageVisited === true,
          listingPageUrl: currentIsProductPage ? (product.listingPageUrl || null) : (product.listingPageUrl || response.url)
        });

        if (products.length >= 5000) {
          break;
        }
      }

      if (products.length >= 5000) {
        break;
      }

      // Detail produktu je konečná cieľová stránka. Pri kategórii sa ďalej
      // prehľadáva iba stránkovanie a konkrétne produktové detaily.
      const variantParentLinks = isFourhomeStart && isCategoryScopedCrawl && !currentIsProductPage
        ? page.products
            .filter(product => product.variantDiscoveryCandidate === true && product.url)
            .map(product => product.url)
            .slice(0, FOURHOME_MAX_VARIANT_PARENT_PAGES)
        : [];
      for (const variantParentUrl of variantParentLinks) {
        discoveredProductUrls.add(normalizeProductUrl(variantParentUrl));
      }

      // Universal category -> product-detail discovery. All product URLs
      // identified inside verified product cards are visited under a strict
      // cap, not only 4home or cards whose price starts with "od".
      const genericDetailLinks = !isFourhomeStart && isCategoryScopedCrawl && !currentIsProductPage
        ? linkInfo.productLinks.filter(url => {
            const registration = registerCategoryProductDetailCandidate(
              url,
              candidateProductDetailUrls,
              skippedProductDetailUrls,
              MAX_CATEGORY_DETAIL_PAGES
            );
            if (registration.status === "duplicate") return false;
            if (registration.status === "limit") {
              productDetailLimitReached = true;
              return false;
            }
            // Do not call a URL "queued" here: it has not yet passed the
            // crawler's queue-capacity and duplicate checks below.
            discoveredProductUrls.add(registration.url);
            return true;
          })
        : [];

      const links = isDirectProductUrl
        ? linkInfo.variantLinks
        : currentIsProductPage
          // On a product detail page follow only links found inside an explicit
          // size-variant selector, never colour siblings/recommendations.
          ? linkInfo.variantLinks
          : isCategoryScopedCrawl
            ? [...paginationLinks, ...variantParentLinks, ...genericDetailLinks]
            : linkInfo.links;
      const genericDetailCrawlUrls = new Set(genericDetailLinks.map(normalizeCrawlPageUrl));

      for (const rawLink of links) {
        const link = normalizeCrawlPageUrl(rawLink);
        const isPaginationCandidate = paginationLinks.includes(rawLink);
        const isGenericProductDetailCandidate = genericDetailCrawlUrls.has(link);
        if (isPaginationCandidate && paginationUrlsQueued >= MAX_PAGINATION_LINKS_TOTAL) {
          paginationLimitReached = true;
          continue;
        }
        const normalizedDetailUrl = isGenericProductDetailCandidate
          ? normalizeProductUrl(link)
          : null;

        // If another discovery path already put this URL in the queue, it is
        // still a legitimate queued detail URL. Likewise, if it was visited
        // earlier in this crawl, its visit must count toward detail coverage.
        if (isGenericProductDetailCandidate && (queued.has(link) || visited.has(link))) {
          queuedCategoryDetailUrls.add(normalizedDetailUrl);
          // A URL may have been crawled earlier through another discovery path
          // (for example pagination) before it was recognized as a product detail.
          // It is still a real detail visit and must count toward coverage.
          if (visited.has(link)) {
            visitedCategoryDetailUrls.add(normalizedDetailUrl);
          }
        }

        if (!queued.has(link) && !visited.has(link)) {
          if (
            queue.length >= MAX_QUEUE ||
            visited.size + queue.length >= MAX_QUEUE + MAX_PAGES
          ) {
            if (isGenericProductDetailCandidate) productDetailLimitReached = true;
            if (isPaginationCandidate) paginationLimitReached = true;
            continue;
          }

          queued.add(link);
          queue.push(link);
          if (isGenericProductDetailCandidate) {
            queuedCategoryDetailUrls.add(normalizedDetailUrl);
          }
          if (isPaginationCandidate) paginationUrlsQueued++;
        }
      }
    } catch (error) {
      failedPages++;
      if (currentIsQueuedProductDetail) failedProductDetailPages++;
      else failedCategoryPages++;

      pages.push({
        url: currentUrl,
        error: String(error?.message || error || "Unknown page extraction error"),
        errorStack: String(error?.stack || "").split("\n").slice(0, 6),
        pageType: currentIsQueuedProductDetail ? "product-detail" : "category-or-pagination",
        products: []
      });
    }

    if (queue.length > 0) {
      // Sequential crawling only: product details get a longer delay to reduce
      // rate limiting. Category pagination keeps the established delay.
      await sleep(currentIsQueuedProductDetail ? PRODUCT_DETAIL_REQUEST_DELAY_MS : REQUEST_DELAY_MS);
    }
  }

  let uniqueProducts = deduplicateProducts(products).map(inferPackageMeasureFromUnitPrice);
  const explicitVariantUrls = new Set(uniqueProducts
    .filter(product => product.isVariant === true && product.source === "json-ld-offer-variant")
    .map(product => normalizeProductUrl(product.url || product.sourceUrl || "")));
  if (explicitVariantUrls.size) {
    uniqueProducts = uniqueProducts.filter(product =>
      product.isVariant === true || !explicitVariantUrls.has(normalizeProductUrl(product.url || product.sourceUrl || ""))
    );
  }
  const detectedVariantGroups = new Set(uniqueProducts
    .filter(product => product.isVariant === true && product.variantGroupName)
    .map(product => normalizeProductName(product.variantGroupName)));
  if (detectedVariantGroups.size) {
    uniqueProducts = uniqueProducts.filter(product =>
      !(product.variantDiscoveryCandidate === true && detectedVariantGroups.has(normalizeProductName(product.name)))
    );
  }

  let stopReason = null;
  if (paginationLimitReached) stopReason = "pagination-limit";
  if (!stopReason && queue.length > 0) {
    if (visited.size >= maxPages) stopReason = "max-pages";
    else if (Date.now() - startedAt >= crawlTimeLimitMs) stopReason = "time-limit";
    else if (totalBytes >= maxTotalBytes) stopReason = "max-total-bytes";
    else if (queue.length >= MAX_QUEUE) stopReason = "max-queue";
  }

  const errors = pages.filter(page => page.error).map(page => ({
    url: page.url,
    error: page.error,
    ...(Array.isArray(page.errorStack) && page.errorStack.length ? { stack: page.errorStack } : {})
  }));

  const diagnostics = {
    importerVersion: "V3.86.5",
    errorDetails: errors.slice(0, 10),
    productDetailCandidatesDiscovered: candidateProductDetailUrls.size + skippedProductDetailUrls.size,
    productDetailCandidatesAdmitted: candidateProductDetailUrls.size,
    productDetailCandidatesSkippedByLimit: skippedProductDetailUrls.size,
    productDetailCandidatesSkippedByLimitSample: [...skippedProductDetailUrls].slice(0, 10),
    productDetailUrlsQueued: queuedCategoryDetailUrls.size,
    productDetailLimit: MAX_CATEGORY_DETAIL_PAGES,
    productDetailCoverageLimited: productDetailLimitReached,
    productDetailLimitReached,
    // Count actual dequeued detail URLs, not only successful page objects
    // carrying an extraction marker. This includes failed attempts and avoids
    // false mismatches caused by redirect/normalization or error branches.
    productDetailPagesVisited: visitedCategoryDetailUrls.size,
    productDetailPagesSuccessful: pages.filter(page => page.diagnostics?.productDetailPage === true && !page.error).length,
    productDetailUrlsQueuedList: [...queuedCategoryDetailUrls],
    productDetailUrlsVisitedList: [...visitedCategoryDetailUrls],
    productDetailUrlsNotVisited: [...queuedCategoryDetailUrls].filter(url => !visitedCategoryDetailUrls.has(url)),
    primaryProductBuyBoxPages: pages.filter(page => page.diagnostics?.primaryProductBuyBox === true).length,
    productDetailPagesWithZeroProducts: pages.filter(page => page.diagnostics?.productDetailPage === true && (!Array.isArray(page.products) || page.products.length === 0)).length,
    productDetailPagesWithMultipleRawProducts: pages.filter(page => page.diagnostics?.productDetailPage === true && Array.isArray(page.products) && page.products.length > 1).length,
    productDetailPagesWithExtraRecordsFiltered: detailPageRecordSelection.length,
    productDetailExtraRecordsFiltered: detailPageRecordSelection.reduce((sum, item) => sum + (item.extractedCandidates - item.retainedCandidates), 0),
    productDetailExtraRecordsFilteredList: detailPageRecordSelection,
    categoryPagesFailed: failedCategoryPages,
    productDetailPagesFailed: failedProductDetailPages,
    productDetailRequestConcurrency: 1,
    productDetailRequestDelayMs: PRODUCT_DETAIL_REQUEST_DELAY_MS,
    packageMeasuresCalculatedFromUnitPrice: uniqueProducts.filter(product => product.packageMeasureDerived === true).length,
    productsWithPackageOptions: uniqueProducts.filter(product => Array.isArray(product.packageOptions) && product.packageOptions.length > 0).length,
    packageOptionsDetected: uniqueProducts.reduce((sum, product) => sum + (Array.isArray(product.packageOptions) ? product.packageOptions.length : 0), 0),
    productsWithVariantOptions: uniqueProducts.filter(product => Array.isArray(product.variantOptions) && product.variantOptions.length > 0).length,
    variantOptionsDetected: uniqueProducts.reduce((sum, product) => sum + (Array.isArray(product.variantOptions) ? product.variantOptions.length : 0), 0),
    variantProducts: uniqueProducts.filter(product => product.isVariant === true).length,
    variantGroups: new Set(uniqueProducts.filter(product => product.isVariant === true).map(product => product.variantGroupId)).size,
    pagesVisited: visited.size,
    pagesSuccessful: pages.filter(page => !page.error).length,
    pagesFailed: failedPages,
    queueRemaining: queue.length,
    stopReason,
    totalBytes,
    productsFound: uniqueProducts.length,
    paginationUrlsDiscovered,
    paginationUrlsQueued,
    paginationLimitReached,
    ajaxPaginationRequests,
    limits: {
      maxPages,
      maxTotalBytes,
      maxResponseBytes: isFourhomeStart ? FOURHOME_MAX_BYTES : MAX_BYTES,
      maxTotalTimeMs: crawlTimeLimitMs,
      maxQueue: MAX_QUEUE
    },
    timeMs: Date.now() - startedAt,
    pagePerformance: pages.filter(page => page.diagnostics?.performance).map(page => ({
      url: page.url,
      htmlParseMs: page.diagnostics.performance.htmlParseMs,
      productExtractionMs: page.diagnostics.performance.productExtractionMs,
      linkExtractionMs: page.diagnostics.performance.linkExtractionMs
    })),
    extractionMethods: {
      jsonLd: 0,
      microdata: 0,
      metadata: 0,
      embeddedJson: 0,
      htmlCards: 0,
      fourhomeCards: 0,
      astroProductIslandFallback: 0
    }
  };

  for (const page of pages) {
    if (!page.diagnostics) continue;

    for (const key of Object.keys(diagnostics.extractionMethods)) {
      diagnostics.extractionMethods[key] +=
        page.diagnostics[key] || 0;
    }
  }

  return {
    url: startUrl.href,
    startUrl: startUrl.href,
    pages,
    pagesScanned: visited.size,
    products: uniqueProducts,
    errors,
    totalBytes,
    stopReason,
    diagnostics
  };
}

// ==========================================
// KOMPATIBILITA SO STARYM SERVER.JS
// ==========================================

export async function extractProductsFromWebsite(
  inputUrl,
  options = {}
) {
  const result = await crawlWebsite(inputUrl, options);

  return {
    products: result.products,
    pages: result.pages,
    diagnostics: result.diagnostics
  };
}