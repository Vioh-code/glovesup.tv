// F-C4 S-J1 Judge dashboard (slice 2c-1). Permission rules (Matt, Nov 25):
// - logged in on every route; the page is for holders of the judge role
//   (403 for anyone else);
// - a judge replies only to their own assignment: the judge comes from the
//   session, the assignment id from the URL; anyone else's id is 404;
// - replying needs judge.assignment.respond (a revoked judge gets 403);
// - a judge sees only their own rows, never their co-judges.
// Slice 2c-2 (Matt, Nov 25): S-J2 Judging (GET /judging/:id), Check link,
// Submit judgment and Recuse, same rules: own assignment only (404 for any
// other id), judge.judgment.submit to pick (403), judge.assignment.respond to
// recuse (403), and the state checks again under the battle lock. YouTube is
// asked only after those checks pass. A co-judge's judgment is never shown
// before finalize; after it the outcome is public (reasons_public_at).
const express = require('express');
const { requireLogin } = require('../lib/auth');
const { notFound: notFoundPage } = require('../lib/web');
const { timeLeft } = require('../lib/callouts');
const { LABELS: labels } = require('../lib/labels');
const { hasRole, can } = require('../lib/permissions');
const panel = require('../lib/panel');
const judging = require('../lib/judging');
const youtube = require('../lib/youtube');

const TABS = ['requests', 'accepted', 'history'];
const REFUSED = {
  accept: { heading: 'Not accepted', lead: 'You did not accept this assignment.' },
  decline: { heading: 'Not declined', lead: 'You did not decline this assignment.' },
};
const WHY = {
  closed: 'The battle is no longer waiting for judges.',
  refused: 'You already answered this request.',
};

// S-J2 messages. Link and video wording match S-B5.
const NEED_PICK = 'Pick the winner.';
const NEED_REASON = 'Add a reason or a review video to submit.';
const TOO_LONG = 'Keep the typed reason to 2,000 characters.';
const BAD_LINK = 'Paste a YouTube link: youtube.com/watch, youtu.be or youtube.com/shorts.';
const NEED_LINK = 'Paste the YouTube link to your review video first.';
const DEAD = 'That video can\'t be used. It is private, deleted, or embedding is turned off.';
const UNREACHABLE = 'Couldn\'t check the video, try again.';
// Why a judge cannot pick (lib/judging whyNot) or recuse.
const WHY_NOT = {
  locked: 'You already submitted your judgment. It is locked.',
  closed: 'This battle is no longer being judged.',
  notAccepted: 'Accept the judge request first.',
  off: 'You are no longer on this panel.',
  notReady: 'Judging opens once both videos are in.',
  drawn: 'You have not accepted this request. Use Decline instead.',
};

