# Appbit

**APK Publishing Workspace**

Appbit is an Android-only publishing workspace for resolving APK app metadata, managing media and versions, checking updates, and moving app records through a publishing queue.

## Product scope

Appbit intentionally supports Android APK workflows only. Its runtime is organized around:

- Dashboard
- APK Library
- Publishing
- Settings
- APK Resolver Engine
- APK metadata and media management
- APK version/update management
- User authentication and team controls
- JSON backups and restore

## Core services

- `src/services/apk-resolver.js` — discovers and refreshes Android app metadata from the configured public APK source.
- `src/services/apk-media.js` — handles app icons, screenshots, and media downloads.
- `src/services/apk-updates.js` — checks managed APK records for newer versions.
- `src/services/publishing.js` — manages publishing state and queue entries.
- `src/services/app-claims.js` — protects app editing work with short-lived user claims.

## Database

Schema version `100` is the Android-only Appbit baseline. Main tables are:

- `apps`
- `apk_versions`
- `apk_media`
- `apk_metadata`
- `publish_queue`
- `apk_sync_state`
- `apk_update_state`
- `users`
- `settings`
- `activity_log`
- `notifications`
- `app_work_claims`
- `backup_history`

The migration preserves compatible Android records from an older mixed installation, then removes obsolete legacy tables.

## Local setup

1. Install Node.js 22–24 and MySQL/MariaDB.
2. Copy `.env.example` to `.env` and set the database and administrator credentials.
3. Install dependencies with `npm install`.
4. Run `npm run check`.
5. Run `npm run dev` for development.

For production:

```bash
npm run build
npm start
```

The production entry point is `dist/run-server.mjs`.

## Branding

The Appbit brand asset is `public/logo.svg`. The same supplied mark is used for the favicon and generated application icons.

## Theme

Appbit now ships with a dark-only workspace. The light-mode toggle and light UI path have been removed.


## Appbit 1.1 UI and resolver controls

- Dark-only workspace inspired by the supplied design system.
- Fixed sidebar navigation layout and enlarged Appbit logo.
- Added Update Center.
- App Library uses compact card grids with bottom Open actions.
- LiteAPKs discovery is manual-only with 5/10/20/custom import limits and Stop.
- Update scans are manual-only with a per-run limit and Stop.
- Backup create/download/upload/restore controls are grouped in Settings.


## UI and manual import hotfix

The App Library contains routed app/Add pages, per-app media refresh, saved category navigation, and manual source-batch controls. Existing source metadata remains internal for resolution; the official-link UI shows only verified Play Store links. The source fetcher pauses on access restrictions and does not guarantee that an unavailable source can be accessed.

The product version remains1.2.3 pending a live deployment acceptance test. See TEST-REPORT.md and CHANGE-MANIFEST.json before redeployment.

## Application detail correction (1.2.3)

App records open at `/apps/<readable-name>-<id>`, for example `/apps/binance-7`. The ID suffix is the permanent database key and avoids collisions without a schema migration. The old numeric URL remains supported. Detail pages show cover, metadata, Google Play link, media, description, screenshots, and prior versions. Copy All excludes the source page and file URLs. Final APK download resolution has been removed from the API and UI.

Refresh, Logo Refresh, Screenshot Refresh and Refresh Cover operate on the selected app. Saved artwork is retained if the source reports no replacement. Source-returned URLs are not a guarantee that the external image host is accessible; errors are reported rather than bypassed.

The full Docker/Astro/Express structure is preserved. The current product version remains 1.2.3. See TEST-REPORT.md and CHANGE-MANIFEST.json before deployment.
