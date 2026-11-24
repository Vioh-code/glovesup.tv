// F-C1, F-C2: S-B1 Create call out, S-B2 Call out detail, S-B3 My battles.
// Permission rules are enforced here, never only in the views:
// - logged in (requireLogin), and a verified email to send, edit or accept;
// - only the two participants can see a call out; strangers get 404;
// - only the opponent accepts or declines, only the creator edits or cancels (403).
// Every state change is one UPDATE whose WHERE clause carries all of its
// conditions (status proposed, not expired, actor, and for accept the terms
// version the opponent saw). Zero rows updated means refuse with 409.
const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../lib/auth');
const { notFound: notFoundPage } = require('../lib/web');
const { parseCalloutForm, eloBandOk, timeLeft, reviewKey } = require('../lib/callouts');
const { LABELS: labels } = require('../lib/labels');
const {
  VERSION_SQL, TOUCH_SQL, markExpired, viewer, findOpponent, loadCallout, myBattles,
} = require('../lib/battles');

const VERSION_RE = /^\d{1,20}$/;

const VERIFY = 'Verify your email to send or accept call outs.';
const NOT_AVAILABLE = 'That member cannot be called out.';
const SELF = 'You cannot call yourself out.';
const OUT_OF_BAND = 'ELO call outs need an opponent within 400 points of your rating.';
const TERMS_CHANGED = 'The terms changed. Review them again.';
const UNREVIEWED = 'You changed the terms after Review. Check them below and send again.';
// A repeat of the same Send within this window is the same click (double-click
// or resubmit), so it lands on the call out already made instead of a copy.
const DUPLICATE_WINDOW = '10 seconds';

// A refusal names the action that did not happen and the call out's current
// state, so it never reads like a confirmation (browser test, Nov 20).
const REFUSED = {
  accept: { heading: 'Not accepted', lead: 'This call out was not accepted.' },
  decline: { heading: 'Not declined', lead: 'This call out was not declined.' },
  cancel: { heading: 'Not cancelled', lead: 'This call out was not cancelled.' },
  edit: { heading: 'Cannot edit', lead: 'This call out can no longer be edited.' },
  save: { heading: 'Not saved', lead: 'Your changes were not saved.' },
};
const ALREADY = {
  declined: 'It has already been declined.',
  cancelled: 'It has already been cancelled.',
  expired: 'It has already expired.',
  finalized: 'It has already finished.',
  forfeited: 'It has already finished.',
  voided: 'It has already finished.',
};
const already = (status) => ALREADY[status] || 'It has already been accepted.';
// The status each action leaves. Finding it already there means this viewer's
// own earlier click did it (only one role can take each action).
const DONE = { accept: 'accepted', decline: 'declined', cancel: 'cancelled' };

