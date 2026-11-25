NOVA AI V3.86.2 – EURONICS / NEXT.JS STRUCTURED PRODUCT DATA

What changed
- The universal embedded-JSON product extractor now recognizes current price objects such as finalPriceData and priceData.
- It reads SKU/partNo, EAN, product ID and brand from the actual embedded product object.
- It normalizes explicit availability text/booleans and reads a single unambiguous stock summary.
- It can retain stock quantities by store location.
- A field such as store[].weight is not treated as product or shipping weight.
- When stock or availability is absent, the parser leaves it unknown.

Files
- website-import-v2.js: complete importer V3.86.2
- tests/test-euronics-next-data.mjs: regression test using four Euronics-shaped Next.js product payloads

Install
1. Back up the current website-import-v2.js.
2. Replace it with this branch version.
3. From the project root run:
   node --check website-import-v2.js
   node tests/test-euronics-next-data.mjs

Important
- The test uses structured fixtures based on the four inspected pages. It is not a new live crawl.
- No catalogue writes or import approvals are performed.
- The source HTML contained no reliable product-weight value. The importer must continue to leave productWeight/shippingWeight unset for these pages.
- Existing price parsing and source ranking remain in place.
