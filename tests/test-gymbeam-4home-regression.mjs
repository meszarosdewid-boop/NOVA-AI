import assert from "node:assert/strict";
import { extractProductsFromHtml, extractWebsiteLinks } from "../website-import-v2.js";

function getProducts(result) {
  return Array.isArray(result) ? result : (Array.isArray(result?.products) ? result.products : []);
}

// GymBeam: explicit JSON-LD Offer variants must remain separate sellable
// products, with their own size, price and identifiers.
{
  const schema = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "GymBeam Whey Protein",
    url: "https://gymbeam.sk/gymbeam-whey-protein/",
    offers: {
      "@type": "AggregateOffer",
      offers: [
        {
          "@type": "Offer",
          name: "GymBeam Whey Protein 500 g",
          size: "500 g",
          price: "19.90",
          priceCurrency: "EUR",
          sku: "GB-WHEY-500",
          gtin13: "8588000000500"
        },
        {
          "@type": "Offer",
          name: "GymBeam Whey Protein 1 kg",
          size: "1 kg",
          price: "34.90",
          priceCurrency: "EUR",
          sku: "GB-WHEY-1000",
          gtin13: "8588000001000"
        }
      ]
    }
  };
  const html = `
    <html><head>
      <script type="application/ld+json">${JSON.stringify(schema)}</script>
    </head><body><main><h1>GymBeam Whey Protein</h1></main></body></html>`;
  const products = getProducts(extractProductsFromHtml(html, schema.url));

  assert.equal(products.length, 2, "GymBeam must retain both explicit JSON-LD offers");
  assert.ok(products.every(product => product.isVariant === true), "GymBeam offers must remain variants");
  assert.deepEqual(
    products.map(product => `${product.packageQuantity} ${product.packageUnit}`).sort(),
    ["1 kg", "500 g"],
    "GymBeam offer sizes must remain attached to the correct variants"
  );
  assert.deepEqual(
    products.map(product => product.price).sort((a, b) => a - b),
    [19.9, 34.9]
  );
  assert.equal(new Set(products.map(product => product.sku)).size, 2, "GymBeam variant SKUs must not collapse");
}

// Universal safety: a physical Schema.org weight remains a physical shipping
// measurement and must not be copied into the sellable package quantity.
{
  const url = "https://example-shop.sk/rychlovarna-kanvica/";
  const schema = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Rýchlovarná kanvica",
    weight: {
      "@type": "QuantitativeValue",
      value: "1.4",
      unitCode: "KGM"
    },
    offers: {
      "@type": "Offer",
      price: "39.90",
      priceCurrency: "EUR"
    }
  };
  const html = `
    <html><head><script type="application/ld+json">${JSON.stringify(schema)}</script></head>
    <body><main><h1>Rýchlovarná kanvica</h1></main></body></html>`;
  const products = getProducts(extractProductsFromHtml(html, url));

  assert.equal(products.length, 1);
  assert.equal(products[0].packageQuantity, undefined, "Physical weight must not become sellable package content");
  assert.equal(products[0].shippingWeight, 1.4, "Physical weight must remain available as a physical specification");
}

// 4home: the dedicated category-card extractor must keep finding products,
// current gross prices and stock without being displaced by generic parsing.
{
  const url = "https://www.4home.sk/kategoria/spotrebice/";
  const html = `
    <html><body>
      <article class="products-list-item product-thumbnail" data-ax-catalog-code="4H-001">
        <a class="product-thumbnail__link" href="/rychlovarna-kanvica-4h001/">
          <div class="product-thumbnail__name">Rýchlovarná kanvica 4Home</div>
          <div class="product-thumbnail__actual-price">39,99 €</div>
          <div class="product-thumbnail__availability">Skladom</div>
          <img class="product-thumbnail__photo" src="/images/4h001.jpg" alt="Rýchlovarná kanvica 4Home">
        </a>
      </article>
    </body></html>`;
  const products = getProducts(extractProductsFromHtml(html, url));

  assert.equal(products.length, 1, "4home category card must be extracted");
  assert.equal(products[0].name, "Rýchlovarná kanvica 4Home");
  assert.equal(products[0].price, 39.99);
  assert.equal(products[0].source, "4home-card-v332");
  assert.equal(products[0].productId, "4H-001");
}

// 4home: the dedicated detail fast path must prefer its regular gross price,
// not the lower coupon-only price shown beside it.
{
  const url = "https://www.4home.sk/komoda-4h002/";
  const html = `
    <html><body><main>
      <div class="size-selector"></div>
      <h1>Komoda 4Home</h1>
      <div class="product-price">
        <span class="price-old">129,99 €</span>
        <div class="cupon-info"><span class="price-new">109,99 €</span></div>
      </div>
    </main></body></html>`;
  const products = getProducts(extractProductsFromHtml(html, url));

  assert.equal(products.length, 1, "4home detail page must be extracted");
  assert.equal(products[0].price, 129.99, "4home regular gross price must win over coupon price");
  assert.equal(products[0].couponPriceDetected, true);
  assert.equal(products[0].source, "4home-detail-fast-v333");
}

// GymBeam: preserve its real `p` pagination parameter while rejecting
// facet combinations as additional category pages.
{
  const url = "https://gymbeam.sk/proteiny/";
  const html = `
    <html><body>
      <nav class="pagination">
        <a href="/proteiny/?p=2">2</a>
        <a href="/proteiny/?p=2&trademark_ingredient=pea">2 s filtrom</a>
      </nav>
    </body></html>`;
  const result = extractWebsiteLinks(html, url, { categoryOnly: true, returnMeta: true });

  assert.deepEqual(
    result.paginationLinks,
    ["https://gymbeam.sk/proteiny/?p=2"],
    "GymBeam must use p=2 and reject facet URLs as pagination"
  );
}

// 4home: JavaScript hash pagination must resolve to the store's AJAX URL.
{
  const url = "https://www.4home.sk/kategoria/spotrebice/";
  const html = `
    <html><body>
      <nav class="pagination">
        <a href="#2">2</a>
        <a href="#3">3</a>
      </nav>
    </body></html>`;
  const result = extractWebsiteLinks(html, url, { categoryOnly: true, returnMeta: true });

  assert.ok(
    result.paginationLinks.includes("https://www.4home.sk/kategoria/spotrebice/?skip=&p=2&ajax_loading=rewrite"),
    "4home hash page 2 must resolve to its AJAX pagination endpoint"
  );
  assert.ok(
    result.paginationLinks.includes("https://www.4home.sk/kategoria/spotrebice/?skip=&p=3&ajax_loading=rewrite"),
    "4home hash page 3 must resolve to its AJAX pagination endpoint"
  );
}

console.log("GymBeam + 4home regression tests passed.");
