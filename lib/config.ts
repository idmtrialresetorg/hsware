function normalizeAdminPath(value?: string) {
  let route = String(value || '/admin').trim();
  if (!route.startsWith('/')) route = '/' + route;
  route = route.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/admin';
  if (!/^\/[A-Za-z0-9_\/-]+$/.test(route) || ['/', '/api', '/health', '/login'].includes(route)) return '/admin';
  return route;
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'production',
  sessionSecret: process.env.SESSION_SECRET || '',
  adminPath: normalizeAdminPath(process.env.ADMIN_PATH || '/admin'),
};
