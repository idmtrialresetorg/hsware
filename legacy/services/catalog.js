const config = require('../config');
const { getPool } = require('../db');
const { listContents, getTree, hasToken } = require('./github');
const { titleizePackageId } = require('../utils/text');
const { compareVersions } = require('../utils/version');
const state = require('../state');
const reliability = require('./reliability');
const { inferCatalogCategory, resolveCatalogCategory, taxonomy } = require('../catalog-taxonomy');
const { marketSeeds, productSeed, intelligenceFor, demandRankFromIntelligence } = require('../catalog-intelligence');
const { DISCOVER_TARGET, planExpansion } = require('../catalog-expansion');

const SYNC_KEY = 'winget-main';
const CATALOG_LOCK = 'hsware_catalog_sync_v709';
let marketSeedCanonicalSynced = false;

async function upsertCanonicalChunk(db, records, ids) {
  if (!records.length) return;
  const placeholders = records.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
  const params = [];
  for (const r of records) {
    params.push(
      String(r.packageId || '').toLowerCase(), r.canonicalName || r.name || r.packageId, r.publisher || null, r.category || null,
      r.status || 'candidate', r.marketScore ?? null, r.qualityScore ?? null, r.relevanceScore ?? null,
      r.pricingModel || 'unknown', r.hasFreeTier ? 1 : 0, r.hasFreeTrial ? 1 : 0, r.commercialProduct ? 1 : 0,
      r.sourceConfidence || null, r.expansionTier || null, r.expansionScore ?? null
    );
  }
  await db.query(
    `INSERT INTO canonical_software
      (canonical_key,canonical_name,publisher,category,catalog_status,market_score,quality_score,relevance_score,pricing_model,has_free_tier,has_free_trial,commercial_product,intelligence_source,expansion_tier,expansion_score)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       canonical_name=VALUES(canonical_name),publisher=COALESCE(VALUES(publisher),canonical_software.publisher),
       category=COALESCE(VALUES(category),canonical_software.category),
       catalog_status=IF(canonical_software.expansion_score IS NULL,VALUES(catalog_status),canonical_software.catalog_status),
       market_score=VALUES(market_score),quality_score=VALUES(quality_score),relevance_score=VALUES(relevance_score),
       pricing_model=VALUES(pricing_model),has_free_tier=VALUES(has_free_tier),has_free_trial=VALUES(has_free_trial),
       commercial_product=VALUES(commercial_product),intelligence_source=VALUES(intelligence_source),
       expansion_tier=COALESCE(VALUES(expansion_tier),canonical_software.expansion_tier),
       expansion_score=COALESCE(VALUES(expansion_score),canonical_software.expansion_score)`, params
  );
  if (ids?.length) {
    await db.query(
      `INSERT INTO software_sources (canonical_id,source_type,source_key,source_url,verified,last_seen_at)
       SELECT cs.id,'winget',c.package_id,c.source_path,IF(c.source_path IS NULL OR c.source_path='',0,1),NOW()
       FROM catalog_packages c JOIN canonical_software cs ON cs.canonical_key=LOWER(c.package_id)
       WHERE c.id IN (${ids.map(() => '?').join(',')})
       ON DUPLICATE KEY UPDATE source_url=VALUES(source_url),verified=VALUES(verified),last_seen_at=VALUES(last_seen_at)`, ids
    );
  }
}

async function seedPopularCatalog() {
  const db = getPool();
  let ranked = 0;
  // Market anchors label and rank only WinGet packages that were actually
  // observed. They never manufacture phantom Discover rows.
  for (const item of marketSeeds()) {
    const info = intelligenceFor(item, { forceCurated:true });
    const { rank, packageId, name, publisher } = item;
    const demandRank = rank || demandRankFromIntelligence(info, rank || 0);
    const [result] = await db.query(
      `UPDATE catalog_packages SET
         name=?,canonical_name=?,category=?,publisher=COALESCE(publisher,?),search_aliases=?,
         discovery_rank=LEAST(COALESCE(discovery_rank,?),?),demand_rank=LEAST(COALESCE(demand_rank,?),?),
         catalog_status='curated',market_score=?,quality_score=?,relevance_score=?,pricing_model=?,
         has_free_tier=?,has_free_trial=?,commercial_product=?,intelligence_source=?,intelligence_reason=?,intelligence_updated_at=NOW()
       WHERE package_id=? AND source_path IS NOT NULL AND source_path<>''`,
      [name, info.canonicalName || name, info.category || null, publisher || null,
       `${name} ${packageId} ${publisher || ''} ${info.category || ''}`, rank || null, rank || null,
       demandRank || null, demandRank || null, info.marketScore, info.qualityScore, info.relevanceScore, info.pricingModel,
       info.hasFreeTier ? 1 : 0, info.hasFreeTrial ? 1 : 0, info.commercialProduct ? 1 : 0,
       info.sourceConfidence, info.reason, packageId]
    );
    ranked += Number(result.affectedRows || 0);
  }
  if (!marketSeedCanonicalSynced) {
    const ids = marketSeeds().map(x => x.packageId);
    if (ids.length) {
      const [rows] = await db.query(
        `SELECT id,package_id,name,publisher,category FROM catalog_packages WHERE source_path IS NOT NULL AND source_path<>'' AND package_id IN (${ids.map(() => '?').join(',')})`, ids
      );
      for (let offset = 0; offset < rows.length; offset += 250) {
        const chunk = rows.slice(offset, offset + 250);
        const records = chunk.map(row => ({ packageId:row.package_id,name:row.name,publisher:row.publisher,...intelligenceFor({packageId:row.package_id,name:row.name,publisher:row.publisher,category:row.category},{forceCurated:true}) }));
        await upsertCanonicalChunk(db, records, chunk.map(row => Number(row.id)));
      }
    }
    marketSeedCanonicalSynced = true;
  }
  return ranked;
}

