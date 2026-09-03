const fs = require('fs');
const config = require('../config');
const { getPool } = require('../db');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'HSWare Studio Backups';
const SETTING_REFRESH_TOKEN = 'google_drive_refresh_token';
const SETTING_FOLDER_ID = 'google_drive_backup_folder_id';

async function getSetting(key) {
  const [[row]] = await getPool().query('SELECT setting_value FROM app_settings WHERE setting_key=? LIMIT 1', [key]);
  return row?.setting_value || null;
}

async function setSetting(key, value) {
  await getPool().query(
    `INSERT INTO app_settings (setting_key,setting_value) VALUES (?,?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,
    [key, value == null ? null : String(value)]
  );
}

async function deleteSetting(key) {
  await getPool().query('DELETE FROM app_settings WHERE setting_key=?', [key]);
}

function configured() {
  return Boolean(config.googleDrive?.clientId && config.googleDrive?.clientSecret);
}

function requestOrigin(req) {
  const configuredOrigin = String(config.googleDrive?.appUrl || '').trim().replace(/\/$/, '');
  if (configuredOrigin) return configuredOrigin;
  const proto = String(req?.get?.('x-forwarded-proto') || 'https').split(',')[0].trim() || 'https';
  const host = String(req?.get?.('x-forwarded-host') || req?.get?.('host') || '').split(',')[0].trim();
  if (!host) throw new Error('Unable to determine the public HSWare URL for Google Drive OAuth. Set APP_URL in the environment.');
  return `${proto}://${host}`;
}

function redirectUri(req) {
  const explicit = String(config.googleDrive?.redirectUri || '').trim();
  return explicit || `${requestOrigin(req)}/api/backups/google/callback`;
}

async function state() {
  const refreshToken = await getSetting(SETTING_REFRESH_TOKEN);
  const folderId = await getSetting(SETTING_FOLDER_ID);
  return {
    configured: configured(),
    connected: Boolean(configured() && refreshToken),
    folderId: folderId || null,
    folderName: FOLDER_NAME,
    autoUpload: true,
    scope: DRIVE_SCOPE
  };
}

async function authorizationUrl(req) {
  if (!configured()) throw new Error('Google Drive backup is not configured. Add GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET in the Hostinger environment first.');
  const stateToken = String(req?.session?.csrfToken || '');
  if (!stateToken) throw new Error('Your HSWare session is missing the OAuth state token. Sign in again and retry.');
  const params = new URLSearchParams({
    client_id: config.googleDrive.clientId,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: stateToken
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function tokenRequest(params) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data?.error_description || data?.error || `Google OAuth failed with HTTP ${response.status}.`);
  return data || {};
}

async function handleCallback(req) {
  if (!configured()) throw new Error('Google Drive backup is not configured.');
  const code = String(req?.query?.code || '');
  const incomingState = String(req?.query?.state || '');
  const expectedState = String(req?.session?.csrfToken || '');
  if (!code) throw new Error(String(req?.query?.error_description || req?.query?.error || 'Google Drive authorization did not return a code.'));
  if (!incomingState || !expectedState || incomingState !== expectedState) throw new Error('Google Drive authorization state check failed. Please reconnect from HSWare Settings.');
  const data = await tokenRequest({
    code,
    client_id: config.googleDrive.clientId,
    client_secret: config.googleDrive.clientSecret,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code'
  });
  if (!data.refresh_token) {
    const existing = await getSetting(SETTING_REFRESH_TOKEN);
    if (!existing) throw new Error('Google did not return an offline refresh token. Disconnect HSWare from your Google account permissions, then connect again.');
  } else {
    await setSetting(SETTING_REFRESH_TOKEN, data.refresh_token);
  }
  return state();
}

async function disconnect() {
  const refreshToken = await getSetting(SETTING_REFRESH_TOKEN);
  if (refreshToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }
      });
    } catch {}
  }
  await deleteSetting(SETTING_REFRESH_TOKEN);
  await deleteSetting(SETTING_FOLDER_ID);
  return state();
}

async function accessToken() {
  if (!configured()) throw new Error('Google Drive backup is not configured.');
  const refreshToken = await getSetting(SETTING_REFRESH_TOKEN);
  if (!refreshToken) throw new Error('Google Drive is not connected.');
  const data = await tokenRequest({
    refresh_token: refreshToken,
    client_id: config.googleDrive.clientId,
    client_secret: config.googleDrive.clientSecret,
    grant_type: 'refresh_token'
  });
  if (!data.access_token) throw new Error('Google Drive did not return an access token.');
  return data.access_token;
}

async function driveFetch(url, options = {}) {
  const token = await accessToken();
  const headers = new Headers(options.headers || {});
  headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  return response;
}

async function createFolder() {
  const response = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) throw new Error(data?.error?.message || `Unable to create the Google Drive backup folder (HTTP ${response.status}).`);
  await setSetting(SETTING_FOLDER_ID, data.id);
  return data.id;
}

async function ensureFolder() {
  let folderId = await getSetting(SETTING_FOLDER_ID);
  if (folderId) {
    const check = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,trashed`, { method: 'GET' });
    if (check.ok) {
      const data = await check.json().catch(() => ({}));
      if (data.id && !data.trashed) return folderId;
    }
    await deleteSetting(SETTING_FOLDER_ID);
    folderId = null;
  }
  return createFolder();
}

async function uploadJson(filepath, filename) {
  if (!fs.existsSync(filepath)) throw new Error('The local JSON backup no longer exists.');
  const folderId = await ensureFolder();
  const stat = fs.statSync(filepath);
  const token = await accessToken();
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,createdTime,webViewLink', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'application/json',
      'x-upload-content-length': String(stat.size)
    },
    body: JSON.stringify({ name: filename, parents: [folderId], mimeType: 'application/json' })
  });
  if (!start.ok) {
    const data = await start.json().catch(() => ({}));
    throw new Error(data?.error?.message || `Google Drive could not start the backup upload (HTTP ${start.status}).`);
  }
  const location = start.headers.get('location');
  if (!location) throw new Error('Google Drive did not return a resumable upload location.');
  const body = fs.readFileSync(filepath);
  const finish = await fetch(location, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body
  });
  const data = await finish.json().catch(() => ({}));
  if (!finish.ok || !data.id) throw new Error(data?.error?.message || `Google Drive backup upload failed (HTTP ${finish.status}).`);
  return { fileId: data.id, name: data.name || filename, size: Number(data.size || stat.size), createdTime: data.createdTime || null, webViewLink: data.webViewLink || null, folderId };
}

module.exports = {
  DRIVE_SCOPE,
  FOLDER_NAME,
  state,
  authorizationUrl,
  handleCallback,
  disconnect,
  uploadJson
};
