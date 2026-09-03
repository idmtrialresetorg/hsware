'use strict';

const assert = require('assert');
const { taxonomy } = require('../legacy/catalog-taxonomy');
const { DISCOVER_TARGET, MIN_EXPANSION_SCORE, expansionFor, canonicalGroupKey, planExpansion } = require('../legacy/catalog-expansion');

const categories = taxonomy().flatMap(g => g.categories);
assert.strictEqual(categories.length, 200);
assert.strictEqual(DISCOVER_TARGET, 50000);
assert.ok(MIN_EXPANSION_SCORE >= 20 && MIN_EXPANSION_SCORE <= 50);

const sdk = expansionFor({ packageId:'Example.Product.SDK', name:'Example Product SDK', publisher:'Example', sourcePath:'manifests/e/Example/Product/1.0/Example.Product.yaml' });
assert.strictEqual(sdk.expansionState, 'qualified');
assert.ok(categories.includes(sdk.category), 'SDKs/runtimes must still resolve into the 200-category catalog.');

const normal = expansionFor({ packageId:'Acme.PhotoManager', name:'Photo Manager', publisher:'Acme Software', sourcePath:'manifests/e/Acme.PhotoManager/1.0/Acme.PhotoManager.yaml' });
assert.ok(normal.category);
assert.ok(normal.expansionScore > 0);

assert.strictEqual(
  canonicalGroupKey({ packageId:'Vendor.Product.x64', name:'Product x64', publisher:'Vendor' }),
  canonicalGroupKey({ packageId:'Vendor.Product.x86', name:'Product x86', publisher:'Vendor' })
);

const pool = [];
for (let i = 0; i < 13000; i++) {
  const category = categories[i % categories.length];
  pool.push({
    id:i + 1,
    package_id:`Publisher${i}.DesktopProduct${i}`,
    name:`Desktop Product ${i}`,
    publisher:`Publisher ${i}`,
    category,
    source_path:`manifests/p/Publisher${i}/DesktopProduct${i}/1.0/Publisher${i}.DesktopProduct${i}.yaml`,
    discovery_rank:i + 1
  });
}
const plan = planExpansion(pool, 50000);
assert.strictEqual(plan.processed, 13000);
assert.strictEqual(plan.selected, 13000, 'Every verified WinGet identity should remain visible in full-catalog mode.');
assert.ok(plan.quota >= 1);
assert.strictEqual(plan.qualified, 13000);
assert.strictEqual(plan.effectiveFloor, 0);
assert.strictEqual(plan.searchOnly, 0);
assert.strictEqual(plan.rejected, 0);
assert.strictEqual(plan.duplicates, 0);

const selectedCategories = new Set(plan.decisions.filter(d => d.selected).map(d => d.info.category));
assert.strictEqual(selectedCategories.size, 200, 'Balanced expansion should cover all 200 categories when candidates exist.');

console.log(`Full WinGet Catalog OK: ${plan.selected}/${plan.processed} visible, ${selectedCategories.size} categories.`);