let catalogCurationBackfilled = false;
async function backfillCatalogCuration(limit = 20000) {
  if (catalogCurationBackfilled) return 0;
  const db = getPool();
  const safeLimit = Math.max(100, Math.min(50000, Number(limit) || 20000));
  const [rows] = await db.query(
    `SELECT id,package_id,name,publisher,category,discovery_rank,demand_rank,catalog_status,relevance_score,intelligence_updated_at
     FROM catalog_packages
     WHERE source_path IS NOT NULL AND source_path<>''
       AND (intelligence_updated_at IS NULL OR relevance_score IS NULL OR catalog_status IS NULL OR category IS NULL OR category='' OR category NOT LIKE '% › %')
     ORDER BY id LIMIT ?`, [safeLimit]
  );
  let updated = 0;
  for (let offset = 0; offset < rows.length; offset += 250) {
    const chunk = rows.slice(offset, offset + 250);
    const fields = {
      category:[], canonical:[], rank:[], status:[], market:[], quality:[], relevance:[], pricing:[], freeTier:[], freeTrial:[], commercial:[], source:[], reason:[]
    };
    const values = Object.fromEntries(Object.keys(fields).map(k => [k, []]));
    const ids = [];
    const canonicalRecords = [];
    for (const row of chunk) {
      const currentCategory = String(row.category || '').includes(' › ') ? row.category : null;
      const info = intelligenceFor({ packageId:row.package_id, name:row.name, publisher:row.publisher, category:currentCategory });
      const category = resolveCatalogCategory({ packageId:row.package_id, name:row.name, publisher:row.publisher, category:currentCategory || info.category });
      const rank = demandRankFromIntelligence(info, Number(row.discovery_rank || row.id));
      const record = { packageId:row.package_id, name:row.name, publisher:row.publisher, ...info, category, status:'curated' };
      canonicalRecords.push(record);
      const mapping = {
        category, canonical:info.canonicalName || row.name || row.package_id, rank,
        status:'curated', market:info.marketScore, quality:info.qualityScore, relevance:info.relevanceScore,
        pricing:info.pricingModel, freeTier:info.hasFreeTier ? 1 : 0, freeTrial:info.hasFreeTrial ? 1 : 0,
        commercial:info.commercialProduct ? 1 : 0, source:info.sourceConfidence, reason:String(info.reason || '').slice(0,500)
      };
      for (const key of Object.keys(fields)) { fields[key].push('WHEN ? THEN ?'); values[key].push(Number(row.id), mapping[key]); }
      ids.push(Number(row.id));
    }
    await db.query(
      `UPDATE catalog_packages SET
         category=CASE id ${fields.category.join(' ')} ELSE category END,
         canonical_name=CASE id ${fields.canonical.join(' ')} ELSE canonical_name END,
         demand_rank=IF(expansion_updated_at IS NULL,CASE id ${fields.rank.join(' ')} ELSE demand_rank END,demand_rank),
         catalog_status=IF(expansion_updated_at IS NULL,CASE id ${fields.status.join(' ')} ELSE catalog_status END,catalog_status),
         market_score=CASE id ${fields.market.join(' ')} ELSE market_score END,
         quality_score=CASE id ${fields.quality.join(' ')} ELSE quality_score END,
         relevance_score=CASE id ${fields.relevance.join(' ')} ELSE relevance_score END,
         pricing_model=CASE id ${fields.pricing.join(' ')} ELSE pricing_model END,
         has_free_tier=CASE id ${fields.freeTier.join(' ')} ELSE has_free_tier END,
         has_free_trial=CASE id ${fields.freeTrial.join(' ')} ELSE has_free_trial END,
         commercial_product=CASE id ${fields.commercial.join(' ')} ELSE commercial_product END,
         intelligence_source=CASE id ${fields.source.join(' ')} ELSE intelligence_source END,
         intelligence_reason=CASE id ${fields.reason.join(' ')} ELSE intelligence_reason END,
         intelligence_updated_at=NOW()
       WHERE id IN (${ids.map(() => '?').join(',')})`,
      [...values.category,...values.canonical,...values.rank,...values.status,...values.market,...values.quality,...values.relevance,
       ...values.pricing,...values.freeTier,...values.freeTrial,...values.commercial,...values.source,...values.reason,...ids]
    );
    await upsertCanonicalChunk(db, canonicalRecords, ids);
    updated += chunk.length;
  }

  // Normalize legacy workspace categories into the same 200-category taxonomy.
  const [softwareRows] = await db.query(
    `SELECT id,package_id,name,publisher,category FROM software
     WHERE workspace_added=1 AND (category IS NULL OR category='' OR category NOT LIKE '% › %')
     ORDER BY id LIMIT ?`, [safeLimit]
  );
  for (let offset = 0; offset < softwareRows.length; offset += 250) {
    const chunk = softwareRows.slice(offset, offset + 250);
    const cases = [];
    const params = [];
    const ids = [];
    for (const row of chunk) {
      const info = intelligenceFor({ packageId:row.package_id, name:row.name, publisher:row.publisher });
      const category = resolveCatalogCategory({ ...row, category:info.category || row.category });
      cases.push('WHEN ? THEN ?'); params.push(Number(row.id), category); ids.push(Number(row.id));
    }
    if (ids.length) await db.query(
      `UPDATE software SET category=CASE id ${cases.join(' ')} ELSE category END WHERE id IN (${ids.map(() => '?').join(',')})`,
      [...params, ...ids]
    );
  }
  if (rows.length < safeLimit && softwareRows.length < safeLimit) catalogCurationBackfilled = true;
  return updated;
}


const EXPANSION_KEY = 'winget-main';
const EXPANSION_LOCK = 'hsware_catalog_expansion_v115';
let catalogExpansionLastRunAt = 0;
let catalogExpansionPromise = null;

