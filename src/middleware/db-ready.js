const state = require('../state');
module.exports = function requireDb(req, res, next) {
  if (state.dbReady) return next();
  return res.status(503).render('db-unavailable', {
    title: 'Setup required',
    state,
    layout: false
  });
};
