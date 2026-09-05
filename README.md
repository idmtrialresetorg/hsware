# HSWare Studio v4.6.0

HSWare Studio is a private software research, publishing, collaboration, and update-management workspace. **Desktop Software remains on the existing Microsoft WinGet workflow.** Android APK metadata is sourced from LiteAPKs and refreshed by the existing Android sync worker.

HSWare is **not** a public download website and it does not automatically publish pages to an external CMS. It is the internal operations layer used before and during publishing.

## v4.6.0 — focused Android APK workspace

v4.6 continues to change only the Android APK workflow. The existing Desktop Software UI and WinGet workflow are preserved.

The Android APK detail screen is intentionally limited to the publishing data currently required:

- App name.
- Version.
- App size.
- Required Android version.
- APK license/type, including labels such as Free, MOD APK, Pre-Activated, Unlimited Money, Premium/Pro Unlocked, or Unlocked APK when the source reports enough information to identify them.
- User rating.
- Download count.
- Original Google Play Store link when it can be identified.
- Current LiteAPKs download target, refreshed from the app page and its public `/download/...` landing page; a plain APK-family URL is used only when LiteAPKs exposes one publicly without a gated flow.
- App icon.
- Screenshots.

Icon and screenshot controls are real HSWare downloads rather than links that simply open the remote image. HSWare fetches the image through its public-URL safety checks, validates the image bytes, and sends it to the signed-in user as a file. **Download Media ZIP** produces one ZIP containing the icon and all valid screenshots found for that APK.

The LiteAPKs page URL is retained internally because the daily sync/update engine needs it, but it is no longer shown as the Android APK publishing link. HSWare also does not attempt to bypass intermediate download pages, tokens, advertisements, access controls, or anti-bot mechanisms; an APK download button is shown only when a plain APK-family file URL is already exposed in the app detail metadata. APK binaries are not proxied or mirrored by HSWare.

The Android and Desktop workspaces remain hard-separated in the API and UI. Existing Android records are automatically queued for a one-time metadata revision refresh so the new v4.5 fields can populate. v4.6.0 requires **no database migration** and continues to use schema version 20.

## Why HSWare exists

A software-publishing workflow becomes difficult to manage when research, installer verification, version history, publishing status, and team ownership are spread across browser tabs, spreadsheets, messages, and memory. HSWare centralizes those jobs.

The product is designed around eight goals:

1. **Verified software identity** — prefer trusted WinGet package metadata and reject obvious package-identity mismatches.
2. **Useful publishing data** — collect installer URLs, SHA-256 hashes, architecture, installer type, publisher, version, website, file size, requirements, and previous versions in one place.
3. **Controlled workflow** — keep New Software, Published Software, and Software Updates separate and understandable.
4. **No duplicate team work** — allow only one active owner for a software record at a time.
5. **Operational safety** — protect administrative actions, backups, restores, and destructive controls behind the Admin role.
6. **Operational awareness** — show important events immediately through in-app notifications rather than forcing users to guess whether background work completed.
7. **Accountability** — keep a searchable Activity Log so Admin can see who imported, published, updated, or changed important workspace data.
8. **Practical deployment** — run as a compact Node/Express/Astro application backed by MySQL and deploy cleanly on Hostinger or a similar Node hosting environment.

## v4.0.0 release focus

Version 4.0 turns HSWare's existing audit data into a visible collaboration layer and adds a persistent notification center. The software research/import/publishing architecture remains the same; v4 focuses on making team activity understandable and background work harder to miss.

The release contains three primary changes:

1. **Activity Log Dashboard** — Dashboard now includes Recent Activity backed by the real `activity_log` table. A full Activity Log viewer supports search, action filters, user filters for Admin, date-range filters, timestamps, software/package context, and pagination. The feed intentionally prioritizes meaningful actions such as imports, publishing, updates, Partner management, backups, and resets instead of flooding the Dashboard with every heartbeat or mouse-level event.
2. **Notification Center** — every authenticated user gets a notification bell with unread count, persistent notification history, Read / Mark all as read controls, and lightweight 15-second polling for newly created notifications. Long-running Auto Import and Update Scan completion notifications are generated on the server, so the notification is still created even when the initiating browser is no longer open. Important Partner actions can notify Admin, and a newly created Partner receives a welcome notification on first sign-in.
3. **Sidebar profile-card shadow removal** — the v3.10 edge-to-edge profile card layout is preserved, but the dark/black drop shadow has been removed completely. The card now relies on the existing HSWare hairline border and surface colors only.