async function getExpansionState() {
  const db = getPool();
  const [rows] = await db.query('SELECT * FROM catalog_expansion_state WHERE expansion_key=? LIMIT 1', [EXPANSION_KEY]);
  return rows[0] || {
    expansion_key:EXPANSION_KEY,target_count:DISCOVER_TARGET,processed_count:0,qualified_count:0,
    selected_count:0,search_only_count:0,rejected_count:0,duplicate_count:0,last_run_at:null,last_error:null
  };
}

async function rebalanceCatalogExpansionUnlocked(target = DISCOVER_TARGET) {
  const db = getPool();
  const safeTarget = Math.max(100, Math.min(50000, Number(target) || DISCOVER_TARGET));
  try {
    const [rows] = await db.query(
      `SELECT id,package_id,name,canonical_name,publisher,category,search_aliases,source_path,discovery_rank,demand_rank,
              market_score,quality_score,relevance_score,pricing_model,has_free_tier,has_free_trial,commercial_product,intelligence_source,
              catalog_status,expansion_state,expansion_tier,expansion_score,canonical_group_key,duplicate_of_package_id,expansion_reason
       FROM catalog_packages
       WHERE source_path IS NOT NULL AND source_path<>''
       ORDER BY id LIMIT 50000`
    );
    const plan = planExpansion(rows, safeTarget);
    for (let offset = 0; offset < plan.decisions.length; offset += 200) {
      const sourceChunk = plan.decisions.slice(offset, offset + 200);
      const fields = { category:[], rank:[], status:[], state:[], tier:[], score:[], group:[], duplicate:[], reason:[] };
      const values = Object.fromEntries(Object.keys(fields).map(k => [k, []]));
      const ids = [];
      for (const d of sourceChunk) {
        const id = Number(d.item.id);
        const mapping = {
          category:d.info.category || d.item.category || null,
          rank:d.selected ? (d.info.anchor && d.item.demand_rank != null
            ? Number(d.item.demand_rank)
            : 100000 + ((100 - Number(d.info.expansionScore || 0)) * 1000) + (Number(d.item.discovery_rank || d.item.id || 0) % 1000))
            : (d.item.demand_rank == null ? null : Number(d.item.demand_rank)),
          status:d.catalogStatus,
          state:d.info.expansionState,
          tier:d.info.expansionTier,
          score:d.info.expansionScore,
          group:d.info.canonicalGroupKey || null,
          duplicate:d.duplicateOf || null,
          reason:String(d.info.reason || '').slice(0,500)
        };
        const current = {
          category:d.item.category || null,
          rank:d.item.demand_rank == null ? null : Number(d.item.demand_rank),
          status:d.item.catalog_status || null,
          state:d.item.expansion_state || null,
          tier:d.item.expansion_tier || null,
          score:d.item.expansion_score == null ? null : Number(d.item.expansion_score),
          group:d.item.canonical_group_key || null,
          duplicate:d.item.duplicate_of_package_id || null,
          reason:String(d.item.expansion_reason || '').slice(0,500) || null
        };
        const same = Object.keys(mapping).every(key => {
          const a = mapping[key] == null ? null : mapping[key];
          const b = current[key] == null ? null : current[key];
          return typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : String(a ?? '') === String(b ?? '');
        });
        if (same) continue;
        for (const key of Object.keys(fields)) { fields[key].push('WHEN ? THEN ?'); values[key].push(id, mapping[key]); }
        ids.push(id);
      }
      if (!ids.length) continue;
      await db.query(
        `UPDATE catalog_packages SET
           category=CASE id ${fields.category.join(' ')} ELSE category END,
           demand_rank=CASE id ${fields.rank.join(' ')} ELSE demand_rank END,
           catalog_status=CASE id ${fields.status.join(' ')} ELSE catalog_status END,
           expansion_state=CASE id ${fields.state.join(' ')} ELSE expansion_state END,
           expansion_tier=CASE id ${fields.tier.join(' ')} ELSE expansion_tier END,
           expansion_score=CASE id ${fields.score.join(' ')} ELSE expansion_score END,
           canonical_group_key=CASE id ${fields.group.join(' ')} ELSE canonical_group_key END,
           duplicate_of_package_id=CASE id ${fields.duplicate.join(' ')} ELSE duplicate_of_package_id END,
           expansion_reason=CASE id ${fields.reason.join(' ')} ELSE expansion_reason END,
           expansion_updated_at=NOW()
         WHERE id IN (${ids.map(() => '?').join(',')})`,
        [...values.category,...values.rank,...values.status,...values.state,...values.tier,...values.score,...values.group,...values.duplicate,...values.reason,...ids]
      );
    }

    // Mirror expansion visibility/scoring into canonical identities without
    // changing source mappings or workspace software rows.
    await db.query(`UPDATE canonical_software cs
      JOIN catalog_packages c ON cs.canonical_key=LOWER(c.package_id)
      SET cs.category=COALESCE(c.category,cs.category),cs.catalog_status=c.catalog_status,
          cs.expansion_tier=c.expansion_tier,cs.expansion_score=c.expansion_score`);

    await db.query(
      `INSERT INTO catalog_expansion_state
        (expansion_key,target_count,processed_count,qualified_count,selected_count,search_only_count,rejected_count,duplicate_count,last_run_at,last_error)
       VALUES (?,?,?,?,?,?,?,?,NOW(),NULL)
       ON DUPLICATE KEY UPDATE target_count=VALUES(target_count),processed_count=VALUES(processed_count),
         qualified_count=VALUES(qualified_count),selected_count=VALUES(selected_count),search_only_count=VALUES(search_only_count),
         rejected_count=VALUES(rejected_count),duplicate_count=VALUES(duplicate_count),last_run_at=VALUES(last_run_at),last_error=NULL`,
      [EXPANSION_KEY,plan.target,plan.processed,plan.qualified,plan.selected,plan.searchOnly,plan.rejected,plan.duplicates]
    );
    catalogExpansionLastRunAt = Date.now();
    return { ...plan, decisions:undefined };
  } catch (err) {
    try {
      await db.query(`INSERT INTO catalog_expansion_state (expansion_key,target_count,last_error)
        VALUES (?,?,?) ON DUPLICATE KEY UPDATE last_error=VALUES(last_error)`,
        [EXPANSION_KEY,safeTarget,String(err.message || err).slice(0,2000)]);
    } catch {}
    throw err;
  }
}


