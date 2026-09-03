const crypto = require('crypto');

function diagnosticId(prefix = 'ERR') {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}
function compactError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    message: String(error?.message || error || 'Unknown error').slice(0, 1800),
    code: error?.code ? String(error.code).slice(0, 120) : null,
    errno: error?.errno == null ? null : String(error.errno).slice(0, 120),
    sqlState: error?.sqlState ? String(error.sqlState).slice(0, 32) : null
  };
}
function safeContext(context = {}) {
  const out = {};
  for (const [key, value] of Object.entries(context)) {
    if (/password|secret|token|cookie|authorization/i.test(key)) continue;
    if (value == null || ['string','number','boolean'].includes(typeof value)) out[key] = typeof value === 'string' ? value.slice(0, 500) : value;
  }
  return out;
}
function logError(error, context = {}, id = diagnosticId()) {
  const entry = { tag:'HSWareDiagnostic', diagnosticId:id, at:new Date().toISOString(), ...safeContext(context), error:compactError(error) };
  console.error('[HSWare Diagnostic]', JSON.stringify(entry));
  if (process.env.NODE_ENV !== 'production' && error?.stack) console.error(error.stack);
  return id;
}
module.exports = { diagnosticId, compactError, logError };
