import assert from 'node:assert/strict';
import { extractProductsFromHtml } from './website-import-v2.js';

const pageUrl = 'https://www.4home.sk/ulozny-nabytok/';
const fixture = `<!doctype html><html><body>
<article class="products-list-item product-thumbnail" data-ax-catalog-code="TEST-001">
  <a href="/ulozny-box-test-1/" title="Úložný box TEST 1"><img src="/images/test1.jpg" alt="Úložný box TEST 1"></a>
  <h3 class="product-name"><a href="/ulozny-box-test-1/">Úložný box TEST 1</a></h3>
  <div class="price">12,99 €</div>
</article>
<article class="products-list-item product-thumbnail" data-ax-catalog-code="TEST-002">
  <a href="/ulozny-box-test-2/" title="Úložný box TEST 2"><img src="/images/test2.jpg" alt="Úložný box TEST 2"></a>
  <h3 class="product-name"><a href="/ulozny-box-test-2/">Úložný box TEST 2</a></h3>
  <div class="price">24,90 €</div>
</article>
</body></html>`;

const result = extractProductsFromHtml(fixture, pageUrl);
const products = result.products.filter(item => item.source === '4home-card');
assert.equal(products.length, 2, 'Should extract both test product cards');
assert.deepEqual(products.map(p => p.name), ['Úložný box TEST 1', 'Úložný box TEST 2']);
assert.deepEqual(products.map(p => p.price), [12.99, 24.9]);
assert.deepEqual(products.map(p => p.currency), ['EUR', 'EUR']);
assert.ok(products.every(p => p.url.startsWith('https://www.4home.sk/')));
console.log('PASS: 4home targeted card extractor fixture');
