
import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { load as loadHtml } from "cheerio";

// ==========================================
// NOVA AI - WEBSITE IMPORTER V3.2
// Bezpecny crawler + viac sposobov extrakcie
// produktov a cien
// ==========================================

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_PAGES = 100;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 12000;
const MAX_TOTAL_TIME_MS = 240000;
const REQUEST_DELAY_MS = 350;
const MAX_QUEUE = 250;
const MAX_PRODUCTS_PER_PAGE = 250;

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

  try {
    records = await dns.lookup(hostname, {
      all: true,
      verbatim: true
    });
  } catch {
    throw new Error("Domenu sa nepodarilo DNS prelozit.");
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

async function requestOnce(url, records, maxBytes) {
  const module = getRequestModule(url.protocol);
  const lookup = createPinnedLookup(records);

  return new Promise((resolve, reject) => {
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
        "Accept-Encoding": "identity",
        "Connection": "close"
      }
    };

    const request = module.request(options, async response => {
      try {
        const encoding = response.headers["content-encoding"];

        if (
          encoding &&
          encoding.toLowerCase() !== "identity"
        ) {
          response.destroy();
          reject(
            new Error("Komprimovana odpoved nie je podporovana.")
          );
          return;
        }

        const body = await readResponseLimited(
          response,
          maxBytes
        );

        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers,
          body
        });
      } catch (error) {
        reject(error);
      }
    });

    request.setTimeout(TIMEOUT_MS, () => {
      request.destroy(
        new Error("Casovy limit pri nacitani stranky.")
      );
    });

    request.on("error", reject);
    request.end();
  });
}

