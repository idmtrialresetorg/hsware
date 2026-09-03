# HSWare Studio v15.0.0 - Cloudflare Edition

Architecture: Cloudflare Workers (vinext) + Hyperdrive + TiDB Cloud Starter (MySQL compatible) + R2 backups + Cron LightWave.

## 1. Create the free MySQL-compatible database
Create a TiDB Cloud Starter cluster at https://tidbcloud.com/ and copy its MySQL connection string.
Import your current HSWare MySQL dump into TiDB before your Hostinger account expires.

## 2. Install dependencies and log in
```bash
npm install
npx wrangler login
```

## 3. Create R2 backup bucket
```bash
npx wrangler r2 bucket create hsware-backups
```

## 4. Create Hyperdrive
Use your TiDB connection string:
```bash
npx wrangler hyperdrive create hsware-db --connection-string="mysql://USER:PASSWORD@HOST:4000/DATABASE"
```
Copy the returned Hyperdrive ID into `wrangler.jsonc`, replacing `REPLACE_WITH_HYPERDRIVE_ID`.

## 5. Add secrets
```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_NAME
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put LOGO_DEV_API_KEY
```
Only add optional tokens you actually use.

Generate SESSION_SECRET locally with:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 6. First deploy
```bash
npm run deploy
```
HSWare will run its existing MySQL migrations against TiDB through Hyperdrive.

## 7. Test
Open the workers.dev URL and verify login, dashboard, published software, logos, Update Center, manual backup, restore, and catalog.
Test Cron locally with Wrangler's scheduled handler route if needed.

## 8. Custom domain
Cloudflare Dashboard > Workers & Pages > hsware-studio > Settings > Domains & Routes > Add Custom Domain.

## LightWave behavior
- Cron every 6 hours.
- Published software only.
- No permanent Node timer/polling process.
- A bounded number of update batches runs per Cron invocation to respect the Workers Free subrequest limit.
- If the queue is not finished, the next Cron resumes it.

## Backups
The local Hostinger filesystem is no longer used. JSON backups are stored in the R2 bucket bound as BACKUPS. Google Drive backup upload is intentionally replaced by R2 in this edition.

## Important
Cloudflare Workers Free has strict CPU/subrequest limits. Heavy full-catalog sync/import jobs may need to be run in smaller batches. The normal admin UI and published-software LightWave workflow are the intended free-tier workload.