v4.0 adds **schema migration 19**. It creates the `notifications` table and adds request/completion ownership fields to long-running import/update state so completion alerts are reliable and de-duplicated. Existing users, profile images, software records, versions, published state, backups, and work locks are preserved.

## Core workflow

```text
Dashboard
   │
   ├── Desktop Software (WinGet)
   │      ├── New Software
   │      ├── Published Software
   │      └── Software Updates
   │
   └── Android APK (LiteAPKs)
          ├── New APK
          ├── Published APK
          └── APK Updates
```

### 1. Discovery and import

HSWare can discover packages from the `microsoft/winget-pkgs` repository and store a searchable local catalog. Manual Import is intended for exact package work, while Auto Import can process a much larger queue.

The import system supports:

- Exact WinGet Package ID searches.
- Manual import of a selected package.
- Automatic/bulk import up to the configured limit.
- Installer-type filtering for EXE, MSI, MSIX, APPX, and portable/archive packages.
- Curated-package preference and low-value package filtering during automatic selection.
- Persistent bulk-import jobs so browser closure does not erase the server-side queue.
- Package identity checks before accepting retrieved WinGet data.

### 2. Enrichment

Imported software can be enriched with data used by the publishing workflow, including:

- Package ID.
- Software name.
- Current version.
- Publisher/developer.
- Description.
- Official website.
- Direct installer URL.
- Installer type.
- Architecture.
- SHA-256.
- File size when available.
- License/language metadata when available.
- System requirements.
- Previous WinGet versions and historical installer data.

The enrichment worker runs on the server rather than depending on a browser tab remaining open.

### 3. Official-site inspection

HSWare can inspect a package's official URL for additional product details. Remote requests are guarded by URL validation and SSRF/private-network protections. Redirect targets are validated again, and responses are subject to time/size limits.

When official system requirements are unavailable, HSWare can provide clearly identified automatic fallback estimates. Estimated values are not intended to masquerade as vendor-published specifications.

### 4. Publishing workflow

Software starts in the New Software queue. A user opens the record, reviews the available metadata, copies what is required for the external publishing process, and then marks the record Published when the external work is complete.

Publishing is a workflow state inside HSWare; HSWare does not itself create the public software page on a third-party website.

### 5. Update monitoring

Published and new records can be checked against newer WinGet versions. HSWare stores the latest discovered version/update information and provides a Software Updates workspace for maintenance work.

## Accounts and roles

HSWare has exactly two application roles:

- **Admin** — the permanent system owner/administrator.
- **Partner** — a working team member who can use the complete software workflow.

The Admin can create and manage multiple Partner accounts from **Settings → Team & Access**. There is intentionally no separate Users sidebar page.

### Permission model

| Feature | Admin | Partner |
| --- | :---: | :---: |
| Dashboard | ✓ | ✓ |
| New Software | ✓ | ✓ |
| Smart Software Import | ✓ | ✓ |
| Auto Import | ✓ | ✓ |
| Manual Import | ✓ | ✓ |
| Open software with temporary lock | ✓ | ✓ |
| Review and copy software data | ✓ | ✓ |
| Mark Published / work with published records | ✓ | ✓ |
| Published Software | ✓ | ✓ |
| Software Updates | ✓ | ✓ |
| Mark software updated | ✓ | ✓ |
| Automatic release when software window closes | ✓ | ✓ |
| Settings | ✓ | — |
| Add / edit / disable Partners | ✓ | — |
| Database Health | ✓ | — |
| Backup / Restore | ✓ | — |
| Reset software data | ✓ | — |
| Force-release another user's claim | ✓ | — |
| Take over another user's claim | ✓ | — |

Permissions are enforced by Express middleware/API checks on the server. Hiding UI controls is not used as the security boundary.

## Team & Access

The Admin can:

- Create a Partner with full name, email, and password.
- Upload a JPG, PNG, or WEBP profile image up to 2 MB.
- Edit a Partner's name and email.
- Set a new Partner password without revealing the existing password.
- Disable or re-enable a Partner account.
- Edit the Admin's own name, email, password, and profile image.