export async function safeFetchWebsite(
  input,
  options = {}
) {
  const maxBytes = Math.min(
    Number(options.maxBytes) || MAX_BYTES,
    MAX_BYTES
  );

  let currentUrl = parseAndValidateUrl(input);
  const originalOrigin = currentUrl.origin;

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount++
  ) {
    const records = await resolvePublicAddresses(
      currentUrl.hostname
    );

    const response = await requestOnce(
      currentUrl,
      records,
      maxBytes
    );

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

      if (nextUrl.origin !== originalOrigin) {
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
    pr: "pár"
  };

  if (map[raw]) return map[raw];

  const normalized = raw
    .replace(/\s+/g, " ")
    .replace(/^kus(y|ov)?$/, "ks");

  const allowed = [
    "ks", "m²", "m2", "m³", "m3", "m", "cm", "mm",
    "kg", "g", "t", "l", "ml", "balenie", "bal", "set",
    "pár", "par", "hod", "deň", "mesiac"
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
    "(ks|kus(?:y|ov)?|piece|pieces|pc|pcs|ea|c62|h87|m²|m2|mtk|m³|m3|mtq|m|mtr|cm|mm|kg|kgm|g|grm|t|l|ltr|ml|balenie|bal|pack|package|set|pár|par|pair|pr)";

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


function extractUnitNearPrice($, container, expectedPrice = null) {
  // E-shopy môžu pri jednej položke zobrazovať predajnú cenu
  // (napr. 2,65 € / ks) aj informatívnu cenu za m/kg/l.
  // Najprv preto hľadáme jednotku priradenú presne k načítanej cene.
  const fullText = container.text()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const priceUnitPattern = new RegExp(
    "(\\d[\\d\\s.,]*)\\s*(?:€|eur)\\s*\\/\\s*" +
    "(ks|kus(?:y|ov)?|pc|pcs|m²|m2|m³|m3|kg|g|l|ml|balenie|bal)\\b",
    "gi"
  );

  const priceUnitMatches = [...fullText.matchAll(priceUnitPattern)];

  if (Number.isFinite(expectedPrice) && priceUnitMatches.length) {
    const expected = Math.round(expectedPrice * 100) / 100;

    for (const match of priceUnitMatches) {
      const amount = parsePrice(match[1]);
      if (amount != null && Math.round(amount * 100) / 100 === expected) {
        return normalizeProductUnit(match[2]);
      }
    }

    // Ak sú v texte ceny s jednotkami, ale žiadna sa nezhoduje
    // s hlavnou cenou produktu, nesmieme prevziať referenčnú jednotku.
    return null;
  }

  // Ďalšie zdroje môžu mať jednotku uvedenú samostatne pri cene.
  const selectors = [
    "[itemprop='price']",
    "[data-price]",
    ".price",
    ".product-price",
    ".price-current",
    ".current-price",
    ".product__price",
    ".product-card__price",
    ".price-value"
  ];

  for (const selector of selectors) {
    const elements = container.find(selector);

    for (const element of elements.toArray()) {
      const priceElement = $(element);
      const texts = [priceElement.text(), priceElement.parent().text()];

      for (const text of texts) {
        const unit = extractUnitFromText(text);
        if (unit) return unit;
      }
    }
  }

  // Záložná kontrola celého kontajnera.
  const match = fullText.match(
    /(\d[\d\s.,]*)\s*(?:€|eur)\s*\/\s*(ks|kus|kusy|kusov|pc|pcs|m²|m2|m³|m3|kg|g|l|ml|balenie|bal)\b/i
  );

  if (match?.[2]) {
    return normalizeProductUnit(match[2]);
  }

  return null;
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



function getOfferPrice(offers) {
  if (!offers) return null;

  const list = Array.isArray(offers)
    ? offers
    : [offers];

  const prices = [];

  for (const offer of list) {
    if (!offer || typeof offer !== "object") continue;

    const nested = offer.offers
      ? getOfferPrice(offer.offers)
      : null;

    if (nested) {
      prices.push(nested);
      continue;
    }

    const rawPrice =
      offer.price ??
      offer.lowPrice ??
      offer.priceSpecification?.price;

    const price = parsePrice(rawPrice);

    if (price == null) continue;

    const currency = normalizeCurrency(
      offer.priceCurrency ??
      offer.priceSpecification?.priceCurrency
    );

    prices.push({
      price,
      currency,
      availability: offer.availability || null,
      unit: extractStructuredUnit(
        offer,
        offer.priceSpecification,
        offer.referenceQuantity,
        offer.eligibleQuantity
      )
    });
  }

  if (!prices.length) return null;

  const unique = new Map();

  for (const item of prices) {
    const key = `${item.price}|${item.currency || ""}`;
    unique.set(key, item);
  }

  if (unique.size === 1) {
    return [...unique.values()][0];
  }

  return null;
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
    currency: offer.currency,
    availability: offer.availability,
    unit: offer.unit || extractStructuredUnit(node, node.offers),
    url: productUrl,
    image,
    source: "json-ld"
  };
}

export function extractProductsFromJsonLd(html, pageUrl) {
  const $ = loadHtml(html);
  const products = [];

  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).contents().text();
    const parsed = parseJsonSafe(raw);

    if (!parsed) return;

    const nodes = collectJsonLdNodes(parsed);

    for (const node of nodes) {
      const product = extractProductFromJsonLd(
        node,
        pageUrl
      );

      if (product) {
        products.push(product);
      }
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

    const unit =
      extractStructuredUnit({
        unitText: root.find("[itemprop='unitText']").first().attr("content") ||
          root.find("[itemprop='unitText']").first().text(),
        unitCode: root.find("[itemprop='unitCode']").first().attr("content") ||
          root.find("[itemprop='unitCode']").first().text()
      }) ||
      extractUnitNearPrice($, root, price) ||
      extractUnitFromText(priceElement.parent().text());

    products.push({
      name,
      price,
      currency,
      availability: null,
      unit,
      url: productUrl,
      image,
      source: "microdata"
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
    value.title;

  const defaultPrice =
    value.defaultPrice &&
    typeof value.defaultPrice === "object"
      ? value.defaultPrice
      : null;

  const rawPrice =
    defaultPrice?.price ??
    value.price ??
    value.finalPrice ??
    value.salePrice ??
    value.currentPrice;

  const price = parsePrice(rawPrice);

  const productLike =
    typeof name === "string" &&
    name.trim().length >= 2 &&
    price != null &&
    (
      value.sku ||
      value.productId ||
      value.product_id ||
      value.id ||
      value.offers ||
      value.priceCurrency ||
      value.currency ||
      defaultPrice ||
      value["@type"] === "Product"
    );

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
      value.images?.[0] ||
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
      unit: extractStructuredUnit(
        defaultPrice,
        value,
        value.offers,
        value.priceSpecification
      ),
      url: productUrl,
      image,
      source: "embedded-json"
    });
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      [
        "offers",
        "image",
        "images",
        "brand",
        "seller"
      ].includes(key)
    ) {
      continue;
    }

    if (child && typeof child === "object") {
      findEmbeddedProducts(child, pageUrl, output);
    }
  }

  return output;
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
    "__ARTICLE_DETAIL_APOLLO_STATE__"
  ];

  $("script").each((_, element) => {
    const raw = $(element).contents().text().trim();

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

function isLikelyProductContainer($, element) {
  const node = $(element);

  const marker = [
    node.attr("class"),
    node.attr("id"),
    node.attr("data-testid"),
    node.attr("itemtype")
  ].filter(Boolean).join(" ").toLowerCase();

  return (
    /product|produkt|article|item-card|product-card/.test(marker) ||
    /schema\.org\/Product/i.test(marker)
  );
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
  const pattern = /(\d{1,3}(?:[ .\u00a0]\d{3})*(?:[,.]\d{2})?|\d+(?:[,.]\d{1,2})?)\s*(EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$)/gi;
  const found = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const price = parsePrice(match[1]);
    const currency = normalizeCurrency(match[2]);
    if (price != null && currency) found.push({ price, currency });
  }
  return found;
}

function extractCardPrice($, container) {
  const selectors = [
    "[itemprop='price']",
    "[data-price]",
    ".price-current",
    ".current-price",
    ".product-price",
    ".product__price",
    ".product-card__price",
    ".price-value",
    ".price"
  ];
  const cardText = container.text();
  const visiblePrices = extractCurrencyPriceCandidates(cardText);
  const uniqueVisiblePrices = new Map(
    visiblePrices.map(item => [`${item.price}|${item.currency}`, item])
  );

  for (const selector of selectors) {
    const elements = container.find(selector).toArray();
    for (const node of elements) {
      const element = $(node);
      const raw =
        element.attr("content") ||
        element.attr("data-price") ||
        element.attr("value") ||
        element.text();
      const price = parsePrice(raw);
      if (price == null) continue;

      // Do not accept a bare number from a generic .price/data attribute.
      // It must either carry its own currency or match the only visible,
      // currency-qualified amount in this product card. This prevents
      // dimensions, model numbers and unrelated numeric values becoming prices.
      const rawHasCurrency = /(?:EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$)/i.test(String(raw));
      if (rawHasCurrency) return price;

      const matching = [...uniqueVisiblePrices.values()].filter(item => item.price === price);
      if (matching.length === 1 && uniqueVisiblePrices.size === 1) {
        return price;
      }
    }
  }

  return null;
}

function extractPriceFromProductCardText(value) {
  let text = decodeEntities(String(value || ""))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Hornbach and several other shops show a secondary unit price
  // (for example €/m) after the main product price. Ignore that tail.
  text = text.split(/(?:corresponds to|corespunde la|zodpoved[aá]\s+to|odpov[ií]d[aá]\s+to)/i)[0];

  const match = text.match(/(\d{1,3}(?:[ .\u00a0]\d{3})*(?:[,.]\d{2})?|\d+(?:[,.]\d{1,2})?)\s*(EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$)/i);
  if (!match) return null;

  const price = parsePrice(match[1]);
  const currency = normalizeCurrency(match[2]);
  if (price == null || !currency) return null;

  return { price, currency };
}

function isGenericProductLinkLabel(value) {
  const text = normalizeWhitespace(value).toLowerCase();
  return !text || /^(?:detail|zobraziť detail|zobrazit detail|viac|viac info|more|view|view details|product|produkt|image|obrázok|obrazok)$/i.test(text);
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

    const anchor = $(element);
    const href = anchor.attr("href");
    let productUrl;

    try {
      productUrl = new URL(href, pageUrl);
    } catch {
      return;
    }

    // Product-detail URL patterns used by common e-shop platforms,
    // including Grandus (/produkt/<slug>).
    if (!/(?:^|\/)(?:p|product|produkt|item|dp)\/[^/?#]+/i.test(productUrl.pathname)) {
      return;
    }

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

    // On some platforms (including Grandus), the product title, price,
    // image and the "Detail" link are separate siblings. Walk up the DOM
    // and read the nearest compact card containing both a real title and
    // a currency-qualified price instead of trusting the link text alone.
    for (let depth = 0; depth < 11 && card.length; depth++) {
      const candidateText = cleanText(card.text(), 2500);

      if (
        candidateText &&
        candidateText.length <= 1800 &&
        /(?:EUR|CZK|PLN|HUF|GBP|USD|CHF|€|Kč|zł|Ft|£|\$)/i.test(candidateText)
      ) {
        const explicitCardPrice = extractCardPrice($, card);
        const textPriceCandidates = extractCurrencyPriceCandidates(candidateText);
        const uniqueTextPrices = new Map(
          textPriceCandidates.map(item => [`${item.price}|${item.currency}`, item])
        );
        const parsed = explicitCardPrice != null
          ? (() => {
              const match = [...uniqueTextPrices.values()].find(item => item.price === explicitCardPrice);
              return match || null;
            })()
          : uniqueTextPrices.size === 1
            ? [...uniqueTextPrices.values()][0]
            : null;
        if (parsed) {
          let name = !isGenericProductLinkLabel(anchorName)
            ? anchorName
            : extractCardName($, card);

          if (isGenericProductLinkLabel(name)) {
            name = cleanText(
              card.find("h1, h2, h3, h4, [itemprop='name'], [class*='title'], [class*='name']").first().text(),
              300
            );
          }

          if (
            name &&
            name.length >= 3 &&
            name.length <= 250 &&
            !isGenericProductLinkLabel(name) &&
            isLikelyRealProductName(name)
          ) {
            best = { name, parsed, cardText: candidateText, card };
            break;
          }
        }
      }

      card = card.parent();
    }

    if (!best) return;

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
      availability: /na sklade|skladom|in stock/i.test(best.cardText) ? "InStock" : null,
      unit: extractUnitNearPrice($, best.card, best.parsed.price) || extractUnitFromText(best.cardText),
      url: productUrl.href,
      image: imageUrl,
      source: "linked-product-card"
    });

    existingUrls.add(productUrl.href);
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
    "article"
  ];

  const candidates = new Set();

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      candidates.add(element);
    });
  }

  for (const element of candidates) {
    if (!isLikelyProductContainer($, element)) {
      continue;
    }

    const container = $(element);

    const name = extractCardName($, container);
    const price = extractCardPrice($, container);

    if (!name || price == null) {
      continue;
    }

    const link =
      container.find("a[href]").first().attr("href") ||
      pageUrl;

    let productUrl = pageUrl;

    try {
      productUrl = new URL(link, pageUrl).href;
    } catch {
      productUrl = pageUrl;
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
      currency,
      availability: null,
      unit: extractUnitNearPrice($, container, price),
      url: productUrl,
      image,
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
// ==========================================
// FALLBACK PRE DETAIL PRODUKTU (AJ SHOPTEC)
// ==========================================
function extractDetailPageFallback($, pageUrl) {
  const path = (() => { try { return new URL(pageUrl).pathname; } catch { return ""; } })();
  const looksLikeProductUrl = /(?:produkt|product|item|detail|\/p\/)/i.test(path) || /[a-z].*[-_](?:[a-z]*\d{3,}|\d{3,})/i.test(path);
  const h1 = cleanText($("h1").first().text(), 300);
  if (!looksLikeProductUrl || !h1 || !isLikelyRealProductName(h1)) return [];

  const bodyText = normalizeWhitespace($("body").text());
  const labelPatterns = [
    /(?:po\s+zľave\s+s\s+DPH|po\s+zlave\s+s\s+DPH)\s*[:：]?\s*((?:\d{1,3}(?:[ .\u00a0]\d{3})*|\d+)(?:[,.]\d{1,2})?)\s*(€|EUR)/i,
    /(?:predajn[aá]\s+cena|aktu[aá]lna\s+cena|cena\s+s\s+DPH)\s*[:：]?\s*((?:\d{1,3}(?:[ .\u00a0]\d{3})*|\d+)(?:[,.]\d{1,2})?)\s*(€|EUR)/i
  ];

  let match = null;
  for (const pattern of labelPatterns) {
    match = bodyText.match(pattern);
    if (match) break;
  }

  // If the shop does not label the discounted price consistently, use
  // an explicit current-price element, never an arbitrary number from specs.
  let price = match ? parsePrice(match[1]) : null;
  let currency = match ? normalizeCurrency(match[2]) : null;
  if (price == null) {
    const selectors = [
      "[itemprop='price']", "meta[property='product:price:amount']",
      "meta[property='og:price:amount']", ".price-current",
      ".current-price", ".product-price", ".product__price", ".price"
    ];
    for (const selector of selectors) {
      const el = $(selector).first();
      if (!el.length) continue;
      const raw = el.attr("content") || el.attr("data-price") || el.text();
      const parsed = extractPriceFromProductCardText(raw);
      if (parsed) { price = parsed.price; currency = parsed.currency; break; }
      const numeric = parsePrice(raw);
      if (numeric != null && /€|EUR/i.test(raw)) { price = numeric; currency = "EUR"; break; }
    }
  }

  if (price == null || !currency) return [];
  return [{
    name: h1,
    price,
    currency,
    availability: /skladom|na sklade/i.test(bodyText) ? "InStock" : null,
    unit: "neuvedené",
    url: pageUrl,
    image: null,
    source: "detail-page-fallback"
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

function cleanProductTitle(value) {
  let name = cleanText(value, 300);
  // Common page-title format: "Shop name | Product name".
  if (/\.(?:sk|cz|hu|pl|com|eu)\s*\|/i.test(name)) {
    name = name.split("|").slice(1).join("|").trim();
  }
  return name;
}

function deduplicateProducts(products) {
  const result = [];
  const byUrlAndPrice = new Map();

  for (const rawProduct of products) {
    if (!rawProduct) continue;
    const product = { ...rawProduct, name: cleanProductTitle(rawProduct.name) };
    if (
      !product.name ||
      !isLikelyRealProductName(product.name) ||
      !Number.isFinite(product.price) ||
      product.price <= 0
    ) continue;

    const url = normalizeProductUrl(product.url || product.sourceUrl || "");
    const key = url ? `${url}|${product.price}` : `${normalizeProductName(product.name)}|${product.price}`;
    const existingIndex = byUrlAndPrice.get(key);

    if (existingIndex !== undefined) {
      const existing = result[existingIndex];
      // Prefer the cleanest, most product-like title and fill missing fields
      // from the other extraction source (JSON-LD, metadata, embedded JSON, HTML).
      if ((!existing.currency || existing.currency === "NEZNAMA") && product.currency) existing.currency = product.currency;
      if ((!existing.unit || existing.unit === "neuvedené") && product.unit && product.unit !== "neuvedené") existing.unit = product.unit;
      if (!existing.image && product.image) existing.image = product.image;
      if (!existing.availability && product.availability) existing.availability = product.availability;
      if (product.source && existing.source && !String(existing.source).includes(product.source)) {
        existing.source += "+" + product.source;
      }
      continue;
    }

    byUrlAndPrice.set(key, result.length);
    result.push(product);
  }

  return result;
}

// ==========================================
// HLAVNA EXTRAKCIA PRODUKTOV Z HTML
// ==========================================

export function extractProductsFromHtml(html, pageUrl) {
  const $ = loadHtml(html);

  const jsonLd = extractProductsFromJsonLd(
    html,
    pageUrl
  );

  const microdata = extractMicrodataProducts(
    $,
    pageUrl
  );

  // Metadata na kategoriovych strankach casto obsahuje iba najnizsiu
  // cenu z celej kategorie. Nie je to samostatny produkt, preto ich ignorujeme.
  const isCategoryPage = /\/(?:kategoria|category|categories|kolekcia)\//i.test(
    new URL(pageUrl).pathname
  );

  const metadata = isCategoryPage
    ? []
    : extractMetadataProduct($, pageUrl);

  const embedded = extractProductsFromEmbeddedJson(
    $,
    pageUrl
  );

  const htmlCards = extractHtmlCardProducts(
    $,
    pageUrl
  );

  const detailFallback = extractDetailPageFallback($, pageUrl);

  const products = deduplicateProducts([
    ...jsonLd,
    ...microdata,
    ...embedded,
    ...metadata,
    ...htmlCards,
    ...detailFallback
  ]);

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
      detailFallback: detailFallback.length,
      total: products.length
    }
  };
}

// ==========================================
// EXTRAKCIA TEXTOVEHO OBSAHU WEBU
// ==========================================

export function extractWebsiteContent(html, pageUrl) {
  const $ = loadHtml(html);

  $("script, style, noscript, svg, iframe, header, footer, nav").remove();

  const title = cleanText(
    $("title").first().text() ||
    $("h1").first().text(),
    300
  );

  const description = cleanText(
    $("meta[name='description']").attr("content") ||
    $("meta[property='og:description']").attr("content") ||
    "",
    1000
  );

  const headings = [];

  $("h1, h2, h3").each((_, element) => {
    const value = cleanText($(element).text(), 200);

    if (value && headings.length < 100) {
      headings.push(value);
    }
  });

  const text = cleanText(
    $("body").text() || $.root().text(),
    50000
  );

  const extracted = extractProductsFromHtml(
    html,
    pageUrl
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

export function extractWebsiteLinks(html, pageUrl, options = {}) {
  const $ = loadHtml(html);
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

      url.hash = "";

      if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|rar|css|js|xml)$/i.test(url.pathname)) {
        return;
      }

      // Zachovaj parametre strankovania, odstran iba bezne tracking parametre.
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_.+|gclid|fbclid|yclid)$/i.test(key)) {
          url.searchParams.delete(key);
        }
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

    const hasPaginationParam = /[?&](page|p|pageno|pageindex|currentpage|offset|pg|strana|seite|pagina)=/i.test(href || "");
    const hasPaginationPath = /\/(?:page|strana|seite|pagina|p)\/\d+(?:\/|$)/i.test(href || "");
    const looksLikeNext = /next|dals|ďal|nasledu|ďalej|weiter|suivant|›|»|→/i.test(label);
    const looksLikePageNumber = /^\s*\d{1,4}\s*$/.test($element.text());
    const inPaginationContainer = $element.parents(
      "[class*='pagination'], [id*='pagination'], [class*='pager'], [id*='pager'], nav[aria-label*='page' i], [data-testid*='pagination']"
    ).length > 0;
    const hasPageData = Boolean(
      $element.attr("data-page") ||
      $element.attr("data-page-number") ||
      $element.attr("aria-current") ||
      $element.attr("data-testid")?.toLowerCase().includes("page")
    );
    const isPagination = hasPaginationParam || hasPaginationPath || looksLikeNext ||
      (inPaginationContainer && (looksLikePageNumber || hasPageData || $element.is("a"))) ||
      (looksLikePageNumber && hasPageData);

    addLink(href, isPagination, !isPagination && isInsideProductCard($element));
  });

  const pagination = [...paginationLinks];
  const products = [...productLinks];
  const others = [...otherLinks];
  const links = options.categoryOnly
    ? [...pagination, ...products]
    : [...pagination, ...products, ...others];

  // Predvolene ostava zachovane povodne API (pole URL). Crawler si moze
  // vyziadat aj rozdelene skupiny, aby vedel spravne spracovat URL produktov.
  return options.returnMeta
    ? { links, paginationLinks: pagination, productLinks: products, otherLinks: others }
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
    group.agents.some(value =>
      value === "*" ||
      agent.includes(value)
    )
  );

  if (!matchingGroups.length) {
    return true;
  }

  const specificGroups = matchingGroups.filter(group =>
    group.agents.some(value => value !== "*")
  );

  const groupsToUse = specificGroups.length
    ? specificGroups
    : matchingGroups;

  const rules = groupsToUse.flatMap(group => group.rules);

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
function getProductPageSignals(html, pageUrl, products) {
  const $ = loadHtml(html);
  let pathname = "";
  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    return { isDetail: false, heading: "", path: "" };
  }

  const heading = normalizeProductName(
    $("h1").first().text() ||
    $("meta[property='og:title']").attr("content") ||
    $("title").first().text() ||
    ""
  );
  const path = normalizeProductName(pathname);
  const categoryPath = /\/(kategoria|category|categories|kategorie|kategorija|catalog|catalogue|kolekcia|collection|collections)(\/|$)/i
    .test(pathname);

  if (categoryPath || !products.length) {
    return { isDetail: false, heading, path };
  }

  const hasProductType =
    String($("meta[property='og:type']").attr("content") || "").toLowerCase() === "product";
  const hasDetailMarker = $(
    "[class*='product-detail'], [class*='product-detail__'], [id*='product-detail'], form[action*='cart'], [itemprop='offers']"
  ).length > 0;

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
    isDetail: hasProductType || hasDetailMarker || bestScore >= 0.34,
    heading,
    path,
    bestScore
  };
}

