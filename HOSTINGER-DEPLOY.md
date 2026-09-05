# HSWare Studio v4.6.0 — Hostinger deployment

## Upgrade from v4.4.0

1. Download/create an HSWare JSON backup from the current Admin Settings screen.
2. Keep the existing MySQL database and all production environment variables.
3. Upload/extract HSWare Studio v4.6.0 over the current v4.4.0 application files.
4. In the Hostinger Node application terminal run:

```bash
npm install
npm run check
npm run build
```

5. Restart/redeploy the Node application.
6. Open `/health` while signed in as Admin and verify **Schema version 20**.
7. Hard-refresh the browser once if an older cached client is still visible.

## Database compatibility

v4.6.0 adds **no new database migration**. It continues to use **schema version 20**, so the existing v4.4.0 database, Desktop Software records, Android records, users, publishing state, history, backups, activity, notifications, and work locks are reused as-is.

Android publishing values such as APK type, rating, Play Store URL, LiteAPKs download-page URL, icon URL, screenshot URLs, and any publicly exposed plain APK-family URL are stored inside the existing `software.source_metadata_json` JSON field.

## v4.5 Android APK behavior

- Desktop Software/WinGet code path and desktop detail layout remain unchanged.
- Android APK details show only the focused publishing fields required for the APK workflow.
- LiteAPKs source-page URLs remain internal and are not shown as the Android publishing/download link.
- Icons and screenshots are downloaded through authenticated HSWare endpoints instead of opening remote image links.
- **Download Media ZIP** downloads the icon plus available screenshots in one archive.
- Image fetches retain HSWare's SSRF/public-network validation, redirect validation, timeout limits, file-size limits, and raster-image validation.
- The APK Download button refreshes the LiteAPKs app page and current `/download/...` landing page before opening the current target. If LiteAPKs exposes a plain `.apk`, `.xapk`, or `.apks` URL publicly, HSWare uses it; otherwise it opens the current LiteAPKs download landing page. HSWare does not bypass timer/ad/token/anti-bot gates or proxy APK binaries.
- Existing Android records with the older metadata revision are automatically queued for refresh as they are opened/processed, so the new icon/screenshots/rating/Play Store fields can populate.
- No table rebuild or data conversion is required when upgrading from v4.4.0.

## v4.4 workspace behavior

- Sidebar: Dashboard, Desktop Software, Android APK, then existing Admin/System controls.
- Desktop Software tabs: New Software, Published Software, Software Updates.
- Android APK tabs: New APK, Published APK, APK Updates.
- Platform filtering is enforced server-side, not only visually.
- Windows and Android update scans use separate persistent scan keys.
- Clearing New Software/New APK affects only the selected platform.

## v4.0 behavior changes

- Dashboard now shows Recent Activity from the real server-side `activity_log`.
- `View All Activity` opens a searchable/filterable activity viewer.
- The top bar now includes a notification bell and unread counter.
- Persistent notifications can be marked individually or all at once.
- Notification state is polled every 15 seconds; new notifications can appear as HSWare toasts without a page reload.
- Background Auto Import completion notifications are produced by the server even if the browser that started the import is closed.
- Update Scan completion is recorded and notified once per scan.
- Important Partner software actions notify Admin.
- Automatic/manual backup completion can notify Admin.
- The sidebar profile card keeps the existing edge-to-edge image but removes the black/drop shadow (`box-shadow:none`).

## Hostinger settings

| Setting | Value |
| --- | --- |
| Framework preset | Astro |
| Node version | 24.x |
| Root directory | `./` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Entry file | `run-server.mjs` |

The normal process is:

```bash
npm install
npm run check
npm run build
npm start
```

`npm run build` generates Astro server output and `scripts/prepare-runtime.js` copies the Express runtime files into `dist/`.

## Required environment

Keep your current database/account values. A production configuration normally includes:

```env
NODE_ENV=production
SESSION_SECRET=replace-with-a-long-random-secret
ADMIN_NAME=Administrator
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-this-password

DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=hsware
DB_USER=hsware_user
DB_PASSWORD=your_database_password
DB_SSL=false

GITHUB_TOKEN=
CATALOG_TARGET=50000
TRUST_PROXY=1
WORK_LOCK_TIMEOUT_SECONDS=90
```

Do not upload a real production `.env` file into a public Git repository.

## LiteAPKs Android sync

HSWare v4.3 includes a server-side Android metadata sync from `https://liteapks.com/`. No extra API key is required. Optional tuning variables are:

```env
LITEAPKS_DAILY_PAGES=8
LITEAPKS_FULL_PAGES=80
LITEAPKS_MAX_ITEMS=50000
LITEAPKS_REQUEST_GAP_MS=1400
```

The worker uses normal public HTTP requests only. The first sync tries to discover the full LiteAPKs catalog from its sitemap. Daily refreshes prefer sitemap `lastmod` entries from the previous few days and fall back to the configurable recent listing-page crawl. If LiteAPKs returns an access/rate-limit response, HSWare records the error and retries later rather than attempting to bypass the site's protection.
