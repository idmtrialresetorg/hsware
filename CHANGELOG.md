# HSWare Studio Changelog

## 4.6.0

### LiteAPKs Android download-flow tracking
- Desktop Software / WinGet code and UI remain unchanged.
- Android records now discover and retain the current LiteAPKs `/download/...` landing page separately from the app detail page.
- The public LiteAPKs download landing page is re-read for version, file size, and APK/XAPK/APKS type so Android publishing data matches the download entry more closely.
- Original Google Play links are now taken only from links LiteAPKs actually exposes; HSWare no longer invents a Play Store URL from a package ID fallback.
- APK update detection now also flags meaningful file-size or download-page changes, not only a higher version string.
- Added a Refresh-and-Download action that re-checks LiteAPKs before opening the current download target. A plain APK-family URL is used only when it is publicly exposed without bypassing LiteAPKs ad/timer/token/anti-bot gates; otherwise the current LiteAPKs download page is opened.
- Kept downloadable icon, individual screenshots, and the icon+screenshots ZIP media pack.
- Simplified Android list rows so they no longer show noisy raw direct-link helper text.
- Bumped Android metadata revision to 7 so existing APK records refresh once after upgrade.
- No database migration is required; schema version remains 20.

## 4.5.0

### Focused Android APK details and downloadable media
- Left the Desktop Software / WinGet workflow and its detail renderer unchanged.
- Simplified Android APK details to the requested publishing fields only: app name, version, app size, required Android version, APK license/type, user rating, download count, original Google Play link, and direct APK-family file URL when the source page exposes one plainly.
- Removed LiteAPKs source-page links and unrelated publisher/category/package/system-requirement fields from the user-facing Android APK detail workspace.
- Improved LiteAPKs parsing for app icons, screenshots, ratings, Play Store links, and MOD labels such as Free, MOD APK, Pre-Activated, Unlimited Money, Premium/Pro Unlocked, and Unlocked APK.
- Added authenticated server-side icon and screenshot downloads. Remote assets are fetched through the existing public-URL/SSRF guard and validated as raster image data before being returned.
- Added a one-click ZIP media pack containing the APK icon and available screenshots, with bounded file counts and size limits.
- Android list rows now show the concise APK publishing metadata instead of the previous mixed source metadata.
- Direct APK download links are accepted only when a normal `.apk`, `.xapk`, or `.apks` URL is exposed directly in the fetched app detail metadata. HSWare does not crawl or bypass intermediate token, advertisement, access-control, or anti-bot download flows and does not proxy/mirror APK binaries.
- Bumped the Android metadata revision to 6 so existing v4.4 Android records automatically queue one refresh and gain the focused v4.5 fields/media metadata after upgrade.
- No database migration is required. v4.5.0 continues to use schema version 20 and stores the new Android-only metadata in the existing `source_metadata_json` field.

## 4.4.0

### Separated Desktop and Android workspaces
- Replaced the mixed New Software / Published Software / Software Updates sidebar items with two parent workspaces: **Desktop Software** and **Android APK**.
- Desktop Software contains three tabs: **New Software**, **Published Software**, and **Software Updates**.
- Android APK contains three tabs: **New APK**, **Published APK**, and **APK Updates**.
- Desktop screens are hard-filtered to `platform_key=windows`; Android screens are hard-filtered to `platform_key=android`, preventing cross-platform records from mixing in the UI or API results.
- Split dashboard counters and priority queues by platform.
- Split manual import controls: WinGet only inside Desktop Software and LiteAPKs only inside Android APK.
- Split update scans into independent persisted Windows and Android scan queues. Running an APK update scan cannot scan WinGet records, and vice versa.
- Split Admin Clear New behavior by platform so clearing Android cannot remove Desktop records or stop a WinGet bulk-import job.
- Preserved the existing HSWare component styling, buttons, panels, filters, modals, light/dark modes, responsive sidebar, work locks, activity, notifications, and publishing workflow.
- Reduced navigation redraws when moving between workspace tabs to avoid visible content flashing.
- No database schema change; v4.4.0 continues to use schema migration 20. Existing v4.3.1 data is reused as-is.

## 4.3.1

- Fixed MySQL/MariaDB `ER_TOO_BIG_ROWSIZE` during migration 20 on existing HSWare databases.
- Converts legacy unindexed wide URL/requirement `VARCHAR` columns in `software` to `TEXT` before adding LiteAPKs source fields.
- Uses `TEXT` for the new source page URL columns.
- The repair is non-destructive and also recovers databases where the v4.3 migration stopped partway through.

## 4.3.0