The Admin role cannot be created from the normal Partner form, disabled, or converted into a Partner. HSWare keeps one owner account and any number of Partner accounts.

Passwords are bcrypt-hashed before storage. Plain-text passwords are not stored in MySQL or included in HSWare JSON backups.

## Duplicate-work protection

HSWare uses a database-backed **temporary open lock** to prevent two users from unknowingly working on the same software at the same time.

```text
Available software
      ↓
Admin or Partner clicks Open
      ↓
Atomic lock is created
      ↓
Other users see Locked · <user name>
      ↓
Owner closes X / publishes / signs out
      ↓
Lock is automatically removed
      ↓
Other users see Open again
```

`software_id` remains unique in `software_work_claims`, so the database itself is the concurrency boundary. Even if Admin and Partner click Open at nearly the same time, only one user can own the active row.

While the details modal remains open, the browser refreshes the lock every 30 seconds. The default stale-lock timeout is 90 seconds and can be adjusted with `WORK_LOCK_TIMEOUT_SECONDS` (clamped to 60–300 seconds). If a browser crashes, a device sleeps, or connectivity disappears without a normal close request, the stale row is removed automatically after the timeout instead of remaining permanently locked.

Closing the details modal now releases the user's lock automatically. The normal interface no longer contains **Release Work** or **Resume Work**. The list action is simply **Open** when available and **Locked** while another user actively has the record open.

A lightweight `/api/work-claims` feed is polled by the client every five seconds, allowing another logged-in Admin/Partner screen to switch from Locked back to Open without downloading the complete software catalog again. Admin retains emergency Force Release / Take Over controls for genuine stuck/conflict cases; Partners cannot force another user's lock.

Publishing removes the owner's lock as part of the publish operation. Both logout routes also remove every lock owned by the signing-out user. Disabling a Partner continues to release that Partner's active locks.

## Activity Log Dashboard

HSWare records important server-side workflow actions in `activity_log`. v4.0 exposes that history directly in the interface instead of keeping it as backend-only audit data.

### Dashboard Recent Activity

The Dashboard shows the latest meaningful activity, including examples such as:

- Software imported manually.
- Auto Import started, stopped, or completed.
- Software published or moved back to New Software.
- Software marked updated.
- Update scan started/completed.
- Partner created, edited, enabled, or disabled.
- Backup created/restored.
- New Software cleared or software data reset.

Normal transient open/close lock activity can remain stored for diagnostics, but it is excluded from the default Recent Activity feed so the interface stays useful rather than noisy.

### Full Activity Log

`View All Activity` opens a searchable activity viewer. Admin can filter by user and action; Partners see workspace-relevant actions plus their own permitted history. Search supports user names, emails, software names, Package IDs, and action names. Pagination limits response size rather than requesting the complete history at once.

The audit record is written by the server after the corresponding API action succeeds, so the history is not dependent on client-side button text or browser state.

## Notifications

v4.0 adds a persistent notification system backed by MySQL.

The top bar contains a notification bell with an unread count. Opening it shows the newest notifications with type, title, message, actor, software context when relevant, timestamp, individual Read actions, and a Mark all as read control. A 15-second lightweight poll checks for newly created notifications; a fresh notification can also surface as an HSWare-styled toast without reloading the page.

Server-generated notification examples include:

- Auto Import completed, including imported and failed/rejected totals.
- Update Scan completed, including checked packages, updates found, and failures.
- Partner imported, published, unpublished, or marked software updated (Admin notification).
- Partner account created/updated/enabled (Partner notification).
- Manual or automatic backup completed.
- Backup restored.

Notifications are retained per user with a bounded history so the table cannot grow indefinitely from ordinary application use. Notification read state is private to the recipient.

Long-running jobs store `requested_by` and `completion_notified` metadata. This means the background Auto Import worker can complete after the user closes the browser and still create exactly one completion notification for the correct user. Update Scan uses the same de-duplication concept.

## Backup and restore

HSWare creates an automatic JSON workspace backup approximately every 24 hours while the server is running. Admin can also create, download, and restore backups from Settings.

Backups contain software workspace and version-history data. They intentionally do **not** contain:

