import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./website-import-v2.js', import.meta.url), 'utf8');
assert.match(source, /const FOURHOME_MAX_BYTES = 16 \* 1024 \* 1024;/);
assert.match(source, /const hostMaxBytes = \/\(\^\|\\\.\)4home\\\.sk\$\/i\.test\(currentUrl\.hostname\)/);
assert.match(source, /const fourhomeCategoryPath = isFourhomeStart/);
assert.match(source, /candidatePath !== fourhomeCategoryPath/);
assert.match(source, /importerVersion: "V3\.28"/);
assert.match(source, /maxResponseBytes: isFourhomeStart \? FOURHOME_MAX_BYTES : MAX_BYTES/);
console.log('V3.28 guard checks passed: bounded 4home response cap, exact category-path scope, version diagnostics.');