function calloutRoutes() {
  const router = express.Router();

  const fail = (res, status, heading, message, link) => res.status(status).render('error', { heading, message, link });
  const forbidden = (res, message = 'You cannot do that on this call out.') => fail(res, 403, 'Not allowed', message);
  // 409 for an action that lost to the call out's state. Re-reads the state
  // (after marking any expiry) so the message is current.
  const refuse = async (res, id, action) => {
    await markExpired();
    const now = await loadCallout(id);
    if (DONE[action] && now.status === DONE[action]) return res.redirect(303, `/callouts/${id}`);
    const { heading, lead } = REFUSED[action];
    let why = already(now.status);
    if (now.status === 'proposed') why = action === 'accept' ? TERMS_CHANGED : 'Reload the page and try again.';
    return fail(res, 409, heading, `${lead} ${why}`, `/callouts/${id}`);
  };

  const renderForm = (req, res, status, locals) => res.status(status).render('callout-form', {
    labels, errors: [], values: { scoring: 'elo', judging: 'official', submission_days: '5' }, review: null, edit: null, ...locals,
  });

  // Loads the call out and the viewer; refuses strangers with 404.
  // Sets req.callout, req.viewer, req.role ('creator' or 'opponent').
  const participantOnly = async (req, res, next) => {
    try {
      await markExpired();
      const [b, me] = await Promise.all([loadCallout(req.params.id), viewer(req.user.id)]);
      if (!b || !me) return notFoundPage(req, res);
      if (b.created_by === me.id) req.role = 'creator';
      else if (b.opponent_user_id === me.id) req.role = 'opponent';
      else return notFoundPage(req, res);
      req.callout = b;
      req.viewer = me;
      return next();
    } catch (err) {
      return next(err);
    }
  };

  const onlyRole = (role) => (req, res, next) => (req.role === role ? next() : forbidden(res));
  const verifiedOnly = (req, res, next) => (req.viewer.verified ? next() : forbidden(res, VERIFY));
  const loadViewer = async (req, res, next) => {
    try {
      req.viewer = await viewer(req.user.id);
      return req.viewer ? next() : res.redirect('/login');
    } catch (err) {
      return next(err);
    }
  };

  // Validates the form and the opponent. Returns { errors, values, opponent }.
  async function checkNew(me, body) {
    const form = parseCalloutForm(body);
    if (form.errors.length) return { ...form, opponent: null };
    const { values } = form;
    if (values.opponent.toLowerCase() === me.username.toLowerCase()) {
      return { ...form, errors: [SELF], opponent: null };
    }
    const opponent = await findOpponent(values.opponent);
    if (!opponent) return { ...form, errors: [NOT_AVAILABLE], opponent: null };
    const band = eloBandOk(values.scoring, me.elo_rating, opponent.elo_rating);
    if (band === false) return { ...form, errors: [OUT_OF_BAND], opponent };
    return { ...form, opponent, band };
  }

  // --- S-B1 Create ---

  const reviewNew = (r) => ({
    values: r.redisplay,
    review: { ...r.values, opponent: r.opponent.username, opponentElo: r.opponent.elo_rating },
    reviewed: reviewKey({ ...r.values, opponent: r.opponent.username }),
  });

  // Inserts the call out unless the same creator sent the same terms to the
  // same opponent within DUPLICATE_WINDOW; then returns that one. The advisory
  // lock (per creator) makes simultaneous clicks wait for each other.
  async function insertOnce(creatorId, opponentId, v, band) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('callout:' || $1))", [creatorId]);
      const { rows: [dup] } = await client.query(
        `SELECT id FROM battles
         WHERE created_by = $1 AND opponent_user_id = $2 AND status = 'proposed'
           AND scoring = $3 AND judging = $4 AND submission_days = $5
           AND created_at > clock_timestamp() - interval '${DUPLICATE_WINDOW}'
         ORDER BY created_at DESC LIMIT 1`,
        [creatorId, opponentId, v.scoring, v.judging, v.submission_days],
      );
      let id = dup && dup.id;
      if (!id) {
        ({ rows: [{ id }] } = await client.query(
          `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by,
                                elo_band_ok, submission_days)
           VALUES ('single', $1, $2, $3, $4, $3, $5, $6) RETURNING id`,
          [v.scoring, v.judging, creatorId, opponentId, band, v.submission_days],
        ));
      }
      await client.query('COMMIT');
      return id;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  router.get('/callouts/new', requireLogin, loadViewer, (req, res) => {
    if (!req.viewer.verified) return renderForm(req, res, 200, { unverified: VERIFY });
    return renderForm(req, res, 200, {});
  });

  router.post('/callouts/review', requireLogin, loadViewer, async (req, res, next) => {
    try {
      if (!req.viewer.verified) return renderForm(req, res, 403, { unverified: VERIFY });
      const r = await checkNew(req.viewer, req.body);
      if (r.errors.length) return renderForm(req, res, 400, { errors: r.errors, values: r.redisplay });
      return renderForm(req, res, 200, reviewNew(r));
    } catch (err) {
      return next(err);
    }
  });

  router.post('/callouts', requireLogin, loadViewer, async (req, res, next) => {
    try {
      if (!req.viewer.verified) return renderForm(req, res, 403, { unverified: VERIFY });
      const r = await checkNew(req.viewer, req.body);
      if (r.errors.length) return renderForm(req, res, 400, { errors: r.errors, values: r.redisplay });
      if (req.body.reviewed !== reviewKey(r.values)) return renderForm(req, res, 400, { ...reviewNew(r), errors: [UNREVIEWED] });
      const id = await insertOnce(req.viewer.id, r.opponent.id, r.values, r.band);
      return res.redirect(303, `/callouts/${id}`);
    } catch (err) {
      return next(err);
    }
  });

  // --- S-B2 Detail ---

  router.get('/callouts/:id', requireLogin, participantOnly, (req, res) => {
    const b = req.callout;
    res.render('callout', {
      labels,
      b,
      role: req.role,
      verified: req.viewer.verified,
      countdown: b.status === 'proposed' ? timeLeft(b.expires_at) : null,
      videosDue: b.submissions_due_at ? timeLeft(b.submissions_due_at) : null,
      notice: VERIFY,
    });
  });

  // --- Edit (creator only, before acceptance) ---

  const editLocals = (b) => ({ id: b.id, opponent: b.opponent_name, opponentElo: b.opponent_elo });
  const reviewEdit = (b, r) => ({
    edit: editLocals(b),
    values: r.redisplay,
    review: { ...r.values, opponent: b.opponent_name, opponentElo: b.opponent_elo },
    reviewed: reviewKey({ ...r.values, opponent: b.opponent_name }),
  });

  // Rechecks the band against the opponent's current rating.
  function checkEdit(b, me, body) {
    const form = parseCalloutForm({ ...body, opponent: b.opponent_name });
    if (form.errors.length) return form;
    const band = eloBandOk(form.values.scoring, me.elo_rating, b.opponent_elo);
    if (band === false) return { ...form, errors: [OUT_OF_BAND] };
    return { ...form, band };
  }

  const editGuards = [requireLogin, participantOnly, onlyRole('creator'), verifiedOnly];

  router.get('/callouts/:id/edit', ...editGuards, async (req, res, next) => {
    const b = req.callout;
    if (b.status !== 'proposed') return refuse(res, b.id, 'edit').catch(next);
    return renderForm(req, res, 200, {
      edit: editLocals(b),
      values: { scoring: b.scoring, judging: b.judging, submission_days: String(b.submission_days) },
    });
  });

  router.post('/callouts/:id/review', ...editGuards, async (req, res, next) => {
    const b = req.callout;
    if (b.status !== 'proposed') return refuse(res, b.id, 'save').catch(next);
    const r = checkEdit(b, req.viewer, req.body);
    if (r.errors.length) return renderForm(req, res, 400, { edit: editLocals(b), errors: r.errors, values: r.redisplay });
    return renderForm(req, res, 200, reviewEdit(b, r));
  });

  router.post('/callouts/:id', ...editGuards, async (req, res, next) => {
    try {
      const b = req.callout;
      if (b.status !== 'proposed') return await refuse(res, b.id, 'save');
      const r = checkEdit(b, req.viewer, req.body);
      if (r.errors.length) {
        return renderForm(req, res, 400, { edit: editLocals(b), errors: r.errors, values: r.redisplay });
      }
      if (req.body.reviewed !== reviewKey({ ...r.values, opponent: b.opponent_name })) {
        return renderForm(req, res, 400, { ...reviewEdit(b, r), errors: [UNREVIEWED] });
      }
      const v = r.values;
      // updated_at always moves forward, so an accept holding the old version fails.
      const { rowCount } = await pool.query(
        `UPDATE battles SET scoring = $1, judging = $2, submission_days = $3, elo_band_ok = $4,
                ${TOUCH_SQL}
         WHERE id = $5 AND created_by = $6 AND status = 'proposed' AND expires_at > now()`,
        [v.scoring, v.judging, v.submission_days, r.band, b.id, req.viewer.id],
      );
      if (!rowCount) return await refuse(res, b.id, 'save');
      return res.redirect(303, `/callouts/${b.id}`);
    } catch (err) {
      return next(err);
    }
  });

  // --- Accept, decline, cancel ---

  router.post('/callouts/:id/accept', requireLogin, participantOnly, onlyRole('opponent'), verifiedOnly, async (req, res, next) => {
    try {
      const b = req.callout;
      const seen = typeof req.body.terms_version === 'string' && VERSION_RE.test(req.body.terms_version)
        ? req.body.terms_version : null;
      // One statement: the accept and the battle's slot (F-C3, a 1v1 has one,
      // position 1) land together or not at all.
      const { rowCount } = await pool.query(
        `WITH acc AS (
           UPDATE battles SET status = 'accepted', accepted_at = now(),
                  submissions_due_at = now() + make_interval(hours => 24 * submission_days), ${TOUCH_SQL}
           WHERE id = $1 AND opponent_user_id = $2 AND status = 'proposed' AND expires_at > now()
             AND ${VERSION_SQL} = $3
           RETURNING id, challenger_user_id, opponent_user_id)
         INSERT INTO battle_slots (battle_id, position, challenger_user_id, opponent_user_id)
         SELECT id, 1, challenger_user_id, opponent_user_id FROM acc`,
        [b.id, req.viewer.id, seen],
      );
      if (rowCount) return res.redirect(303, `/callouts/${b.id}`);
      // Still proposed after the refusal means the terms changed since the page was opened.
      return await refuse(res, b.id, 'accept');
    } catch (err) {
      return next(err);
    }
  });

  const close = (action, column, status) => async (req, res, next) => {
    try {
      const b = req.callout;
      const { rowCount } = await pool.query(
        `UPDATE battles SET status = $1, ${TOUCH_SQL}
         WHERE id = $2 AND ${column} = $3 AND status = 'proposed' AND expires_at > now()`,
        [status, b.id, req.viewer.id],
      );
      if (!rowCount) return await refuse(res, b.id, action);
      return res.redirect(303, `/callouts/${b.id}`);
    } catch (err) {
      return next(err);
    }
  };

  router.post('/callouts/:id/decline', requireLogin, participantOnly, onlyRole('opponent'), close('decline', 'opponent_user_id', 'declined'));
  router.post('/callouts/:id/cancel', requireLogin, participantOnly, onlyRole('creator'), close('cancel', 'created_by', 'cancelled'));

  // --- S-B3 My battles ---

  const TABS = ['incoming', 'outgoing', 'active', 'past'];

  router.get('/my-battles', requireLogin, async (req, res, next) => {
    try {
      await markExpired();
      const tab = TABS.includes(req.query.tab) ? req.query.tab : 'incoming';
      const lists = await myBattles(req.user.id);
      res.render('my-battles', { labels, tab, tabs: TABS, lists, timeLeft });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { calloutRoutes };
