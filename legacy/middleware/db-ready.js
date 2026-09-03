const state = require('../state');

module.exports = function requireDb(req, res, next) {
  if (state.dbReady) return next();
  return res.status(503).json({ ok:false, error:'Database is temporarily unavailable.' });
};
