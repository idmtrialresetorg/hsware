const YAML = require('yaml');
const { getPool } = require('../db');
const { findInstallerManifest, listContents, listDirectoryFromHtml, releaseAssetDownloadCount, manifestLastUpdatedDate, rawTextAtRef, listContentsAtRef, commitsForPath, hasToken } = require('./github');
const { cachedManifestText } = require('./manifest-cache');
const { compareVersions } = require('../utils/version');
const { titleizePackageId } = require('../utils/text');
const { probeRemoteFileSize } = require('./remote');

function parseManifest(text) {
  try { return YAML.parse(text) || {}; }
  catch (e) { throw new Error(`Invalid WinGet manifest YAML: ${e.message}`); }
}

function versionDirFromInstallerPath(path) {
  const parts = String(path || '').split('/');
  parts.pop();
  return parts.join('/');
}

function packageRootFromInstallerPath(path) {
  const parts = String(path || '').split('/');
  parts.splice(-2, 2);
  return parts.join('/');
}

function versionFromInstallerPath(path) {
  const parts = String(path || '').split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

function inferCategory(packageId, locale = {}) {
  const hay = [
    packageId,
    locale.PackageName,
    locale.ShortDescription,
    locale.Description,
    ...(Array.isArray(locale.Tags) ? locale.Tags : [])
  ].filter(Boolean).join(' ').toLowerCase();
  const rules = [
    ['Browser', ['browser','chromium','firefox','web browser']],
    ['Security', ['security','password','antivirus','vpn','encryption','privacy','authenticator']],
    ['Developer', ['developer','development','ide','editor','git','compiler','sdk','terminal','database client','vscode','visual studio','command palette','code extension']],
    ['Media', ['media','video','audio','player','codec','streaming','recording','screen recorder']],
    ['Graphics', ['graphics','photo','image editor','design','drawing','3d','cad']],
    ['Communication', ['chat','messaging','communication','meeting','conference','voice call']],
    ['Remote Access', ['remote desktop','remote access','rdp','vnc']],
    ['Virtualization', ['virtualization','virtual machine','hypervisor','container']],
    ['Compression', ['archive','compression','zip','rar','7z']],
    ['Office', ['office','document','spreadsheet','presentation','pdf']],
    ['Gaming', ['game','gaming','steam','epic games','gog','battle.net','itch.io']],
    ['Internet', ['download manager','ftp','sftp','torrent','network','internet']],
    ['Utilities', ['utility','utilities','system tool','file manager','backup','cleanup','monitoring']]
  ];
  for (const [category, terms] of rules) if (terms.some(t => hay.includes(t))) return category;
  return null;
}


function normalizeManifestDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function friendlyArchitectureRequirement(values) {
  const map = {
    x64: '64-bit x86 (x64) compatible processor',
    x86: '32-bit x86 (x86) compatible processor',
    arm64: '64-bit ARM (ARM64) compatible processor',
    arm: 'ARM compatible processor',
    neutral: 'Architecture-neutral package'
  };
  const unique = [...new Set((values || []).map(v => String(v || '').trim().toLowerCase()).filter(Boolean))];
  return unique.map(v => map[v] || `${v} compatible processor`).join(' / ') || null;
}

function collectInstallerLocales(manifest, installers) {
  const values = [];
  const add = value => {
    if (Array.isArray(value)) return value.forEach(add);
    const v = String(value || '').trim();
    if (v && !values.some(x => x.toLowerCase() === v.toLowerCase())) values.push(v);
  };
  add(manifest.PackageLocale);
  add(manifest.InstallerLocale);
  for (const installer of installers || []) add(installer?.InstallerLocale);
  return values;
}

function normalizeInstallerFormat(value) {
  const v = String(value || 'all').trim().toLowerCase();
  return ['all','exe','msi','msix','appx','portable'].includes(v) ? v : 'all';
}

function installerUrlExtension(url) {
  const clean = String(url || '').split(/[?#]/, 1)[0].toLowerCase();
  const match = clean.match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function installerMatchesFormat(installer, preferredFormat) {
  const wanted = normalizeInstallerFormat(preferredFormat);
  if (wanted === 'all') return true;
  const ext = installerUrlExtension(installer?.InstallerUrl);
  const type = String(installer?.InstallerType || '').trim().toLowerCase();
  if (wanted === 'exe') return ext === 'exe';
  if (wanted === 'msi') return ext === 'msi' || (!ext && type === 'msi');
  if (wanted === 'msix') return ['msix','msixbundle'].includes(ext) || (!ext && ['msix','msixbundle'].includes(type));
  if (wanted === 'appx') return ['appx','appxbundle'].includes(ext) || (!ext && ['appx','appxbundle'].includes(type));
  if (wanted === 'portable') return ['zip','7z','rar'].includes(ext) || type === 'portable';
  return false;
}

function installerFields(manifest, preferredFormat = 'all') {
  const installers = Array.isArray(manifest.Installers) ? manifest.Installers : [];
  const matching = installers.filter(i => installerMatchesFormat(i, preferredFormat));
  // For a requested type, no match is a real mismatch: do not silently fall
  // back to a different extension. Within matching entries, prefer x64.
  const first = matching.find(i => String(i?.Architecture || '').toLowerCase() === 'x64') || matching[0] || null;
  const architectures = [...new Set(installers.map(i => String(i?.Architecture || '').trim()).filter(Boolean))];
  const platformValues = [];
  const addPlatform = value => {
    for (const v of (Array.isArray(value) ? value : (value ? [value] : []))) {
      const clean = String(v).replace('Windows.Desktop','Windows Desktop').replace('Windows.Universal','Windows Universal').trim();
      if (clean && !platformValues.includes(clean)) platformValues.push(clean);
    }
  };
  addPlatform(manifest.Platform);
  for (const installer of installers) addPlatform(installer?.Platform);
  const locales = collectInstallerLocales(manifest, installers);
  return {
    version: manifest.PackageVersion || null,
    installerUrl: first?.InstallerUrl || null,
    sha256: first?.InstallerSha256 || null,
    architecture: first?.Architecture || architectures[0] || null,
    architectures,
    processor: friendlyArchitectureRequirement(architectures),
    platform: platformValues.join(', ') || 'Windows Desktop',
    minimumOsVersion: first?.MinimumOSVersion || manifest.MinimumOSVersion || null,
    installerLocale: first?.InstallerLocale || manifest.InstallerLocale || null,
    installerLocales: locales,
    installerType: first?.InstallerType || manifest.InstallerType || null,
    releaseDate: normalizeManifestDate(manifest.ReleaseDate || first?.ReleaseDate || null),
    releaseDateSource: (manifest.ReleaseDate || first?.ReleaseDate) ? 'winget-release-date' : null
  };
}

async function rawManifestMaybe(path) {
  if (!path) return null;
  try { return parseManifest(await cachedManifestText(path)); }
  catch (err) {
    if (Number(err.status) === 404) return null;
    throw err;
  }
}

async function fetchLocale(versionDir, packageId) {
  // Normal WinGet packages use predictable locale filenames. Reading the raw
  // files avoids a GitHub API directory request for every software import.
  let locale = await rawManifestMaybe(`${versionDir}/${packageId}.locale.en-US.yaml`);
  if (locale) return locale;

  const versionManifest = await rawManifestMaybe(`${versionDir}/${packageId}.yaml`);
  const defaultLocale = versionManifest?.DefaultLocale || versionManifest?.PackageLocale || null;
  if (defaultLocale && defaultLocale !== 'en-US') {
    locale = await rawManifestMaybe(`${versionDir}/${packageId}.locale.${defaultLocale}.yaml`);
    if (locale) return locale;
  }
  return versionManifest || {};
}

async function listPackageVersions(root) {
  let items = [];
  try {
    items = await listContents(root);
  } catch {
    // No-token installations often exhaust the GitHub REST allowance while
    // indexing. Fall back to the normal GitHub directory HTML, then use raw
    // manifests for the actual package data. This keeps Open/Import useful.
    try { items = await listDirectoryFromHtml(root); } catch { items = []; }
  }
  return (Array.isArray(items) ? items : [])
    .filter(x => x.type === 'dir')
    .map(x => x.name)
    .filter(Boolean)
    .sort((a, b) => compareVersions(b, a));
}

async function latestInstallerPathFromHint(packageId, hintPath, allowApi = true) {
  if (!hintPath || !allowApi) return hintPath;
  const root = packageRootFromInstallerPath(hintPath);
  const versions = await listPackageVersions(root);
  for (const version of versions.slice(0, 12)) {
    const candidate = `${root}/${version}/${packageId}.installer.yaml`;
    try {
      await cachedManifestText(candidate);
      return candidate;
    } catch (err) {
      if (Number(err.status) !== 404) break;
    }
  }
  return hintPath;
}

async function indexedVersionPaths(packageId, currentVersion) {
  try {
    const db = getPool();
    const [rows] = await db.query(
      `SELECT version, source_path FROM catalog_version_paths
       WHERE package_id=? AND version<>?
       ORDER BY id ASC LIMIT 12`,
      [packageId, currentVersion || '']
    );
    return (rows || []).sort((a,b) => compareVersions(b.version, a.version));
  } catch {
    // Installations upgrade automatically, but a missing optional history table
    // must never prevent current-version details from loading.
    return [];
  }
}

async function fetchOldVersions(packageId, installerPath, currentVersion, preferredFormat = 'all') {
  const out = [];
  const used = new Set([String(currentVersion || '')]);

  // Best path: catalog sync already saw the version directories. Reading their
  // raw manifests costs no GitHub REST API request and works without a token.
  const indexed = await indexedVersionPaths(packageId, currentVersion);
  for (const row of indexed) {
    if (out.length >= 5 || used.has(String(row.version))) continue;
    try {
      const parsed = parseManifest(await cachedManifestText(row.source_path));
      const fields = installerFields(parsed, preferredFormat);
      let releaseDate = fields.releaseDate;
      let releaseDateSource = fields.releaseDateSource;
      if (!releaseDate && hasToken()) {
        releaseDate = await manifestLastUpdatedDate(row.source_path);
        if (releaseDate) releaseDateSource = 'winget-manifest-update';
      }
      releaseDateSource = releaseDateSource || 'not-reported';
      out.push({ ...fields, releaseDate, releaseDateSource, version: fields.version || row.version, sourcePath: row.source_path });
      used.add(String(row.version));
    } catch {}
  }
  if (out.length >= 5) return out.slice(0, 5);

  // Fallback for catalogs created before v2.1.2. This can use the GitHub API,
  // but failure/rate limiting is non-fatal.
  const root = packageRootFromInstallerPath(installerPath);
  const versions = await listPackageVersions(root);
  for (const version of versions) {
    if (out.length >= 5 || used.has(String(version))) continue;
    try {
      const path = `${root}/${version}/${packageId}.installer.yaml`;
      const parsed = parseManifest(await cachedManifestText(path));
      const fields = installerFields(parsed, preferredFormat);
      let releaseDate = fields.releaseDate;
      let releaseDateSource = fields.releaseDateSource;
      if (!releaseDate && hasToken()) {
        releaseDate = await manifestLastUpdatedDate(path);
        if (releaseDate) releaseDateSource = 'winget-manifest-update';
      }
      releaseDateSource = releaseDateSource || 'not-reported';
      out.push({ ...fields, releaseDate, releaseDateSource, sourcePath: path });
      used.add(String(version));
    } catch {}
  }
  // Last-resort history recovery: inspect recent commits for the package root.
  // WinGet removes superseded manifest folders, so the current master branch may
  // legitimately contain only one version. With a GitHub token we can recover
  // a few prior version directories from repository history without inventing data.
  if (out.length < 5 && hasToken()) {
    try {
      const commits = await commitsForPath(root, 8);
      for (const commit of commits || []) {
        if (out.length >= 5) break;
        const sha = commit?.sha; if (!sha) continue;
        let items=[]; try { items=await listContentsAtRef(root,sha); } catch { continue; }
        const dirs=(Array.isArray(items)?items:[]).filter(x=>x?.type==='dir'&&x?.name).map(x=>x.name).sort((a,b)=>compareVersions(b,a));
        for (const version of dirs) {
          if (out.length >= 5 || used.has(String(version))) continue;
          const path = `${root}/${version}/${packageId}.installer.yaml`;
          try {
            const parsed=parseManifest(await rawTextAtRef(path,sha));
            const fields=installerFields(parsed,preferredFormat);
            const rawDate=commit?.commit?.committer?.date||commit?.commit?.author?.date||null;
            const releaseDate=rawDate?new Date(rawDate).toISOString().slice(0,10):null;
            out.push({...fields,version:fields.version||version,sourcePath:path,releaseDate,releaseDateSource:releaseDate?'winget-git-history':'not-reported'});
            used.add(String(version));
          } catch {}
        }
      }
    } catch {}
  }
  return out.slice(0, 5);
}

function packageRootFromId(packageId) {
  const parts = String(packageId || '').split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0][0]?.toLowerCase();
  return first ? `manifests/${first}/${parts.join('/')}` : null;
}

async function latestIndexedInstallerPath(packageId) {
  try {
    const db = getPool();
    const [rows] = await db.query(
      'SELECT version, source_path FROM catalog_version_paths WHERE package_id=? LIMIT 30',
      [packageId]
    );
    if (!rows?.length) return null;
    rows.sort((a,b) => compareVersions(b.version, a.version));
    return rows.find(r => r.source_path)?.source_path || null;
  } catch {
    return null;
  }
}

async function resolveInstallerPath(packageId, knownPath = null, options = {}) {
  // Prefer paths already indexed by HSWare. This uses raw GitHub content only
  // and therefore does not spend GitHub REST API quota.
  const indexedPath = await latestIndexedInstallerPath(packageId);
  // The local catalog version index already knows the newest observed WinGet
  // version. Prefer it directly and avoid a GitHub directory/API request.
  if (indexedPath) return indexedPath;
  if (knownPath) {
    return latestInstallerPathFromHint(packageId, knownPath, options.findLatest !== false);
  }

  // Fallback: enumerate the deterministic WinGet package directory. This uses
  // the GitHub REST API and may be rate-limited without GITHUB_TOKEN.
  const root = packageRootFromId(packageId);
  if (root) {
    const versions = await listPackageVersions(root);
    for (const version of versions.slice(0, 12)) {
      const candidate = `${root}/${version}/${packageId}.installer.yaml`;
      try { await cachedManifestText(candidate); return candidate; }
      catch (err) { if (Number(err.status) !== 404) break; }
    }
  }
  return findInstallerManifest(packageId);
}

async function fetchPackageDetails(packageId, knownPath = null, options = {}) {
  let installerPath = await resolveInstallerPath(packageId, knownPath, options);
  if (!installerPath) throw new Error(`Could not locate WinGet installer manifest for ${packageId}.`);

  let installerManifest;
  try {
    installerManifest = parseManifest(await cachedManifestText(installerPath));
  } catch (err) {
    // A stale catalog path can happen after WinGet reorganizes a package. If a
    // GitHub token/API is available, do one exact lookup as a recovery path.
    if (knownPath && options.recoverPath !== false) {
      try {
        const recovered = await findInstallerManifest(packageId);
        if (recovered) {
          installerPath = recovered;
          installerManifest = parseManifest(await cachedManifestText(installerPath));
        }
      } catch { /* keep original error below */ }
    }
    if (!installerManifest) throw err;
  }

  const manifestId = String(installerManifest.PackageIdentifier || '').trim();
  if (manifestId && manifestId.toLowerCase() !== String(packageId).toLowerCase()) {
    throw new Error(`WinGet identity mismatch: requested ${packageId} but installer manifest returned ${manifestId}.`);
  }

  const base = installerFields(installerManifest, options.preferredInstallerFormat || 'all');
  const versionDir = versionDirFromInstallerPath(installerPath);
  let locale = {};
  try { locale = await fetchLocale(versionDir, packageId); } catch { locale = {}; }
  const localeId = String(locale.PackageIdentifier || '').trim();
  if (localeId && localeId.toLowerCase() !== String(packageId).toLowerCase()) {
    throw new Error(`WinGet identity mismatch: requested ${packageId} but locale manifest returned ${localeId}.`);
  }

  const currentVersion = base.version || locale.PackageVersion || versionFromInstallerPath(installerPath) || null;
  const oldVersions = currentVersion && options.includeOldVersions !== false
    ? await fetchOldVersions(packageId, installerPath, currentVersion, options.preferredInstallerFormat || 'all')
    : [];

  let fileSizeBytes = null;
  if (base.installerUrl && options.probeSize !== false) {
    try { fileSizeBytes = await probeRemoteFileSize(base.installerUrl); } catch {}
  }

  let downloadMetric = { count: null, sourceUrl: null, kind: null };
  if (base.installerUrl) {
    try { downloadMetric = await releaseAssetDownloadCount(base.installerUrl); } catch {}
  }

  return {
    packageId: installerManifest.PackageIdentifier || locale.PackageIdentifier || packageId,
    name: locale.PackageName || titleizePackageId(packageId),
    publisher: locale.Publisher || null,
    author: locale.Author || null,
    developer: locale.Author || locale.Publisher || null,
    category: inferCategory(packageId, locale),
    version: currentVersion,
    description: locale.Description || locale.ShortDescription || null,
    // Keep the exact PackageUrl separately as the product-specific source for
    // description/system-requirement enrichment. PublisherUrl may be broader.
    officialUrl: locale.PackageUrl || locale.PublisherUrl || null,
    productSourceUrl: locale.PackageUrl || null,
    licenseName: locale.License || null,
    language: [...new Set([locale.PackageLocale, locale.DefaultLocale, ...base.installerLocales].map(v => String(v || '').trim()).filter(Boolean))].join(', ') || null,
    tags: Array.isArray(locale.Tags) ? locale.Tags.slice(0, 40) : [],
    installerUrl: base.installerUrl,
    architecture: base.architecture,
    processor: base.processor,
    platform: base.platform,
    minimumOsVersion: base.minimumOsVersion,
    installerType: base.installerType,
    sha256: base.sha256,
    fileSizeBytes,
    downloadCount: downloadMetric.count,
    downloadCountSource: downloadMetric.sourceUrl,
    downloadCountKind: downloadMetric.kind,
    sourcePath: installerPath,
    oldVersions
  };
}

async function ensureManagedSoftware(packageId, category = null, priorityRank = null, knownPath = null) {
  const db = getPool();
  const [[cat]] = await db.query('SELECT * FROM catalog_packages WHERE package_id=? LIMIT 1', [packageId]);
  const seedName = cat?.name || titleizePackageId(packageId);
  const seedPublisher = cat?.publisher || packageId.split('.')[0] || null;
  const seedCategory = category || cat?.category || null;
  const seedPriority = priorityRank ?? cat?.demand_rank ?? cat?.discovery_rank ?? null;
  const seedPath = knownPath || cat?.source_path || null;

  await db.query(
    `INSERT INTO software (package_id,name,category,publisher,priority_rank,source_path,enrichment_status,workspace_added,workspace_added_at)
     VALUES (?,?,?,?,?,?,'pending',1,NOW())
     ON DUPLICATE KEY UPDATE
       name=COALESCE(NULLIF(software.name,''),VALUES(name)),
       category=COALESCE(software.category,VALUES(category)),
       publisher=COALESCE(software.publisher,VALUES(publisher)),
       priority_rank=COALESCE(software.priority_rank,VALUES(priority_rank)),
       source_path=COALESCE(software.source_path,VALUES(source_path)),
       workspace_added_at=IF(software.workspace_added=0 OR software.workspace_added_at IS NULL,NOW(),software.workspace_added_at),
       workspace_added=1`,
    [packageId, seedName, seedCategory, seedPublisher, seedPriority, seedPath]
  );

  const [[sw]] = await db.query('SELECT * FROM software WHERE package_id=? LIMIT 1', [packageId]);
  if (!sw) throw new Error('Software queue record could not be created.');
  await db.query('UPDATE catalog_packages SET managed_software_id=? WHERE package_id=?', [sw.id, packageId]);
  try {
    await db.query(`INSERT INTO enrichment_queue (software_id,status) VALUES (?,'queued')
      ON DUPLICATE KEY UPDATE status=IF(status='ready',status,'queued')`, [sw.id]);
  } catch {}
  return sw;
}

async function enrichManagedSoftwareById(softwareId, options = {}) {
  const db = getPool();
  const [[sw]] = await db.query('SELECT * FROM software WHERE id=? LIMIT 1', [softwareId]);
  if (!sw) throw new Error('Software not found.');

  await db.query(`UPDATE software SET enrichment_attempts=COALESCE(enrichment_attempts,0)+1,
    last_enrichment_attempt_at=NOW(), enrichment_status='fetching' WHERE id=?`, [softwareId]);
  try { await db.query("UPDATE enrichment_queue SET status='running', attempts=attempts+1, last_error=NULL WHERE software_id=?", [softwareId]); } catch {}

  try {
    const details = await fetchPackageDetails(sw.package_id, sw.source_path, options);
    await db.query(
      `UPDATE software SET name=?, category=COALESCE(NULLIF(?,''),category), publisher=?, author=?, developer_name=?, current_version=?, description=?,
       license_name=?, license_url=NULL, support_url=NULL, release_notes_url=NULL, tags_json=?, language=?, platform=?, processor=?, minimum_os_version=?,
       official_url=?, media_source_url=?, installer_url=?, architecture=?, installer_type=?, sha256=?, file_size_bytes=COALESCE(?,file_size_bytes),
       download_count=COALESCE(?,download_count), download_count_source=COALESCE(?,download_count_source),
       source_path=?, enrichment_status='ready', enrichment_error=NULL, enriched_at=NOW(), metadata_revision=4,
       link_status=?, link_checked_at=NOW(), updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [details.name, details.category || sw.category, details.publisher, details.author, details.developer, details.version, details.description,
       details.licenseName, JSON.stringify(details.tags || []), details.language, details.platform, details.processor, details.minimumOsVersion, details.officialUrl, details.productSourceUrl,
       details.installerUrl, details.architecture, details.installerType, details.sha256, details.fileSizeBytes, details.downloadCount, details.downloadCountSource,
       details.sourcePath, details.installerUrl ? 'ready' : 'missing', sw.id]
    );

    if (options.includeOldVersions !== false) {
      for (const v of details.oldVersions) {
        if (!v.version) continue;
        await db.query(
          `INSERT INTO software_versions (software_id,version,installer_url,architecture,installer_type,sha256,source_path,release_date,release_date_source)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE installer_url=VALUES(installer_url), architecture=VALUES(architecture),
           installer_type=VALUES(installer_type), sha256=VALUES(sha256), source_path=VALUES(source_path),
           release_date=COALESCE(VALUES(release_date),release_date), release_date_source=COALESCE(VALUES(release_date_source),release_date_source)`,
          [sw.id, v.version, v.installerUrl, v.architecture, v.installerType, v.sha256, v.sourcePath, v.releaseDate, v.releaseDateSource]
        );
      }
    }

    await db.query("UPDATE catalog_packages SET managed_software_id=?, metadata_status='enriched', source_path=?, last_metadata_error=NULL, last_metadata_attempt_at=NOW() WHERE package_id=?", [sw.id, details.sourcePath, sw.package_id]);
    try { await db.query("UPDATE enrichment_queue SET status='ready', last_error=NULL WHERE software_id=?", [sw.id]); } catch {}
    const [[fresh]] = await db.query('SELECT * FROM software WHERE id=? LIMIT 1', [sw.id]);
    return fresh;
  } catch (err) {
    const message = String(err.message || err).slice(0, 2000);
    await db.query("UPDATE software SET enrichment_status='error', enrichment_error=?, link_status='unknown' WHERE id=?", [message, sw.id]);
    await db.query("UPDATE catalog_packages SET last_metadata_error=?, last_metadata_attempt_at=NOW() WHERE package_id=?", [message, sw.package_id]);
    try { await db.query("UPDATE enrichment_queue SET status='error', last_error=? WHERE software_id=?", [message, sw.id]); } catch {}
    throw err;
  }
}


async function backfillVersionDates(softwareId) {
  const db = getPool();
  let rows = [];
  try {
    [rows] = await db.query(
      `SELECT id,source_path FROM software_versions
       WHERE software_id=? AND release_date_source IS NULL
       ORDER BY id DESC LIMIT 5`,
      [softwareId]
    );
  } catch {
    return 0;
  }
  let updated = 0;
  for (const row of rows || []) {
    let releaseDate = null;
    let source = null;
    try {
      if (row.source_path) {
        const parsed = parseManifest(await cachedManifestText(row.source_path));
        releaseDate = normalizeManifestDate(parsed.ReleaseDate || null);
        if (releaseDate) source = 'winget-release-date';
      }
      if (!releaseDate && row.source_path && hasToken()) {
        releaseDate = await manifestLastUpdatedDate(row.source_path);
        if (releaseDate) source = 'winget-manifest-update';
      }
    } catch {
      // Historical dates are helpful metadata, never a reason to break details.
    }
    source = source || 'not-reported';
    try {
      await db.query('UPDATE software_versions SET release_date=?,release_date_source=? WHERE id=?', [releaseDate, source, row.id]);
      updated++;
    } catch {}
  }
  return updated;
}

async function prepareSoftware(softwareId) {
  const db = getPool();
  const [[sw]] = await db.query('SELECT * FROM software WHERE id=? LIMIT 1', [softwareId]);
  if (!sw) throw new Error('Software not found.');
  const [[history]] = await db.query('SELECT COUNT(*) c, SUM(release_date_source IS NULL) missing_dates FROM software_versions WHERE software_id=?', [softwareId]);
  const needsCurrent = !sw.current_version || !sw.installer_url || sw.enrichment_status !== 'ready';
  // v3.6.4 performs one automatic pass over existing history rows so their
  // release/update date is populated (or explicitly marked as not reported).
  const needsHistory = Number(history.c || 0) < 5 || Number(history.missing_dates || 0) > 0;
  if (!needsCurrent && !needsHistory) return { software: sw, refreshed: false, warning: null };

  try {
    // The catalog source path is enough for current details without an API call.
    // Old-version history attempts one directory API lookup but failure there is
    // non-fatal inside fetchPackageDetails.
    const fresh = await enrichManagedSoftwareById(softwareId, {
      includeOldVersions: true,
      probeSize: true,
      findLatest: true,
      recoverPath: true
    });
    return { software: fresh, refreshed: true, warning: null };
  } catch (err) {
    return { software: sw, refreshed: false, warning: err.message || String(err) };
  }
}

async function upsertManagedSoftware(packageId, category = null, priorityRank = null, knownPath = null) {
  const sw = await ensureManagedSoftware(packageId, category, priorityRank, knownPath);
  return enrichManagedSoftwareById(sw.id, { includeOldVersions: true, probeSize: true, findLatest: true, recoverPath: true });
}

module.exports = {
  fetchPackageDetails,
  normalizeInstallerFormat,
  installerUrlExtension,
  ensureManagedSoftware,
  enrichManagedSoftwareById,
  prepareSoftware,
  backfillVersionDates,
  upsertManagedSoftware,
  versionFromInstallerPath
};
