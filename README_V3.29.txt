NOVA AI Website Importer V3.29

Changes:
- 4home single-response ceiling: 16 MiB -> 32 MiB.
- 4home total response budget: 60 MiB -> 100 MiB (still bounded).
- Per-page product extraction ceiling: 250 -> 1500.
- Total crawler product ceiling: 1000 -> 5000.
- Preserves exact 4home category-path scope and cumulative-product deduplication.
- Importer diagnostic version label: V3.29.

Test status:
- Node syntax check: PASS.
- V3.29 static guard tests: PASS.
- Live browser check of 4home category: 506 product count shown by website; initial 24 cards, load-more append observed to 50; category pagination stays in category; direct p=13 opens and shows category content.
- Full importer extractor/e2e tests NOT run: npm dependency install (cheerio, ipaddr.js) timed out in test environment.
- Do not import/approve catalog yet. Next local preview is a validation test only.
