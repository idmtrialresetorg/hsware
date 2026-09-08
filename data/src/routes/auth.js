const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { getPool } = require('../db');
const state = require('../state');
const { guestOnly, requireAuth } = require('../middleware/auth');
const { verifyToken } = require('../middleware/csrf');
const activity = require('../services/activity');
const workClaims = require('../services/app-claims');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

router.get('/login', guestOnly, async (req, res) => {
  let hasUsers = false;
  if (state.dbReady) {
    try { const [[row]] = await getPool().query('SELECT COUNT(*) AS c FROM users WHERE is_active=1'); hasUsers = Number(row.c) > 0; } catch {}
  }
  res.render('login', { title: 'Sign in', error: null, next: req.query.next || '/', state, hasUsers });
});

router.post('/login', loginLimiter, verifyToken, guestOnly, async (req, res, next) => {
  try {
    if (!state.dbReady) return res.status(503).render('db-unavailable', { title: 'Setup required', state, layout: false });
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const [rows] = await getPool().query("SELECT id,name,email,password_hash,role,is_active FROM users WHERE email=? LIMIT 1", [email]);
    const user = rows[0];
    if (!user || !user.is_active || !['admin','partner'].includes(String(user.role)) || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).render('login', { title: 'Sign in', error: 'Invalid email or password.', next: req.body.next || '/', state, hasUsers: true });
    }
    await getPool().query('UPDATE users SET last_login_at=NOW() WHERE id=?', [user.id]);
    req.session.user = { id: Number(user.id), name: user.name, email: user.email, role: user.role };
    await activity.record(user.id, 'user_login');
    const nextUrl = String(req.body.next || '/');
    res.redirect(nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : '/');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, verifyToken, async (req, res) => {
  const userId = req.session?.user?.id;
  if (userId) await workClaims.releaseAllOwned(userId);
  req.session = null;
  if (userId) await activity.record(userId, 'user_logout');
  res.redirect('/login');
});

module.exports = router;
