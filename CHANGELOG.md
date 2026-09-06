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
