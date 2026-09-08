# Appbit - Local Docker Deployment

This Docker setup wraps the existing Appbit Astro + Express application. It does not replace or convert the framework.

## Requirements on Windows

1. Install Git.
2. Install Docker Desktop.
3. In Docker Desktop, use the WSL 2 backend and make sure Docker is running.

Check in PowerShell:

```powershell
docker --version
docker compose version
```

## First deployment from GitHub

```powershell
git clone https://github.com/YOUR-USER/YOUR-APPBIT-REPO.git
cd YOUR-APPBIT-REPO
Copy-Item docker.env.template .env.docker
notepad .env.docker
```

Change at least:

- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `DB_PASSWORD`
- `MYSQL_PASSWORD` (same value as `DB_PASSWORD`)
- `MYSQL_ROOT_PASSWORD`

Keep `NODE_ENV=development` for local `http://localhost`. Appbit marks session cookies Secure when `NODE_ENV=production`, which requires HTTPS.

Start Appbit and MySQL:

```powershell
docker compose up -d --build
```

The first build can take several minutes because Chromium and its Linux libraries are installed for Appbit's Playwright APK download resolver.

Open:

```text
http://localhost:3000
```

Sign in using `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env.docker`.

## Check status and logs

```powershell
docker compose ps
docker compose logs -f appbit
docker compose logs -f db
```

Exit log view with `Ctrl+C`; the containers continue running.

## Stop / start without deleting data

```powershell
docker compose stop
docker compose start
```

or:

```powershell
docker compose down
docker compose up -d
```

The MySQL database remains in the named Docker volume `appbit_mysql_data`.

## Rebuild after changing Appbit code

Edit the files normally in VS Code, then run:

```powershell
docker compose up -d --build appbit
```

Your database is not deleted by a rebuild. Then inspect the runtime log:

```powershell
docker compose logs --tail=200 appbit
```

For every future Appbit update, test the actual change locally before increasing the version.

## Pull a new GitHub commit and redeploy

```powershell
git pull
docker compose up -d --build
```

## Create a clean database from zero

WARNING: this permanently deletes the local Appbit MySQL database and Docker backup volume.

```powershell
docker compose down -v
docker compose up -d --build
```

Do not run `down -v` if you want to keep your apps and settings.

## Backup persistence

Appbit JSON backups are stored in the named Docker volume `appbit_backups`, while MySQL data is stored in `appbit_mysql_data`.

List Docker volumes:

```powershell
docker volume ls
```

## Docker architecture

```text
Windows / Docker Desktop
        |
        +-- appbit container
        |     Node.js 22
        |     Astro middleware + Express
        |     Playwright + Chromium
        |     Port 3000 -> localhost:3000
        |
        +-- appbit-db container
              MySQL 8.4
              persistent appbit_mysql_data volume
```


## Updating the existing Komodo deployment

Keep your existing `appbit` Stack, Local server, GitHub repository, environment variables, Compose path, and persistent volumes. Create/download an Appbit backup first. Replace the repository's project files with this package's contents (do not delete the persistent database or backups). Commit the changes on the branch selected in Komodo, then use Stacks → appbit → Deploy. Check the deployment log and both services. Do not use Destroy, Reset Data, or `docker compose down -v` for an update.

This release does not require a new hosting framework, another Linux VM, another database, or a new Komodo stack. The installed Dockerfile still performs a fresh npm install, source check and Astro build. The existing source package version remains unchanged.

Security: credentials previously shared in chat should be treated as exposed. Rotate the Appbit admin password, session secret, and database credentials. Changing an existing MySQL volume's environment password alone does not rotate the database user's stored password; rotate that user through MySQL administration and then update the matching environment values. Do not commit `.env.docker`, `.env`, tokens, passwords, database dumps or backup files to a public GitHub repository.

## Updating the existing Komodo stack

Create and download an Appbit database backup first. Replace the repository files with the contents of this ZIP (not a nested folder), commit to the existing branch, then use the existing Komodo Stack's Deploy action. Keep the existing Compose settings, environment values and named volumes. Do not run Destroy or `docker compose down -v`. After deployment, confirm `/apps/<name>-<id>` loads directly and the new record toolbar is visible. A failed build should be inspected in Komodo's deployment log; do not assume a source-check pass proves a production build.

The previous public-chat secrets should be rotated in Komodo's private environment settings. Never commit `.env.docker`, backups, passwords or tokens.
