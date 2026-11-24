NOVA AI IMPORTER V3.42 – OPRAVA LIMITU DETAILOV A VEĽKOSTI BALENIA

Obsah:
- server.js
- website-import-v2.js
- tests/importer-safety-regression.test.cjs

Dôležité:
1. Pred výmenou súborov zastavte server a vytvorte zálohu celého projektu.
2. Nahraďte iba server.js a website-import-v2.js.
3. Testovací súbor skopírujte do existujúceho priečinka tests. Zachovajte aj ostatné existujúce testy.
4. catalog.json, tenants.json, users.json, leads.json, quotes.json ani admin HTML sa v tomto ZIP-e nenahrádzajú.

Opravy:
- Dosiahnutie limitu 30 produktových detailov je zaznamenané ako obmedzené pokrytie detailov, nie ako neúplné stránkovanie kategórie.
- Úplnosť kategórie sa posudzuje podľa chýb kategórie/paginácie a zostávajúcej fronty.
- Chyby detailových stránok zostávajú samostatne diagnostikované.
- Parser balenia už nepovažuje všeobecné označenie „hmotnosť“ alebo „balenie“ za dôkaz veľkosti balenia; vyžaduje explicitnejšie označenie netto obsahu/balenia.

Overenie v tomto balíku:
- node --check website-import-v2.js
- node --check server.js
- node --test tests/*.test.cjs

Poznámka: Regresné testy a syntaktická kontrola nie sú živým crawl testom. Pred schválením importu vždy skontrolujte náhľad a diagnostiku. Tento balík nemení ani neobsahuje catalog.json.