async function withExpansionLock(task, fallback = null) {
  const db = getPool();
  const conn = await db.getConnection();
  let locked = false;
  try {
    const [[row]] = await conn.query('SELECT GET_LOCK(?,0) AS got', [EXPANSION_LOCK]);
    locked = Number(row?.got || 0) === 1;
    if (!locked) return typeof fallback === 'function' ? fallback() : fallback;
    return await task();
  } finally {
    if (locked) { try { await conn.query('SELECT RELEASE_LOCK(?)', [EXPANSION_LOCK]); } catch {} }
    conn.release();
  }
}

async function rebalanceCatalogExpansion(target = DISCOVER_TARGET) {
  return withExpansionLock(
    () => rebalanceCatalogExpansionUnlocked(target),
    async () => {
      const st = await getExpansionState();
      return { ...st, busy:true, target:Number(st.target_count || DISCOVER_TARGET), selected:Number(st.selected_count || 0), processed:Number(st.processed_count || 0), qualified:Number(st.qualified_count || 0), searchOnly:Number(st.search_only_count || 0), rejected:Number(st.rejected_count || 0), duplicates:Number(st.duplicate_count || 0) };
    }
  );
}

async function ensureCatalogExpansion({ force=false, target=DISCOVER_TARGET } = {}) {
  if (catalogExpansionPromise) return catalogExpansionPromise;
  const db = getPool();
  const [[pending]] = await db.query(`SELECT COUNT(*) c FROM catalog_packages
    WHERE source_path IS NOT NULL AND source_path<>'' AND (expansion_updated_at IS NULL OR expansion_state='unprocessed' OR expansion_score IS NULL OR expansion_tier IS NULL)`);
  const stateRow = await getExpansionState();
  const freshPersisted = stateRow.last_run_at && (Date.now() - new Date(stateRow.last_run_at).getTime() < 10 * 60_000);
  const freshProcess = catalogExpansionLastRunAt && (Date.now() - catalogExpansionLastRunAt < 10 * 60_000);
  // Do not rebalance the entire 13k–50k pool on every catalog sync step. A
  // fresh expansion remains valid while new index rows accumulate; the worker
  // forces a bounded full rebalance every tenth step and again at completion.
  if (!force && (freshPersisted || freshProcess) && Number(stateRow.processed_count || 0) > 0) return stateRow;
  if (!force && Number(pending.c || 0) === 0 && Number(stateRow.processed_count || 0) > 0) return stateRow;
  catalogExpansionPromise = rebalanceCatalogExpansion(target).finally(() => { catalogExpansionPromise = null; });
  return catalogExpansionPromise;
}

async function counts() {
  const db = getPool();
  const curated = `(c.source_path IS NOT NULL AND c.source_path<>'')`;
  const [[catalog]] = await db.query(`SELECT COUNT(*) AS c FROM catalog_packages c WHERE ${curated}`);
  const [[available]] = await db.query(`SELECT COUNT(*) AS c FROM catalog_packages c LEFT JOIN software s ON s.package_id=c.package_id AND s.workspace_added=1 WHERE ${curated} AND s.id IS NULL`);
  const [[candidates]] = await db.query("SELECT COUNT(*) AS c FROM catalog_packages c LEFT JOIN software s ON s.package_id=c.package_id AND s.workspace_added=1 WHERE c.source_path IS NOT NULL AND c.source_path<>'' AND c.catalog_status='candidate' AND s.id IS NULL");
  const [[hidden]] = await db.query("SELECT COUNT(*) AS c FROM catalog_packages c LEFT JOIN software s ON s.package_id=c.package_id AND s.workspace_added=1 WHERE c.source_path IS NOT NULL AND c.source_path<>'' AND c.catalog_status='rejected' AND s.id IS NULL");
  const [[searchOnly]] = await db.query("SELECT COUNT(*) AS c FROM catalog_packages c WHERE c.source_path IS NOT NULL AND c.source_path<>'' AND c.expansion_state='search-only'");
  const [[duplicates]] = await db.query("SELECT COUNT(*) AS c FROM catalog_packages c WHERE c.source_path IS NOT NULL AND c.source_path<>'' AND c.expansion_state='duplicate'");
  const [[expansionPending]] = await db.query("SELECT COUNT(*) AS c FROM catalog_packages c WHERE c.source_path IS NOT NULL AND c.source_path<>'' AND (c.expansion_updated_at IS NULL OR c.expansion_state='unprocessed' OR c.expansion_score IS NULL OR c.expansion_tier IS NULL)");
  const expansion = await getExpansionState();
  const [[commercial]] = await db.query(`SELECT COUNT(*) AS c FROM catalog_packages c WHERE ${curated} AND c.commercial_product=1`);
  const [[freeTier]] = await db.query(`SELECT COUNT(*) AS c FROM catalog_packages c WHERE ${curated} AND c.has_free_tier=1`);
  const [[draft]] = await db.query(`SELECT COUNT(*) AS c FROM catalog_packages c JOIN software s ON s.package_id=c.package_id AND s.workspace_added=1 WHERE s.published=0`);
  const [[published]] = await db.query(`SELECT COUNT(*) AS c FROM catalog_packages c JOIN software s ON s.package_id=c.package_id AND s.workspace_added=1 WHERE s.published=1`);
  const [[updates]] = await db.query(`SELECT COUNT(*) AS c FROM catalog_packages c JOIN software s ON s.package_id=c.package_id AND s.workspace_added=1 WHERE s.update_available=1`);
  return {
    catalog:Number(catalog.c),available:Number(available.c),candidates:Number(candidates.c),hidden:Number(hidden.c),searchOnly:Number(searchOnly.c),duplicates:Number(duplicates.c),commercial:Number(commercial.c),freeTier:Number(freeTier.c),anchors:marketSeeds().length,
    expansionTarget:Number(expansion.target_count || DISCOVER_TARGET),expansionProcessed:Number(expansion.processed_count || 0),expansionQualified:Number(expansion.qualified_count || 0),
    expansionSelected:Number(expansion.selected_count || 0),expansionPending:Number(expansionPending.c || 0),expansionError:expansion.last_error || null,
    draft:Number(draft.c),published:Number(published.c),updates:Number(updates.c)
  };
}