- User passwords or password hashes.
- Profile images.
- Session secrets.
- Database credentials.
- GitHub tokens.
- Hostinger environment variables.
- Temporary software work claims.

Before restoring a backup, HSWare creates a safety backup of the current workspace.

## Application architecture

HSWare is **not a Ruby on Rails project**. The working runtime is:

- **Node.js 22–24** — application runtime.
- **Express 5** — HTTP server, sessions, authentication, APIs, security middleware, and application orchestration.
- **Astro 7** — application shell/build layer using the Node adapter in middleware mode.
- **Vanilla JavaScript** — primary browser-side application logic.
- **MySQL / InnoDB** — persistent software, user, import, backup, collaboration, activity, and notification data.
- **EJS** — login, health, and server-rendered fallback/error views.
- **bcryptjs** — password hashing.
- **Helmet / CSRF / rate limiting** — request and authentication protections.
- **YAML** — WinGet manifest parsing.
- **Cheerio** — controlled official-site metadata extraction.

The main browser workspace is concentrated in `public/ui/app.js` and `public/ui/app.css`. Express remains the application server and mounts the Astro handler after API/auth/database middleware.

## Server startup sequence

```text
Node starts
   ↓
Express application created
   ↓
Security / compression / logging middleware
   ↓
Session + CSRF handling
   ↓
Static client assets
   ↓
Health + authentication routes
   ↓
/api routes
   ↓
Database + active-user checks
   ↓
Astro application handler
```

After the server starts listening, HSWare initializes the database and starts the background enrichment, import, and backup workers.

## Database model

The application uses incremental schema migrations. v4.0.0 uses **schema migration 19**.

Important tables include:

- `users` — Admin/Partner authentication and profile data.
- `software` — main software records.
- `software_versions` — previous/historical versions.
- `catalog_packages` — discovered WinGet package catalog.
- `catalog_version_paths` — stored historical manifest paths.
- `catalog_sync_state` — catalog progress/state.
- `software_import_history` — import/deduplication history.
- `import_jobs` — persistent bulk-import job state.
- `enrichment_queue` — background enrichment work.
- `update_scan_state` — update-check progress.
- `winget_manifest_cache` — cached manifest data.
- `backup_history` — generated backup records.
- `app_settings` — application settings.
- `schema_migrations` — applied schema versions.
- `software_work_claims` — one-owner-at-a-time collaboration claims.
- `activity_log` — important user/workflow activity.
- `notifications` — recipient-specific persistent notifications and read state.

Migration 18 introduced Admin/Partner accounts and work claims. Migration 19 adds notifications plus `requested_by` / `completion_notified` fields used by Auto Import and Update Scan completion alerts. Existing v3.x software and account data remains compatible with v4.0.

## Interface and design system

HSWare uses a restrained application UI rather than decorative one-off styles. v4.0 preserves that rule and builds Activity/Notification components from the same tokens.

### Typography

- Body/UI: **Inter**.
- Package IDs, versions, hashes, and technical values: **JetBrains Mono**.

### Core brand and light-theme tokens

| Token | Value |
| --- | --- |
| Primary blue | `#0052ff` |
| Primary active | `#003ecc` |
| Canvas | `#ffffff` |
| Surface | `#ffffff` |
| Soft surface | `#f7f7f7` |
| Strong surface | `#eef0f3` |
| Hairline | `#dee1e6` |
| Main text | `#0a0b0d` |
| Body text | `#5b616e` |

### Dark-theme tokens

| Token | Value |
| --- | --- |
| Primary blue | `#0052ff` |
| Primary active | `#2e6bff` |
| Canvas | `#0a0b0d` |
| Surface | `#16181c` |
| Soft surface | `#111317` |
| Strong surface | `#1f2227` |
| Hairline | `#23262b` |
| Main text | `#ffffff` |
| Body text | `#a8acb3` |
| Muted text | `#8a8f98` |

### Shape system

The main radius scale is 4px, 8px, 12px, 16px, 24px, pill, and full-circle. Normal cards use the existing 16px application radius. Buttons generally use the pill radius. The outer profile card provides the rounding; the profile image itself remains an **edge-to-edge square media block** with no inner radius or padding. In v4.0 the profile card has **no drop shadow**.

