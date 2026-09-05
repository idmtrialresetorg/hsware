const config = require('../config');
const cheerio = require('cheerio');

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com/microsoft/winget-pkgs/master';

function headers(extra = {}) {
  const h = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'HSWare-Studio/4.6.0',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra
  };
  if (config.githubToken) h.Authorization = `Bearer ${config.githubToken}`;
  return h;
}

async function githubJson(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: headers(options.headers || {}),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`GitHub API ${response.status}: ${body.slice(0, 300) || response.statusText}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

async function rawText(repoPath) {
  const response = await fetch(`${RAW}/${repoPath.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { 'User-Agent': 'HSWare-Studio/4.6.0' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) { const err = new Error(`WinGet manifest fetch failed (${response.status}).`); err.status = response.status; throw err; }
  return response.text();
}

async function findInstallerManifest(packageId) {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is required to search for a package that is not yet indexed.');
  const q = encodeURIComponent(`repo:microsoft/winget-pkgs filename:${packageId}.installer.yaml`);
  const data = await githubJson(`/search/code?q=${q}&per_page=20`);
  const exact = (data.items || []).find(item => String(item.path || '').endsWith(`/${packageId}.installer.yaml`));
  return exact?.path || data.items?.[0]?.path || null;
}

async function listContents(path) {
  return githubJson(`/repos/microsoft/winget-pkgs/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
}

async function listDirectoryFromHtml(repoPath) {
  const encoded = String(repoPath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  if (!encoded) return [];
  const url = `https://github.com/microsoft/winget-pkgs/tree/master/${encoded}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'HSWare-Studio/4.6.0',
      'Accept': 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    const err = new Error(`GitHub directory page failed (${response.status}).`);
    err.status = response.status;
    throw err;
  }
  const html = await response.text();
  const $ = cheerio.load(html);
  const prefix = `/microsoft/winget-pkgs/tree/master/${encoded}/`;
  const out = new Map();
  $('a[href]').each((_, el) => {
    const href = String($(el).attr('href') || '');
    if (!href.startsWith(prefix)) return;
    const rest = href.slice(prefix.length).split(/[?#]/)[0];
    if (!rest || rest.includes('/')) return;
    let name = rest;
    try { name = decodeURIComponent(rest); } catch {}
    if (!out.has(name)) out.set(name, { name, type: 'dir', path: `${repoPath}/${name}` });
  });
  return [...out.values()];
}

function parseGithubReleaseAssetUrl(installerUrl) {
  try {
    const u = new URL(installerUrl);
    if (u.hostname.toLowerCase() !== 'github.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 6 || parts[2] !== 'releases' || parts[3] !== 'download') return null;
    return {
      owner: decodeURIComponent(parts[0]),
      repo: decodeURIComponent(parts[1]),
      tag: decodeURIComponent(parts[4]),
      asset: decodeURIComponent(parts.slice(5).join('/'))
    };
  } catch { return null; }
}

async function releaseAssetDownloadCount(installerUrl) {
  const ref = parseGithubReleaseAssetUrl(installerUrl);
  if (!ref) return { count: null, sourceUrl: null, kind: null };
  try {
    const release = await githubJson(`/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/releases/tags/${encodeURIComponent(ref.tag)}`);
    const asset = (release.assets || []).find(a => String(a?.name || '') === ref.asset);
    if (!asset || asset.download_count == null) return { count: null, sourceUrl: release.html_url || null, kind: 'github-release-asset' };
    return {
      count: Number(asset.download_count),
      sourceUrl: release.html_url || null,
      kind: 'github-release-asset'
    };
  } catch {
    return { count: null, sourceUrl: null, kind: 'github-release-asset' };
  }
}


async function manifestLastUpdatedDate(repoPath) {
  if (!repoPath) return null;
  try {
    const rows = await githubJson(`/repos/microsoft/winget-pkgs/commits?path=${encodeURIComponent(repoPath)}&per_page=1`);
    const raw = rows?.[0]?.commit?.committer?.date || rows?.[0]?.commit?.author?.date || null;
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

async function getTree(sha, recursive = true) {
  return githubJson(`/repos/microsoft/winget-pkgs/git/trees/${encodeURIComponent(sha)}${recursive ? '?recursive=1' : ''}`);
}

async function rawTextAtRef(repoPath, ref) {
  const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`https://raw.githubusercontent.com/microsoft/winget-pkgs/${encodeURIComponent(ref)}/${encoded}`, {
    headers: { 'User-Agent': 'HSWare-Studio/4.6.0' }, signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) { const err = new Error(`Historical WinGet manifest fetch failed (${response.status}).`); err.status=response.status; throw err; }
  return response.text();
}
async function listContentsAtRef(path, ref) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return githubJson(`/repos/microsoft/winget-pkgs/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
}
async function commitsForPath(path, perPage = 8) {
  return githubJson(`/repos/microsoft/winget-pkgs/commits?path=${encodeURIComponent(path)}&per_page=${Math.max(1,Math.min(20,Number(perPage)||8))}`);
}

module.exports = { githubJson, rawText, findInstallerManifest, listContents, listDirectoryFromHtml, getTree, releaseAssetDownloadCount, manifestLastUpdatedDate, rawTextAtRef, listContentsAtRef, commitsForPath, hasToken: () => Boolean(config.githubToken) };
