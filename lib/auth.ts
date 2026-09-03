import { redirect } from 'next/navigation';
import { readSession, ensureCsrf } from './session';
import { config } from './config';
import { ensureDatabaseReady } from './runtime';
import dbModule from '../legacy/db.js';
import type { SessionUser } from '../types/session';

const { getPool } = dbModule as any;

export async function currentUser(): Promise<SessionUser | null> {
  const session = ensureCsrf(await readSession());
  const id = Number(session.user?.id || 0);
  if (!id) return null;
  const state = await ensureDatabaseReady();
  if (!state.dbReady) return null;
  const [[user]] = await getPool().query(
    'SELECT id,name,email,role,is_active FROM users WHERE id=? LIMIT 1', [id]
  );
  if (!user?.is_active || !['admin','partner'].includes(String(user.role))) return null;
  return { id:Number(user.id), name:user.name, email:user.email, role:user.role };
}
export async function requireUser() {
  const user = await currentUser();
  if (!user) redirect(config.adminPath);
  return user;
}
export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== 'admin') redirect('/dashboard');
  return user;
}
