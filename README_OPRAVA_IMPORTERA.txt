NOVA AI – oprava univerzalneho website importera

CO SA OPRAVUJE
V extractProductsFromHtml() mala rychla vetva pre viac JSON-LD variantov iny navratovy format:
- bezna vetva vracia objekt { products, diagnostics }
- rychla JSON-LD variantova vetva vracala iba pole produktov

extractWebsiteContent() vsak ocakava extracted.products a extracted.diagnostics.
Preto sa pri strankach s viacerymi JSON-LD variantmi produkty nasli, ale v crawleri sa stratili.

ZASAH
Opravena je iba tato navratova vetva. Teraz vracia rovnaky objektovy kontrakt ako zvysok funkcie a zachovava diagnostiku.
server.js a catalog.json neboli menene.

INSTALACIA
1. Rozbal ZIP do korenoveho priecinka projektu NOVA AI (tam, kde je server.js).
2. Otvor CMD v priecinku projektu.
3. Spusti:
   powershell -NoProfile -ExecutionPolicy Bypass -File .\INSTALL_OPRAVA_IMPORTERA.ps1
4. Over syntax:
   node --check website-import-v2.js
5. Spusti test:
   node test-gymbeam-active-importer.js

Ocakavany vysledok testu GymBeam: totalProducts = 3, produkty Protein Latte cokolada, kava a matcha.
Testovaci skript nesmie zapisovat do katalogu.

Automaticka zaloha povodneho website-import-v2.js sa vytvori pred prepisom.
