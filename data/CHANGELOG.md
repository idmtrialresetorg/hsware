# Changelog

## 1.1.0 — Dark workspace and manual resolver controls

- Applied the v1.1 workspace changes to the full `dist/` production runtime as well as source files.
- Fixed sidebar class/layout regression.
- Removed light mode and rebuilt the workspace as dark-only.
- Added Update Center and compact app cards.
- Disabled automatic LiteAPKs discovery.
- Added import/update quantity limits and explicit Stop controls.
- Reworked backup upload/restore UI and latest-backup download action.


## 1.0.1

- Restored the Android resolver version-comparison utility required by `apk-resolver.js`.
- Strengthened project checks to detect missing local module imports, not only JavaScript syntax.
- Added a clean source-package release layout without generated `dist/` duplication.

## 1.0.0 — Appbit Android-only baseline

- Renamed the product to **Appbit** and the workspace to **APK Publishing Workspace**.
- Replaced the previous brand assets with the Appbit logo and favicon.
- Removed the legacy non-APK package resolver, package catalog/import pipeline, installer metadata, and related routes/services.
- Removed the obsolete package-manifest dependency.
- Renamed the Android resolver and media services to `apk-resolver.js` and `apk-media.js`.
- Rebuilt the API around APK apps, APK versions, APK media, update checks, and publishing.
- Added a clean Android-only schema baseline with migration of compatible existing Android records.
- Rebuilt the dashboard navigation around Dashboard, APK Library, Publishing, and Settings.
- Kept the existing light/dark theme engine intact.


## Appbit 1.2.3 — UI and Manual Import Hotfix (release candidate)

Product version retained. Application changes, not a framework conversion:

- App detail and Add APK now use routable full pages (`/apps/:id`, `/library/add`) with history/back navigation. Existing work claims are released when leaving a detail page.
- Removed the four top summary blocks; added Updated Date to APK Metadata. Only a verified Google Play Store URL is displayed as the official store link. Added Description copy. Internal source URL is retained for resolution but not displayed as a source link.
- Moved manual LiteAPKs batch controls into App Library. Added5/10/20/custom quantity, mode selection, progress, Start and Stop; no unsolicited import startup.
- Fixed the discovery/worker Stop race using run IDs, state guards, and abort signals. Access restrictions/verification pages pause the queue without bypass attempts. Metadata-only imports no longer invoke the final-file Chromium resolver.
- Added per-app media refresh with an identity check and transactional replacement of only successfully discovered artwork types. Missing or failed source media does not erase saved artwork.
- Persisted category-fetch state, reuse of existing saved categories, explicit refresh/retry, and descendant-aware category filtering. Failed/partial crawls retain existing taxonomy. Completeness is not certified without authoritative source evidence.
- Updated App Library controls and flat dark panel/detail CSS for consistent borders and responsive layout.
- Preserved existing database records, published states, Docker/Compose configuration, Astro+Express, authentication, team, backup and settings systems. Schema123 adds nullable run IDs only for existing Android databases.

See TEST-REPORT.md for exact testing limits and CHANGE-MANIFEST.json for file hashes.