function selectMainProduct(products, signals) {
  if (!products.length) return [];

  const headingTokens = new Set((signals.heading || "").split(/\s+/).filter(token => token.length > 1));
  const pathTokens = new Set((signals.path || "").split(/\s+/).filter(token => token.length > 1));

  const scoreProduct = product => {
    const name = normalizeProductName(product.name);
    const tokens = [...new Set(name.split(/\s+/).filter(token => token.length > 1))];
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

  return ranked[0].score >= 0.20 ? [ranked[0].product] : [products[0]];
}

function sortQueue(queue) {
  return queue.sort(
    (a, b) => scoreProductPage(b) - scoreProductPage(a)
  );
}
// Niektore e-shopy (vratane Grandus) vykreslia cisla stran ako JS ovladacie
// prvky namiesto beznych <a href> odkazov. Ak HTML obsahuje rozsah
// "zobrazenych 1 - 32 z celkoveho poctu 473", vieme bezpecne dopoctat
// dalsie strany cez standardne query parametre page/perPage.
function discoverRangeBasedPagination(html, pageUrl) {
  const $ = loadHtml(html);
  const text = normalizeWhitespace($.root().text());
  const match = text.match(
    /(?:zobrazen(?:ych|\u00fdch)|showing|displaying)\s+([\d]{1,3}(?:\s[\d]{3})*)\s*[-–]\s*([\d]{1,3}(?:\s[\d]{3})*)\s+(?:z\s+celkov[e\u00e9]ho\s+po[c\u010d]tu|of)\s+([\d]{1,3}(?:\s[\d]{3})*)/i
  );

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

  const currentPage = Math.max(1, Number(current.searchParams.get("page")) || 1);
  const pageCount = Math.ceil(total / pageSize);
  const urls = [];

  for (let page = currentPage + 1; page <= pageCount; page++) {
    const next = new URL(current.href);
    next.searchParams.set("page", String(page));
    next.searchParams.set("perPage", String(pageSize));
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

  // Rozlisime priamy produkt, kategoriu a vseobecnu vstupnu URL.
  // Pri kategorii sa nesmie crawler rozbehnut cez navigaciu do celeho e-shopu.
  let isDirectProductUrl = /\/(?:p|product|products|produkt|produkte|item|items|detail|dp)\//i.test(
    startUrl.pathname
  );
  let isCategoryScopedCrawl = /\/(?:kategoria|category|categories|product-category|product_category|kolekcia|collection|collections|catalog|catalogue|katalog|c|shop)\//i.test(
    startUrl.pathname
  ) || /[?&](?:category|cat|kategoria|collection)=/i.test(startUrl.search);

  const maxPages = isDirectProductUrl
    ? 1
    : Math.min(
        Math.max(Number(options.maxPages) || MAX_PAGES, 1),
        MAX_PAGES
      );

  const maxTotalBytes = Math.min(
    Number(options.maxTotalBytes) || MAX_TOTAL_BYTES,
    MAX_TOTAL_BYTES
  );

  const queue = [startUrl.href];
  const queued = new Set(queue);
  const visited = new Set();
  const discoveredProductUrls = new Set();

  const pages = [];
  const products = [];

  let totalBytes = 0;
  let failedPages = 0;

  const robots = await loadRobotsTxt(startUrl.href);

  if (robots.rules === null) {
    throw new Error(
      "Nepodarilo sa overit robots.txt. Import bol z bezpecnostnych dovodov zastaveny."
    );
  }

  while (
    queue.length > 0 &&
    visited.size < maxPages &&
    Date.now() - startedAt < MAX_TOTAL_TIME_MS &&
    totalBytes < maxTotalBytes
  ) {
    sortQueue(queue);

    const currentUrl = queue.shift();

    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);

    if (!isAllowedByRobots(robots.rules, currentUrl)) {
      continue;
    }

    try {
      const remainingBytes = maxTotalBytes - totalBytes;

      const response = await safeFetchWebsite(
        currentUrl,
        {
          maxBytes: Math.min(
            MAX_BYTES,
            remainingBytes
          )
        }
      );

      totalBytes += response.body.length;

      if (!isHtmlResponse(response.headers)) {
        continue;
      }

      const html = response.body.toString("utf8");

      const page = extractWebsiteContent(
        html,
        response.url
      );

      // Rozpoznaj aj produktove URL bez standardnej cesty /produkt/,
      // napr. /tlakomer-eta-e4297-90000. Kategoriu explicitne chranime.
      const pageSignals = pages.length === 0
        ? getProductPageSignals(html, response.url, page.products)
        : { isDetail: false };

      const isDirectProductPage = pages.length === 0 && pageSignals.isDetail;

      if (isDirectProductPage) {
        page.products = selectMainProduct(page.products, pageSignals);
        if (page.products[0]) {
          // Zdrojom ma byt skutocna URL detailu, nie chybny odkaz z metadata.
          page.products[0].url = response.url;
        }
        isDirectProductUrl = true;
        isCategoryScopedCrawl = false;
        page.diagnostics = {
          ...(page.diagnostics || {}),
          productPageMode: "single-product"
        };
      }

      // Ak URL nema standardny nazov kategorie, odhalime vypis produktov
      // podla produktovych kariet a odkazov. To pokryva aj vlastne e-shopy.
      const linkInfo = extractWebsiteLinks(
        html,
        response.url,
        { returnMeta: true }
      );

      // Doplnkove zistenie stranok z rozsahu "zobrazenych X - Y z N".
      // Pouziva sa iba pri katalogoch a URL zostavaju na rovnakom origine.
      const inferredPaginationLinks = isCategoryScopedCrawl
        ? discoverRangeBasedPagination(html, response.url)
        : [];
      const paginationLinks = [...new Set([
        ...linkInfo.paginationLinks,
        ...inferredPaginationLinks
      ])];
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
      for (const productUrl of linkInfo.productLinks) {
        discoveredProductUrls.add(normalizeProductUrl(productUrl));
      }

      pages.push(page);

      // Pri importe kategórie navštevujeme aj detaily kvôli presnej mene/cene,
      // ale z detailu preberieme iba samotný produkt danej URL. Odporúčané a
      // súvisiace produkty z detailu sa nesmú pridať do výsledku kategórie.
      const currentPageUrl = new URL(response.url);
      const currentIsProductPage = isDirectProductPage ||
        /\/(?:p|product|products|produkt|produkte|item|items|detail|dp)\//i.test(
          currentPageUrl.pathname
        ) || discoveredProductUrls.has(normalizeProductUrl(response.url)) ||
        discoveredProductUrls.has(normalizeProductUrl(currentPageUrl.href));

      const pageProducts = isCategoryScopedCrawl && currentIsProductPage
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
        products.push(product);

        if (products.length >= 1000) {
          break;
        }
      }

      if (products.length >= 1000) {
        break;
      }

      // Detail produktu je konečná cieľová stránka. Pri kategórii sa ďalej
      // prehľadáva iba stránkovanie a konkrétne produktové detaily.
      const links = (
        isDirectProductUrl || currentIsProductPage
      )
        ? []
        : isCategoryScopedCrawl
          ? [...paginationLinks, ...linkInfo.productLinks]
          : linkInfo.links;

      for (const link of links) {
        if (
          queue.length >= MAX_QUEUE ||
          visited.size + queue.length >= MAX_QUEUE + MAX_PAGES
        ) {
          break;
        }

        if (
          !queued.has(link) &&
          !visited.has(link)
        ) {
          queued.add(link);
          queue.push(link);
        }
      }
    } catch (error) {
      failedPages++;

      pages.push({
        url: currentUrl,
        error: error.message,
        products: []
      });
    }

    if (queue.length > 0) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const uniqueProducts = deduplicateProducts(products);

  const diagnostics = {
    pagesVisited: visited.size,
    pagesSuccessful: pages.filter(page => !page.error).length,
    pagesFailed: failedPages,
    totalBytes,
    productsFound: uniqueProducts.length,
    limits: {
      maxPages,
      maxTotalBytes,
      maxTotalTimeMs: MAX_TOTAL_TIME_MS,
      maxQueue: MAX_QUEUE
    },
    timeMs: Date.now() - startedAt,
    extractionMethods: {
      jsonLd: 0,
      microdata: 0,
      metadata: 0,
      embeddedJson: 0,
      htmlCards: 0
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
    pages,
    products: uniqueProducts,
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