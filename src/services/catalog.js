const config = require('../config');
const { getPool } = require('../db');
const { listContents, getTree } = require('./github');
const { titleizePackageId } = require('../utils/text');
const { compareVersions } = require('../utils/version');

const SYNC_KEY = 'winget-main';

async function counts() {
  const db = getPool();
  const [[catalog]] = await db.query('SELECT COUNT(*) AS c FROM catalog_packages');
  const [[managed]] = await db.query('SELECT COUNT(*) AS c FROM software WHERE workspace_added=1');
  const [[published]] = await db.query('SELECT COUNT(*) AS c FROM software WHERE workspace_added=1 AND published=1');
  const [[enriched]] = await db.query("SELECT COUNT(*) AS c FROM catalog_packages WHERE metadata_status='enriched'");
  return { catalog: Number(catalog.c), managed: Number(managed.c), published: Number(published.c), enriched: Number(enriched.c) };
}

async function getSyncState() {
  const db = getPool();
  const [rows] = await db.query('SELECT * FROM catalog_sync_state WHERE sync_key=? LIMIT 1', [SYNC_KEY]);
  if (!rows[0]) return { status: 'idle', target_count: config.catalogTarget, processed_count: 0, inserted_count: 0, seen_count: 0, queue_json: '[]' };
  return rows[0];
}

async function startSync(target = config.catalogTarget) {
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
    [SYNC_KEY, 'running', target, JSON.stringify(queue)]
  );
  return getSyncState();
}

function packageIdFromInstallerPath(path) {
  const name = String(path).split('/').pop() || '';
  if (!/\.installer\.yaml$/i.test(name)) return null;
  return name.replace(/\.installer\.yaml$/i, '');
}
function versionFromPath(path) {
  const parts = String(path || '').split('/');
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

  let inserted = 0;
  for (const [packageId, manifests] of grouped) {
    manifests.sort((a, b) => compareVersions(b.version, a.version));
    const bestItem = manifests[0];
    const name = titleizePackageId(packageId);
    const publisher = packageId.split('.')[0] || null;
    const fullPath = bestItem.path.startsWith('manifests/') ? bestItem.path : null;
    const [[existing]] = await db.query('SELECT source_path FROM catalog_packages WHERE package_id=? LIMIT 1', [packageId]);
    const existingVersion = versionFromPath(existing?.source_path);
    const candidateVersion = bestItem.version;
    const useCandidate = !existing?.source_path || compareVersions(candidateVersion, existingVersion) > 0;

    const [result] = await db.query(
      `INSERT INTO catalog_packages (package_id,name,publisher,search_aliases,source_path,metadata_status)
       VALUES (?,?,?,?,?,'index')
       ON DUPLICATE KEY UPDATE
         name=VALUES(name), publisher=COALESCE(catalog_packages.publisher,VALUES(publisher)),
         search_aliases=VALUES(search_aliases), source_path=IF(?,VALUES(source_path),catalog_packages.source_path)`,
      [packageId, name, publisher, `${name} ${packageId} ${publisher || ''}`, fullPath, useCandidate ? 1 : 0]
    );
    if (result.affectedRows === 1) inserted++;

    // Keep the latest six manifest paths (current + five previous) so Open can
    // obtain historical direct installer links from raw manifests without
    // spending GitHub REST API calls later.
    for (const item of manifests.slice(0, 6)) {
      const sourcePath = item.path.startsWith('manifests/') ? item.path : null;
      if (!sourcePath) continue;
      await db.query(
        `INSERT INTO catalog_version_paths (package_id,version,source_path)
         VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE source_path=VALUES(source_path), updated_at=CURRENT_TIMESTAMP`,
        [packageId, item.version, sourcePath]
      );
    }
  }
  return { inserted, seen: grouped.size };
}

async function syncStep() {
  const db = getPool();
  let state = await getSyncState();
  if (state.status === 'idle') state = await startSync(state.target_count || config.catalogTarget);
  if (state.status !== 'running') return { state, counts: await counts() };

  if (Number(state.seen_count || 0) >= Number(state.target_count || config.catalogTarget)) {
    await db.query("UPDATE catalog_sync_state SET status='complete', queue_json='[]' WHERE sync_key=?", [SYNC_KEY]);
    return { state: await getSyncState(), counts: await counts() };
  }

  let queue = [];
  try { queue = JSON.parse(state.queue_json || '[]'); } catch { queue = []; }
  if (!queue.length) {
    await db.query("UPDATE catalog_sync_state SET status='complete' WHERE sync_key=?", [SYNC_KEY]);
    return { state: await getSyncState(), counts: await counts() };
  }

  const job = queue.shift();
  try {
    const tree = await getTree(job.sha, true);
    let result = { inserted: 0, seen: 0 };
    if (tree.truncated) {
      const children = await listContents(job.path);
      const childDirs = (Array.isArray(children) ? children : [])
        .filter(x => x.type === 'dir' && x.sha)
        .map(x => ({ path: x.path, sha: x.sha }));
      queue = childDirs.concat(queue);
    } else {
      const normalizedTree = (tree.tree || []).map(x => ({ ...x, path: `${job.path}/${x.path}` }));
      result = await insertPackagesFromTree(normalizedTree);
    }
    await db.query(
      `UPDATE catalog_sync_state SET queue_json=?, processed_count=processed_count+1,
       inserted_count=inserted_count+?, seen_count=seen_count+?, last_path=?, last_error=NULL WHERE sync_key=?`,
      [JSON.stringify(queue), result.inserted, result.seen, job.path, SYNC_KEY]
    );
  } catch (err) {
    queue.push(job);
    await db.query(
      `UPDATE catalog_sync_state SET queue_json=?, last_path=?, last_error=?, status='paused' WHERE sync_key=?`,
      [JSON.stringify(queue), job.path, String(err.message || err).slice(0, 2000), SYNC_KEY]
    );
  }

  state = await getSyncState();
  if (Number(state.seen_count || 0) >= Number(state.target_count || config.catalogTarget)) {
    await db.query("UPDATE catalog_sync_state SET status='complete', queue_json='[]' WHERE sync_key=?", [SYNC_KEY]);
  }
  return { state: await getSyncState(), counts: await counts() };
}

async function resumeSync() {
  const db = getPool();
  await db.query("UPDATE catalog_sync_state SET status='running', last_error=NULL WHERE sync_key=?", [SYNC_KEY]);
  return getSyncState();
}

module.exports = { counts, getSyncState, startSync, syncStep, resumeSync };
