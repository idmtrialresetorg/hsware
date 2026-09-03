# HSWare Studio v15.0.0

Production hardened release of HSWare Studio LightWave Update Center.

## Requirements
- Node.js 22.x
- MySQL 8+

## Installation
```bash
npm install
cp .env.example .env
# configure environment values
npm run build
npm start
```

## Security changes in v15
- Removed insecure fallback session secret
- Added production secret enforcement
- Updated deployment documentation
- Improved environment configuration guidance

## Deployment
1. Upload project files to hosting.
2. Configure Node 22.
3. Add all required environment variables.
4. Run build.
5. Start application.

Do not deploy with placeholder credentials or secrets.
