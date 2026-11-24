// S-M1 Dashboard. Slice 2a fills the call out parts: call outs waiting on the
// viewer (with countdowns), videos to submit (F-C3), active battles, the
// viewer's rating, and the Create a call out button. Judge requests and results come with later slices.
const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');
const { timeLeft } = require('../lib/callouts');
const { LABELS: labels } = require('../lib/labels');
const { openBattles, markExpired } = require('../lib/battles');
const { videosDue } = require('../lib/submissions');

const router = express.Router();

router.get('/dashboard', requireLogin, async (req, res, next) => {
  try {
    await markExpired();
    const [lists, videos, { rows: [me] }] = await Promise.all([
      openBattles(req.user.id),
      videosDue(req.user.id),
      pool.query('SELECT elo_rating FROM users WHERE id = $1', [req.user.id]),
    ]);
    res.render('dashboard', {
      labels,
      incoming: lists.incoming,
      videos,
      active: lists.active,
      rating: me ? me.elo_rating : null,
      timeLeft,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
