# Appbit 1.2.3 — Detail Page Correction

This corrects the earlier incomplete UI hotfix. It is not a new product-version release. The original uploaded Docker/Astro/Express deployment is retained.

## Application detail

- Native, full-page app workspace at a readable canonical route such as `/apps/binance-7`. The numeric suffix is the permanent database ID, so duplicate names cannot collide. Existing numeric URLs still work and resolve to the canonical route. The API supplies `slug` and `url` from existing data; no destructive database rewrite is needed.
- App Library cards use ordinary links, supporting browser history, direct links, refresh, and opening in another tab. Add APK remains a routed form, not a modal.
- Rebuilt detail markup and a dedicated `.record-*` CSS layout: header with icon/name/version/status/actions, cover, metadata, official links, media, description, screenshots, and previous versions. The design uses the supplied reference's compact dark cards, restrained borders, and blue actions without copying its desktop-only modules.
- Removed the four Readiness/Version/Type/Updated summary boxes. The update date is within metadata. Current version appears once in metadata, and the current release is excluded from Previous Versions.
- Header actions: Copy All, Publish/Unpublish, Refresh, Logo Refresh, Screenshot Refresh, Back. Cover and gallery also have individual refresh actions. Description has a copy button.
- Only a verified Google Play Store URL is presented as the official store link. The source-page link is not displayed or included in Copy All.
- Removed final APK download UI, its API endpoint, browser resolver module, and unused final-file parser. No new direct-download URL is resolved during metadata import. Existing historical records and release-page metadata are retained; the Docker dependency configuration is deliberately not changed in this UI correction.
- Individual media refresh accepts selected artwork kinds. It updates only the requested types transactionally, preserves unavailable existing artwork, and rejects concurrent refreshes on the same app. The response distinguishes source-returned metadata from retained artwork; no new image is falsely reported as downloaded.
- Prevents a completed asynchronous refresh from replacing a different page after the user navigates away.

## Preserved from the earlier hotfix

The Android-only database, category hierarchy and saved fetch state, 20-record server-side pagination, manual import and Stop, HTTP403 pause behavior, Update Center, publishing, backup system, and existing authentication are retained. This correction does not claim to have re-fetched your live category catalog or repaired source-side access restrictions.

## Deployment

The existing Dockerfile, Compose file, environment template, root server entry, Astro configuration, Node/Astro/Express dependencies, and production launcher remain unchanged. The only package.json change removes the deleted resolver file from the `npm run check` command. Source and packaged runtime copies are synchronized. The existing product VERSION remains 1.2.3.

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
