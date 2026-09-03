'use strict';

// HSWare v11.5 Catalog Expansion Engine
//
// Catalog Intelligence v11.4 established a conservative high-confidence layer.
// v11.5 uses the complete verified WinGet index as a candidate pool, applies a
// broader end-user classification model and keeps the complete verified WinGet
// package index visible in Discover. Scores remain useful for ordering, but they
// no longer remove valid WinGet PackageIdentifier records from the catalog.

const { intelligenceFor, productSeed } = require('./catalog-intelligence');
const { inferCatalogCategory, resolveCatalogCategory, taxonomy } = require('./catalog-taxonomy');

const DISCOVER_TARGET = 50000;
const MIN_EXPANSION_SCORE = 34;
const CATEGORY_COUNT = taxonomy().reduce((n, group) => n + group.categories.length, 0);
const BASE_CATEGORY_QUOTA = Math.max(1, Math.floor(DISCOVER_TARGET / Math.max(1, CATEGORY_COUNT)));

const HARD_REJECT = [
  /(?:^|[\s._-])(runtime|redistributable|redist|sdk|devkit|headers?|symbols?|lang(?:uage)?[\s._-]*pack|driver[\s._-]*pack|plugin|extension|addon|module|libraries?|samples?|tests?|testdata|debug)(?:$|[\s._-])/i,
  /(?:^|[\s._-])(nightly|alpha|beta|preview|canary|snapshot|insiders?|experimental|devbuild|unstable)(?:$|[\s._-])/i,
  /(?:^|[\s._-])(sample|example|template|skeleton|starter[\s._-]*kit)(?:$|[\s._-])/i,
  /(?:^|[\s._-])(toolchain|compiler[\s._-]*runtime|server[\s._-]*core|headless|daemon|service[\s._-]*only)(?:$|[\s._-])/i
];

const END_USER = /\b(app|application|desktop|client|studio|editor|viewer|player|manager|browser|terminal|console|utility|suite|launcher|recorder|converter|monitor|reader|designer|ide|vpn|chat|meeting|office|backup|sync|remote|capture|wallet|calendar|notes?|database|search|scanner|benchmark|music|video|photo|graphics|security|password|file|download|mail|messenger|finance|accounting|diagram|project|task|game)\b/i;
const PRODUCT_SUFFIX = /\.(desktop|client|studio|editor|viewer|player|manager|browser|terminal|launcher|reader|ide|app)$/i;
const LOW_SIGNAL = /\b(cli|command line|library|framework|runtime|sdk|developer kit|portable|unofficial|fork|legacy|deprecated|old version)\b/i;
const VARIANT_WORDS = new Set([
  'x64','x86','x32','arm','arm64','amd64','win32','win64','windows','stable','latest','machine','user','system',
  'installer','install','setup','msi','exe','portable','store','desktop','client','app','application'
]);

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[_+./-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function usefulPublisher(item = {}) {
  const publisher = normalize(item.publisher || String(item.packageId || item.package_id || '').split('.')[0]);
  if (!publisher || publisher.length < 2) return false;
  return !/^(unknown|none|null|n a|na|community|developer|author|vendor)$/.test(publisher);
}

function canonicalGroupKey(item = {}) {
  const packageId = String(item.packageId || item.package_id || '');
  const publisher = normalize(item.publisher || packageId.split('.')[0] || 'unknown');
  let name = normalize(item.canonicalName || item.canonical_name || item.name || packageId.split('.').slice(1).join(' ') || packageId);
  const tokens = name.split(' ').filter(Boolean);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (VARIANT_WORDS.has(last) || /^v?\d+(?:\d+)?$/.test(last)) tokens.pop();
    else break;
  }
  name = tokens.join(' ') || normalize(packageId);
  return `${publisher}|${name}`.slice(0, 190);
}

function fallbackCategory(item = {}) {
  return resolveCatalogCategory(item);
}

