# Appbit deployment

Appbit uses Astro in server mode with an Express runtime wrapper.

## Runtime

- Node.js: 22–24
- Build command: `npm run build`
- Start command: `npm start`
- Runtime entry: `dist/run-server.mjs`
- Database: MySQL or MariaDB

## Environment

Create the variables shown in `.env.example`, using production values for the session secret, administrator credentials, and database connection.

Recommended production database identity:

- Database: `appbit`
- User: `appbit_user`

Set `TRUST_PROXY=1` when the application is behind the hosting platform reverse proxy.

## Build and deploy

```bash
npm install
npm run check
npm run build
npm start
```

The build copies the Appbit backend services and views into `dist/` after Astro generates its server bundle.

## Existing database migration

On first startup, Appbit upgrades the schema to the Android-only baseline. Compatible Android records are migrated to the new APK tables. Create a database backup before deploying the first Appbit build to an existing installation.