async function getSyncState() {
  const db = getPool();
  const [rows] = await db.query('SELECT * FROM catalog_sync_state WHERE sync_key=? LIMIT 1', [SYNC_KEY]);
  if (!rows[0]) return { status: 'idle', target_count: config.catalogTarget, processed_count: 0, inserted_count: 0, seen_count: 0, queue_json: '[]' };
  return rows[0];
}

async function startSyncUnlocked(target = config.catalogTarget) {
  await seedPopularCatalog();
  await backfillCatalogCuration();
  const db = getPool();
  const root = await listContents('manifests');
  const queue = (Array.isArray(root) ? root : [])
    .filter(item => item.type === 'dir' && item.sha)
    .map(item => ({ path: item.path, sha: item.sha }));
  await db.query(
    `INSERT INTO catalog_sync_state (sync_key,status,target_count,queue_json,processed_count,inserted_count,seen_count,last_error)
     VALUES (?,?,?,?,0,0,0,NULL)
     ON DUPLICATE KEY UPDATE status=VALUES(status), target_count=VALUES(target_count), queue_json=VALUES(queue_json),
       processed_count=0, inserted_count=0, seen_count=0, last_error=NULL`,
    [SYNC_KEY, 'running', Math.max(100, Math.min(config.catalogTarget, Number(target) || config.catalogTarget)), JSON.stringify(queue)]
  );
  return getSyncState();
}

function packageIdFromInstallerPath(pathValue) {
  const name = String(pathValue).split('/').pop() || '';
  if (!/\.installer\.yaml$/i.test(name)) return null;
  return name.replace(/\.installer\.yaml$/i, '');
}
function versionFromPath(pathValue) {
  const parts = String(pathValue || '').split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

async function insertPackagesFromTree(tree) {
  const db = getPool();
  const grouped = new Map();
  for (const item of tree || []) {
    if (item.type !== 'blob' || !/\.installer\.yaml$/i.test(item.path || '')) continue;
    const packageId = packageIdFromInstallerPath(item.path);
    if (!packageId || packageId.length > 190) continue;
    const version = versionFromPath(item.path);
    if (!version) continue;
    const list = grouped.get(packageId) || [];
    list.push({ ...item, version });
    grouped.set(packageId, list);
  }

  // discovery_rank is only a stable traversal order. Market relevance is stored
  // independently in market_score/relevance_score and never presented as a
  // fabricated download count.
  const [[rankRow]] = await db.query('SELECT COALESCE(MAX(discovery_rank),0) AS max_rank FROM catalog_packages');
  let nextRank = Number(rankRow?.max_rank || 0);
  let inserted = 0;
  const canonicalRecords = [];
  const canonicalIds = [];
  const entries = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [packageId, manifests] of entries) {
    manifests.sort((a, b) => compareVersions(b.version, a.version));
    const bestItem = manifests[0];
    const seedInfo = productSeed({ packageId });
    const name = seedInfo?.name || titleizePackageId(packageId);
    const publisher = seedInfo?.publisher || packageId.split('.')[0] || null;
    const fullPath = bestItem.path.startsWith('manifests/') ? bestItem.path : null;
    const [[existing]] = await db.query('SELECT id,source_path,discovery_rank,category FROM catalog_packages WHERE package_id=? LIMIT 1', [packageId]);
    const existingVersion = versionFromPath(existing?.source_path);
    const candidateVersion = bestItem.version;
    const useCandidate = !existing?.source_path || compareVersions(candidateVersion, existingVersion) > 0;
    const discoveryRank = existing?.discovery_rank == null ? ++nextRank : Number(existing.discovery_rank);
    const info = intelligenceFor({ packageId, name, publisher, category:String(existing?.category || '').includes(' › ') ? existing.category : null });
    const category = resolveCatalogCategory({ packageId, name, publisher, category:existing?.category || info.category });
    const demandRank = demandRankFromIntelligence(info, discoveryRank);
    const [result] = await db.query(
      `INSERT INTO catalog_packages
       (package_id,name,canonical_name,publisher,category,search_aliases,source_path,discovery_rank,demand_rank,catalog_status,market_score,quality_score,relevance_score,pricing_model,has_free_tier,has_free_trial,commercial_product,intelligence_source,intelligence_reason,intelligence_updated_at,metadata_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),'index')
       ON DUPLICATE KEY UPDATE
         name=IF(catalog_packages.discovery_rank IS NULL,VALUES(name),catalog_packages.name),
         canonical_name=VALUES(canonical_name),publisher=COALESCE(catalog_packages.publisher,VALUES(publisher)),
         category=COALESCE(VALUES(category),catalog_packages.category),
         search_aliases=CONCAT_WS(' ',catalog_packages.search_aliases,VALUES(search_aliases)),
         source_path=IF(?,VALUES(source_path),catalog_packages.source_path),
         discovery_rank=COALESCE(catalog_packages.discovery_rank,VALUES(discovery_rank)),
         demand_rank=IF(catalog_packages.expansion_updated_at IS NULL,VALUES(demand_rank),catalog_packages.demand_rank),
         catalog_status=IF(catalog_packages.expansion_updated_at IS NULL,VALUES(catalog_status),catalog_packages.catalog_status),
         market_score=VALUES(market_score),
         quality_score=VALUES(quality_score),relevance_score=VALUES(relevance_score),pricing_model=VALUES(pricing_model),
         has_free_tier=VALUES(has_free_tier),has_free_trial=VALUES(has_free_trial),commercial_product=VALUES(commercial_product),
         intelligence_source=VALUES(intelligence_source),intelligence_reason=VALUES(intelligence_reason),intelligence_updated_at=NOW()`,
      [packageId, name, info.canonicalName || name, publisher, category, `${name} ${packageId} ${publisher || ''} ${category || ''}`,
       fullPath, discoveryRank, demandRank, 'curated', info.marketScore, info.qualityScore, info.relevanceScore, info.pricingModel,
       info.hasFreeTier ? 1 : 0, info.hasFreeTrial ? 1 : 0, info.commercialProduct ? 1 : 0, info.sourceConfidence, String(info.reason || '').slice(0,500), useCandidate ? 1 : 0]
    );
    if (result.affectedRows === 1) inserted++;
    const catalogId = existing?.id || Number(result.insertId || 0);
    if (catalogId) {
      canonicalIds.push(Number(catalogId));
      canonicalRecords.push({ packageId,name,publisher,...info,category,status:'curated' });
    }
    for (const item of manifests.slice(0, 6)) {
      const sourcePath = item.path.startsWith('manifests/') ? item.path : null;
      if (!sourcePath) continue;
      await db.query(
        `INSERT INTO catalog_version_paths (package_id,version,source_path)
         VALUES (?,?,?) ON DUPLICATE KEY UPDATE source_path=VALUES(source_path), updated_at=CURRENT_TIMESTAMP`,
        [packageId, item.version, sourcePath]
      );
    }
  }
  for (let offset = 0; offset < canonicalRecords.length; offset += 250) {
    await upsertCanonicalChunk(db, canonicalRecords.slice(offset, offset + 250), canonicalIds.slice(offset, offset + 250));
  }
  return { inserted, seen: grouped.size };
}


