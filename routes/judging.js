// F-C4 S-J1 Judge dashboard (slice 2c-1). Permission rules (Matt, Nov 25):
// - logged in on every route; the page is for holders of the judge role
//   (403 for anyone else);
// - a judge replies only to their own assignment: the judge comes from the
//   session, the assignment id from the URL; anyone else's id is 404;
// - replying needs judge.assignment.respond (a revoked judge gets 403);
// - a judge sees only their own rows, never their co-judges.
// Accept and Decline only; recusal comes in slice 2c-2.
const express = require('express');
const { requireLogin } = require('../lib/auth');
const { notFound: notFoundPage } = require('../lib/web');
const { timeLeft } = require('../lib/callouts');
const { LABELS: labels } = require('../lib/labels');
const { hasRole } = require('../lib/permissions');
const panel = require('../lib/panel');

const TABS = ['requests', 'accepted', 'history'];
const REFUSED = {
  accept: { heading: 'Not accepted', lead: 'You did not accept this assignment.' },
  decline: { heading: 'Not declined', lead: 'You did not decline this assignment.' },
};
const WHY = {
  closed: 'The battle is no longer waiting for judges.',
  refused: 'You already answered this request.',
};

function judgingRoutes() {
  const router = express.Router();
  const forbidden = (res, message) => res.status(403).render('error', { heading: 'Not allowed', message });

  router.get('/judging', requireLogin, async (req, res, next) => {
    try {
      if (!(await hasRole(req.user.id, 'judge'))) return forbidden(res, 'Only judges can open this page.');
      const tab = TABS.includes(req.query.tab) ? req.query.tab : 'requests';
      const lists = await panel.assignmentsFor(req.user.id);
      return res.render('judging', { labels, tab, tabs: TABS, lists, timeLeft });
    } catch (err) {
      return next(err);
    }
  });

  for (const action of ['accept', 'decline']) {
    router.post(`/judging/:id/${action}`, requireLogin, async (req, res, next) => {
      try {
        const out = await panel.respond(req.params.id, req.user.id, action);
        if (out === 'notFound') return notFoundPage(req, res);
        if (out === 'forbidden') return forbidden(res, 'You can no longer answer judge requests.');
        if (out === 'done' || out === 'same') return res.redirect(303, '/judging');
        const { heading, lead } = REFUSED[action];
        return res.status(409).render('error', { heading, message: `${lead} ${WHY[out]}`, link: '/judging' });
      } catch (err) {
        return next(err);
      }
    });
  }

  return router;
}

module.exports = { judgingRoutes };
