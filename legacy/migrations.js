const { getPool } = require('./db');

const baselineStatements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT PRIMARY KEY, name VARCHAR(120) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, email VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(120) NOT NULL PRIMARY KEY, setting_value TEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS software (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    package_id VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL, category VARCHAR(120) NULL, publisher VARCHAR(255) NULL,
    current_version VARCHAR(120) CHARACTER SET ascii NULL, description MEDIUMTEXT NULL,
    official_url TEXT NULL, installer_url TEXT NULL,
    architecture VARCHAR(80) CHARACTER SET ascii NULL, installer_type VARCHAR(80) CHARACTER SET ascii NULL,
    sha256 VARCHAR(128) CHARACTER SET ascii NULL, published TINYINT(1) NOT NULL DEFAULT 0,
    priority_rank INT NULL, demand_score DECIMAL(8,2) NULL,
    source_path TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_software_published (published), INDEX idx_software_priority (priority_rank)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS software_versions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, software_id BIGINT UNSIGNED NOT NULL,
    version VARCHAR(120) CHARACTER SET ascii NOT NULL, installer_url VARCHAR(2000) NULL,
    architecture VARCHAR(80) CHARACTER SET ascii NULL, installer_type VARCHAR(80) CHARACTER SET ascii NULL,
    sha256 VARCHAR(128) CHARACTER SET ascii NULL, source_path VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
    release_date DATE NULL, release_date_source VARCHAR(40) CHARACTER SET ascii NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_software_version (software_id, version),
    CONSTRAINT fk_versions_software FOREIGN KEY (software_id) REFERENCES software(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS catalog_packages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    package_id VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL, publisher VARCHAR(255) NULL, category VARCHAR(120) NULL,
    search_aliases TEXT NULL, source_path VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
    discovery_rank INT NULL, demand_rank INT NULL,
    metadata_status VARCHAR(40) CHARACTER SET ascii NOT NULL DEFAULT 'index', managed_software_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_catalog_discovery (discovery_rank), INDEX idx_catalog_demand (demand_rank), INDEX idx_catalog_managed (managed_software_id),
    CONSTRAINT fk_catalog_managed FOREIGN KEY (managed_software_id) REFERENCES software(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS catalog_sync_state (
    sync_key VARCHAR(80) CHARACTER SET ascii NOT NULL PRIMARY KEY, status VARCHAR(40) CHARACTER SET ascii NOT NULL DEFAULT 'idle',
    target_count INT NOT NULL DEFAULT 5000, queue_json LONGTEXT NULL, processed_count INT NOT NULL DEFAULT 0,
    inserted_count INT NOT NULL DEFAULT 0, last_path VARCHAR(1000) CHARACTER SET ascii NULL, last_error TEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS software_assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, software_id BIGINT UNSIGNED NOT NULL,
    asset_type ENUM('logo','screenshot') NOT NULL, asset_url VARCHAR(2000) NOT NULL, source_page VARCHAR(2000) NULL,
    source_domain VARCHAR(255) CHARACTER SET ascii NULL, source_type VARCHAR(80) CHARACTER SET ascii NULL,
    confidence_score SMALLINT UNSIGNED NOT NULL DEFAULT 0, status ENUM('candidate','approved','rejected') NOT NULL DEFAULT 'candidate',
    sort_order INT NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_asset_url (software_id, asset_type, asset_url(500)), INDEX idx_asset_status (software_id, asset_type, status),
    CONSTRAINT fk_assets_software FOREIGN KEY (software_id) REFERENCES software(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS asset_discovery_runs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, software_id BIGINT UNSIGNED NOT NULL,
    source_url VARCHAR(2000) NULL, status VARCHAR(40) CHARACTER SET ascii NOT NULL,
    pages_scanned INT NOT NULL DEFAULT 0, candidates_found INT NOT NULL DEFAULT 0, error_message TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_asset_runs_software FOREIGN KEY (software_id) REFERENCES software(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function tableExists(db, table) {
  const [rows] = await db.query('SHOW TABLES LIKE ?', [table]);
  return rows.length > 0;
}
async function columnExists(db, table, column) {
  if (!(await tableExists(db, table))) return false;
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  return rows.length > 0;
}
async function ensureColumn(db, table, column, definition) {
  if (!(await columnExists(db, table, column))) await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

// MySQL/MariaDB cap the non-BLOB/TEXT portion of a row at roughly 65 KB.
// Older HSWare schemas accumulated several large utf8mb4 VARCHAR columns on
// `software`, which can make a partially migrated installation impossible to
// finish. Moving non-indexed long-form values off-page is non-destructive and
// leaves application semantics unchanged while making migrations resumable.
async function compactSoftwareRowStorage(db) {
  if (!(await tableExists(db, 'software'))) return;
  const definitions = {
    official_url: 'TEXT NULL',
    installer_url: 'TEXT NULL',
    source_path: 'TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL',
    latest_installer_url: 'TEXT NULL',
    license_url: 'TEXT NULL',
    support_url: 'TEXT NULL',
    release_notes_url: 'TEXT NULL',
    media_source_url: 'TEXT NULL',
    ram_requirement: 'TEXT NULL',
    storage_requirement: 'TEXT NULL',
    graphics_requirement: 'TEXT NULL',
    requirements_source_url: 'TEXT NULL',
    download_count_source: 'TEXT NULL',
    logo_url: 'TEXT NULL'
  };
  for (const [column, definition] of Object.entries(definitions)) {
    if (await columnExists(db, 'software', column)) {
      await db.query(`ALTER TABLE \`software\` MODIFY COLUMN \`${column}\` ${definition}`);
    }
  }
}
async function clearLegacySoftwareMedia(db, where = '') {
  const assignments = [];
  if (await columnExists(db, 'software', 'logo_url')) assignments.push('logo_url=NULL');
  if (await columnExists(db, 'software', 'media_enriched_at')) assignments.push('media_enriched_at=NULL');
  if (!assignments.length) return;
  await db.query(`UPDATE software SET ${assignments.join(',')} ${where}`);
}

async function applyV2(db) {
  await ensureColumn(db, 'software', 'file_size_bytes', 'BIGINT UNSIGNED NULL AFTER sha256');
  await ensureColumn(db, 'software', 'latest_version', 'VARCHAR(120) CHARACTER SET ascii NULL AFTER source_path');
  await ensureColumn(db, 'software', 'latest_installer_url', 'TEXT NULL AFTER latest_version');
  await ensureColumn(db, 'software', 'latest_sha256', 'VARCHAR(128) CHARACTER SET ascii NULL AFTER latest_installer_url');
  await ensureColumn(db, 'software', 'update_available', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER latest_sha256');
  await ensureColumn(db, 'software', 'last_checked_at', 'DATETIME NULL AFTER update_available');
  await ensureColumn(db, 'software', 'update_error', 'TEXT NULL AFTER last_checked_at');

  await db.query(`CREATE TABLE IF NOT EXISTS import_jobs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'queued',
    requested_count INT NOT NULL, completed_count INT NOT NULL DEFAULT 0, failed_count INT NOT NULL DEFAULT 0,
    queue_json LONGTEXT NOT NULL, current_package VARCHAR(190) CHARACTER SET ascii NULL, last_error TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_import_jobs_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS update_scan_state (
    scan_key VARCHAR(80) CHARACTER SET ascii NOT NULL PRIMARY KEY,
    status VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'idle', queue_json LONGTEXT NULL,
    total_count INT NOT NULL DEFAULT 0, processed_count INT NOT NULL DEFAULT 0,
    update_count INT NOT NULL DEFAULT 0, failed_count INT NOT NULL DEFAULT 0,
    current_software_id BIGINT UNSIGNED NULL, last_error TEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}


async function applyV3(db) {
  await ensureColumn(db, 'software', 'enrichment_status', "VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'pending' AFTER update_error");
  await ensureColumn(db, 'software', 'enrichment_error', 'TEXT NULL AFTER enrichment_status');
  await ensureColumn(db, 'software', 'enriched_at', 'DATETIME NULL AFTER enrichment_error');
  await ensureColumn(db, 'import_jobs', 'enriched_count', 'INT NOT NULL DEFAULT 0 AFTER completed_count');
  await ensureColumn(db, 'import_jobs', 'detail_failed_count', 'INT NOT NULL DEFAULT 0 AFTER enriched_count');
  await ensureColumn(db, 'catalog_sync_state', 'seen_count', 'INT NOT NULL DEFAULT 0 AFTER inserted_count');
}


async function applyV4(db, repairWorkspace = false) {
  await ensureColumn(db, 'software', 'workspace_added', "TINYINT(1) NOT NULL DEFAULT 0 AFTER published");

  await db.query(`CREATE TABLE IF NOT EXISTS catalog_version_paths (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    package_id VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    version VARCHAR(120) CHARACTER SET ascii NOT NULL,
    source_path VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_catalog_package_version (package_id, version),
    INDEX idx_catalog_version_package (package_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  if (repairWorkspace) {
    // v2.1 briefly conflated a catalog record with an actively imported workspace
    // record. Repair that once during the v4 migration. Do not repeat this on
    // every process start because a newly imported row may intentionally still
    // be waiting for enrichment.
    const [[softwareCountRow]] = await db.query('SELECT COUNT(*) c FROM software');
    const [[catalogCountRow]] = await db.query('SELECT COUNT(*) c FROM catalog_packages');
    const softwareCount = Number(softwareCountRow?.c || 0);
    const catalogCount = Number(catalogCountRow?.c || 0);

    if (softwareCount > 0) {
      if (softwareCount <= 500 || catalogCount < 1000) {
        await db.query('UPDATE software SET workspace_added=1 WHERE workspace_added=0');
      } else {
        await db.query(`UPDATE software s
          SET workspace_added = CASE
            WHEN s.published=1
              OR s.current_version IS NOT NULL
              OR s.installer_url IS NOT NULL
              OR s.enrichment_status='ready'
              OR s.enriched_at IS NOT NULL
              OR EXISTS (SELECT 1 FROM software_versions v WHERE v.software_id=s.id)
              OR EXISTS (SELECT 1 FROM software_assets a WHERE a.software_id=s.id)
            THEN 1 ELSE 0 END`);
      }
    }
  }
}

async function applyV5(db) {
  await ensureColumn(db, 'software', 'enrichment_attempts', 'INT NOT NULL DEFAULT 0 AFTER enriched_at');
  await ensureColumn(db, 'software', 'last_enrichment_attempt_at', 'DATETIME NULL AFTER enrichment_attempts');
  await ensureColumn(db, 'software', 'link_status', "VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'unknown' AFTER last_enrichment_attempt_at");
  await ensureColumn(db, 'software', 'link_checked_at', 'DATETIME NULL AFTER link_status');
  await ensureColumn(db, 'catalog_packages', 'last_metadata_error', 'TEXT NULL AFTER metadata_status');
  await ensureColumn(db, 'catalog_packages', 'last_metadata_attempt_at', 'DATETIME NULL AFTER last_metadata_error');
  await db.query(`CREATE TABLE IF NOT EXISTS enrichment_queue (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    software_id BIGINT UNSIGNED NOT NULL,
    status VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'queued',
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_enrichment_software (software_id),
    INDEX idx_enrichment_status (status, updated_at),
    CONSTRAINT fk_enrichment_software FOREIGN KEY (software_id) REFERENCES software(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}



async function applyV6(db) {
  await ensureColumn(db, 'software', 'workspace_added_at', 'DATETIME NULL AFTER workspace_added');
  await ensureColumn(db, 'software', 'author', 'VARCHAR(255) NULL AFTER publisher');
  await ensureColumn(db, 'software', 'license_name', 'VARCHAR(255) NULL AFTER description');
  await ensureColumn(db, 'software', 'license_url', 'TEXT NULL AFTER license_name');
  await ensureColumn(db, 'software', 'support_url', 'TEXT NULL AFTER license_url');
  await ensureColumn(db, 'software', 'release_notes_url', 'TEXT NULL AFTER support_url');
  await ensureColumn(db, 'software', 'tags_json', 'TEXT NULL AFTER release_notes_url');
  await ensureColumn(db, 'software', 'last_opened_at', 'DATETIME NULL AFTER link_checked_at');
  await db.query('UPDATE software SET workspace_added_at=COALESCE(workspace_added_at, created_at) WHERE workspace_added=1');
  try { await db.query('CREATE INDEX idx_software_workspace_added_at ON software (workspace_added, published, workspace_added_at)'); } catch (err) {
    if (!/Duplicate key name/i.test(String(err.message || err))) throw err;
  }
}


async function applyV7(db) {
  await ensureColumn(db, 'software_assets', 'width_px', 'INT UNSIGNED NULL AFTER sort_order');
  await ensureColumn(db, 'software_assets', 'height_px', 'INT UNSIGNED NULL AFTER width_px');
  await ensureColumn(db, 'software_assets', 'file_size_bytes', 'BIGINT UNSIGNED NULL AFTER height_px');
  await ensureColumn(db, 'software_assets', 'mime_type', 'VARCHAR(120) CHARACTER SET ascii NULL AFTER file_size_bytes');
  await ensureColumn(db, 'software_assets', 'content_hash', 'CHAR(64) CHARACTER SET ascii NULL AFTER mime_type');
  await ensureColumn(db, 'software_assets', 'perceptual_hash', 'VARCHAR(64) CHARACTER SET ascii NULL AFTER content_hash');
  await ensureColumn(db, 'software_assets', 'quality_status', "VARCHAR(24) CHARACTER SET ascii NOT NULL DEFAULT 'unknown' AFTER perceptual_hash");
  await ensureColumn(db, 'software_assets', 'quality_grade', 'VARCHAR(24) CHARACTER SET ascii NULL AFTER quality_status');
  await ensureColumn(db, 'software_assets', 'validated_at', 'DATETIME NULL AFTER quality_grade');
  try { await db.query('CREATE INDEX idx_asset_quality ON software_assets (software_id, asset_type, quality_status, status)'); } catch (err) {
    if (!/Duplicate key name/i.test(String(err.message || err))) throw err;
  }
}

async function applyV8(db) {
  await ensureColumn(db, 'software', 'media_enriched_at', 'DATETIME NULL AFTER last_opened_at');
  await ensureColumn(db, 'enrichment_queue', 'media_status', "VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'pending' AFTER status");
  await ensureColumn(db, 'enrichment_queue', 'last_media_error', 'TEXT NULL AFTER last_error');
  await ensureColumn(db, 'enrichment_queue', 'next_attempt_at', 'DATETIME NULL AFTER last_media_error');
  await ensureColumn(db, 'enrichment_queue', 'completed_at', 'DATETIME NULL AFTER next_attempt_at');
  await db.query(`CREATE TABLE IF NOT EXISTS winget_manifest_cache (
    path_hash CHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY,
    source_path TEXT NOT NULL,
    manifest_text MEDIUMTEXT NULL,
    fetched_at DATETIME NULL,
    last_error TEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_manifest_cache_fetched (fetched_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  try { await db.query('CREATE INDEX idx_enrichment_background ON enrichment_queue (status, media_status, next_attempt_at, updated_at)'); } catch (err) {
    if (!/Duplicate key name/i.test(String(err.message || err))) throw err;
  }
  await db.query("UPDATE enrichment_queue SET media_status='pending' WHERE media_status IS NULL OR media_status=''");
}


async function applyV9(db, cleanStart = false) {
  // v3.4 changes imports from "create now, enrich later" to verified imports.
  // The user explicitly requested one clean start when this version is first deployed.
  if (cleanStart) {
    await db.query('DELETE FROM software');
    await db.query('DELETE FROM catalog_version_paths');
    await db.query('DELETE FROM catalog_packages');
    await db.query('DELETE FROM import_jobs');
    await db.query('DELETE FROM update_scan_state');
    await db.query('DELETE FROM catalog_sync_state');
    await db.query('DELETE FROM winget_manifest_cache');
    await db.query(`INSERT INTO app_settings (setting_key,setting_value) VALUES ('starter_catalog_enabled','0')
      ON DUPLICATE KEY UPDATE setting_value='0'`);
  }
}


async function applyV10(db) {
  await ensureColumn(db, 'software', 'published_at', 'DATETIME NULL AFTER published');
  await db.query('UPDATE software SET published_at=COALESCE(published_at,updated_at) WHERE published=1');
  // v3.5 removes Catalog as a user workflow. Keep a small internal discovery
  // cache for WinGet expansion, but track imported/cleared packages separately
  // so Auto Import does not immediately repeat software the user removed.
  await db.query(`CREATE TABLE IF NOT EXISTS software_import_history (
    package_id VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
    status VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'imported',
    last_error TEXT NULL,
    last_imported_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_import_history_status (status, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`INSERT INTO app_settings (setting_key,setting_value) VALUES ('starter_catalog_enabled','0')
    ON DUPLICATE KEY UPDATE setting_value='0'`);
  // Preserve existing New/Published software. v3.5 is a workflow migration, not
  // another destructive reset.
  await db.query(`INSERT INTO software_import_history (package_id,status,last_imported_at)
    SELECT package_id,IF(published=1,'published','imported'),COALESCE(workspace_added_at,created_at)
    FROM software WHERE workspace_added=1
    ON DUPLICATE KEY UPDATE status=VALUES(status),last_imported_at=VALUES(last_imported_at)`);
}


async function applyV11(db, resetLegacyMedia = false) {
  // v3.6: append-only imports + strict media identity. This migration is
  // deliberately non-destructive for software/version records.
  await ensureColumn(db, 'software', 'media_source_url', 'TEXT NULL AFTER official_url');
  await ensureColumn(db, 'software_import_history', 'last_job_id', 'BIGINT UNSIGNED NULL AFTER last_imported_at');
  await ensureColumn(db, 'software_assets', 'identity_verified', "TINYINT(1) NOT NULL DEFAULT 0 AFTER quality_grade");
  await ensureColumn(db, 'software_assets', 'identity_reason', 'VARCHAR(255) NULL AFTER identity_verified');

  if (resetLegacyMedia) {
    // Old media was selected by looser v3.2-v3.5 rules. Do not delete it, but
    // hide it until the new product-identity scanner verifies fresh candidates.
    await db.query("UPDATE software_assets SET identity_verified=0,status=IF(status='rejected','rejected','candidate')");
    await clearLegacySoftwareMedia(db, 'WHERE workspace_added=1');
    if (await columnExists(db, 'software', 'enrichment_status')) {
      await db.query("UPDATE software SET enrichment_status=IF(enrichment_status='fetching','fetching','pending') WHERE workspace_added=1");
    }
    try {
      await db.query("UPDATE enrichment_queue q JOIN software s ON s.id=q.software_id SET q.status=IF(q.status='running','running','queued'),q.media_status='pending',q.next_attempt_at=NOW(),q.last_error=NULL,q.last_media_error=NULL WHERE s.workspace_added=1");
    } catch {}
  }
}

async function applyV12(db, resetMedia = false) {
  // v3.6.3: exact-product media identity + richer software specifications.
  await ensureColumn(db, 'software', 'developer_name', 'VARCHAR(255) NULL AFTER author');
  await ensureColumn(db, 'software', 'language', 'VARCHAR(255) NULL AFTER tags_json');
  await ensureColumn(db, 'software', 'platform', 'VARCHAR(255) NULL AFTER language');
  await ensureColumn(db, 'software', 'processor', 'VARCHAR(255) NULL AFTER platform');
  await ensureColumn(db, 'software', 'minimum_os_version', 'VARCHAR(120) CHARACTER SET ascii NULL AFTER processor');
  await ensureColumn(db, 'software', 'ram_requirement', 'TEXT NULL AFTER minimum_os_version');
  await ensureColumn(db, 'software', 'storage_requirement', 'TEXT NULL AFTER ram_requirement');
  await ensureColumn(db, 'software', 'graphics_requirement', 'TEXT NULL AFTER storage_requirement');
  await ensureColumn(db, 'software', 'requirements_source_url', 'TEXT NULL AFTER graphics_requirement');
  await ensureColumn(db, 'software', 'download_count', 'BIGINT UNSIGNED NULL AFTER requirements_source_url');
  await ensureColumn(db, 'software', 'download_count_source', 'TEXT NULL AFTER download_count');
  await ensureColumn(db, 'software_assets', 'identity_version', 'TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER identity_reason');

  await db.query("UPDATE software SET developer_name=COALESCE(developer_name,author,publisher), platform=COALESCE(platform,'Windows') WHERE workspace_added=1");

  if (resetMedia) {
    // Media approved by v3.6.0-v3.6.2 used a looser matcher that could accept
    // another product from the same vendor site. Force every asset through the
    // new exact-product matcher before it can be shown again.
    await db.query("UPDATE software_assets SET identity_verified=0,identity_version=1,status=IF(status='rejected','rejected','candidate')");
    await clearLegacySoftwareMedia(db, 'WHERE workspace_added=1');
    try {
      await db.query("UPDATE enrichment_queue q JOIN software s ON s.id=q.software_id SET q.media_status='pending',q.next_attempt_at=NOW(),q.last_media_error=NULL WHERE s.workspace_added=1");
    } catch {}
  }
}


async function applyV13(db) {
  // v3.6.4: persist release/update dates for each historical WinGet version.
  await ensureColumn(db, 'software_versions', 'release_date', 'DATE NULL AFTER source_path');
  await ensureColumn(db, 'software_versions', 'release_date_source', 'VARCHAR(40) CHARACTER SET ascii NULL AFTER release_date');
}



async function applyV14(db, firstApply = false) {
  // v3.6.5 removes all logo/screenshot behavior and upgrades Auto Import into
  // a resumable server-side bulk job. Legacy media tables remain only so older
  // migration history is compatible; they are no longer read or written.
  await ensureColumn(db, 'import_jobs', 'phase', "VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'idle' AFTER status");
  await ensureColumn(db, 'import_jobs', 'available_count', 'INT NOT NULL DEFAULT 0 AFTER failed_count');
  await ensureColumn(db, 'import_jobs', 'catalog_complete', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER available_count');
  // Media columns/tables are legacy and may already have been removed on an
  // installation. Never make startup depend on them existing.
  if (await tableExists(db, 'enrichment_queue') && await columnExists(db, 'enrichment_queue', 'media_status')) {
    const clearError = await columnExists(db, 'enrichment_queue', 'last_media_error') ? ',last_media_error=NULL' : '';
    await db.query(`UPDATE enrichment_queue SET media_status='disabled'${clearError} WHERE media_status<>'disabled' OR media_status IS NULL`);
  }
  if (firstApply) await clearLegacySoftwareMedia(db);
  // Keep legacy image tables empty only during the one-time v3.6.5 migration. They are not required by the
  // v3.6.5+ runtime and their absence is also valid.
  if (firstApply && await tableExists(db, 'software_assets')) await db.query('DELETE FROM software_assets');
  if (firstApply && await tableExists(db, 'asset_discovery_runs')) await db.query('DELETE FROM asset_discovery_runs');
  if (firstApply) {
    // Re-open catalog discovery so deployments that previously stopped at the
    // old 5,000 target can continue toward the new 50,000 ceiling. Existing
    // catalog rows are retained and de-duplicated.
    await db.query("DELETE FROM catalog_sync_state WHERE sync_key='winget-main'");
  }
  await db.query(`INSERT INTO app_settings (setting_key,setting_value) VALUES ('media_feature_enabled','0')
    ON DUPLICATE KEY UPDATE setting_value='0'`);
}


async function applyV15(db, firstApply = false) {
  // v3.6.7: track the richer metadata/enrichment pass. Existing software stays
  // intact and is refreshed once when opened or explicitly refreshed.
  await ensureColumn(db, 'software', 'metadata_revision', 'TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER enrichment_status');
  if (firstApply && await columnExists(db, 'software', 'minimum_os_version')) {
    // Official requirement pages may use normal UTF-8 punctuation/text, while
    // the old WinGet-only column was ASCII. Widen it without deleting data.
    await db.query('ALTER TABLE software MODIFY COLUMN minimum_os_version VARCHAR(255) NULL');
  }
}


async function applyV16(db) {
  // v3.7.1: non-destructive JSON backup metadata. Backup contents stay as
  // downloadable files on disk; this table only tracks their status.
  await db.query(`CREATE TABLE IF NOT EXISTS backup_history (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    backup_kind VARCHAR(24) CHARACTER SET ascii NOT NULL DEFAULT 'manual',
    filename VARCHAR(255) NOT NULL,
    file_size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    downloaded_at DATETIME NULL,
    INDEX idx_backup_created (backup_kind, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}


async function applyV17(db) {
  // v3.7.8: logo integration retired. Existing logo cache tables, if present,
  // are intentionally left untouched to avoid destructive schema changes.
  void db;
}


async function applyV18(db) {
  // v3.8.0: real multi-user access with exactly two roles (Admin + Partner),
  // account profiles, audit history, and one-owner-at-a-time software work claims.
  await ensureColumn(db, 'users', 'name', 'VARCHAR(120) NULL AFTER id');
  await ensureColumn(db, 'users', 'role', "VARCHAR(24) CHARACTER SET ascii NOT NULL DEFAULT 'partner' AFTER password_hash");
  await ensureColumn(db, 'users', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER role');
  await ensureColumn(db, 'users', 'avatar_mime', 'VARCHAR(64) CHARACTER SET ascii NULL AFTER is_active');
  await ensureColumn(db, 'users', 'avatar_blob', 'MEDIUMBLOB NULL AFTER avatar_mime');
  await ensureColumn(db, 'users', 'last_login_at', 'DATETIME NULL AFTER avatar_blob');
  await ensureColumn(db, 'users', 'created_by', 'BIGINT UNSIGNED NULL AFTER last_login_at');

  await db.query("UPDATE users SET role='partner' WHERE role IS NULL OR role='' OR role NOT IN ('admin','partner')");
  const [[admin]] = await db.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  if (!admin) {
    const [[first]] = await db.query('SELECT id FROM users ORDER BY id LIMIT 1');
    if (first) await db.query("UPDATE users SET role='admin',is_active=1 WHERE id=?", [first.id]);
  }
  // HSWare intentionally has one owner role. If an installation somehow had
  // multiple admins before v3.8, preserve the oldest account as Admin and make
  // the remaining accounts Partners rather than creating multiple owners.
  const [admins] = await db.query("SELECT id FROM users WHERE role='admin' ORDER BY id");
  for (const row of admins.slice(1)) await db.query("UPDATE users SET role='partner' WHERE id=?", [row.id]);
  await db.query("UPDATE users SET name=SUBSTRING_INDEX(email,'@',1) WHERE name IS NULL OR TRIM(name)=''");

  await db.query(`CREATE TABLE IF NOT EXISTS software_work_claims (
    software_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    lock_token CHAR(48) CHARACTER SET ascii NOT NULL,
    claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_work_claim_user (user_id, updated_at),
    CONSTRAINT fk_work_claim_software FOREIGN KEY (software_id) REFERENCES software(id) ON DELETE CASCADE,
    CONSTRAINT fk_work_claim_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS activity_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NULL,
    action VARCHAR(80) CHARACTER SET ascii NOT NULL,
    software_id BIGINT UNSIGNED NULL,
    target_user_id BIGINT UNSIGNED NULL,
    details_json TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_activity_created (created_at),
    INDEX idx_activity_user (user_id, created_at),
    INDEX idx_activity_software (software_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}


async function applyV19(db) {
  // v4.0.0: persistent notification center plus ownership metadata for
  // long-running Auto Import and update-scan completion notifications.
  await ensureColumn(db, 'import_jobs', 'requested_by', 'BIGINT UNSIGNED NULL AFTER requested_count');
  await ensureColumn(db, 'import_jobs', 'completion_notified', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER requested_by');
  await ensureColumn(db, 'update_scan_state', 'requested_by', 'BIGINT UNSIGNED NULL AFTER scan_key');
  await ensureColumn(db, 'update_scan_state', 'completion_notified', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER requested_by');

  await db.query(`CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    actor_user_id BIGINT UNSIGNED NULL,
    type VARCHAR(40) CHARACTER SET ascii NOT NULL DEFAULT 'info',
    title VARCHAR(160) NOT NULL,
    message VARCHAR(700) NULL,
    software_id BIGINT UNSIGNED NULL,
    target_user_id BIGINT UNSIGNED NULL,
    dedupe_key VARCHAR(190) CHARACTER SET ascii NULL,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at DATETIME NULL,
    INDEX idx_notifications_user_unread (user_id,is_read,created_at),
    INDEX idx_notifications_created (created_at),
    INDEX idx_notifications_software (software_id,created_at),
    UNIQUE KEY uniq_notification_dedupe (user_id,dedupe_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}



async function applyV20(db) {
  // v4.3.0: carry installer size/date through current, update and history
  // records, and restore a manifest-trusted software logo field.
  await ensureColumn(db, 'software_versions', 'file_size_bytes', 'BIGINT UNSIGNED NULL AFTER sha256');
  await ensureColumn(db, 'software', 'latest_file_size_bytes', 'BIGINT UNSIGNED NULL AFTER latest_sha256');
  await ensureColumn(db, 'software', 'latest_release_date', 'DATE NULL AFTER latest_file_size_bytes');
  await ensureColumn(db, 'software', 'logo_url', 'TEXT NULL AFTER official_url');
  await ensureColumn(db, 'software', 'logo_source', 'VARCHAR(80) CHARACTER SET ascii NULL AFTER logo_url');
  await ensureColumn(db, 'software', 'logo_confidence', 'TINYINT UNSIGNED NULL AFTER logo_source');
}

async function applyV21(db) {
  // v4.4.0: persist the current package/version date and its provenance.
  await ensureColumn(db, 'software', 'release_date', 'DATE NULL AFTER file_size_bytes');
  await ensureColumn(db, 'software', 'release_date_source', 'VARCHAR(40) CHARACTER SET ascii NULL AFTER release_date');
}


async function applyV22(db) {
  // v4.4.4 HQ logo metadata: record actual intrinsic dimensions/format so
  // HSWare never labels a tiny upscaled bitmap as a high-quality logo.
  await ensureColumn(db, 'software', 'logo_width', 'INT UNSIGNED NULL AFTER logo_confidence');
  await ensureColumn(db, 'software', 'logo_height', 'INT UNSIGNED NULL AFTER logo_width');
  await ensureColumn(db, 'software', 'logo_format', 'VARCHAR(20) CHARACTER SET ascii NULL AFTER logo_height');
  await ensureColumn(db, 'software', 'logo_quality', 'VARCHAR(20) CHARACTER SET ascii NULL AFTER logo_format');
  await ensureColumn(db, 'software', 'logo_export_size', 'SMALLINT UNSIGNED NULL AFTER logo_quality');
}


async function applyV24(db) {
  // v7.0.9: durable queue for single-package imports. Heavy WinGet verification
  // runs in the background so Hostinger/proxy request timeouts cannot abort an
  // import after the user clicks Import.
  await db.query(`CREATE TABLE IF NOT EXISTS single_import_jobs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    package_id VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    source VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'manual',
    requested_by BIGINT UNSIGNED NULL,
    status VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'queued',
    software_id BIGINT UNSIGNED NULL,
    last_error TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_single_import_status (status,id),
    INDEX idx_single_import_package (package_id,status),
    INDEX idx_single_import_user (requested_by,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}


async function applyV25(db) {
  // v8.0.4: catalog collation recovery.
  // Older schemas stored WinGet package identifiers as ASCII while mysql2 sends
  // request values using utf8mb4. A package that requires coercion can pause the
  // catalog with ER_CANT_AGGREGATE_2COLLATIONS / "Illegal mix of collations".
  // Standardize every package-id join key to utf8mb4_unicode_ci without
  // deleting or rebuilding catalog data, then allow discovery to resume.
  const alters = [
    ['software', 'package_id', 'VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL'],
    ['catalog_packages', 'package_id', 'VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL'],
    ['catalog_version_paths', 'package_id', 'VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL'],
    ['software_import_history', 'package_id', 'VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL'],
    ['single_import_jobs', 'package_id', 'VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL'],
    ['import_jobs', 'current_package', 'VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL'],
    ['software', 'source_path', 'TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL'],
    ['catalog_packages', 'source_path', 'VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL'],
    ['catalog_version_paths', 'source_path', 'VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL'],
    ['software_versions', 'source_path', 'VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL']
  ];
  for (const [table, column, definition] of alters) {
    if (!(await columnExists(db, table, column))) continue;
    const [[meta]] = await db.query(
      `SELECT CHARACTER_SET_NAME AS charset_name,COLLATION_NAME AS collation_name
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
      [table, column]
    );
    if (String(meta?.charset_name || '').toLowerCase() === 'utf8mb4' &&
        String(meta?.collation_name || '').toLowerCase() === 'utf8mb4_unicode_ci') continue;
    await db.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
  }
  if (await tableExists(db, 'catalog_sync_state')) {
    await db.query("UPDATE catalog_sync_state SET status='running',last_error=NULL WHERE sync_key='winget-main' AND status='paused' AND last_error LIKE '%collation%'");
  }
}



async function applyV26(db) {
  // v8.1.0: Backup V2 metadata. This only extends backup_history; it does not
  // alter software, publishing, WinGet, claims, catalog, or workflow tables.
  await ensureColumn(db, 'backup_history', 'software_count', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER file_size_bytes');
  await ensureColumn(db, 'backup_history', 'version_count', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER software_count');
  await ensureColumn(db, 'backup_history', 'integrity_sha256', 'VARCHAR(64) CHARACTER SET ascii NULL AFTER version_count');
  await ensureColumn(db, 'backup_history', 'drive_status', "VARCHAR(24) CHARACTER SET ascii NOT NULL DEFAULT 'not_connected' AFTER integrity_sha256");
  await ensureColumn(db, 'backup_history', 'drive_file_id', 'VARCHAR(255) CHARACTER SET ascii NULL AFTER drive_status');
  await ensureColumn(db, 'backup_history', 'drive_uploaded_at', 'DATETIME NULL AFTER drive_file_id');
  await ensureColumn(db, 'backup_history', 'drive_error', 'TEXT NULL AFTER drive_uploaded_at');
}


async function applyV27(db) {
  // v11.1 reliability hardening: persistent worker health/retry state and
  // database-backed rate-limit buckets. These tables are additive only.
  await db.query(`CREATE TABLE IF NOT EXISTS worker_health (
    worker_name VARCHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY,
    instance_id VARCHAR(64) CHARACTER SET ascii NULL,
    status VARCHAR(24) CHARACTER SET ascii NOT NULL DEFAULT 'starting',
    last_heartbeat_at DATETIME NULL,
    last_success_at DATETIME NULL,
    consecutive_failures INT NOT NULL DEFAULT 0,
    next_retry_at DATETIME NULL,
    last_error TEXT NULL,
    last_diagnostic_id VARCHAR(64) CHARACTER SET ascii NULL,
    details_json TEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_worker_health_status (status,last_heartbeat_at),
    INDEX idx_worker_retry (next_retry_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await ensureColumn(db, 'single_import_jobs', 'attempts', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER status');
  await ensureColumn(db, 'single_import_jobs', 'next_attempt_at', 'DATETIME NULL AFTER last_error');
  try { await db.query('CREATE INDEX idx_single_import_retry ON single_import_jobs (status,next_attempt_at,id)'); } catch (err) { if (!/Duplicate key name/i.test(String(err.message || err))) throw err; }
  await db.query(`CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key CHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY,
    window_started_at DATETIME NOT NULL,
    request_count INT UNSIGNED NOT NULL DEFAULT 0,
    last_seen_at DATETIME NOT NULL,
    INDEX idx_rate_limit_cleanup (last_seen_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function applyV28(db) {
  // v11.3.3: catalog source integrity. Older releases inserted curated starter
  // identities directly into catalog_packages even when no current WinGet
  // manifest had been observed. Remove only unresolved catalog-only rows; any
  // managed New/Published software is preserved.
  await db.query(`DELETE c FROM catalog_packages c
    LEFT JOIN software s ON s.package_id=c.package_id AND s.workspace_added=1
    WHERE (c.source_path IS NULL OR c.source_path='') AND s.id IS NULL`);
}


async function applyV29(db) {
  const hadCatalogStatus = await columnExists(db, 'catalog_packages', 'catalog_status');
  // v11.4 Catalog Intelligence: keep the complete WinGet index internally, but
  // separate market-ready Discover software from low-signal candidates. These
  // columns are additive and do not alter publishing/workspace semantics.
  await ensureColumn(db, 'catalog_packages', 'canonical_name', 'VARCHAR(255) NULL AFTER name');
  await ensureColumn(db, 'catalog_packages', 'catalog_status', "VARCHAR(24) CHARACTER SET ascii NOT NULL DEFAULT 'candidate' AFTER demand_rank");
  await ensureColumn(db, 'catalog_packages', 'market_score', 'DECIMAL(5,2) NULL AFTER catalog_status');
  await ensureColumn(db, 'catalog_packages', 'quality_score', 'DECIMAL(5,2) NULL AFTER market_score');
  await ensureColumn(db, 'catalog_packages', 'relevance_score', 'DECIMAL(5,2) NULL AFTER quality_score');
  await ensureColumn(db, 'catalog_packages', 'pricing_model', "VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'unknown' AFTER relevance_score");
  await ensureColumn(db, 'catalog_packages', 'has_free_tier', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER pricing_model');
  await ensureColumn(db, 'catalog_packages', 'has_free_trial', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER has_free_tier');
  await ensureColumn(db, 'catalog_packages', 'commercial_product', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER has_free_trial');
  await ensureColumn(db, 'catalog_packages', 'intelligence_source', "VARCHAR(32) CHARACTER SET ascii NULL AFTER commercial_product");
  await ensureColumn(db, 'catalog_packages', 'intelligence_reason', 'VARCHAR(500) NULL AFTER intelligence_source');
  await ensureColumn(db, 'catalog_packages', 'intelligence_updated_at', 'DATETIME NULL AFTER intelligence_reason');
  try { await db.query('CREATE INDEX idx_catalog_intelligence ON catalog_packages (catalog_status,relevance_score,market_score)'); } catch (err) { if (!/Duplicate key name/i.test(String(err.message || err))) throw err; }
  try { await db.query('CREATE INDEX idx_catalog_pricing ON catalog_packages (catalog_status,pricing_model,has_free_tier)'); } catch (err) { if (!/Duplicate key name/i.test(String(err.message || err))) throw err; }

  // Dedicated canonical/source tables make package repositories replaceable.
  // A product remains an HSWare identity even if a WinGet manifest disappears.
  await db.query(`CREATE TABLE IF NOT EXISTS canonical_software (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    canonical_key VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL UNIQUE,
    canonical_name VARCHAR(255) NOT NULL,
    publisher VARCHAR(255) NULL,
    category VARCHAR(120) NULL,
    catalog_status VARCHAR(24) CHARACTER SET ascii NOT NULL DEFAULT 'candidate',
    market_score DECIMAL(5,2) NULL,
    quality_score DECIMAL(5,2) NULL,
    relevance_score DECIMAL(5,2) NULL,
    pricing_model VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'unknown',
    has_free_tier TINYINT(1) NOT NULL DEFAULT 0,
    has_free_trial TINYINT(1) NOT NULL DEFAULT 0,
    commercial_product TINYINT(1) NOT NULL DEFAULT 0,
    intelligence_source VARCHAR(32) CHARACTER SET ascii NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_canonical_catalog (catalog_status,relevance_score),
    INDEX idx_canonical_category (category)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS software_sources (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    canonical_id BIGINT UNSIGNED NOT NULL,
    source_type VARCHAR(32) CHARACTER SET ascii NOT NULL,
    source_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    source_url TEXT NULL,
    verified TINYINT(1) NOT NULL DEFAULT 0,
    last_seen_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_software_source (source_type,source_key),
    INDEX idx_software_source_canonical (canonical_id,source_type),
    CONSTRAINT fk_software_sources_canonical FOREIGN KEY (canonical_id) REFERENCES canonical_software(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS catalog_market_signals (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    canonical_id BIGINT UNSIGNED NOT NULL,
    signal_type VARCHAR(64) CHARACTER SET ascii NOT NULL,
    source_name VARCHAR(120) NOT NULL,
    signal_value DECIMAL(12,4) NULL,
    confidence DECIMAL(5,2) NULL,
    observed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_market_signal_product (canonical_id,signal_type,observed_at),
    CONSTRAINT fk_market_signal_canonical FOREIGN KEY (canonical_id) REFERENCES canonical_software(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // v11.3.4 used metadata_status for curation. v11.4 reserves it for source
  // metadata state and moves curation into catalog_status.
  await db.query("UPDATE catalog_packages SET metadata_status='index' WHERE metadata_status='curation-rejected' AND source_path IS NOT NULL AND source_path<>''");
  if (!hadCatalogStatus) await db.query("UPDATE catalog_packages SET catalog_status='candidate', intelligence_updated_at=NULL WHERE source_path IS NOT NULL AND source_path<>''");
}


async function applyV30(db) {
  // v11.5 Catalog Expansion Engine. The existing catalog_status remains the
  // Discover visibility gate; these additive fields explain how the long-tail
  // candidate pool was processed and balanced toward the 5,000-product target.
  await ensureColumn(db, 'catalog_packages', 'expansion_state', "VARCHAR(24) CHARACTER SET ascii NOT NULL DEFAULT 'unprocessed' AFTER intelligence_updated_at");
  await ensureColumn(db, 'catalog_packages', 'expansion_tier', "VARCHAR(24) CHARACTER SET ascii NULL AFTER expansion_state");
  await ensureColumn(db, 'catalog_packages', 'expansion_score', 'DECIMAL(5,2) NULL AFTER expansion_tier');
  await ensureColumn(db, 'catalog_packages', 'canonical_group_key', 'VARCHAR(190) NULL AFTER expansion_score');
  await ensureColumn(db, 'catalog_packages', 'duplicate_of_package_id', 'VARCHAR(190) NULL AFTER canonical_group_key');
  await ensureColumn(db, 'catalog_packages', 'expansion_reason', 'VARCHAR(500) NULL AFTER duplicate_of_package_id');
  await ensureColumn(db, 'catalog_packages', 'expansion_updated_at', 'DATETIME NULL AFTER expansion_reason');
  try { await db.query('CREATE INDEX idx_catalog_expansion ON catalog_packages (expansion_state,expansion_score,catalog_status)'); } catch (err) { if (!/Duplicate key name/i.test(String(err.message || err))) throw err; }
  try { await db.query('CREATE INDEX idx_catalog_group_key ON catalog_packages (canonical_group_key)'); } catch (err) { if (!/Duplicate key name/i.test(String(err.message || err))) throw err; }

  await ensureColumn(db, 'canonical_software', 'expansion_tier', "VARCHAR(24) CHARACTER SET ascii NULL AFTER intelligence_source");
  await ensureColumn(db, 'canonical_software', 'expansion_score', 'DECIMAL(5,2) NULL AFTER expansion_tier');

  await db.query(`CREATE TABLE IF NOT EXISTS catalog_expansion_state (
    expansion_key VARCHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY,
    target_count INT UNSIGNED NOT NULL DEFAULT 50000,
    processed_count INT UNSIGNED NOT NULL DEFAULT 0,
    qualified_count INT UNSIGNED NOT NULL DEFAULT 0,
    selected_count INT UNSIGNED NOT NULL DEFAULT 0,
    search_only_count INT UNSIGNED NOT NULL DEFAULT 0,
    rejected_count INT UNSIGNED NOT NULL DEFAULT 0,
    duplicate_count INT UNSIGNED NOT NULL DEFAULT 0,
    last_run_at DATETIME NULL,
    last_error TEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`INSERT INTO catalog_expansion_state (expansion_key,target_count)
    VALUES ('winget-main',50000) ON DUPLICATE KEY UPDATE target_count=VALUES(target_count)`);

  // Force one v11.5 re-evaluation of the existing indexed long tail without
  // deleting or re-importing any package/workspace data.
  await db.query("UPDATE catalog_packages SET expansion_state='unprocessed',expansion_updated_at=NULL WHERE source_path IS NOT NULL AND source_path<>''");
}


async function applyV31(db) {
  const indexes=[
    ['idx_software_workspace_recent','CREATE INDEX idx_software_workspace_recent ON software (workspace_added,published,workspace_added_at,id)'],
    ['idx_software_published_recent','CREATE INDEX idx_software_published_recent ON software (workspace_added,published,published_at,id)'],
    ['idx_software_updates_recent','CREATE INDEX idx_software_updates_recent ON software (workspace_added,update_available,last_checked_at,id)'],
    ['idx_software_scope_priority','CREATE INDEX idx_software_scope_priority ON software (workspace_added,published,priority_rank,id)'],
    ['idx_software_scope_demand','CREATE INDEX idx_software_scope_demand ON software (workspace_added,published,demand_score,id)']
  ];
  for (const [,sql] of indexes) {
    try { await db.query(sql); } catch (err) { if (!/Duplicate key name/i.test(String(err.message||err))) throw err; }
  }
}


async function applyV32(db) {
  // v12.1 Catalog Expansion repair. Some installations carried the v11.4
  // conservative catalog_status values forward without ever completing the
  // v11.5 5,000-product expansion pass. Reset only expansion-derived state so
  // the background worker can re-evaluate the existing verified WinGet index.
  await db.query(`UPDATE catalog_packages SET
    catalog_status=CASE WHEN intelligence_source='market-anchor' THEN 'curated' ELSE 'candidate' END,
    expansion_state='unprocessed', expansion_tier=NULL, expansion_score=NULL,
    canonical_group_key=NULL, duplicate_of_package_id=NULL, expansion_reason=NULL,
    expansion_updated_at=NULL
    WHERE source_path IS NOT NULL AND source_path<>''`);
  await db.query(`INSERT INTO catalog_expansion_state
    (expansion_key,target_count,processed_count,qualified_count,selected_count,search_only_count,rejected_count,duplicate_count,last_run_at,last_error)
    VALUES ('winget-main',50000,0,0,0,0,0,0,NULL,NULL)
    ON DUPLICATE KEY UPDATE target_count=50000,processed_count=0,qualified_count=0,selected_count=0,
      search_only_count=0,rejected_count=0,duplicate_count=0,last_run_at=NULL,last_error=NULL`);
}


async function applyV33(db) {
  // v14 full WinGet catalog: every verified PackageIdentifier is visible and
  // reclassified into the fixed 200-category taxonomy. Reset expansion-derived
  // visibility once so existing databases are upgraded without deleting data.
  await db.query(`UPDATE catalog_packages SET
    catalog_status='curated',
    expansion_state='unprocessed', expansion_tier=NULL, expansion_score=NULL,
    duplicate_of_package_id=NULL, expansion_reason=NULL, expansion_updated_at=NULL
    WHERE source_path IS NOT NULL AND source_path<>''`);
  await db.query(`INSERT INTO catalog_expansion_state
    (expansion_key,target_count,processed_count,qualified_count,selected_count,search_only_count,rejected_count,duplicate_count,last_run_at,last_error)
    VALUES ('winget-main',50000,0,0,0,0,0,0,NULL,NULL)
    ON DUPLICATE KEY UPDATE target_count=50000,processed_count=0,qualified_count=0,selected_count=0,
      search_only_count=0,rejected_count=0,duplicate_count=0,last_run_at=NULL,last_error=NULL`);
}

async function migrate() {
  const db = getPool();
  await db.query(baselineStatements[0]);
  const [rows] = await db.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map(r => Number(r.version)));
  if (!applied.has(1)) {
    for (const sql of baselineStatements) await db.query(sql);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (1,?)', ['baseline']);
  } else {
    // Keep CREATE IF NOT EXISTS statements safe for installations that were partially uploaded.
    for (const sql of baselineStatements.slice(1)) await db.query(sql);
  }
  // Run the row-storage repair before any incremental ADD COLUMN work. This
  // specifically heals databases that previously stopped mid-migration with
  // ER_TOO_BIG_ROWSIZE / "Row size too large".
  await compactSoftwareRowStorage(db);

  if (!applied.has(2)) {
    await applyV2(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (2,?)', ['v2.1_workspace_import_updates']);
  } else {
    await applyV2(db);
  }
  if (!applied.has(3)) {
    await applyV3(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (3,?)', ['v2.1.1_functional_workflow']);
  } else {
    await applyV3(db);
  }
  if (!applied.has(4)) {
    await applyV4(db, true);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (4,?)', ['v2.1.2_workspace_and_history_index']);
  } else {
    await applyV4(db, false);
  }
  if (!applied.has(5)) {
    await applyV5(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (5,?)', ['v3_astro_reliable_enrichment']);
  } else {
    await applyV5(db);
  }
  if (!applied.has(6)) {
    await applyV6(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (6,?)', ['v3_1_workflow_speed_workspace']);
  } else {
    await applyV6(db);
  }
  if (!applied.has(7)) {
    await applyV7(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (7,?)', ['v3_2_hq_media_engine']);
  } else {
    await applyV7(db);
  }
  if (!applied.has(8)) {
    await applyV8(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (8,?)', ['v3_3_automatic_enrichment_engine']);
  } else {
    await applyV8(db);
  }
  if (!applied.has(9)) {
    // v3.5 must never introduce a new surprise wipe. The one-time v3.4 clean
    // start has already served its purpose; installations jumping straight to
    // v3.5 record the migration without deleting workspace data.
    await applyV9(db, false);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (9,?)', ['v3_4_verified_import_clean_start']);
  } else {
    await applyV9(db, false);
  }
  if (!applied.has(10)) {
    await applyV10(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (10,?)', ['v3_5_simple_new_published_workflow']);
  } else {
    await applyV10(db);
  }
  if (!applied.has(11)) {
    await applyV11(db, true);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (11,?)', ['v3_6_import_integrity_media_identity']);
  } else {
    await applyV11(db, false);
  }
  if (!applied.has(12)) {
    await applyV12(db, true);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (12,?)', ['v3_6_3_exact_media_and_specs']);
  } else {
    await applyV12(db, false);
  }
  if (!applied.has(13)) {
    await applyV13(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (13,?)', ['v3_6_4_previous_version_dates']);
  } else {
    await applyV13(db);
  }
  if (!applied.has(14)) {
    await applyV14(db, true);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (14,?)', ['v3_6_5_media_free_bulk_import']);
  } else {
    await applyV14(db, false);
  }
  if (!applied.has(15)) {
    await applyV15(db, true);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (15,?)', ['v3_6_7_metadata_enrichment_revision']);
  } else {
    await applyV15(db, false);
  }
  if (!applied.has(16)) {
    await applyV16(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (16,?)', ['v3_7_1_json_backup_system']);
  } else {
    await applyV16(db);
  }
  if (!applied.has(17)) {
    await applyV17(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (17,?)', ['v3_7_7_logo_feature_retired']);
  } else {
    await applyV17(db);
  }
  if (!applied.has(18)) {
    await applyV18(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (18,?)', ['v3_8_multi_user_roles_work_claims']);
  } else {
    await applyV18(db);
  }
  if (!applied.has(19)) {
    await applyV19(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (19,?)', ['v4_activity_notifications']);
  } else {
    await applyV19(db);
  }
  if (!applied.has(20)) {
    await applyV20(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (20,?)', ['v4_3_winget_size_logo_metadata']);
  } else {
    await applyV20(db);
  }
  if (!applied.has(21)) {
    await applyV21(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (21,?)', ['v4_4_release_date_accuracy']);
  } else {
    await applyV21(db);
  }
  if (!applied.has(22)) {
    await applyV22(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (22,?)', ['v4_4_4_hq_logo_metadata']);
  } else {
    await applyV22(db);
  }
  if (!applied.has(23)) {
    await compactSoftwareRowStorage(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (23,?)', ['v7_0_7_mysql_row_storage_hardening']);
  } else {
    await compactSoftwareRowStorage(db);
  }
  if (!applied.has(24)) {
    await applyV24(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (24,?)', ['v7_0_9_background_single_import_queue']);
  } else {
    await applyV24(db);
  }
  if (!applied.has(25)) {
    await applyV25(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (25,?)', ['v8_0_4_catalog_utf8mb4_collation_recovery']);
  } else {
    await applyV25(db);
  }
  if (!applied.has(26)) {
    await applyV26(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (26,?)', ['v8_1_0_published_json_backup_v2_google_drive']);
  } else {
    await applyV26(db);
  }
  if (!applied.has(27)) {
    await applyV27(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (27,?)', ['v11_1_reliability_hardening']);
  } else {
    await applyV27(db);
  }
  if (!applied.has(28)) {
    await applyV28(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (28,?)', ['v11_3_3_catalog_source_integrity']);
  } else {
    await applyV28(db);
  }
  if (!applied.has(29)) {
    await applyV29(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (29,?)', ['v11_4_catalog_intelligence']);
  } else {
    // Keep additive v11.4 structures self-healing on partially uploaded hosts.
    await applyV29(db);
  }
  if (!applied.has(30)) {
    await applyV30(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (30,?)', ['v11_5_catalog_expansion_engine']);
  } else {
    // Keep additive v11.5 structures self-healing without resetting expansion state.
    await ensureColumn(db, 'catalog_packages', 'expansion_state', "VARCHAR(24) CHARACTER SET ascii NOT NULL DEFAULT 'unprocessed' AFTER intelligence_updated_at");
    await ensureColumn(db, 'catalog_packages', 'expansion_tier', "VARCHAR(24) CHARACTER SET ascii NULL AFTER expansion_state");
    await ensureColumn(db, 'catalog_packages', 'expansion_score', 'DECIMAL(5,2) NULL AFTER expansion_tier');
    await ensureColumn(db, 'catalog_packages', 'canonical_group_key', 'VARCHAR(190) NULL AFTER expansion_score');
    await ensureColumn(db, 'catalog_packages', 'duplicate_of_package_id', 'VARCHAR(190) NULL AFTER canonical_group_key');
    await ensureColumn(db, 'catalog_packages', 'expansion_reason', 'VARCHAR(500) NULL AFTER duplicate_of_package_id');
    await ensureColumn(db, 'catalog_packages', 'expansion_updated_at', 'DATETIME NULL AFTER expansion_reason');
    await ensureColumn(db, 'canonical_software', 'expansion_tier', "VARCHAR(24) CHARACTER SET ascii NULL AFTER intelligence_source");
    await ensureColumn(db, 'canonical_software', 'expansion_score', 'DECIMAL(5,2) NULL AFTER expansion_tier');
    await db.query(`CREATE TABLE IF NOT EXISTS catalog_expansion_state (
      expansion_key VARCHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY,
      target_count INT UNSIGNED NOT NULL DEFAULT 50000,
      processed_count INT UNSIGNED NOT NULL DEFAULT 0,
      qualified_count INT UNSIGNED NOT NULL DEFAULT 0,
      selected_count INT UNSIGNED NOT NULL DEFAULT 0,
      search_only_count INT UNSIGNED NOT NULL DEFAULT 0,
      rejected_count INT UNSIGNED NOT NULL DEFAULT 0,
      duplicate_count INT UNSIGNED NOT NULL DEFAULT 0,
      last_run_at DATETIME NULL,
      last_error TEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db.query(`INSERT IGNORE INTO catalog_expansion_state (expansion_key,target_count) VALUES ('winget-main',50000)`);
  }
  if (!applied.has(31)) {
    await applyV31(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (31,?)', ['v12_runtime_pagination_indexes']);
  }
  if (!applied.has(32)) {
    await applyV32(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (32,?)', ['v12_1_catalog_5000_repair']);
  }
  if (!applied.has(33)) {
    await applyV33(db);
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (33,?)', ['v14_full_winget_catalog_200_categories']);
  }
  const [[v]] = await db.query('SELECT MAX(version) AS version FROM schema_migrations');
  return Number(v?.version || 0);
}

module.exports = { migrate };
