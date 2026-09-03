import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';
import { config } from './config';
import type { HSWareSession } from '../types/session';

export const SESSION_COOKIE = 'hsware_session';
const MAX_AGE = 7 * 24 * 60 * 60;

function secret() {
  if (config.nodeEnv === 'production' && config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production.');
  }
  if (!config.sessionSecret) {
    throw new Error('SESSION_SECRET is required. Configure it in production environment variables.');
  }
  return config.sessionSecret;
}
function sign(value: string) { return crypto.createHmac('sha256', secret()).update(value).digest('base64url'); }
export function encodeSession(session: HSWareSession) {
  const payload = Buffer.from(JSON.stringify(session || {}), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function decodeSession(value?: string | null): HSWareSession {
  try {
    const [payload, sig] = String(value || '').split('.');
    if (!payload || !sig) return {};
    const expected = sign(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return {};
    const out = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return out && typeof out === 'object' ? out : {};
  } catch { return {}; }
}
export function sessionFromRequest(request: NextRequest): HSWareSession {
  return decodeSession(request.cookies.get(SESSION_COOKIE)?.value);
}
export function saveSessionOnResponse(response: NextResponse, session: HSWareSession | null) {
  if (!session) {
    response.cookies.set(SESSION_COOKIE, '', { path: '/', expires: new Date(0) });
    return;
  }
  response.cookies.set(SESSION_COOKIE, encodeSession(session), {
    path: '/', httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production', maxAge: MAX_AGE
  });
}
export async function readSession(): Promise<HSWareSession> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}
export async function writeSession(session: HSWareSession | null) {
  const store = await cookies();
  if (!session) store.delete(SESSION_COOKIE);
  else store.set(SESSION_COOKIE, encodeSession(session), {
    path: '/', httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production', maxAge: MAX_AGE
  });
}
export function ensureCsrf(session: HSWareSession) {
  if (!session.csrfToken) session.csrfToken = crypto.randomBytes(24).toString('hex');
  return session;
}