async function withCatalogLock(task, fallback = null) {
  const db = getPool();
  const conn = await db.getConnection();
  let locked = false;
  try {
    const [[row]] = await conn.query('SELECT GET_LOCK(?,0) AS got', [CATALOG_LOCK]);
    locked = Number(row?.got || 0) === 1;
    if (!locked) return typeof fallback === 'function' ? fallback() : fallback;
    return await task();
  } finally {
    if (locked) { try { await conn.query('SELECT RELEASE_LOCK(?)', [CATALOG_LOCK]); } catch {} }
    conn.release();
  }
}

async function backfillDiscoveryRanksUnlocked(limit = 2000) {
  const db = getPool();
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 2000));
  const [[maxRow]] = await db.query('SELECT COALESCE(MAX(discovery_rank),75) AS max_rank FROM catalog_packages');
  let nextRank = Math.max(75, Number(maxRow?.max_rank || 75));
  const [rows] = await db.query('SELECT id FROM catalog_packages WHERE discovery_rank IS NULL ORDER BY id LIMIT ?', [safeLimit]);
  if (!rows.length) return 0;
  let updated = 0;
  for (let offset = 0; offset < rows.length; offset += 250) {
    const chunk = rows.slice(offset, offset + 250);
    const cases = [];
    const caseParams = [];
    const ids = [];
    for (const row of chunk) {
      const rank = ++nextRank;
      cases.push('WHEN ? THEN ?');
      caseParams.push(Number(row.id), rank);
      ids.push(Number(row.id));
    }
    await db.query(
      `UPDATE catalog_packages SET discovery_rank=CASE id ${cases.join(' ')} ELSE discovery_rank END WHERE id IN (${ids.map(() => '?').join(',')})`,
      [...caseParams, ...ids]
    );
    updated += chunk.length;
  }
  return updated;
}

async function backfillDiscoveryRanks(limit = 2000) {
  return withCatalogLock(() => backfillDiscoveryRanksUnlocked(limit), 0);
}

async function startSync(target = config.catalogTarget) {
  return withCatalogLock(
    () => startSyncUnlocked(target),
    async () => getSyncState()
  );
}

async function syncStepUnlocked() {
  const db = getPool();
  let sync = await getSyncState();
  if (sync.status === 'idle') sync = await startSyncUnlocked(sync.target_count || config.catalogTarget);
  if (sync.status !== 'running') return { state:sync, counts:await counts() };
  if (Number(sync.seen_count || 0) >= Number(sync.target_count || config.catalogTarget)) {
    await db.query("UPDATE catalog_sync_state SET status='complete', queue_json='[]' WHERE sync_key=?", [SYNC_KEY]);
    return { state:await getSyncState(), counts:await counts() };
  }
  let queue = [];
  try { queue = JSON.parse(sync.queue_json || '[]'); } catch { queue = []; }
  if (!queue.length) {
    await db.query("UPDATE catalog_sync_state SET status='complete' WHERE sync_key=?", [SYNC_KEY]);
    return { state:await getSyncState(), counts:await counts() };
  }
  const job = queue.shift();
  try {
    const tree = await getTree(job.sha, true);
    let result = { inserted:0, seen:0 };
    if (tree.truncated) {
      const children = await listContents(job.path);
      const childDirs = (Array.isArray(children) ? children : []).filter(x => x.type === 'dir' && x.sha).map(x => ({ path:x.path, sha:x.sha }));
      queue = childDirs.concat(queue);
    } else {
      const normalizedTree = (tree.tree || []).map(x => ({ ...x, path:`${job.path}/${x.path}` }));
      result = await insertPackagesFromTree(normalizedTree);
    }
    await db.query(
      `UPDATE catalog_sync_state SET queue_json=?,processed_count=processed_count+1,inserted_count=inserted_count+?,seen_count=seen_count+?,last_path=?,last_error=NULL WHERE sync_key=?`,
      [JSON.stringify(queue), result.inserted, result.seen, job.path, SYNC_KEY]
    );
  } catch (err) {
    queue.push(job);
    await db.query(`UPDATE catalog_sync_state SET queue_json=?,last_path=?,last_error=?,status='paused' WHERE sync_key=?`,
      [JSON.stringify(queue), job.path, String(err.message || err).slice(0,2000), SYNC_KEY]);
  }
  sync = await getSyncState();
  if (Number(sync.seen_count || 0) >= Number(sync.target_count || config.catalogTarget)) {
    await db.query("UPDATE catalog_sync_state SET status='complete',queue_json='[]' WHERE sync_key=?", [SYNC_KEY]);
  }
  return { state:await getSyncState(), counts:await counts() };
}


