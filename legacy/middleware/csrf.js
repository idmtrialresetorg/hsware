const crypto = require('crypto');

function ensureToken(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function verifyToken(req, res, next) {
  const token = req.get('x-csrf-token') || req.body?._csrf;
  const expected = String(req.session?.csrfToken || '');
  const supplied = String(token || '');
  const valid = supplied.length === expected.length && supplied.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) {
    if (req.accepts('json') && !req.accepts('html')) return res.status(403).json({ ok: false, error: 'Invalid CSRF token.' });
    return res.status(403).send('Invalid CSRF token.');
  }
  next();
}

module.exports = { ensureToken, verifyToken };
