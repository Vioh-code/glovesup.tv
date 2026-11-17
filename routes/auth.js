// S-P8 Register and S-P10 Log in pages, each carrying the session's CSRF token.
// Never log request bodies, passwords, DOBs or email addresses.
const express = require('express');
const { csrfToken } = require('../lib/csrf');

function authRoutes() {
  const router = express.Router();

  const renderRegister = (req, res, status, { errors = [], values = {} } = {}) => res
    .status(status)
    .render('register', { csrfToken: csrfToken(req), errors, values });

  router.get('/register', (req, res) => renderRegister(req, res, 200));

  router.get('/login', (req, res) => res.render('login', {
    csrfToken: csrfToken(req),
    registered: req.query.registered === '1',
  }));

  return router;
}

module.exports = { authRoutes };
