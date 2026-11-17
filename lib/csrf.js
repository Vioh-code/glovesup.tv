// CSRF protection: one random token per session, sent in each form as _csrf
// and compared with crypto.timingSafeEqual on every POST (and other unsafe
// methods). No token, a wrong token, or no session: 403 and nothing runs.
const crypto = require('node:crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Returns the session's token, creating it if needed. Creating one stores data
// in the session, so only call this when rendering a page that has a form.
function csrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  }
  return req.session.csrfToken;
}

function tokensMatch(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Mount after express-session and the urlencoded body parser.
function csrfProtection(req, res, next) {
  // Pages rendered for a session that already has a token (for example the
  // logout button in the member header) can use it without creating one.
  if (req.session && req.session.csrfToken) res.locals.csrfToken = req.session.csrfToken;

  if (SAFE_METHODS.has(req.method)) return next();

  const given = req.body && req.body._csrf;
  if (req.session && tokensMatch(req.session.csrfToken, given)) return next();

  res.status(403).render('error', {
    heading: 'This form has expired',
    message: 'Go back, reload the page and try again.',
  });
}

module.exports = { csrfToken, tokensMatch, csrfProtection };
