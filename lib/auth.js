// F-A2: Passport local login. Log in with email or username (case-insensitive).
// Every failure (unknown account, wrong password, banned, suspended, deleted)
// looks the same to the user, and an unknown account still costs a bcrypt compare.
// The session stores only the user id. Never log identifiers or passwords.
const passport = require('passport');
const { Strategy: LocalStrategy } = require('passport-local');
const { pool } = require('../db');
const { verifyPassword, dummyVerify } = require('./passwords');
const { csrfToken } = require('./csrf');

const PUBLIC_FIELDS = 'id, username, status';

async function findForLogin(identifier) {
  const { rows } = await pool.query(
    `SELECT id, username, status, password_hash FROM users
     WHERE lower(email) = lower($1) OR lower(username) = lower($1)`,
    [identifier],
  );
  return rows[0] || null; // usernames cannot contain @, so at most one row matches
}

async function checkCredentials(identifier, password) {
  const user = typeof identifier === 'string' && identifier.trim()
    ? await findForLogin(identifier.trim())
    : null;
  if (!user) {
    await dummyVerify(password);
    return null;
  }
  const ok = await verifyPassword(password, user.password_hash);
  // Status is checked after the password so a banned account takes the same time.
  if (!ok || user.status !== 'active') return null;
  return { id: user.id, username: user.username, status: user.status };
}

function configurePassport(app) {
  passport.use(new LocalStrategy(
    { usernameField: 'identifier', passwordField: 'password' },
    (identifier, password, done) => {
      checkCredentials(identifier, password).then((user) => done(null, user || false), done);
    },
  ));

  passport.serializeUser((user, done) => done(null, user.id));

  // A user who is no longer active (banned, suspended, deleted mid-session) is
  // treated as logged out: returning false makes Passport drop the login.
  passport.deserializeUser((id, done) => {
    pool.query(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = $1`, [id])
      .then(({ rows }) => done(null, rows[0] && rows[0].status === 'active' ? rows[0] : false), done);
  });

  app.use(passport.initialize());
  app.use(passport.session());

  // Views read currentUser for the member nav. Logged-in pages always have a
  // CSRF token for the logout button.
  app.use((req, res, next) => {
    if (req.user) {
      res.locals.currentUser = { username: req.user.username };
      res.locals.csrfToken = csrfToken(req);
    }
    next();
  });
}

const requireLogin = (req, res, next) => (req.user ? next() : res.redirect('/login'));
const visitorsOnly = (req, res, next) => (req.user ? res.redirect(req.method === 'GET' ? 302 : 303, '/dashboard') : next());

module.exports = { configurePassport, checkCredentials, requireLogin, visitorsOnly, passport };
