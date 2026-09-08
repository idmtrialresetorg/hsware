# Appbit — UI and Manual Import Hotfix: Verification

Release identity: existing VERSION 1.2.3 retained. The database migration number is 123 and is not the product version.

## Completed checks

- 13 focused Node tests passed (7 backend/source/data tests and 6 UI DOM-interaction tests).
- `node scripts/check-files.js` passed: JavaScript syntax and relative module-resolution checks.
- New source and update worker modules pass `node --check`.
- Source and packaged backend/frontend copies are synchronized; see CHANGE-MANIFEST.json.
- Original deployment/framework files are hash-identical to the uploaded base; see CHANGE-MANIFEST.json.
- ZIP CRC integrity verified.

## Not completed / not claimed

- Fresh npm dependency installation and Astro compiler build: the execution environment could not reach the npm registry.
- Live MySQL migration, existing 1,853-record count, or live import against your database: no access to your local Docker/MySQL instance.
- End-to-end Docker/Komodo startup or GitHub deployment: no access to your local engine/repository write session.
- Real LiteAPKs category completeness or successful HTTP403 access: source access is unavailable/restricted. The importer now reports and pauses on restrictions rather than claiming to bypass them.
- Browser pixel/layout validation: attempted, but managed Chromium policy blocked local and synthetic navigation. CSS changes are included but their visual result must be checked on your PC.

## Deployment acceptance checklist

Before changing the live stack, create and download an Appbit backup and keep a copy outside Docker. In Komodo, redeploy the same stack after updating the GitHub repository. Do not destroy the stack or remove volumes. After startup, verify the database health/schema, direct `/apps/7` routing with a real app ID, category page counts, description copy, one-app media refresh, manual import5 with Stop, and a deliberately small source request. A403 should pause with an explanatory message; it is not a successful import.

Do not promote this candidate to a new version until these live acceptance checks pass.
