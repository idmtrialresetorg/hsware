function normalizeAdminPath(value?: string) {
  let route = String(value || '/admin').trim();
  if (!route.startsWith('/')) route = '/' + route;
  route = route.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/admin';
  if (!/^\/[A-Za-z0-9_\/-]+$/.test(route) || ['/', '/api', '/health', '/login'].includes(route)) return '/admin';
  return route;
}
export const config = {
  get nodeEnv(){ return process.env.NODE_ENV || 'production'; },
  get sessionSecret(){ return process.env.SESSION_SECRET || ''; },
  get adminPath(){ return normalizeAdminPath(process.env.ADMIN_PATH || '/admin'); },
};
