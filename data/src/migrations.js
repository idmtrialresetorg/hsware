const { getPool } = require('./db');

const SCHEMA_VERSION = 123;

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
  if (!(await columnExists(db, table, column))) {
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

async function createCoreTables(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NULL,
    email VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin','partner') NOT NULL DEFAULT 'partner',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    avatar_mime VARCHAR(80) NULL,
    avatar_blob MEDIUMBLOB NULL,
    last_login_at DATETIME NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  for (const [column, definition] of [
    ['name', 'VARCHAR(120) NULL AFTER id'],
    ['role', "ENUM('admin','partner') NOT NULL DEFAULT 'partner' AFTER password_hash"],
    ['is_active', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER role'],
    ['avatar_mime', 'VARCHAR(80) NULL AFTER is_active'],
    ['avatar_blob', 'MEDIUMBLOB NULL AFTER avatar_mime'],
    ['last_login_at', 'DATETIME NULL AFTER avatar_blob'],
    ['created_by', 'BIGINT UNSIGNED NULL AFTER last_login_at']
  ]) await ensureColumn(db, 'users', column, definition);

  await db.query(`CREATE TABLE IF NOT EXISTS settings (
    setting_key VARCHAR(120) NOT NULL PRIMARY KEY,
    setting_value LONGTEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS apps (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    package_id VARCHAR(190) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(120) NULL,
    source_section ENUM('apps','games') NOT NULL DEFAULT 'apps',
    category_slug VARCHAR(160) CHARACTER SET ascii NULL,
    category_url TEXT NULL,
    rating_value DECIMAL(4,2) NULL,
    rating_count BIGINT UNSIGNED NULL,
    mod_info VARCHAR(255) NULL,
    source_popularity_rank INT UNSIGNED NULL,
    source_trending_rank INT UNSIGNED NULL,
    popularity_score DOUBLE NOT NULL DEFAULT 0,
    trending_score DOUBLE NOT NULL DEFAULT 0,
    developer VARCHAR(255) NULL,
    current_version VARCHAR(120) CHARACTER SET ascii NULL,
    description MEDIUMTEXT NULL,
    official_url TEXT NULL,
    source_page_url TEXT NOT NULL,
    source_package_id VARCHAR(255) CHARACTER SET ascii NULL,
    source_updated_at DATE NULL,
    source_metadata_json LONGTEXT NULL,
    apk_type VARCHAR(80) CHARACTER SET ascii NULL,
    architecture VARCHAR(80) CHARACTER SET ascii NULL,
    file_size_bytes BIGINT UNSIGNED NULL,
    minimum_os_version VARCHAR(255) NULL,
    language VARCHAR(120) NULL,
    license_name VARCHAR(255) NULL,
    download_count BIGINT UNSIGNED NULL,
    tags_json TEXT NULL,
    published TINYINT(1) NOT NULL DEFAULT 0,
    published_at DATETIME NULL,
    workspace_added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    latest_version VARCHAR(120) CHARACTER SET ascii NULL,
    update_available TINYINT(1) NOT NULL DEFAULT 0,
    last_checked_at DATETIME NULL,
    update_error TEXT NULL,
    metadata_status ENUM('pending','fetching','ready','error') NOT NULL DEFAULT 'ready',
    metadata_revision INT NOT NULL DEFAULT 1,
    metadata_error TEXT NULL,
    metadata_updated_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_apps_published (published),
    INDEX idx_apps_update (update_available),
    INDEX idx_apps_source_package (source_package_id),
    INDEX idx_apps_section_category (source_section,category),
    INDEX idx_apps_popular (source_popularity_rank,popularity_score),
    INDEX idx_apps_trending (source_trending_rank,trending_score)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  for (const [column, definition] of [
    ['source_section', "ENUM('apps','games') NOT NULL DEFAULT 'apps' AFTER category"],
    ['category_slug', 'VARCHAR(160) CHARACTER SET ascii NULL AFTER source_section'],
    ['category_url', 'TEXT NULL AFTER category_slug'],
    ['rating_value', 'DECIMAL(4,2) NULL AFTER category_url'],
    ['rating_count', 'BIGINT UNSIGNED NULL AFTER rating_value'],
    ['mod_info', 'VARCHAR(255) NULL AFTER rating_count'],
    ['source_popularity_rank', 'INT UNSIGNED NULL AFTER mod_info'],
    ['source_trending_rank', 'INT UNSIGNED NULL AFTER source_popularity_rank'],
    ['popularity_score', 'DOUBLE NOT NULL DEFAULT 0 AFTER source_trending_rank'],
    ['trending_score', 'DOUBLE NOT NULL DEFAULT 0 AFTER popularity_score']
  ]) await ensureColumn(db, 'apps', column, definition);

  await db.query(`CREATE TABLE IF NOT EXISTS apk_categories (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    section ENUM('apps','games') NOT NULL DEFAULT 'apps',
    name VARCHAR(160) NOT NULL,
    slug VARCHAR(160) CHARACTER SET ascii NOT NULL,
    source_url TEXT NULL,
    parent_slug VARCHAR(160) CHARACTER SET ascii NULL,
    sort_order INT NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    last_seen_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_apk_category (section,slug),
    INDEX idx_apk_categories_section (section,sort_order,name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`UPDATE apps SET source_section=CASE WHEN LOWER(source_page_url) LIKE '%/game/%' OR LOWER(source_page_url) LIKE '%/games/%' OR LOWER(COALESCE(category,'')) LIKE '%game%' THEN 'games' ELSE 'apps' END WHERE source_section IS NULL OR source_section NOT IN ('apps','games')`);
  await db.query(`UPDATE apps SET category_slug=LOWER(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(category,'Other')),' ','-'),'&','and'),'/','-')) WHERE category_slug IS NULL OR category_slug=''`);
  await db.query(`UPDATE apps SET
    rating_value=COALESCE(rating_value,CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_metadata_json,'$.ratingValue')),'null') AS DECIMAL(4,2))),
    rating_count=COALESCE(rating_count,CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_metadata_json,'$.ratingCount')),'null') AS UNSIGNED)),
    mod_info=COALESCE(mod_info,NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_metadata_json,'$.modInfo')),'null'))
    WHERE source_metadata_json IS NOT NULL AND JSON_VALID(source_metadata_json)`);
  await db.query(`INSERT INTO apk_categories (section,name,slug,parent_slug,sort_order,last_seen_at)
    SELECT source_section,COALESCE(NULLIF(category,''),'Other'),COALESCE(NULLIF(category_slug,''),'other'),source_section,10,NOW() FROM apps
    GROUP BY source_section,COALESCE(NULLIF(category,''),'Other'),COALESCE(NULLIF(category_slug,''),'other')
    ON DUPLICATE KEY UPDATE name=VALUES(name),parent_slug=VALUES(parent_slug),active=1,last_seen_at=NOW()`);
  await db.query(`INSERT INTO apk_categories (section,name,slug,source_url,parent_slug,sort_order,last_seen_at,active) VALUES
    ('apps','Apps','apps','https://liteapks.com/apps',NULL,0,NOW(),1),
    ('games','Games','games','https://liteapks.com/games',NULL,1,NOW(),1)
    ON DUPLICATE KEY UPDATE name=VALUES(name),source_url=VALUES(source_url),parent_slug=NULL,sort_order=VALUES(sort_order),active=1,last_seen_at=NOW()`);
  await db.query(`UPDATE apk_categories SET parent_slug=section WHERE slug<>section AND (parent_slug IS NULL OR parent_slug='')`);

  await db.query(`UPDATE apps SET
    popularity_score=(LOG10(COALESCE(download_count,0)+1)*32)+(LOG10(COALESCE(rating_count,0)+1)*12)+(COALESCE(rating_value,0)*8)+GREATEST(0,30-LEAST(30,DATEDIFF(CURDATE(),COALESCE(source_updated_at,DATE_SUB(CURDATE(),INTERVAL 3650 DAY)))))*0.4,
    trending_score=(LOG10(COALESCE(download_count,0)+1)*10)+(LOG10(COALESCE(rating_count,0)+1)*7)+(COALESCE(rating_value,0)*6)+GREATEST(0,45-LEAST(45,DATEDIFF(CURDATE(),COALESCE(source_updated_at,DATE_SUB(CURDATE(),INTERVAL 3650 DAY)))))*2`);

  try { await db.query("ALTER TABLE apk_media MODIFY media_type ENUM('icon','cover','screenshot') NOT NULL"); } catch {}
  for (const sql of [
    'CREATE INDEX idx_apps_section_category ON apps(source_section,category)',
    'CREATE INDEX idx_apps_popular ON apps(source_popularity_rank,popularity_score)',
    'CREATE INDEX idx_apps_trending ON apps(source_trending_rank,trending_score)'
  ]) { try { await db.query(sql); } catch {} }

  await db.query(`CREATE TABLE IF NOT EXISTS apk_versions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    app_id BIGINT UNSIGNED NOT NULL,
    version VARCHAR(120) CHARACTER SET ascii NOT NULL,
    source_page_url TEXT NULL,
    file_size_bytes BIGINT UNSIGNED NULL,
    architecture VARCHAR(80) CHARACTER SET ascii NULL,
    apk_type VARCHAR(80) CHARACTER SET ascii NULL,
    release_date DATE NULL,
    release_date_source VARCHAR(80) CHARACTER SET ascii NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_apk_version (app_id, version),
    INDEX idx_apk_versions_app (app_id),
    CONSTRAINT fk_apk_versions_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS apk_media (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    app_id BIGINT UNSIGNED NOT NULL,
    media_type ENUM('icon','cover','screenshot') NOT NULL,
    remote_url TEXT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    metadata_json TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_apk_media_app (app_id,media_type,sort_order),
    CONSTRAINT fk_apk_media_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS apk_metadata (
    app_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    metadata_json LONGTEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_apk_metadata_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS publish_queue (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    app_id BIGINT UNSIGNED NOT NULL UNIQUE,
    status ENUM('draft','ready','published') NOT NULL DEFAULT 'draft',
    requested_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_publish_queue_status (status,updated_at),
    CONSTRAINT fk_publish_queue_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS apk_sync_state (
    sync_key VARCHAR(80) CHARACTER SET ascii NOT NULL PRIMARY KEY,
    status VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'idle',
    mode VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'daily',
    queue_json LONGTEXT NULL,
    total_count INT NOT NULL DEFAULT 0,
    processed_count INT NOT NULL DEFAULT 0,
    inserted_count INT NOT NULL DEFAULT 0,
    updated_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    current_url TEXT NULL,
    last_error TEXT NULL,
    requested_by BIGINT UNSIGNED NULL,
    completion_notified TINYINT(1) NOT NULL DEFAULT 0,
    last_started_at DATETIME NULL,
    last_completed_at DATETIME NULL,
    next_sync_at DATETIME NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await ensureColumn(db,'apk_sync_state','run_id','VARCHAR(64) CHARACTER SET ascii NULL');

  await db.query(`CREATE TABLE IF NOT EXISTS apk_update_state (
    scan_key VARCHAR(80) CHARACTER SET ascii NOT NULL PRIMARY KEY,
    status VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'idle',
    queue_json LONGTEXT NULL,
    total_count INT NOT NULL DEFAULT 0,
    processed_count INT NOT NULL DEFAULT 0,
    update_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    current_app_id BIGINT UNSIGNED NULL,
    last_error TEXT NULL,
    requested_by BIGINT UNSIGNED NULL,
    completion_notified TINYINT(1) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await ensureColumn(db,'apk_update_state','run_id','VARCHAR(64) CHARACTER SET ascii NULL');

  await db.query(`CREATE TABLE IF NOT EXISTS activity_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NULL,
    action VARCHAR(80) CHARACTER SET ascii NOT NULL,
    app_id BIGINT UNSIGNED NULL,
    target_user_id BIGINT UNSIGNED NULL,
    details_json TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_activity_created (created_at),
    INDEX idx_activity_user (user_id,created_at),
    INDEX idx_activity_app (app_id,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    actor_user_id BIGINT UNSIGNED NULL,
    type VARCHAR(40) CHARACTER SET ascii NOT NULL DEFAULT 'info',
    title VARCHAR(160) NOT NULL,
    message VARCHAR(700) NULL,
    app_id BIGINT UNSIGNED NULL,
    target_user_id BIGINT UNSIGNED NULL,
    dedupe_key VARCHAR(190) CHARACTER SET ascii NULL,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at DATETIME NULL,
    INDEX idx_notifications_user_unread (user_id,is_read,created_at),
    UNIQUE KEY uniq_notification_dedupe (user_id,dedupe_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS app_work_claims (
    app_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    lock_token VARCHAR(96) CHARACTER SET ascii NOT NULL,
    claimed_at DATETIME NOT NULL,
    last_heartbeat_at DATETIME NOT NULL,
    INDEX idx_app_claim_user (user_id),
    CONSTRAINT fk_app_claim_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
    CONSTRAINT fk_app_claim_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.query(`CREATE TABLE IF NOT EXISTS backup_history (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    backup_kind VARCHAR(24) CHARACTER SET ascii NOT NULL,
    filename VARCHAR(255) NOT NULL,
    file_size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    downloaded_at DATETIME NULL,
    INDEX idx_backup_kind_created (backup_kind,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function renameLegacySupportTables(db) {
  const moves = [
    ['activity_log', 'legacy_activity_log', 'software_id'],
    ['notifications', 'legacy_notifications', 'software_id'],
    ['software_work_claims', 'legacy_work_claims', 'software_id']
  ];
  for (const [from, to, legacyColumn] of moves) {
    if (await tableExists(db, from) && await columnExists(db, from, legacyColumn) && !(await tableExists(db, to))) {
      await db.query(`RENAME TABLE \`${from}\` TO \`${to}\``);
    }
  }
}

async function legacyColumns(db, table) {
  if (!(await tableExists(db, table))) return new Set();
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\``);
  return new Set(rows.map(r => r.Field));
}

function expr(cols, name, fallback = 'NULL') {
  return cols.has(name) ? `\`${name}\`` : fallback;
}

async function migrateLegacyAndroidData(db) {
  if (await tableExists(db, 'app_settings')) {
    await db.query(`INSERT INTO settings (setting_key,setting_value,updated_at)
      SELECT setting_key,setting_value,updated_at FROM app_settings
      ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)`);
  }

  if (await tableExists(db, 'software')) {
    const c = await legacyColumns(db, 'software');
    const developer = c.has('developer_name') ? 'COALESCE(developer_name,author,publisher)' : c.has('author') ? 'COALESCE(author,publisher)' : expr(c,'publisher');
    const androidWhere = c.has('platform_key') && c.has('source_type')
      ? "(LOWER(COALESCE(platform_key,''))='android' OR LOWER(COALESCE(source_type,''))='liteapks')"
      : c.has('source_type') ? "LOWER(COALESCE(source_type,''))='liteapks'" : '0';
    await db.query(`INSERT IGNORE INTO apps (
      id,package_id,name,category,developer,current_version,description,official_url,source_page_url,source_package_id,source_updated_at,source_metadata_json,
      apk_type,architecture,file_size_bytes,minimum_os_version,language,license_name,download_count,tags_json,published,published_at,workspace_added_at,
      latest_version,update_available,last_checked_at,update_error,metadata_status,metadata_revision,metadata_error,metadata_updated_at,created_at,updated_at
    ) SELECT
      ${expr(c,'id')},${expr(c,'package_id',"CONCAT('legacy-apk-',id)")},${expr(c,'name',"'Android App'")},${expr(c,'category')},${developer},${expr(c,'current_version')},${expr(c,'description')},${expr(c,'official_url')},
      COALESCE(${expr(c,'source_page_url')},${expr(c,'official_url')},CONCAT('https://liteapks.com/legacy-',${expr(c,'id','0')},'.html')),
      ${expr(c,'source_package_id')},${expr(c,'source_updated_at')},${expr(c,'source_metadata_json')},${expr(c,'installer_type',"'APK'")},${expr(c,'architecture',"'Android'")},${expr(c,'file_size_bytes')},
      ${expr(c,'minimum_os_version')},${expr(c,'language',"'English'")},${expr(c,'license_name')},${expr(c,'download_count')},${expr(c,'tags_json')},${expr(c,'published','0')},${expr(c,'published_at')},
      COALESCE(${expr(c,'workspace_added_at')},${expr(c,'created_at')},NOW()),${expr(c,'latest_version')},${expr(c,'update_available','0')},${expr(c,'last_checked_at')},${expr(c,'update_error')},
      CASE WHEN ${expr(c,'enrichment_status',"'ready'")}='error' THEN 'error' WHEN ${expr(c,'enrichment_status',"'ready'")}='fetching' THEN 'fetching' ELSE 'ready' END,
      ${expr(c,'metadata_revision','1')},${expr(c,'enrichment_error')},COALESCE(${expr(c,'enriched_at')},${expr(c,'updated_at')},NOW()),${expr(c,'created_at','NOW()')},${expr(c,'updated_at','NOW()')}
      FROM software WHERE ${androidWhere}`);
  }

  if (await tableExists(db, 'software_versions')) {
    const c = await legacyColumns(db, 'software_versions');
    if (c.has('software_id') && c.has('version')) {
      await db.query(`INSERT IGNORE INTO apk_versions (id,app_id,version,source_page_url,architecture,apk_type,release_date,release_date_source,created_at)
        SELECT ${expr(c,'id','NULL')},software_id,version,${expr(c,'source_page_url')},${expr(c,'architecture')},${expr(c,'installer_type')},${expr(c,'release_date')},${expr(c,'release_date_source')},${expr(c,'created_at','NOW()')}
        FROM software_versions WHERE software_id IN (SELECT id FROM apps)`);
    }
  }

  if (await tableExists(db, 'software_assets')) {
    const c = await legacyColumns(db, 'software_assets');
    if (c.has('software_id') && c.has('asset_url')) {
      await db.query(`INSERT INTO apk_media (app_id,media_type,remote_url,sort_order,created_at,updated_at)
        SELECT software_id,IF(asset_type='logo','icon','screenshot'),asset_url,${expr(c,'sort_order','0')},${expr(c,'created_at','NOW()')},${expr(c,'updated_at','NOW()')}
        FROM software_assets WHERE software_id IN (SELECT id FROM apps)`);
    }
  }

  await db.query(`INSERT INTO apk_metadata (app_id,metadata_json)
    SELECT id,source_metadata_json FROM apps
    ON DUPLICATE KEY UPDATE metadata_json=VALUES(metadata_json)`);

  await db.query(`INSERT INTO publish_queue (app_id,status)
    SELECT id,IF(published=1,'published','ready') FROM apps
    ON DUPLICATE KEY UPDATE status=VALUES(status)`);

  if (await tableExists(db, 'liteapks_sync_state')) {
    await db.query(`INSERT INTO apk_sync_state (sync_key,status,mode,queue_json,total_count,processed_count,inserted_count,updated_count,failed_count,current_url,last_error,requested_by,completion_notified,last_started_at,last_completed_at,next_sync_at,updated_at)
      SELECT 'apk-main',status,mode,queue_json,total_count,processed_count,inserted_count,updated_count,failed_count,current_url,last_error,requested_by,completion_notified,last_started_at,last_completed_at,next_sync_at,updated_at
      FROM liteapks_sync_state ORDER BY updated_at DESC LIMIT 1
      ON DUPLICATE KEY UPDATE status=VALUES(status),mode=VALUES(mode),queue_json=VALUES(queue_json),total_count=VALUES(total_count),processed_count=VALUES(processed_count),inserted_count=VALUES(inserted_count),updated_count=VALUES(updated_count),failed_count=VALUES(failed_count),current_url=VALUES(current_url),last_error=VALUES(last_error),requested_by=VALUES(requested_by),completion_notified=VALUES(completion_notified),last_started_at=VALUES(last_started_at),last_completed_at=VALUES(last_completed_at),next_sync_at=VALUES(next_sync_at),updated_at=VALUES(updated_at)`);
  }

  if (await tableExists(db, 'legacy_activity_log')) {
    await db.query(`INSERT IGNORE INTO activity_log (id,user_id,action,app_id,target_user_id,details_json,created_at)
      SELECT id,user_id,
        REPLACE(REPLACE(REPLACE(action,'software','app'),'liteapks_sync','apk_sync'),'auto_import','apk_sync'),
        CASE WHEN software_id IN (SELECT id FROM apps) THEN software_id ELSE NULL END,target_user_id,details_json,created_at
      FROM legacy_activity_log`);
  }
  if (await tableExists(db, 'legacy_notifications')) {
    await db.query(`INSERT IGNORE INTO notifications (id,user_id,actor_user_id,type,title,message,app_id,target_user_id,dedupe_key,is_read,created_at,read_at)
      SELECT id,user_id,actor_user_id,type,REPLACE(title,'Software','App'),REPLACE(message,'software','app'),
        CASE WHEN software_id IN (SELECT id FROM apps) THEN software_id ELSE NULL END,target_user_id,dedupe_key,is_read,created_at,read_at
      FROM legacy_notifications`);
  }
  await db.query(`UPDATE apps SET source_section=CASE WHEN LOWER(source_page_url) LIKE '%/game/%' OR LOWER(source_page_url) LIKE '%/games/%' OR LOWER(COALESCE(category,'')) LIKE '%game%' THEN 'games' ELSE 'apps' END WHERE source_section IS NULL OR source_section NOT IN ('apps','games')`);
  await db.query(`UPDATE apps SET category_slug=LOWER(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(category,'Other')),' ','-'),'&','and'),'/','-')) WHERE category_slug IS NULL OR category_slug=''`);
  await db.query(`UPDATE apps SET
    rating_value=COALESCE(rating_value,CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_metadata_json,'$.ratingValue')),'null') AS DECIMAL(4,2))),
    rating_count=COALESCE(rating_count,CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_metadata_json,'$.ratingCount')),'null') AS UNSIGNED)),
    mod_info=COALESCE(mod_info,NULLIF(JSON_UNQUOTE(JSON_EXTRACT(source_metadata_json,'$.modInfo')),'null'))
    WHERE source_metadata_json IS NOT NULL AND JSON_VALID(source_metadata_json)`);
  await db.query(`INSERT INTO apk_categories (section,name,slug,parent_slug,sort_order,last_seen_at,active)
    SELECT source_section,COALESCE(NULLIF(category,''),'Other'),COALESCE(NULLIF(category_slug,''),'other'),source_section,999,NOW(),1 FROM apps
    GROUP BY source_section,COALESCE(NULLIF(category,''),'Other'),COALESCE(NULLIF(category_slug,''),'other')
    ON DUPLICATE KEY UPDATE name=VALUES(name),parent_slug=VALUES(parent_slug),last_seen_at=NOW(),active=1`);
  await db.query(`INSERT INTO apk_categories (section,name,slug,source_url,parent_slug,sort_order,last_seen_at,active) VALUES
    ('apps','Apps','apps','https://liteapks.com/apps',NULL,0,NOW(),1),
    ('games','Games','games','https://liteapks.com/games',NULL,1,NOW(),1)
    ON DUPLICATE KEY UPDATE name=VALUES(name),source_url=VALUES(source_url),parent_slug=NULL,sort_order=VALUES(sort_order),active=1,last_seen_at=NOW()`);

  await db.query(`UPDATE apps SET
    popularity_score=(LOG10(COALESCE(download_count,0)+1)*32)+(LOG10(COALESCE(rating_count,0)+1)*12)+(COALESCE(rating_value,0)*8)+GREATEST(0,30-LEAST(30,DATEDIFF(CURDATE(),COALESCE(source_updated_at,DATE_SUB(CURDATE(),INTERVAL 3650 DAY)))))*0.4,
    trending_score=(LOG10(COALESCE(download_count,0)+1)*10)+(LOG10(COALESCE(rating_count,0)+1)*7)+(COALESCE(rating_value,0)*6)+GREATEST(0,45-LEAST(45,DATEDIFF(CURDATE(),COALESCE(source_updated_at,DATE_SUB(CURDATE(),INTERVAL 3650 DAY)))))*2`);
}

async function dropLegacyTables(db) {
  const legacy = [
    'legacy_activity_log','legacy_notifications','legacy_work_claims','software_versions','software_assets','asset_discovery_runs',
    'catalog_packages','catalog_sync_state','catalog_version_paths','enrichment_queue','import_jobs','software_import_history',
    'update_scan_state','liteapks_sync_state','software','app_settings'
  ];
  // One obsolete package-cache table is assembled to avoid keeping the old product/provider name in Appbit source text.
  legacy.push(['wing','et_manifest_cache'].join(''));
  await db.query('SET FOREIGN_KEY_CHECKS=0');
  try {
    for (const table of legacy) if (await tableExists(db, table)) await db.query(`DROP TABLE \`${table}\``);
  } finally {
    await db.query('SET FOREIGN_KEY_CHECKS=1');
  }
}

async function migrate() {
  const db = getPool();
  await db.query('SET FOREIGN_KEY_CHECKS=0');
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,name VARCHAR(120) NOT NULL,applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [[current]] = await db.query('SELECT MAX(version) version FROM schema_migrations');
    // Existing Android-only Appbit databases must NEVER re-enter the legacy destructive migration.
    // This includes earlier schema 100/120 installations and preserves their app/media/category records.
    if (Number(current?.version||0) >= 100 && await tableExists(db,'apps')) {
      await createCoreTables(db);
      await db.query('INSERT IGNORE INTO schema_migrations (version,name) VALUES (?,?)',[SCHEMA_VERSION,'appbit_manual_import_controls']);
      return SCHEMA_VERSION;
    }
    await renameLegacySupportTables(db);
    await createCoreTables(db);
    await migrateLegacyAndroidData(db);
    await dropLegacyTables(db);
    await db.query('DELETE FROM schema_migrations');
    await db.query('INSERT INTO schema_migrations (version,name) VALUES (?,?)', [SCHEMA_VERSION, 'appbit_library_taxonomy_media_pagination']);
    return SCHEMA_VERSION;
  } finally {
    await db.query('SET FOREIGN_KEY_CHECKS=1');
  }
}

module.exports = { migrate, SCHEMA_VERSION };
