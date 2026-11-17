// F-A1 / S-P8 Register. (F-A2 / S-P10 log in and log out are added next.)
// Never log request bodies, passwords, DOBs or email addresses.
const express = require('express');
const { pool } = require('../db');
const { csrfToken } = require('../lib/csrf');
const { validateRegistration } = require('../lib/validate');
const { hashPassword } = require('../lib/passwords');
const { encryptDob } = require('../lib/dob-crypto');

const DUPLICATE = 'That username or email is not available.';

function authRoutes({ dobKey }) {
  const router = express.Router();

  const renderRegister = (req, res, status, { errors = [], values = {} } = {}) => res
    .status(status)
    .render('register', { csrfToken: csrfToken(req), errors, values });

  router.get('/register', (req, res) => renderRegister(req, res, 200));

  router.post('/register', async (req, res, next) => {
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

  router.get('/login', (req, res) => res.render('login', {
    csrfToken: csrfToken(req),
    registered: req.query.registered === '1',
  }));

  return router;
}

module.exports = { authRoutes };
