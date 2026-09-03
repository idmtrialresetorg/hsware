'use server';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ensureDatabaseReady } from '../../lib/runtime';
import dbModule from '../../legacy/db.js';
import activityModule from '../../legacy/services/activity.js';
import healthModule from '../../legacy/services/health-checks.js';
import { writeSession } from '../../lib/session';
import { config } from '../../lib/config';
import legacyConfig from '../../legacy/config.js';
import { allow } from '../../lib/rate-limit';
import persistentRateLimitModule from '../../legacy/services/rate-limits.js';

const { getPool } = dbModule as any;
const activity = activityModule as any;
const runtimeConfig = legacyConfig as any;
const { getReadiness } = healthModule as any;
const persistentRateLimit = persistentRateLimitModule as any;

function safeNext(value: FormDataEntryValue | null) {
  const raw = String(value || '/dashboard');
  return /^\/(dashboard|software|published|updates|settings|catalog|health)(?:[/?#].*)?$/.test(raw) ? raw : '/dashboard';
}
export async function loginAction(formData: FormData) {
  const h = await headers();
  const host = (h.get('x-forwarded-host') || h.get('host') || '').split(',')[0].trim().toLowerCase();
  const origin = h.get('origin');
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch {}
    if (!host || originHost !== host) redirect(`${config.adminPath}?error=origin`);
  }
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = runtimeConfig.trustProxy ? (forwarded || h.get('x-real-ip') || 'unknown') : (h.get('x-real-ip') || 'unknown');
  const gate = allow(`login-burst:${ip}`, 25, 60*1000);
  if (!gate.ok) redirect(`${config.adminPath}?error=rate`);
  const state = await ensureDatabaseReady();
  if (!state.dbReady) redirect(`${config.adminPath}?error=database`);
  const persistentGate = await persistentRateLimit.consume(`login:${ip}`, 12, 10*60);
  if (!persistentGate.ok) redirect(`${config.adminPath}?error=rate`);
  const email = String(formData.get('email') || '').trim().toLowerCase();
  const password = String(formData.get('password') || '');
  const [rows] = await getPool().query('SELECT id,name,email,password_hash,role,is_active FROM users WHERE email=? LIMIT 1', [email]);
  const user = rows[0];
  if (!user || !user.is_active || !['admin','partner'].includes(String(user.role)) || !(await bcrypt.compare(password, user.password_hash))) {
    redirect(`${config.adminPath}?error=invalid`);
  }
  const readiness = await getReadiness();
  if (!readiness.ok) redirect(`${config.adminPath}?error=health`);
  await getPool().query('UPDATE users SET last_login_at=NOW() WHERE id=?', [user.id]);
  await writeSession({
    csrfToken: crypto.randomBytes(24).toString('hex'),
    user: { id:Number(user.id), name:user.name, email:user.email, role:user.role }
  });
  await activity.record(user.id, 'user_login');
  redirect(safeNext(formData.get('next')) === '/health' ? '/health?from=login' : safeNext(formData.get('next')));
}
