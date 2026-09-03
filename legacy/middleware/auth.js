const state = require('../state');
const { getPool } = require('../db');
const config = require('../config');

function wantsJson(req) {
  return req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/') || (req.accepts(['json','html']) === 'json');
}

function denyUnauthenticated(req, res) {
  if (wantsJson(req)) return res.status(401).json({ ok: false, error: 'Your session has ended. Sign in again.' });
  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`${config.adminPath}?next=${nextUrl}`);
}

function requireAuth(req, res, next) {
  if (req.session?.user?.id) return next();
  return denyUnauthenticated(req, res);
}

async function requireActiveUser(req, res, next) {
  try {
    if (!req.session?.user?.id) return denyUnauthenticated(req, res);
    if (!state.dbReady) return next();
    const [[user]] = await getPool().query(
      'SELECT id,name,email,role,is_active,avatar_mime,(avatar_blob IS NOT NULL) AS has_avatar,last_login_at,created_at,updated_at FROM users WHERE id=? LIMIT 1',
      [Number(req.session.user.id)]
    );
    if (!user || !user.is_active || !['admin','partner'].includes(String(user.role))) {
      req.session = null;
      return denyUnauthenticated(req, res);
    }
    req.currentUser = user;
    req.session.user = { id: Number(user.id), name: user.name, email: user.email, role: user.role };
    res.locals.user = req.session.user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  const role = req.currentUser?.role || req.session?.user?.role;
  if (role === 'admin') return next();
  if (wantsJson(req)) return res.status(403).json({ ok: false, error: 'Admin access is required for this action.' });
  return res.status(403).render('error', { title: 'Access denied', active: '', message: 'Admin access is required for this page.' });
}

function guestOnly(req, res, next) {
  if (req.session?.user?.id) return res.redirect(config.dashboardPath);
  next();
}

module.exports = { requireAuth, requireActiveUser, requireAdmin, guestOnly };
