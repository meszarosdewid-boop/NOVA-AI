# V3.86.2 – Euronics / Next.js embedded product data

- Extended the universal embedded JSON extractor to read `finalPriceData`, `priceData` and their currency.
- Added safe extraction of SKU/part number, explicit availability, aggregate stock quantity and per-store stock counts.
- Added two-way deduplication preservation for stock location fields.
- Explicitly ignored nested store-unit `weight` as product weight.
- Added regression fixtures for JBL Quantum 200, TP-Link LS1005, TP-Link MS105 and Trust GXT 232 Mantis.
- Preserved V3.86.1 generic availability-heading guard and existing price parser/ranking logic.