### v4.0 signed-in profile card

The sidebar footer keeps the edge-to-edge 1:1 profile image introduced previously. v4.0 removes the black/drop shadow entirely so the card sits flat in the sidebar and is defined only by its surface and hairline border:

```text
┌────────────────────────────┐
│                            │
│      FULL-WIDTH IMAGE      │
│       1 : 1 crop           │
│   no side/top image gap    │
│                            │
├────────────────────────────┤
│ User Name                  │
│ email@example.com          │
│                            │
│ ─────────────────────────  │
│ ↪ Logout                   │
└────────────────────────────┘
```

The outer card owns the 16px rounding and clips the media cleanly. `.profile-media` has zero padding/margin, while `.profile-avatar` uses `width: 100%`, `aspect-ratio: 1 / 1`, `object-fit: cover`, and no inner border/radius. `.profile-card` explicitly uses `box-shadow: none`. The identity/logout body remains separate below the image, and the same media area is used for the initials fallback when no image exists.

## Security behavior

- Exactly two application roles exist: `admin` and `partner`.
- Admin-only APIs verify the authenticated user's current database role.
- Disabled users cannot continue using an old session.
- Partner accounts cannot access Settings, Database Health, backup/restore, reset, force release, or takeover APIs.
- Passwords are bcrypt-hashed with cost 12.
- Mutating requests require CSRF validation.
- Login requests are rate limited.
- Session cookies are HTTP-only, SameSite=Lax, and Secure in production.
- Profile-image uploads validate supported image types and file size.
- Remote official-site requests retain HSWare's SSRF/private-network protections.
- Production deployments should use HTTPS and a long random `SESSION_SECRET`.

## Environment variables

Use hosting environment variables for production secrets. `.env.example` contains placeholders only.

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

`ADMIN_NAME` is used for initial Admin creation on a fresh installation. Existing installations retain their database account and can edit the Admin profile from Settings. `ADMIN_PASSWORD` must be at least 10 characters for first-time Admin creation.

## Build and deployment

Recommended Hostinger configuration:

| Setting | Value |
| --- | --- |
| Framework preset | Astro |
| Branch | `main` |
| Node version | `24.x` |
| Root directory | `./` |
| Build command | `npm run build` |
| Package manager | `npm` |
| Output directory | `dist` |
| Entry file | `run-server.mjs` |

Normal deployment flow:

```bash
npm install
npm run check
npm run build
npm start
```

`scripts/prepare-runtime.js` copies the Express-side runtime (`src`, `views`, `data`, and `run-server.mjs`) into `dist/` after Astro creates the server build.

The release ZIP also includes synchronized v4.0 client/runtime files under `dist/` so an upload cannot silently serve the old v3.10 client/runtime assets. Running `npm run build` on the target server remains the recommended deployment path.

## Upgrade from v3.10.0 to v4.0.0

1. Create/download an HSWare JSON backup before replacing application files.
2. Keep the existing MySQL database and environment variables.
3. Replace the v3.10 application source with v4.0.0.
4. Run `npm install`.
5. Run `npm run check`.
6. Run `npm run build`.
7. Restart the Node application.
8. Migration 19 runs automatically during database initialization.
9. Hard-refresh the browser once if an older cached `app.js`/`app.css` is still visible.

Migration 19 is non-destructive. It preserves existing Admin/Partner accounts, profile images, software records, published state, versions, import history, backups, activity history, and temporary work-lock behavior. It only adds the notification table and completion-notification metadata required by v4.

## Release versioning

- Package/release version: **4.0.0**.
- Sidebar interface badge: **v4.0**.
- Database schema: **19**.

See `CHANGELOG.md` for release-specific changes and `HOSTINGER-DEPLOY.md` for concise deployment steps.


## Version 4.7.0

### Dashboard improvements
- Fixed missing Recent Activity loader in the dashboard workflow.
- Improved dashboard reliability when activity data is unavailable.

### LiteAPKs workflow
- Improved direct download link handling when LiteAPKs exposes a public APK/XAPK/APKS file URL.
- Download page URLs are no longer treated as direct links.
- Dynamic ad/timer protected links still require browser automation if the source does not expose the final file URL.

### Maintenance
- Updated project version metadata to 4.7.0.
