// Optional browser-based LiteAPKs resolver.
// Requires: npm install playwright && npx playwright install chromium
const FILE_RE = /\.(apk|xapk|apks)(?:[?#]|$)/i;

async function resolveFinalDownloadUrl(url, timeout = 45000) {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    let found = null;
    page.on('response', response => {
      const u = response.url();
      if (!found && FILE_RE.test(u)) found = u;
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout });
    await page.waitForTimeout(5000);

    // Some pages expose the link after client-side actions.
    const links = await page.$$eval('a[href]', els => els.map(a => a.href));
    found = found || links.find(u => FILE_RE.test(u)) || null;

    return found;
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { resolveFinalDownloadUrl };