### Android / LiteAPKs source
- Added Android as a first-class platform while preserving the existing Windows/WinGet workflow.
- Added LiteAPKs as the only Android source requested for this release; no F-Droid or Google Play provider is included.
- Added schema migration 20 with source/platform identity fields and a persistent `liteapks_sync_state` table. Existing Windows records are migrated to `platform_key=windows` and `source_type=winget` without changing their Package IDs.
- Added a 24-hour LiteAPKs metadata worker. The first run attempts a full sitemap-based discovery and falls back to public listing pagination; later runs scan recent listing pages for new/updated apps.
- LiteAPKs Android records are automatically added to New Software and refreshed from their source page. Managed records participate in the existing update scanner.
- Added Android/Windows platform counts, platform filters, source badges, Android-aware details, source-page links, and LiteAPKs manual import/search controls.
- Added Admin “Sync LiteAPKs Now” control and sync progress/error state.
- The LiteAPKs integration intentionally uses standard public HTTP requests only. It does not bypass Cloudflare/anti-bot controls.
- HSWare stores LiteAPKs page metadata and source-page references; it does not mirror or automatically redistribute third-party APK binaries.

### Release / compatibility
- Bumped application/runtime/backup metadata to 4.3.0.
- Schema migration 20 is additive and preserves existing users, Windows software, publishing state, history, backups, activity, notifications, and work claims.

## 4.2.0

### Security
- Pinned transitive dependency `brace-expansion` to `>=5.0.8` via a new `overrides` (and `resolutions`) entry in `package.json`, resolving a denial-of-service vulnerability where a small crafted brace-pattern input (e.g. `'{a,b}'.repeat(1500)`, ~7.5 KB) could exhaust process memory and crash Node with an uncatchable out-of-memory error. `brace-expansion` is not a direct dependency of HSWare; it is pulled in transitively (commonly via `minimatch`/`glob`). The override forces the patched version regardless of which package introduces it.
- No application code changes were required for this fix; run `rm -rf node_modules package-lock.json && npm install` after upgrading to regenerate a lockfile that honors the override, then confirm with `npm ls brace-expansion`.

### Release / compatibility
- Bumped package, runtime, UI badge, cache-busting, backup metadata, and GitHub User-Agent versions to 4.2.0.
- No database schema change: v4.2 continues to use schema migration 19.

## 4.0.0

### Activity Log Dashboard
- Turned the existing server-side `activity_log` into a visible Dashboard Recent Activity feed.
- Added a full Activity Log modal with search, action filters, Admin user filters, timestamps, software/Package ID context, and bounded pagination.
- Default activity feeds intentionally exclude high-frequency temporary lock open/close events so the operational history remains useful.
- Partners see workspace-relevant history while Admin can inspect the complete meaningful audit feed.
- Added server-side activity records for Auto Import completion and Update Scan start/completion.

### Notification Center
- Added schema migration 19 and a new `notifications` table with per-user unread/read state.
- Added a top-bar notification bell with unread count, persistent history, individual Read actions, and Mark all as read.
- Added lightweight 15-second notification polling and HSWare-styled live toasts for new notifications.
- Added server-generated completion notifications for Auto Import and Update Scan.
- Added `requested_by` / `completion_notified` metadata so long-running job alerts remain reliable when the initiating browser is closed and are emitted only once.
- Important Partner import/publish/update actions can notify Admin.
- New/updated/enabled Partner accounts receive account notifications.
- Manual/automatic backup completion and restore actions can notify Admin.
- Notification history is bounded per user to prevent unbounded growth.

### Sidebar profile card
- Preserved the v3.10 edge-to-edge 1:1 profile image and identity/logout layout.
- Removed the black/drop shadow from `.profile-card` completely with `box-shadow:none`.
- No other sidebar/dashboard styling was redesigned for this fix.

### Release / compatibility
- Bumped package, runtime, UI badge, cache-busting, backup metadata, and GitHub User-Agent versions to 4.0.0.
- Updated README, Hostinger deployment guide, environment template, login version text, and synchronized `dist/` runtime/client files.
- Schema migration 19 is additive/non-destructive and preserves existing Admin/Partner accounts, software data, version history, publishing state, backups, activity history, and temporary work locks.

## 3.10.0

### Temporary open-lock workflow
- Replaced the persistent work-claim UX with a temporary lock that exists only while the software details window is active.
- Removed `Resume` from software list actions; available records always use `Open`.
- Removed the normal `Release Work` button from the software details toolbar.
- Closing the details window with X automatically releases the current user's lock in one click.
- Publishing and both logout paths automatically release owned locks.
- Added a 30-second heartbeat with a default 90-second stale-lock timeout so browser crashes, sleep, or lost connectivity cannot leave a permanent lock.
- Added `WORK_LOCK_TIMEOUT_SECONDS` (60–300 seconds, default 90) for deployment tuning.
- Added lightweight `/api/work-claims` synchronization every five seconds so another signed-in browser can change from Locked back to Open without reloading the full software catalog.
- Preserved the database-level unique `software_id` lock guarantee and Admin emergency Force Release / Take Over controls.

