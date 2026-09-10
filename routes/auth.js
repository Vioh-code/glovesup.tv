const express = require('express');
const bcrypt = require('bcrypt');
const passport = require('../config/passport');
const User = require('../models/user');
const { requireRecaptcha } = require('../middleware/recaptcha');

const router = express.Router();

function siteKey() {
  return process.env.GOOGLE_RECAPTCHA_SITE_KEY || '';
}

function renderRegister(res, { error, formData, status = 200 } = {}) {
  res.status(status).render('register', {
    title: 'Register',
    siteKey: siteKey(),
    error,
    formData,
  });
}

function renderLogin(res, { error, formData, status = 200 } = {}) {
  res.status(status).render('login', {
    title: 'Login',
    siteKey: siteKey(),
    error,
    formData,
  });
}

router.get('/register', (req, res) => {
  renderRegister(res, {});
});

router.post(
  '/register',
  requireRecaptcha({ view: 'register', title: 'Register' }),
  async (req, res, next) => {
    const { username, email, password, confirmPassword } = req.body;

    if (!username || !password) {
      return renderRegister(res, {
        status: 400,
        error: 'Username and password are required.',
        formData: req.body,
      });
    }

    if (password !== confirmPassword) {
      return renderRegister(res, {
        status: 400,
        error: 'Passwords do not match.',
        formData: req.body,
      });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({
        username,
        email: email || null,
        passwordHash,
      });

      req.login(user, (err) => {
        if (err) return next(err);
        res.redirect('/');
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        return renderRegister(res, {
          status: 400,
          error: 'That username or email is already in use.',
          formData: req.body,
        });
      }

      console.error('Registration error:', err);
      return renderRegister(res, {
        status: 500,
        error: 'Something went wrong. Please try again.',
        formData: req.body,
      });
    }
  }
);

router.get('/login', (req, res) => {
  renderLogin(res, {});
});

router.post(
  '/login',
  requireRecaptcha({ view: 'login', title: 'Login' }),
  (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);

      if (!user) {
        return renderLogin(res, {
          status: 401,
          error: (info && info.message) || 'Incorrect username or password.',
          formData: req.body,
        });
      }

      req.login(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        res.redirect('/');
      });
    })(req, res, next);
  }
);

router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

module.exports = router;
