import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import ipaddr from "ipaddr.js";
import { load as loadHtml } from "cheerio";

// ==========================================
// NOVA AI - WEBSITE IMPORTER V3.66
// Universal product import: structured data, listings, flexible product detail pricing, variants and deduplication
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
const MAX_CATEGORY_DETAIL_PAGES = 150;

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
  const keys = ["netWeight", "packageWeight", "weight", "netContent", "contentSize", "fluidVolume", "volume"];
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
  return { packageQuantity: null, packageUnit: null, packageMeasureSource: null };
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

  // Accept only labels that explicitly describe the product's net/package
  // contents. This intentionally excludes generic "hmotnosť" and nutrition
  // table reference quantities such as 100 g.
  const match = text.match(/(?:netto\s*(?:(?:váha|hmotnosť|obsah))?|net\s*(?:weight|mass|content)|čist(?:á|a)\s*(?:hmotnosť|váha)|hmotnosť\s*(?:balenia|produktu)|váha\s*(?:balenia|produktu)|netto\s*weight|package\s*(?:weight|content)|obsah\s*balenia|objem\s*balenia)\s*(?:\((kg|g|ml|l)\))?\s*[:：-]?\s*(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)?\b/i);
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

  // Explicit net/package weight wins over generic structured weight fields.
  // This prevents a nutrition-table value (e.g. 100 g) from masking the
  // actual package label (e.g. "Netto váha: 1.00 kg").
  const explicitNetPackageMeasure = extractExplicitNetPackageMeasureFromText(fullTextForPackage);
  if (explicitNetPackageMeasure) {
    return { ...explicitNetPackageMeasure, packageOptions: null };
  }

  const selectors = [
    "[itemprop='weight']", "[itemprop='netWeight']", "[itemprop='netContent']",
    "[data-net-weight]", "[data-package-weight]", "[data-weight]",
    ".product-weight", ".net-weight", ".package-weight", ".product-card__weight",
    ".product-detail__weight", ".product-detail-weight"
  ];
  for (const selector of selectors) {
    const node = container.find(selector).first();
    if (!node.length) continue;
    const raw = node.attr("content") || node.attr("data-net-weight") ||
      node.attr("data-package-weight") || node.attr("data-weight") || node.text();
    const measure = extractPackageMeasure({ weight: {
      value: raw,
      unitCode: node.attr("data-unit-code") || node.attr("data-weight-unit") || node.attr("data-unit"),
      unitText: node.attr("data-unit-text") || node.attr("data-weight-unit") || node.attr("data-unit")
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
  const labelMatch = labelledText.match(/(?:netto\s*(?:váha|hmotnosť)|čistá\s+hmotnosť|hmotnosť\s+balenia|obsah\s+balenia|net\s+weight|package\s+weight|net\s+content|veľkosť\s+balenia|kapsuly|počet\s+kapsúl|capsules?)\s*:?\s*([^|;,]{1,60})/i);
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

    prices.push({
      price,
      packagePrice: rawPackagePrice != null ? price : null,
      unitPrice: unitPrice != null && unitSpecification ? unitPrice : null,
      unitPriceUnit: unitPriceUnit || null,
      priceBasis: rawPackagePrice != null ? "offer-price" : "unspecified-price-specification",
      currency,
      availability: offer.availability || null,
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
    sku: scalar(value.sku, value.SKU, value.itemNumber, value.item_number, value.articleNumber, value.article_number),
    gtin: scalar(value.gtin, value.gtin8, value.gtin12, value.gtin13, value.gtin14, value.ean, value.ean13, value.barcode),
    mpn: scalar(value.mpn, value.MPN, value.manufacturerPartNumber, value.manufacturer_part_number),
    productId: scalar(value.productID, value.productId, value.product_id, value.id, value.itemId, value.item_id),
    brand: scalar(brandValue)
  };
  return Object.fromEntries(Object.entries(identifiers).filter(([, item]) => item));
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
    unit: offer.unit || null,
    ...extractPackageMeasure(node, offer),
    url: productUrl,
    image,
    ...extractProductIdentifiers(node),
    source: "json-ld"
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
    const packageMeasure = sizeText ? parseExplicitPackageLabel(sizeText) : null;
    const color = cleanText(offer.color?.name || offer.color || itemOffered.color?.name || itemOffered.color || "", 120);
    const sku = cleanText(offer.sku || offer.productID || itemOffered.sku || "", 160);
    const variantLabel = [sizeText, color].filter(Boolean).join(" / ");
    const name = offerName || (variantLabel ? `${baseName} — ${variantLabel}` : baseName);
    const signature = [sku, sizeText, color, price, currency].join("|").toLowerCase();
    if (seen.has(signature)) continue;
    seen.add(signature);

    const { unitPrice, unitPriceUnit } = getJsonLdOfferUnitPrice(offer);
    let url = offer.url || itemOffered.url || productUrl;
    try { url = new URL(url, pageUrl).href; } catch { url = productUrl; }
    const imageCandidate = Array.isArray(itemOffered.image) ? itemOffered.image[0] : itemOffered.image;
    const image = typeof imageCandidate === "string" ? imageCandidate : imageCandidate?.url || baseImage;
    const identifiers = extractProductIdentifiers({ ...node, ...itemOffered, ...offer });
    const groupId = cleanText(node.productGroupID || node.sku || productUrl, 300);

    records.push({
      name,
      price,
      packagePrice: price,
      currency,
      priceBasis: "json-ld-variant-offer",
      unitPrice,
      unitPriceUnit: unitPriceUnit || null,
      availability: offer.availability || null,
      unit: extractStructuredUnit(offer),
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
        ...(sku ? { sku } : {})
      },
      source: "json-ld-offer-variant"
    });
  }

  // Do not expand a collection of ordinary offers unless at least two offers
  // carry explicit variant identity. This prevents price tiers from becoming variants.
  const identifiable = records.filter(item => item.packageQuantity != null ||
    Object.keys(item.variantAttributes || {}).length > 1 || item.variantAttributes?.sku);
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
          products.push({
          ...product,
          detailPageVisited: currentIsProductPage ? true : product.detailPageVisited === true,
          listingPageUrl: currentIsProductPage ? (product.listingPageUrl || null) : (product.listingPageUrl || response.url)
        });
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
      if (product) products.push(product);
    }
  });

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
      name, price, currency, availability: null, unit, ...packageMeasure, url: productUrl, image,
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

  const rawPrice =
    defaultPrice?.price ??
    nestedPrice?.value ??
    value.product_final_price ??
    value.product_base_price ??
    value.price ??
    value.finalPrice ??
    value.salePrice ??
    value.currentPrice;

  const price = parsePrice(rawPrice);
  const typeText = Array.isArray(value["@type"])
    ? value["@type"].join(" ")
    : String(value["@type"] || "");
  const explicitProductType = /(?:^|\s|\/)Product(?:$|\s)/i.test(typeText);
  const hasProductIdentifier = Boolean(
    value.sku || value.productId || value.product_id ||
    (value.id && (value.product_variants || value.product_images || value.categories || value.attributes))
  );
  const hasOffer = Boolean(value.offers && getOfferPrice(value.offers));
  const hasCurrency = Boolean(normalizeCurrency(
    defaultPrice?.currencyCode ||
    defaultPrice?.currency ||
    nestedPrice?.currency ||
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
      currency: normalizeCurrency(
        defaultPrice?.currencyCode ||
        defaultPrice?.currency ||
        value.priceCurrency ||
        value.currency
      ),
      availability:
        value.availability ||
        value.availabilityText ||
        null,
      unit: extractStructuredUnit(value, defaultPrice),
      ...extractPackageMeasure(value, defaultPrice),
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
    packagePrice: price,
    currency,
    priceType: "bežná predajná cena",
    availability: product.available_in_stock === true || product.is_available === true ? "InStock" : null,
    unit: "neuvedené",
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

function extractCardPrice($, container) {
  const selectors = [
    "[itemprop='price']", "[data-price]", ".price-current",
    ".current-price", ".product-price", ".product__price",
    ".product-card__price", ".price-value", ".price"
  ];
  const cardText = container.text();
  const primary = selectPrimaryCurrencyPrice(cardText);

  for (const selector of selectors) {
    const elements = container.find(selector).toArray();
    for (const node of elements) {
      const element = $(node);
      const raw = element.attr("content") || element.attr("data-price") ||
        element.attr("value") || element.text();
      const price = parsePrice(raw);
      if (price == null) continue;
      const rawHasCurrency = /(?:EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$)/i.test(String(raw));
      if (rawHasCurrency && (!primary || price === primary.price)) return price;
      // Bare numeric price attributes are accepted only when they match the
      // selected currency-qualified selling price, never a model/spec number.
      if (!rawHasCurrency && primary && price === primary.price) return price;
    }
  }

  return primary ? primary.price : null;
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
        const explicitCardPrice = extractCardPrice($, card);
        const selectedTextPrice = selectPrimaryCurrencyPrice(candidateText);
        const parsed = selectedTextPrice &&
          (explicitCardPrice == null || explicitCardPrice === selectedTextPrice.price)
          ? selectedTextPrice
          : null;

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
    const price = extractCardPrice($, container);
    const priceDetails = selectPrimaryCurrencyPrice(container.text());

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

    const currency = normalizeCurrency(
      container.text().match(
        /EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$/i
      )?.[0]
    );

    products.push({
      name,
      price,
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
        candidates.push({ parsed, distance: titleDistance, productAction, semantic, inMain, textLength: chosenScopeText.length });
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
    currency,
    availability: /skladom|na sklade|in stock/i.test(bodyText) ? "InStock" : null,
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
  const sourceRank = source => {
    const value = String(source || "");
    // The visible, selected purchase offer is the authoritative current price
    // for the exact package selected in the main buy box.
    if (value.includes("primary-product-buybox")) return 110;
    if (value.includes("json-ld")) return 100;
    if (value.includes("microdata")) return 95;
    if (value.includes("embedded-json")) return 90;
    if (value.includes("html-card")) return 80;
    if (value.includes("linked-product-card")) return 75;
    if (value.includes("detail-page-fallback")) return 65;
    if (value.includes("metadata")) return 40;
    return 10;
  };

  for (const rawProduct of products) {
    if (!rawProduct) continue;
    const product = { ...rawProduct, name: cleanProductTitle(rawProduct.name) };
    if (!product.name || !isLikelyRealProductName(product.name) ||
        !Number.isFinite(product.price) || product.price <= 0) continue;

    const url = normalizeProductUrl(product.url || product.sourceUrl || "");
    // Keep distinct items on a category URL, but merge conflicting extraction
    // methods for the same product URL and title instead of importing twice.
    const key = `${url}|${normalizeProductName(product.name)}`;
    const existingIndex = byIdentity.get(key);
    if (existingIndex !== undefined) {
      const existing = result[existingIndex];
      const previousSource = existing.source || "";
      if (sourceRank(product.source) > sourceRank(existing.source)) {
        const merged = { ...existing, ...product };
        if (!product.currency && existing.currency) merged.currency = existing.currency;
        if ((!product.unit || product.unit === "neuvedené") && existing.unit) merged.unit = existing.unit;
        if (!product.image && existing.image) merged.image = existing.image;
        if (!product.availability && existing.availability) merged.availability = existing.availability;
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
        if ((!existing.currency || existing.currency === "NEZNAMA") && product.currency) existing.currency = product.currency;
        if ((!existing.unit || existing.unit === "neuvedené") && product.unit && product.unit !== "neuvedené") existing.unit = product.unit;
        if (!existing.image && product.image) existing.image = product.image;
        if (!existing.availability && product.availability) existing.availability = product.availability;
        for (const field of ["unitPrice", "unitPriceUnit", "packagePrice", "packageQuantity", "packageUnit", "packageLabel", "packageMeasureSource", "sku", "gtin", "mpn", "productId"]) {
          if (existing[field] == null && product[field] != null) existing[field] = product[field];
        }
        if (Array.isArray(product.packageOptions) && product.packageOptions.length && (!Array.isArray(existing.packageOptions) || !existing.packageOptions.length)) {
          existing.packageOptions = product.packageOptions;
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
    const selectedVariants = deduplicateProducts(jsonLdVariantSet).slice(0, MAX_PRODUCTS_PER_PAGE);
    return {
      products: selectedVariants,
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
        total: selectedVariants.length
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
    const bodyMeasure = extractPackageMeasureFromDom($, $("body"));
    if (bodyMeasure && (bodyMeasure.packageQuantity != null || Array.isArray(bodyMeasure.packageOptions))) {
      products = products.map((product, index) => {
        // When the page identity is available, update only the matching main
        // product record(s), never unrelated recommendations on the page.
        if (primaryPageProductIndexes.size > 0 && !primaryPageProductIndexes.has(index)) return product;
        return {
          ...product,
          ...(bodyMeasure.packageQuantity != null ? {
            packageQuantity: bodyMeasure.packageQuantity,
            packageUnit: bodyMeasure.packageUnit,
            packageLabel: bodyMeasure.packageLabel || `${bodyMeasure.packageQuantity} ${bodyMeasure.packageUnit}`,
            packageMeasureSource: bodyMeasure.packageMeasureSource
          } : {}),
          ...(bodyMeasure.packageOptions?.length ? { packageOptions: bodyMeasure.packageOptions } : {})
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
function extractSizeVariantLinks($, pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return []; }
  const markerPattern = /(?:veľkostn[eé]\s+varianty|velkostn[eé]\s+varianty|size\s+variants|choose\s+(?:a\s+)?size|select\s+(?:a\s+)?size)/i;
  const sizePattern = /(\d{2,3})\s*(?:[-–]\s*)?[x×]\s*(?:[-–]\s*)?(\d{2,3})(?:\s*\+\s*(\d{1,3}))?\s*(?:cm)?/i;
  const results = new Map();

  // 4home's current explicit size selector. Its anchor labels are the
  // authoritative sizes (some legacy href slugs contain a typo).
  $(".size-selector a[href], .size-variant a[href], #size-variant-blurable a[href]").each((_, anchorNode) => {
    const anchor = $(anchorNode);
    let parsed;
    try { parsed = new URL(anchor.attr("href"), pageUrl); } catch { return; }
    if (parsed.origin !== origin) return;
    const label = cleanText(anchor.attr("title") || anchor.attr("aria-label") || anchor.text() || anchor.find("img").first().attr("alt"), 180);
    const dimensionMatch = label.match(sizePattern) || decodeURIComponent(parsed.pathname).match(sizePattern);
    if (!dimensionMatch) return;
    parsed.hash = "";
    const size = `${dimensionMatch[1]} x ${dimensionMatch[2]}${dimensionMatch[3] ? ` + ${dimensionMatch[3]}` : ""} cm`;
    results.set(normalizeProductUrl(parsed.href), { url: parsed.href, size, label: label || size });
  });
  if (results.size >= 2) return [...results.values()];

  $("p,div,span,h2,h3,h4,strong,b,legend,label").each((_, markerNode) => {
    const marker = $(markerNode);
    const markerText = cleanText(marker.text(), 140);
    if (!markerPattern.test(markerText)) return;

    let scope = marker;
    for (let depth = 0; depth < 5 && scope.length; depth++) {
      scope = scope.parent();
      if (!scope.length) break;
      const scopeText = cleanText(scope.text(), 2600);
      if (scopeText.length > 2600) continue;

      const options = [];
      scope.find("a[href]").each((__, anchorNode) => {
        const anchor = $(anchorNode);
        let parsed;
        try { parsed = new URL(anchor.attr("href"), pageUrl); } catch { return; }
        if (parsed.origin !== origin || /\.(?:jpg|jpeg|png|gif|webp|svg|pdf|zip)$/i.test(parsed.pathname)) return;
        const label = cleanText(anchor.attr("title") || anchor.attr("aria-label") || anchor.text() || anchor.find("img").first().attr("alt"), 180);
        const dimensionMatch = `${label} ${decodeURIComponent(parsed.pathname)}`.match(sizePattern);
        if (!dimensionMatch) return;
        parsed.hash = "";
        const size = `${dimensionMatch[1]} x ${dimensionMatch[2]}${dimensionMatch[3] ? ` + ${dimensionMatch[3]}` : ""} cm`;
        options.push({ url: parsed.href, size, label: label || size });
      });

      const unique = [...new Map(options.map(option => [normalizeProductUrl(option.url), option])).values()];
      if (unique.length >= 2 && unique.length <= 20) {
        for (const option of unique) results.set(normalizeProductUrl(option.url), option);
        return false;
      }
    }
  });

  return [...results.values()];
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
  const dimensionMatch = `${product.name || ""} ${product.url || ""}`.match(/(\d{2,3})\s*[x×]\s*(\d{2,3})(?:\s*\+\s*(\d{1,3}))?\s*(?:cm)?/i);
  // The explicit selector label is authoritative. Some 4home legacy slugs
  // contain a mismatched size even though the visible anchor label is correct.
  if (!matchingOption && !dimensionMatch) return product;
  const size = matchingOption?.size || `${dimensionMatch[1]} x ${dimensionMatch[2]}${dimensionMatch[3] ? ` + ${dimensionMatch[3]}` : ""} cm`;
  const baseName = cleanText(String(product.name || "").replace(/[,\s-]*\d{2,3}\s*[x×]\s*\d{2,3}(?:\s*\+\s*\d{1,3})?\s*(?:cm)?\s*$/i, ""), 250);
  if (!baseName || normalizeProductName(baseName).length < 8) return product;
  const matchingCurrentUrl = variantLinks.some(option => normalizeProductUrl(option.url) === normalizeProductUrl(product.url));
  if (!matchingCurrentUrl) return product;
  const slugCounts = new Map();
  for (const option of variantLinks) {
    try {
      const slug = new URL(option.url).pathname
        .replace(/[,\s-]*\d{2,3}\s*(?:[-x×]\s*){1,2}\d{2,3}(?:\s*\+\s*\d{1,3})?(?:\s*cm)?\/?$/i, "")
        .replace(/[-,\s]+$/g, "");
      if (slug) slugCounts.set(slug, (slugCounts.get(slug) || 0) + 1);
    } catch {}
  }
  const canonicalSlug = [...slugCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || baseName;
  return {
    ...product,
    isVariant: true,
    variantGroupId: `size:${normalizeProductName(canonicalSlug)}`,
    variantGroupName: baseName,
    variantName: size,
    variantAttributes: { ...(product.variantAttributes || {}), size },
    variantCount: variantLinks.length
  };
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
      } else if (isProductPath(url.pathname) || productContext) {
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

function selectMainProduct(products, signals) {
  if (!products.length) return [];

  const headingTokens = new Set((signals.heading || "").split(/\\s+/).filter(token => token.length > 1));
  const pathTokens = new Set((signals.path || "").split(/\\s+/).filter(token => token.length > 1));

  const scoreProduct = product => {
    const name = normalizeProductName(product.name);
    const tokens = [...new Set(name.split(/\\s+/).filter(token => token.length > 1))];
    if (!tokens.length) return 0;

    const overlap = source => {
      if (!source.size) return 0;
      return tokens.filter(token => source.has(token)).length / tokens.length;
    };

    let score = Math.max(overlap(headingTokens) * 1.25, overlap(pathTokens));
    if (product.source === "metadata") score += 0.08;
    if (product.source === "microdata") score += 0.04;
    return score;
  };

  const ranked = products
    .map((product, index) => ({ product, index, score: scoreProduct(product) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // Keep every verified offer in the winning JSON-LD variant group. Selecting
  // only the best-scoring flavour silently discarded its sibling variants.
  const best = ranked[0];
  if (best.score < 0.20) return [];
  if (best.product.isVariant === true && best.product.variantGroupId &&
      best.product.source === "json-ld-offer-variant") {
    const group = products.filter(product =>
      product.isVariant === true &&
      product.source === "json-ld-offer-variant" &&
      product.variantGroupId === best.product.variantGroupId
    );
    if (group.length >= 2) return group;
  }

  // Keep ordinary detail-page selection strict; never fall back to unrelated cards.
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
// DIAGNOSTIKA HTTP ODPOVEDE (GYMBEAM / JS STOREFRONTS)
// ==========================================

// Ukladá iba obmedzené metadáta odpovede. Nezapisuje celé HTML ani cookies,
// autorizačné hlavičky alebo iné citlivé údaje.
function buildResponseAudit(html, root, response) {
  const $ = root;
  const bodyText = cleanText($("body").text() || $.root().text(), 1600);
  const title = cleanText($("title").first().text(), 240);
  const canonical = $("link[rel='canonical']").first().attr("href") || null;
  const ogTitle = cleanText($("meta[property='og:title']").attr("content") || "", 240);
  const description = cleanText(
    $("meta[name='description']").attr("content") ||
    $("meta[property='og:description']").attr("content") || "", 360
  );
  const scripts = $("script");
  const scriptTypes = {};
  const structuredData = [];
  const dataScripts = [];
  const htmlSource = String(html || "");
  const maxBlockChars = 16000;

  const compact = value => {
    try {
      return JSON.stringify(value).slice(0, maxBlockChars);
    } catch {
      return String(value || "").slice(0, maxBlockChars);
    }
  };

  scripts.each((index, node) => {
    const type = String($(node).attr("type") || "classic").trim().toLowerCase();
    const raw = String($(node).html() || "").trim();
    scriptTypes[type] = (scriptTypes[type] || 0) + 1;

    if (type === "application/ld+json") {
      const parsed = parseJsonSafe(raw);
      structuredData.push({
        index,
        parsed: parsed !== null,
        chars: raw.length,
        content: parsed !== null ? compact(parsed) : raw.slice(0, maxBlockChars)
      });
      return;
    }

    if (type === "application/json") {
      const parsed = parseJsonSafe(raw);
      dataScripts.push({
        index,
        type,
        id: $(node).attr("id") || null,
        parsed: parsed !== null,
        chars: raw.length,
        content: parsed !== null ? compact(parsed) : raw.slice(0, maxBlockChars)
      });
      return;
    }

    if (raw && /protein.?latte|gymbeam|product|offers?|price|variant|sku|ecommerce/i.test(raw)) {
      const matches = [...raw.matchAll(/protein.?latte|45[,.]95|price|offers?|variant|sku|product/ig)].slice(0, 12);
      dataScripts.push({
        index,
        type,
        id: $(node).attr("id") || null,
        chars: raw.length,
        relevantMatches: matches.map(match => ({
          term: match[0],
          snippet: raw.slice(Math.max(0, match.index - 350), Math.min(raw.length, match.index + 900))
        }))
      });
    }
  });

  const htmlSnippets = [];
  const htmlPatterns = [
    /protein.?latte/ig,
    /45[,.]95/ig,
    /priceCurrency/ig,
    /"price"\s*:/ig,
    /"offers"\s*:/ig,
    /"@type"\s*:\s*"Product/ig
  ];
  for (const pattern of htmlPatterns) {
    let match;
    let count = 0;
    while ((match = pattern.exec(htmlSource)) && count < 5) {
      htmlSnippets.push({
        term: match[0],
        index: match.index,
        snippet: htmlSource.slice(Math.max(0, match.index - 450), Math.min(htmlSource.length, match.index + 1200))
      });
      count++;
    }
  }

  const bodyLower = bodyText.toLowerCase();
  const htmlLower = htmlSource.slice(0, 2_000_000).toLowerCase();
  const signals = {
    captcha: /captcha|hcaptcha|g-recaptcha|cf-turnstile/.test(htmlLower),
    cloudflareChallenge: /cf-challenge|challenge-platform|just a moment|attention required/.test(htmlLower),
    botProtection: /access denied|automated requests|unusual traffic|bot detection|request blocked/.test(bodyLower),
    javascriptRequired: /enable javascript|javascript is required|please enable javascript/.test(bodyLower),
    astro: $("astro-island").length > 0 || /astro-island|astro\//i.test(htmlSource),
    productSchema: /"@type"\s*:\s*"(?:Product|ProductGroup)"/i.test(htmlSource) ||
      $("[itemtype*='schema.org/Product']").length > 0,
    priceMarkers: /itemprop=["']price|priceCurrency|\bprice\b|cena|€|eur/i.test(htmlLower),
    gymbeamBrand: /gymbeam/i.test((title + " " + ogTitle + " " + bodyText).toLowerCase())
  };
  const headers = response?.headers || {};
  const safeHeader = name => {
    const value = headers[name];
    return value == null ? null : String(value).slice(0, 240);
  };
  return {
    httpStatus: Number(response?.statusCode || 0),
    finalUrl: String(response?.url || "").slice(0, 1000),
    contentType: safeHeader("content-type"),
    contentEncoding: safeHeader("content-encoding"),
    server: safeHeader("server"),
    poweredBy: safeHeader("x-powered-by"),
    bytes: Buffer.isBuffer(response?.body) ? response.body.length : Buffer.byteLength(htmlSource),
    htmlTitle: title,
    ogTitle,
    canonical,
    description,
    document: {
      mainElements: $("main").length,
      astroIslands: $("astro-island").length,
      scriptCount: scripts.length,
      scriptTypes,
      jsonLdBlocks: $("script[type='application/ld+json']").length,
      productItemtypeElements: $("[itemtype*='schema.org/Product']").length,
      h1Count: $("h1").length,
      formCount: $("form").length,
      linkCount: $("a[href]").length
    },
    signals,
    structuredData,
    dataScripts: dataScripts.slice(0, 20),
    htmlSnippets: htmlSnippets.slice(0, 24),
    bodyTextSample: bodyText.slice(0, 1200)
  };
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
  let productDetailLimitReached = false;

  const pages = [];
  const products = [];
  const collectedProductKeys = new Set();

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
        const responseAudit = {
          httpStatus: Number(response.statusCode || 0),
          finalUrl: String(response.url || currentUrl).slice(0, 1000),
          contentType: String(response.headers?.["content-type"] || "").slice(0, 240),
          contentEncoding: String(response.headers?.["content-encoding"] || "").slice(0, 120),
          bytes: response.body?.length || 0,
          nonHtml: true
        };
        failedPages++;
        if (currentIsQueuedProductDetail) failedProductDetailPages++;
        else failedCategoryPages++;
        pages.push({
          url: response.url || currentUrl,
          error: "non-HTML response",
          pageType: currentIsQueuedProductDetail ? "product-detail" : "category-or-pagination",
          products: [],
          diagnostics: { responseAudit }
        });
        continue;
      }

      const html = response.body.toString("utf8");

      // Parse HTML once and share the DOM across all page-level operations.
      const htmlParseStartedAt = Date.now();
      const pageRoot = loadHtml(html);
      const responseAudit = buildResponseAudit(html, pageRoot, response);
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
        page.products = selectMainProduct(page.products, pageSignals);
        if (page.products[0] && !(page.products[0].isVariant === true &&
            page.products[0].source === "json-ld-offer-variant")) {
          // Ordinary records use the canonical detail URL. Verified offer variants
          // keep their source URLs, including option fragments such as #SKU.
          page.products[0].url = response.url;
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
        responseAudit,
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
        ? page.products.filter(product => {
            try {
              const candidate = new URL(
                product.url || product.sourceUrl || response.url,
                response.url
              );
              const currentPath = currentPageUrl.pathname.replace(/\/+$/, "");
              const candidatePath = candidate.pathname.replace(/\/+$/, "");
              return candidate.origin === currentPageUrl.origin &&
                candidatePath === currentPath;
            } catch {
              return false;
            }
          })
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
            const normalized = normalizeProductUrl(url);
            if (candidateProductDetailUrls.has(normalized)) return false;
            if (candidateProductDetailUrls.size >= MAX_CATEGORY_DETAIL_PAGES) {
              productDetailLimitReached = true;
              return false;
            }
            candidateProductDetailUrls.add(normalized);
            // Do not call a URL "queued" here: it has not yet passed the
            // crawler's queue-capacity and duplicate checks below.
            discoveredProductUrls.add(normalized);
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
    importerVersion: "V3.66-DIAGNOSTIC",
    errorDetails: errors.slice(0, 10),
    productDetailCandidatesDiscovered: candidateProductDetailUrls.size,
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
    responseAudits: pages.filter(page => page.diagnostics?.responseAudit).map(page => ({
      url: page.url,
      ...page.diagnostics.responseAudit
    })),
    productDetailPagesWithZeroProducts: pages.filter(page => page.diagnostics?.productDetailPage === true && (!Array.isArray(page.products) || page.products.length === 0)).length,
    productDetailPagesWithMultipleRawProducts: pages.filter(page => page.diagnostics?.productDetailPage === true && Array.isArray(page.products) && page.products.length > 1).length,
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