### Sidebar account card
- Removed all inner padding/margin around the profile media area.
- Changed the profile image to a full-width 1:1 edge-to-edge block at the top of the existing card.
- The outer profile card now provides the rounded top corners; the image itself has no inner border or radius that creates blank strips.
- Kept the existing name, email, Logout action, HSWare colors, typography, spacing tokens, and sidebar structure unchanged.
- Initials fallback now fills the same full-width 1:1 media area when no profile image exists.

### Release / compatibility
- Bumped package, runtime, UI badge, cache-busting, backup metadata, and GitHub User-Agent versions to 3.10.0.
- Updated README, Hostinger deployment notes, environment template, and synchronized `dist/` runtime/client assets.
- No database schema migration: v3.10 continues to use schema 18 and preserves existing Admin/Partner accounts and software data.
- Dashboard, navigation, imports, Settings, permissions, publishing data, and all unrelated UI components remain unchanged.

## 3.9.0

### Sidebar account card
- Rebuilt only the signed-in account card at the bottom of the existing sidebar.
- Changed the authenticated profile photo from a small circular avatar to a 150 × 150 pixel rounded-square image.
- Moved name and email into a dedicated lower information block.
- Replaced the floating role badge with a cleaner identity presentation; Admin/Partner permissions and role logic are unchanged.
- Added a full-width Logout row with the existing HSWare logout icon/action.
- Long names and email addresses wrap safely instead of being compressed into the old horizontal footer.
- Initials fallback remains available when an account has no uploaded profile image.

### Design-system preservation
- Uses the existing HSWare `--surface`, `--surface-soft`, `--hairline`, `--ink`, `--muted`, and `--primary` tokens.
- Does not add a new dashboard palette, gradient/glow theme, navigation layout, or unrelated component styling.
- Dashboard, Smart Software Import, New Software, Published Software, Software Updates, Settings, and Team & Access layouts are unchanged.

### Release / documentation
- Bumped application/package/runtime/cache-busting version to 3.9.0 (interface badge v3.9).
- Updated GitHub request User-Agent and JSON backup application version metadata to 3.9.0.
- Updated shipped `dist/` UI/runtime copies so deployments do not retain the old v3.8 account card.
- Expanded README with product purpose, full workflow, architecture, roles, collaboration, database, security, deployment, interface tokens, and the v3.9 card specification.
- No database schema change: v3.9 continues to use migration/schema 18.

## 3.8.0

### Admin + Partner accounts
- Added exactly two application roles: Admin and Partner.
- Added real database-backed names, email login, role, active status, last login, and profile photos.
- Added Partner creation and management inside Settings → Team & Access; no separate Users navigation tab.
- Added Admin profile editing for name, email, password, and profile photo.
- Added Partner enable/disable and password reset through Admin Settings.
- Removed hard-coded account name/photo from the sidebar.

### Permissions
- Partners retain the complete software workflow: Dashboard, New Software, Smart Auto/Manual Import, publishing, Published Software, and Software Updates.
- Settings, Database Health, Partner management, backup/restore, software-data reset, force release, and takeover are Admin-only.
- Admin-only restrictions are enforced by Express middleware/API checks, not only by hidden UI controls.
- Disabled Partner sessions are rejected on the next request.

### Duplicate-work protection
- Added `software_work_claims` with one unique owner per software record.
- Opening software claims it atomically for the current Admin/Partner.
- Added 30-second work heartbeat while the details window is active.
- Claims stay persistent when the modal is closed and are removed on Publish or explicit Release Work.
- Other users receive HTTP 423 Locked with the current owner's name/role.
- Admin can Force Release or Take Over another user's claim.
- Disabling a Partner releases that Partner's active claims.

### Audit and schema
- Added schema migration 18.
- Added `activity_log` for important login, account, import, publishing, backup, and claim events.
- Existing v3.7.8 software/library data is preserved during migration.

### UI and deployment
- Preserved the corrected Manual Import result card layout and sidebar profile layout.
- Added Team & Access UI to the existing Settings screen.
- Added dynamic Admin/Partner profile cards and initials fallback avatars.
- Updated asset versioning to v3.8.0 and included synchronized runtime client assets to prevent stale v3.7.8 UI files.
- Updated README, Hostinger deployment notes, environment template, and version metadata.