// The S-J2 form as typed. Errors in the order the page shows them.
function parseJudgment(body = {}) {
  const pick = judging.PICKS.includes(body.pick) ? body.pick : null;
  const reasonText = typeof body.reason_text === 'string' ? body.reason_text.trim() : '';
  const videoUrl = typeof body.reason_video_url === 'string' ? body.reason_video_url.trim().slice(0, 200) : '';
  const parsed = videoUrl ? youtube.parseYouTubeUrl(videoUrl) : null;
  const errors = [];
  if (!pick) errors.push(NEED_PICK);
  if (!reasonText && !videoUrl) errors.push(NEED_REASON);
  if ([...reasonText].length > judging.REASON_MAX) errors.push(TOO_LONG);
  if (videoUrl && !parsed) errors.push(BAD_LINK);
  return {
    pick, reasonText, videoUrl, parsed, errors,
    // For the repeat-submit check: the video as it would be stored.
    asStored: { pick, reasonText: reasonText || null, video: parsed },
  };
}

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

  // --- S-J2 Judging ---

  const page = (id) => `/judging/${id}`;
  const conflict = (res, id, heading, why) => res.status(409).render('error', {
    heading, message: WHY_NOT[why], link: page(id),
  });

  // Loads the viewer's own assignment (404 for anything else) into req.ctx.
  const ownAssignment = async (req, res, next) => {
    try {
      req.ctx = await judging.load(req.params.id, req.user.id);
      return req.ctx ? next() : notFoundPage(req, res);
    } catch (err) {
      return next(err);
    }
  };

  async function render(req, res, status, form = {}) {
    const { assignment: a, battle: b } = req.ctx;
    const mayPick = !req.ctx.why && (await can(req.user.id, 'judge.judgment.submit'));
    res.status(status).render('judge-battle', {
      labels,
      timeLeft,
      ctx: req.ctx,
      mayPick,
      mayRecuse: a.status === 'accepted' && panel.IN_PLAY.includes(b.status),
      outcome: await judging.outcome(b.id),
      WHY_NOT,
      form: { pick: null, reasonText: '', videoUrl: '', errors: [], preview: null, ...form },
    });
  }

  router.get('/judging/:id', requireLogin, ownAssignment, (req, res, next) => {
    render(req, res, 200).catch(next);
  });

  // Check link and Submit need judge.judgment.submit. Returns true when it
  // already answered (403).
  async function refused(req, res) {
    if (!(await can(req.user.id, 'judge.judgment.submit'))) {
      forbidden(res, 'You can no longer judge battles.');
      return true;
    }
    return false;
  }

  // Asks YouTube about a parsed link. Renders the error and returns null when it fails.
  async function checked(req, res, f) {
    const result = await youtube.checkVideo(f.parsed.videoId);
    if (result.ok) return { url: f.parsed.url, videoId: f.parsed.videoId, title: result.title, thumbnail: result.thumbnail };
    const dead = result.reason === 'dead';
    await render(req, res, dead ? 400 : 503, { ...shown(f), errors: [dead ? DEAD : UNREACHABLE] });
    return null;
  }
  const shown = (f) => ({ pick: f.pick, reasonText: f.reasonText, videoUrl: f.videoUrl });

  router.post('/judging/:id/check-link', requireLogin, ownAssignment, async (req, res, next) => {
    try {
      if (await refused(req, res)) return undefined;
      if (req.ctx.why) return conflict(res, req.params.id, 'Not checked', req.ctx.why);
      const f = parseJudgment(req.body);
      if (!f.videoUrl || !f.parsed) return await render(req, res, 400, { ...shown(f), errors: [f.videoUrl ? BAD_LINK : NEED_LINK] });
      const video = await checked(req, res, f);
      if (!video) return undefined;
      return await render(req, res, 200, { ...shown(f), preview: video });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/judging/:id/judge', requireLogin, ownAssignment, async (req, res, next) => {
    try {
      if (await refused(req, res)) return undefined;
      const f = parseJudgment(req.body);
      const id = req.params.id;
      // A repeat of the stored judgment: nothing to save, no YouTube call.
      if (req.ctx.why === 'locked') {
        if (!f.errors.length && judging.sameJudgment(req.ctx.judgment, f.asStored)) return res.redirect(303, page(id));
        return conflict(res, id, 'Not submitted', 'locked');
      }
      if (req.ctx.why) return conflict(res, id, 'Not submitted', req.ctx.why);
      if (f.errors.length) return await render(req, res, 400, { ...shown(f), errors: f.errors });
      let video = null;
      if (f.parsed) {
        video = await checked(req, res, f);
        if (!video) return undefined;
      }
      const out = await judging.submit(id, req.user.id, { pick: f.pick, reasonText: f.reasonText || null, video });
      if (out === 'notFound') return notFoundPage(req, res);
      if (out === 'forbidden') return forbidden(res, 'You can no longer judge battles.');
      if (out === 'done' || out === 'same') return res.redirect(303, page(id));
      return conflict(res, id, 'Not submitted', out);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/judging/:id/recuse', requireLogin, async (req, res, next) => {
    try {
      const out = await judging.recuse(req.params.id, req.user.id);
      if (out === 'notFound') return notFoundPage(req, res);
      if (out === 'forbidden') return forbidden(res, 'You can no longer answer judge requests.');
      if (out === 'done' || out === 'same') return res.redirect(303, '/judging');
      return res.status(409).render('error', {
        heading: 'Not recused', message: `You did not recuse. ${WHY_NOT[out]}`, link: page(req.params.id),
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { judgingRoutes };
