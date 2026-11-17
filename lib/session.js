// F-A2: login sessions in Postgres (connect-pg-simple, table from a migration).
//
// Without "keep me logged in" the cookie has no expiry (it ends when the browser
// closes) and the row expires 12 hours after the last request: every request
// touches it forward. With "keep me logged in" the cookie and row last 30 days
// from login; the cookie is not re-sent on later requests (rolling is off).
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);

const IDLE_SECONDS = 12 * 3600;
const REMEMBER_MS = 30 * 24 * 3600 * 1000;
const COOKIE_NAME = 'glovesup.sid';

function configureSessions(app, { sessionSecret, isProduction }, pool) {
  // Nginx on the same host is the only proxy. Trusting loopback lets
  // X-Forwarded-Proto mark requests as HTTPS so Secure cookies are set.
  app.set('trust proxy', 'loopback');

  const store = new PgStore({
    pool,
    tableName: 'session',
    createTableIfMissing: false, // the table comes from migrations/…_session.js
    ttl: IDLE_SECONDS,
  });

  app.use(session({
    name: COOKIE_NAME,
    secret: sessionSecret,
    store,
    resave: false,
    saveUninitialized: false, // visitors get no cookie until something is stored
    rolling: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      path: '/',
    },
  }));
}

function rememberDevice(req) {
  req.session.cookie.maxAge = REMEMBER_MS;
}

module.exports = { configureSessions, rememberDevice, IDLE_SECONDS, REMEMBER_MS, COOKIE_NAME };
