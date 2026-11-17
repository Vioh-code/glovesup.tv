// S-P13 Legal pages (placeholders until Matt supplies the text).
const express = require('express');

const router = express.Router();

const LEGAL = { terms: 'Terms of Service', privacy: 'Privacy Policy' };
for (const page of Object.keys(LEGAL)) {
  router.get(`/${page}`, (req, res) => res.render('legal', { page, heading: LEGAL[page] }));
}

module.exports = router;
