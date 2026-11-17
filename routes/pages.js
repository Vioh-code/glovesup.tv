// GET pages for slice 1a: S-P8 Register, S-P10 Log in, S-P13 Legal.
// The POST handlers live in routes/auth.js (added step by step).
const express = require('express');

const router = express.Router();

router.get('/register', (req, res) => res.render('register'));
router.get('/login', (req, res) => res.render('login'));

const LEGAL = { terms: 'Terms of Service', privacy: 'Privacy Policy' };
for (const page of Object.keys(LEGAL)) {
  router.get(`/${page}`, (req, res) => res.render('legal', { page, heading: LEGAL[page] }));
}

module.exports = router;