function expansionFor(item = {}) {
  const packageId = String(item.packageId || item.package_id || '');
  const name = String(item.canonicalName || item.canonical_name || item.name || packageId.split('.').pop() || packageId);
  const publisher = String(item.publisher || packageId.split('.')[0] || '');
  const hay = normalize([packageId,name,publisher,item.category,item.searchAliases,item.search_aliases].filter(Boolean).join(' '));
  const base = intelligenceFor({ ...item, packageId, name, publisher });
  const anchor = Boolean(productSeed({ packageId })) || base.sourceConfidence === 'market-anchor';
  const category = resolveCatalogCategory({ ...item, packageId, name, publisher });
  const componentLike = !hay || HARD_REJECT.some(re => re.test(hay));

  let score = 0;
  const reasons = [];
  if (anchor) { score += 55; reasons.push('market anchor'); }
  if (category) { score += 24; reasons.push('classified end-user category'); }
  if (usefulPublisher({ ...item, packageId, publisher })) { score += 10; reasons.push('publisher identity'); }
  if (/^[a-z0-9][a-z0-9 .+&'()_-]{2,120}$/i.test(name.trim())) score += 8;
  if (/^[^.\s]{2,80}\.[^.\s]{2,160}$/.test(packageId)) score += 6;
  if (END_USER.test(hay)) { score += 14; reasons.push('end-user product signal'); }
  if (PRODUCT_SUFFIX.test(packageId)) score += 5;
  if (base.commercialProduct) { score += 8; reasons.push('commercial product signal'); }
  if (base.hasFreeTier || base.hasFreeTrial) score += 3;
  if (String(item.sourcePath || item.source_path || '').startsWith('manifests/')) score += 6;

  // Carry forward v11.4 evidence, but with bounded influence so unknown products
  // can still qualify from the indexed long tail.
  score += Math.round(Number(base.marketScore || item.market_score || 0) * 0.10);
  score += Math.round(Number(base.qualityScore || item.quality_score || 0) * 0.08);
  score += Math.round(Number(base.relevanceScore || item.relevance_score || 0) * 0.10);

  if (LOW_SIGNAL.test(hay)) { score -= 18; reasons.push('developer/variant signal'); }
  if (/\b(portable|unofficial|fork|legacy|deprecated)\b/.test(hay)) score -= 10;
  if (/\b(cli|command line)\b/.test(hay) && !/\b(terminal|developer|database|network|security)\b/.test(hay)) score -= 10;

  if (componentLike) { score = Math.max(1, score - 18); reasons.push('component/prerelease identity retained in complete WinGet catalog'); }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const eligible = Boolean(category);
  return {
    ...base,
    category,
    expansionScore:score,
    expansionState:eligible ? 'qualified' : 'search-only',
    expansionTier:eligible ? (score >= 88 ? 'featured' : score >= 70 ? 'recommended' : 'standard') : 'search-only',
    canonicalGroupKey:canonicalGroupKey({ ...item, packageId, name, publisher }),
    hardRejected:false,
    anchor,
    reason:reasons.join('; ') || (eligible ? 'Qualified by Catalog Expansion end-user signals.' : 'Indexed but below automatic Discover threshold.')
  };
}

function sortDecision(a, b) {
  if (a.info.anchor !== b.info.anchor) return a.info.anchor ? -1 : 1;
  if (b.info.expansionScore !== a.info.expansionScore) return b.info.expansionScore - a.info.expansionScore;
  const ar = Number(a.item.demandRank ?? a.item.demand_rank ?? a.item.discoveryRank ?? a.item.discovery_rank ?? a.item.id ?? 99999999);
  const br = Number(b.item.demandRank ?? b.item.demand_rank ?? b.item.discoveryRank ?? b.item.discovery_rank ?? b.item.id ?? 99999999);
  if (ar !== br) return ar - br;
  return String(a.item.packageId || a.item.package_id || '').localeCompare(String(b.item.packageId || b.item.package_id || ''));
}

function planExpansion(items = [], target = DISCOVER_TARGET) {
  const safeTarget = Math.max(100, Math.min(50000, Number(target) || DISCOVER_TARGET));
  const decisions = items.map(item => ({ item, info:expansionFor(item), selected:true, duplicateOf:null }));
  const categories = taxonomy().flatMap(g => g.categories);
  const quota = Math.max(1, Math.floor(Math.max(decisions.length, 1) / Math.max(1, categories.length)));

  // Full-catalog mode: every verified WinGet PackageIdentifier remains visible.
  // Canonical grouping and relevance scores are retained as metadata only; they
  // are not used to suppress variants, SDKs, runtimes, CLI tools, or long-tail apps.
  for (const d of decisions) {
    d.catalogStatus = 'curated';
    d.info.category = resolveCatalogCategory({ ...d.item, category:d.info.category });
    d.info.expansionState = 'qualified';
    if (!d.info.expansionTier || d.info.expansionTier === 'search-only' || d.info.expansionTier === 'hidden') d.info.expansionTier = 'standard';
  }

  return {
    target:safeTarget,
    quota,
    effectiveFloor:0,
    processed:decisions.length,
    selected:decisions.length,
    qualified:decisions.length,
    searchOnly:0,
    rejected:0,
    duplicates:0,
    decisions
  };
}

module.exports = {
  DISCOVER_TARGET,
  MIN_EXPANSION_SCORE,
  BASE_CATEGORY_QUOTA,
  canonicalGroupKey,
  fallbackCategory,
  expansionFor,
  planExpansion
};
