'use strict';

const assert = require('assert');
const { CATEGORY_ENTRIES } = require('../legacy/catalog-taxonomy');
const { marketSeeds, intelligenceFor } = require('../legacy/catalog-intelligence');

assert.strictEqual(CATEGORY_ENTRIES.length, 200, 'Catalog taxonomy must contain exactly 200 subcategories.');

const seeds = marketSeeds();
assert.ok(seeds.length >= 120, 'Catalog Intelligence must ship with a meaningful market-anchor set.');
const ids = new Set();
for (const seed of seeds) {
  const key = String(seed.packageId || '').toLowerCase();
  assert.ok(key, 'Every market seed needs a package ID.');
  assert.ok(!ids.has(key), `Duplicate market seed: ${seed.packageId}`);
  ids.add(key);
  const info = intelligenceFor(seed, { forceCurated:true });
  assert.strictEqual(info.status, 'curated', `${seed.packageId} must be a curated market anchor.`);
  assert.ok(String(info.category || '').includes(' › '), `${seed.packageId} must resolve into the 200-category taxonomy.`);
  assert.ok(info.marketScore >= 60, `${seed.packageId} market score is unexpectedly weak.`);
}

const sdk = intelligenceFor({ packageId:'Example.Product.SDK', name:'Example Product SDK', publisher:'Example' });
assert.strictEqual(sdk.status, 'rejected', 'SDK/component packages must not enter Discover.');

const obscure = intelligenceFor({ packageId:'RandomTiny.Project', name:'RandomTiny Project', publisher:'Unknown Individual' });
assert.notStrictEqual(obscure.status, 'curated', 'Unknown long-tail projects must not become Discover software by default.');

const commercial = intelligenceFor({ packageId:'Adobe.CreativeCloud', name:'Adobe Creative Cloud', publisher:'Adobe' });
assert.strictEqual(commercial.status, 'curated');
assert.strictEqual(commercial.commercialProduct, true);
assert.strictEqual(commercial.pricingModel, 'subscription');

const freemium = intelligenceFor({ packageId:'Figma.Figma', name:'Figma', publisher:'Figma' });
assert.strictEqual(freemium.status, 'curated');
assert.strictEqual(freemium.hasFreeTier, true);

console.log(`Catalog Intelligence OK: ${seeds.length} market anchors, ${CATEGORY_ENTRIES.length} subcategories.`);