async function syncStep() {
  return withCatalogLock(async () => {
    const result = await syncStepUnlocked();
    await backfillDiscoveryRanksUnlocked(2000);
    return result;
  }, async () => ({ state:await getSyncState(), counts:await counts(), busy:true }));
}

async function resumeSync() {
  const db = getPool();
  await db.query("UPDATE catalog_sync_state SET status='running',last_error=NULL WHERE sync_key=?", [SYNC_KEY]);
  return getSyncState();
}

function normalizedCatalogStatus(row) {
  if (!row.software_id) return 'available';
  if (Number(row.update_available || 0)) return 'update';
  return Number(row.published || 0) ? 'published' : 'draft';
}

async function listCatalog({ q='', status='all', category='all', pricing='all', page=1, limit=100, sort='popular' } = {}) {
  const db = getPool();
  const safeLimit = Math.max(20, Math.min(200, Number(limit) || 100));
  const safePage = Math.max(1, Number(page) || 1);
  const params = [];
  // Complete-catalog mode: every package with a current WinGet source is visible.
  // Relevance and quality scores affect sorting only; they never suppress a valid
  // PackageIdentifier. Managed workspace software also stays visible if upstream
  // later disappears.
  const curated = `(c.source_path IS NOT NULL AND c.source_path<>'')`;
  let where = ` WHERE (${curated} OR s.id IS NOT NULL) `;
  const needle = String(q || '').trim();
  if (needle) {
    where += ' AND (c.name LIKE ? OR c.canonical_name LIKE ? OR c.package_id LIKE ? OR c.publisher LIKE ? OR c.search_aliases LIKE ?) ';
    for (let i=0;i<5;i++) params.push(`%${needle}%`);
  }
  if (category && category !== 'all') { where += " AND COALESCE(c.category,s.category,'System & Utilities › General Utilities')=? "; params.push(category); }
  if (pricing && pricing !== 'all') {
    if (pricing === 'free-access') where += ' AND (c.has_free_tier=1 OR c.has_free_trial=1) ';
    else if (pricing === 'commercial') where += ' AND c.commercial_product=1 ';
    else { where += ' AND c.pricing_model=? '; params.push(String(pricing)); }
  }
  if (status === 'available') where += ` AND ${curated} AND s.id IS NULL `;
  if (status === 'draft') where += ' AND s.id IS NOT NULL AND s.published=0 AND s.update_available=0 ';
  if (status === 'published') where += ' AND s.id IS NOT NULL AND s.published=1 AND s.update_available=0 ';
  if (status === 'update') where += ' AND s.id IS NOT NULL AND s.update_available=1 ';
  const order = sort === 'az' ? 'COALESCE(c.canonical_name,c.name) ASC,c.id ASC'
    : sort === 'updated' ? 'COALESCE(s.last_checked_at,c.updated_at) DESC,COALESCE(c.canonical_name,c.name) ASC'
      : `CASE WHEN c.intelligence_source='market-anchor' THEN 0 ELSE 1 END ASC,
         COALESCE(c.expansion_score,0) DESC,COALESCE(c.relevance_score,0) DESC,COALESCE(c.market_score,0) DESC,
         COALESCE(s.priority_rank,c.demand_rank,c.discovery_rank,999999) ASC,COALESCE(c.canonical_name,c.name) ASC,c.id ASC`;
  const [[totalRow]] = await db.query(`SELECT COUNT(*) c FROM catalog_packages c LEFT JOIN software s ON s.package_id=c.package_id AND s.workspace_added=1 ${where}`, params);
  const [rows] = await db.query(
    `SELECT c.id,c.package_id,COALESCE(c.canonical_name,c.name) name,c.publisher,COALESCE(c.category,s.category,'System & Utilities › General Utilities') category,
      c.discovery_rank,c.demand_rank,c.source_path,c.catalog_status,c.market_score,c.quality_score,c.relevance_score,c.pricing_model,
      c.has_free_tier,c.has_free_trial,c.commercial_product,c.intelligence_source,c.intelligence_reason,c.expansion_state,c.expansion_tier,c.expansion_score,c.duplicate_of_package_id,c.expansion_reason,
      s.id software_id,s.published,s.current_version,s.latest_version,s.update_available,s.priority_rank,s.demand_score,s.enrichment_status,s.logo_url
     FROM catalog_packages c LEFT JOIN software s ON s.package_id=c.package_id AND s.workspace_added=1
     ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, safeLimit, (safePage-1)*safeLimit]
  );
  const [cats] = await db.query(`SELECT COALESCE(c.category,s.category,'System & Utilities › General Utilities') category,COUNT(*) c
    FROM catalog_packages c LEFT JOIN software s ON s.package_id=c.package_id AND s.workspace_added=1
    WHERE (${curated} OR s.id IS NOT NULL) GROUP BY COALESCE(c.category,s.category,'System & Utilities › General Utilities')`);
  const countMap = new Map(cats.map(r => [String(r.category), Number(r.c)]));
  const categoryGroups = taxonomy().map(group => ({
    group: group.group,
    categories: group.categories.map(name => ({ name, count:countMap.get(name) || 0 }))
  }));
  return {
    items:rows.map(r => ({
      packageId:r.package_id,name:r.name,publisher:r.publisher||'',category:r.category||'System & Utilities › General Utilities',
      softwareId:r.software_id?Number(r.software_id):null,published:Boolean(r.published),currentVersion:r.current_version||null,
      latestVersion:r.latest_version||null,updateAvailable:Boolean(r.update_available),status:normalizedCatalogStatus(r),
      rank:r.priority_rank==null?(r.demand_rank==null?(r.discovery_rank==null?null:Number(r.discovery_rank)):Number(r.demand_rank)):Number(r.priority_rank),
      marketScore:r.market_score==null?null:Number(r.market_score),qualityScore:r.quality_score==null?null:Number(r.quality_score),
      relevanceScore:r.relevance_score==null?null:Number(r.relevance_score),pricingModel:r.pricing_model||'unknown',
      hasFreeTier:Boolean(r.has_free_tier),hasFreeTrial:Boolean(r.has_free_trial),commercialProduct:Boolean(r.commercial_product),
      intelligenceSource:r.intelligence_source||null,intelligenceReason:r.intelligence_reason||null,
      expansionState:r.expansion_state||null,expansionTier:r.expansion_tier||null,expansionScore:r.expansion_score==null?null:Number(r.expansion_score),
      duplicateOfPackageId:r.duplicate_of_package_id||null,expansionReason:r.expansion_reason||null,
      demandScore:r.demand_score==null?null:Number(r.demand_score),enrichmentStatus:r.enrichment_status||null,hasLogo:Boolean(r.logo_url)
    })),
    total:Number(totalRow.c),page:safePage,limit:safeLimit,
    categories:categoryGroups.flatMap(group => group.categories),categoryGroups,counts:await counts(),sync:await getSyncState()
  };
}

let catalogWorkerStarted = false;
let catalogWorkerBusy = false;
let catalogWorkerNextAttemptAt = 0;
let catalogWorkerSteps = 0;
let catalogWorkerForcedBootstrap = false;

async function catalogWorkerTick() {
  if (catalogWorkerBusy || !state.dbReady || Date.now() < catalogWorkerNextAttemptAt) return;
  catalogWorkerBusy = true;
  try {
    // Heal ranks created by older builds in bounded batches without blocking startup.
    await backfillDiscoveryRanks(2000);
    await ensureCatalogExpansion();
    let sync = await getSyncState();
    if (sync.status === 'complete') {
      // Recover installations that were marked complete while only the original
      // market-anchor-only catalog existed. Retry once per process, then respect a
      // genuinely exhausted upstream source.
      const c = await counts();
      if (!catalogWorkerForcedBootstrap && (Number(c.expansionProcessed || 0) < DISCOVER_TARGET || Number(c.catalog || 0) <= marketSeeds().length) && config.catalogTarget > marketSeeds().length) {
        catalogWorkerForcedBootstrap = true;
        sync = await startSync(config.catalogTarget);
      } else return;
    }
    if (sync.status === 'idle') sync = await startSync(config.catalogTarget);
    if (sync.status === 'paused') {
      const updated = sync.updated_at ? new Date(sync.updated_at).getTime() : 0;
      const waitMs = hasToken() ? 60_000 : 10 * 60_000;
      if (updated && Date.now() - updated < waitMs) return;
      sync = await resumeSync();
    }
    if (sync.status !== 'running') return;

    const stepsThisTick = hasToken() ? 2 : 1;
    for (let i = 0; i < stepsThisTick; i++) {
      const result = await syncStep();
      sync = result.state;
      catalogWorkerSteps++;
      if (sync.status !== 'running' || catalogWorkerSteps % 10 === 0) await ensureCatalogExpansion({force:true});
      if (catalogWorkerSteps === 1 || catalogWorkerSteps % 10 === 0 || sync.status !== 'running') {
        const c = result.counts || await counts();
        console.log(`[HSWare] Catalog index: ${Number(c.catalog || 0).toLocaleString()} packages · ${sync.status} · target ${Number(sync.target_count || config.catalogTarget).toLocaleString()}.`);
      }
      if (sync.status !== 'running') break;
    }
  } catch (err) {
    const message = String(err?.message || err);
    console.error('[HSWare] Catalog background sync:', message);
    catalogWorkerNextAttemptAt = Date.now() + (hasToken() ? 2 * 60_000 : 15 * 60_000);
    throw err;
  } finally {
    catalogWorkerBusy = false;
  }
}

function startCatalogWorker() {
  if (catalogWorkerStarted) return;
  catalogWorkerStarted = true;
  const intervalMs = hasToken() ? 4_000 : 65_000;
  const run=()=>reliability.runWorkerTick('catalog',catalogWorkerTick,{baseDelayMs:hasToken()?2*60_000:15*60_000,maxDelayMs:30*60_000}).catch(()=>{});
  const first = setTimeout(run, 20_000);
  if (first.unref) first.unref();
  const timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[HSWare] Background catalog worker started (${hasToken() ? 'authenticated GitHub' : 'unauthenticated GitHub throttled mode'}).`);
}

module.exports = { counts, getSyncState, getExpansionState, startSync, syncStep, resumeSync, seedPopularCatalog, listCatalog, startCatalogWorker, backfillDiscoveryRanks, backfillCatalogCuration, ensureCatalogExpansion, rebalanceCatalogExpansion };
