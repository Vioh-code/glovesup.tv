// F-A1 / S-P8 Register, F-A2 / S-P10 Log in and log out, S-M1 dashboard stub.
// Never log request bodies, passwords, DOBs or email addresses.
const express = require('express');
const { pool } = require('../db');
const { csrfToken } = require('../lib/csrf');
const { validateRegistration } = require('../lib/validate');
const { hashPassword } = require('../lib/passwords');
const { encryptDob } = require('../lib/dob-crypto');
const { passport, requireLogin, visitorsOnly } = require('../lib/auth');
const { rememberDevice, COOKIE_NAME } = require('../lib/session');

const DUPLICATE = 'That username or email is not available.';
const LOGIN_FAILED = 'Wrong email, username or password.';

function authRoutes({ dobKey }) {
  const router = express.Router();

  const renderRegister = (req, res, status, { errors = [], values = {} } = {}) => res
    .status(status)
    .render('register', { csrfToken: csrfToken(req), errors, values });

  router.get('/register', visitorsOnly, (req, res) => renderRegister(req, res, 200));

  router.post('/register', visitorsOnly, async (req, res, next) => {
    try {
      const result = validateRegistration(req.body, new Date());
      if (result.errors.length) {
        // Under 13 lands here too: only the age message, and nothing is written.
        return renderRegister(req, res, 400, { errors: result.errors, values: result.redisplay });
      }
      const { username, email, dob, password } = result.values;

      // Every account is a Member from registration (01-feature-spec, section 8).
      // email_verified_at stays null until slice 1b; it gates call outs and voting.
      try {
        await pool.query(
          `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at)
           VALUES ($1, $2, $3, $4, true, now())`,
          [username, email, await hashPassword(password), encryptDob(dob, dobKey)],
        );
      } catch (err) {
        if (err.code === '23505') {
          return renderRegister(req, res, 400, { errors: [DUPLICATE], values: result.redisplay });
        }
        throw err;
      }
      return res.redirect(303, '/login?registered=1');
    } catch (err) {
      return next(err);
    }
  });

  const renderLogin = (req, res, status, { errors = [], values = {}, registered = false } = {}) => res
    .status(status)
    .render('login', { csrfToken: csrfToken(req), errors, values, registered });

  router.get('/login', visitorsOnly, (req, res) => renderLogin(req, res, 200, {
    registered: req.query.registered === '1',
  }));

  router.post('/login', visitorsOnly, (req, res, next) => {
    // Missing fields go through the same path and get the same message.
    req.body.identifier = typeof req.body.identifier === 'string' ? req.body.identifier : '';
    req.body.password = typeof req.body.password === 'string' ? req.body.password : '';
    passport.authenticate('local', (err, user) => {
      if (err) return next(err);
      if (!user) {
        return renderLogin(req, res, 401, {
          errors: [LOGIN_FAILED],
          values: { identifier: req.body.identifier.trim(), remember: req.body.remember === 'yes' },
        });
      }
      // Passport regenerates the session (new id) and saves it. The 30-day
      // lifetime and a fresh CSRF token are set after that, so save once more.
      return req.login(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        if (req.body.remember === 'yes') rememberDevice(req);
        csrfToken(req);
        return req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect(303, '/dashboard')));
      });
    })(req, res, next);
  });

  // POST only, with the CSRF token. Deletes the session row and the cookie.
  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure: req.secure });
      return res.redirect(303, '/');
    });
  });

  // S-M1 Dashboard: stub until the dashboard slice.
  router.get('/dashboard', requireLogin, (req, res) => res.render('dashboard'));

  return router;
}

module.exports = { authRoutes };
