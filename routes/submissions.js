// F-C3: S-B5 Submit video. Permission rules (approved by Matt, Nov 24):
// - logged in (requireLogin) on every route;
// - only the battle's two players can see the page or act; anyone else 404;
// - a player acts only on their own submission: the player comes from the
//   session, never from the form, and no submission id is ever in a form;
// - Check, Submit, Replace and Cancel only while the battle is awaiting_panel
//   or submissions_open and before the due date, and not after the lock;
//   checked again under the battle and slot locks (lib/submissions). YouTube
//   is asked only after these checks pass;
// - the page notice and every refusal give one reason (closedReason);
// - the opponent's video is hidden until both are in or the due date passes.
// No email verification is needed to submit (only call outs and voting).
const express = require('express');
const { requireLogin } = require('../lib/auth');
const { notFound: notFoundPage } = require('../lib/web');
const { timeLeft } = require('../lib/callouts');
const { LABELS: labels } = require('../lib/labels');
const { loadCallout, closedReason } = require('../lib/battles');
const youtube = require('../lib/youtube');
const subs = require('../lib/submissions');

const BAD_LINK = 'Paste a YouTube link: youtube.com/watch, youtu.be or youtube.com/shorts.';
const DEAD = 'That video can\'t be used. It is private, deleted, or embedding is turned off.';
const UNREACHABLE = 'Couldn\'t check the video, try again.';
const UNCHECKED = 'You changed the link after Check. Check it below and submit again.';

const WHY = {
  notAccepted: 'Videos open once the call out is accepted.',
  over: 'This battle is over.',
  locked: 'Both videos are in, so submissions are locked.',
  closed: 'The due date has passed.',
};
const REFUSED = {
  check: { heading: 'Not checked', lead: 'The link was not checked.' },
  save: { heading: 'Not saved', lead: 'Your video was not saved.' },
  cancel: { heading: 'Not cancelled', lead: 'Your video was not cancelled.' },
};

function submissionRoutes() {
  const router = express.Router();

  const refuse = (res, id, action, why) => {
    const { heading, lead } = REFUSED[action];
    return res.status(409).render('error', { heading, message: `${lead} ${WHY[why]}`, link: `/battles/${id}/video` });
  };

  // Loads the battle and the viewer's slot; refuses anyone but the two players with 404.
  // Sets req.battle, req.role, req.slot (null until the call out is accepted), req.pastDue.
  const playersOnly = async (req, res, next) => {
    try {
      const b = await loadCallout(req.params.id);
      if (!b) return notFoundPage(req, res);
      if (b.challenger_user_id === req.user.id) req.role = 'challenger';
      else if (b.opponent_user_id === req.user.id) req.role = 'opponent';
      else return notFoundPage(req, res);
      req.battle = b;
      req.slot = await subs.slotFor(b.id, req.user.id);
      req.pastDue = Boolean(b.submissions_due_at && b.submissions_due_at <= new Date());
      return next();
    } catch (err) {
      return next(err);
    }
  };

  // The reason this player cannot change their video now, or null. A first
  // look only; saveVideo and cancelVideo check again under the locks.
  const blocked = (req, state) => {
    if (!req.slot) return 'notAccepted';
    const why = closedReason(req.battle);
    if (why) return why;
    if (state.locked) return 'locked';
    return null;
  };

  async function render(req, res, status, form = {}) {
    const b = req.battle;
    const state = req.slot
      ? await subs.videoState(req.slot.id, req.user.id, req.pastDue)
      : { mine: null, theirs: null, theirsIn: false, locked: false, revealed: false };
    const opponent = req.role === 'challenger' ? b.opponent_name : b.challenger_name;
    res.status(status).render('submit-video', {
      labels,
      b,
      opponent,
      state,
      why: blocked(req, state),
      WHY,
      // Any Check or Submit result keeps the form open, even with a blank link.
      replacing: req.query.replace === '1' || Boolean(form.url || form.preview || (form.errors && form.errors.length)),
      countdown: b.submissions_due_at && !req.pastDue ? timeLeft(b.submissions_due_at) : null,
      form: { url: '', errors: [], preview: null, ...form },
    });
  }

  // Format, then YouTube. Renders the error and returns null when the link fails.
  async function checkLink(req, res) {
    const parsed = youtube.parseYouTubeUrl(req.body.youtube_url);
    const url = typeof req.body.youtube_url === 'string' ? req.body.youtube_url.trim().slice(0, 200) : '';
    if (!parsed) {
      await render(req, res, 400, { url, errors: [BAD_LINK] });
      return null;
    }
    const result = await youtube.checkVideo(parsed.videoId);
    if (!result.ok) {
      await render(req, res, result.reason === 'dead' ? 400 : 503, { url, errors: [result.reason === 'dead' ? DEAD : UNREACHABLE] });
      return null;
    }
    return { ...parsed, title: result.title, thumbnail: result.thumbnail, typed: url };
  }

  const page = (req) => `/battles/${req.battle.id}/video`;

  router.get('/battles/:id/video', requireLogin, playersOnly, (req, res, next) => {
    render(req, res, 200).catch(next);
  });

  router.post('/battles/:id/video/check', requireLogin, playersOnly, async (req, res, next) => {
    try {
      const state = req.slot ? await subs.videoState(req.slot.id, req.user.id, req.pastDue) : {};
      const why = blocked(req, state);
      if (why) return refuse(res, req.battle.id, 'check', why);
      const video = await checkLink(req, res);
      if (!video) return undefined;
      return await render(req, res, 200, { url: video.typed, preview: video });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/battles/:id/video', requireLogin, playersOnly, async (req, res, next) => {
    try {
      const state = req.slot ? await subs.videoState(req.slot.id, req.user.id, req.pastDue) : {};
      const parsed = youtube.parseYouTubeUrl(req.body.youtube_url);
      // The live video again (a double-click or resubmit, even after it locked
      // both): nothing to save, no YouTube call, no refusal.
      if (parsed && state.mine && state.mine.video_id === parsed.videoId && req.body.checked === parsed.videoId) {
        return res.redirect(303, page(req));
      }
      const why = blocked(req, state);
      if (why) return refuse(res, req.battle.id, 'save', why);
      const video = await checkLink(req, res);
      if (!video) return undefined;
      if (req.body.checked !== video.videoId) {
        return await render(req, res, 400, { url: video.typed, preview: video, errors: [UNCHECKED] });
      }
      const out = await subs.saveVideo({ slotId: req.slot.id, battleId: req.battle.id, userId: req.user.id, video });
      if (WHY[out]) return refuse(res, req.battle.id, 'save', out);
      return res.redirect(303, page(req));
    } catch (err) {
      return next(err);
    }
  });

  router.post('/battles/:id/video/cancel', requireLogin, playersOnly, async (req, res, next) => {
    try {
      const why = req.slot ? closedReason(req.battle) : 'notAccepted';
      if (why) return refuse(res, req.battle.id, 'cancel', why);
      const out = await subs.cancelVideo({ slotId: req.slot.id, battleId: req.battle.id, userId: req.user.id });
      if (WHY[out]) return refuse(res, req.battle.id, 'cancel', out);
      return res.redirect(303, page(req));
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { submissionRoutes };
