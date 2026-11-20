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
const { parseCalloutForm, eloBandOk, timeLeft } = require('../lib/callouts');
const { LABELS: labels } = require('../lib/labels');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_RE = /^\d{1,20}$/;

const VERIFY = 'Verify your email to send or accept call outs.';
const NOT_AVAILABLE = 'That member cannot be called out.';
const SELF = 'You cannot call yourself out.';
const OUT_OF_BAND = 'ELO call outs need an opponent within 400 points of your rating.';
const TERMS_CHANGED = 'The terms changed. Review them again.';
const CLOSED = 'This call out is no longer open.';

// updated_at as whole microseconds, so the value round-trips exactly through a form.
const VERSION_SQL = '(extract(epoch FROM updated_at) * 1000000)::bigint::text';
const ACTIVE = ['accepted', 'awaiting_panel', 'submissions_open', 'judging'];
const PAST = ['declined', 'cancelled', 'expired', 'finalized', 'forfeited', 'voided'];

// Marks every past-due proposed call out expired. Stands in for the worker.
const markExpired = () => pool.query(
  "UPDATE battles SET status = 'expired' WHERE status = 'proposed' AND expires_at <= now()",
);

async function viewer(userId) {
  const { rows } = await pool.query(
    'SELECT id, username, elo_rating, email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1',
    [userId],
  );
  return rows[0];
}

// Active, verified members only. Every miss gets the same message.
async function findOpponent(username) {
  const { rows } = await pool.query(
    `SELECT id, username, elo_rating FROM users
     WHERE lower(username) = lower($1) AND status = 'active' AND email_verified_at IS NOT NULL`,
    [username],
  );
  return rows[0] || null;
}

async function loadCallout(id) {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await pool.query(
    `SELECT b.*, ${VERSION_SQL} AS version,
            c.username AS challenger_name, c.elo_rating AS challenger_elo,
            o.username AS opponent_name, o.elo_rating AS opponent_elo
     FROM battles b
     JOIN users c ON c.id = b.challenger_user_id
     JOIN users o ON o.id = b.opponent_user_id
     WHERE b.id = $1 AND b.kind = 'single'`,
    [id],
  );
  return rows[0] || null;
}

function calloutRoutes() {
  const router = express.Router();

  const fail = (res, status, heading, message, link) => res.status(status).render('error', { heading, message, link });
  const notFound = (res) => fail(res, 404, 'Page not found', 'That page does not exist or was moved.');
  const forbidden = (res, message = 'You cannot do that on this call out.') => fail(res, 403, 'Not allowed', message);
  const closed = (res, id, message = CLOSED) => fail(res, 409, 'Call out closed', message, `/callouts/${id}`);

  const renderForm = (req, res, status, locals) => res.status(status).render('callout-form', {
    labels, errors: [], values: { scoring: 'elo', judging: 'official', submission_days: '5' }, review: null, edit: null, ...locals,
  });

  // Loads the call out and the viewer; refuses strangers with 404.
  // Sets req.callout, req.viewer, req.role ('creator' or 'opponent').
  const participantOnly = async (req, res, next) => {
    try {
      await markExpired();
      const [b, me] = await Promise.all([loadCallout(req.params.id), viewer(req.user.id)]);
      if (!b || !me) return notFound(res);
      if (b.created_by === me.id) req.role = 'creator';
      else if (b.opponent_user_id === me.id) req.role = 'opponent';
      else return notFound(res);
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

  router.get('/callouts/new', requireLogin, loadViewer, (req, res) => {
    if (!req.viewer.verified) return renderForm(req, res, 200, { unverified: VERIFY });
    return renderForm(req, res, 200, {});
  });

  router.post('/callouts/review', requireLogin, loadViewer, async (req, res, next) => {
    try {
      if (!req.viewer.verified) return renderForm(req, res, 403, { unverified: VERIFY });
      const r = await checkNew(req.viewer, req.body);
      if (r.errors.length) return renderForm(req, res, 400, { errors: r.errors, values: r.redisplay });
      return renderForm(req, res, 200, {
        values: r.redisplay,
        review: { ...r.values, opponent: r.opponent.username, opponentElo: r.opponent.elo_rating },
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/callouts', requireLogin, loadViewer, async (req, res, next) => {
    try {
      if (!req.viewer.verified) return renderForm(req, res, 403, { unverified: VERIFY });
      const r = await checkNew(req.viewer, req.body);
      if (r.errors.length) return renderForm(req, res, 400, { errors: r.errors, values: r.redisplay });
      const v = r.values;
      const { rows: [b] } = await pool.query(
        `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by,
                              elo_band_ok, submission_days)
         VALUES ('single', $1, $2, $3, $4, $3, $5, $6) RETURNING id`,
        [v.scoring, v.judging, req.viewer.id, r.opponent.id, r.band, v.submission_days],
      );
      return res.redirect(303, `/callouts/${b.id}`);
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

  // Rechecks the band against the opponent's current rating.
  function checkEdit(b, me, body) {
    const form = parseCalloutForm({ ...body, opponent: b.opponent_name });
    if (form.errors.length) return form;
    const band = eloBandOk(form.values.scoring, me.elo_rating, b.opponent_elo);
    if (band === false) return { ...form, errors: [OUT_OF_BAND] };
    return { ...form, band };
  }

  const editGuards = [requireLogin, participantOnly, onlyRole('creator'), verifiedOnly];

  router.get('/callouts/:id/edit', ...editGuards, (req, res) => {
    const b = req.callout;
    if (b.status !== 'proposed') return closed(res, b.id);
    return renderForm(req, res, 200, {
      edit: editLocals(b),
      values: { scoring: b.scoring, judging: b.judging, submission_days: String(b.submission_days) },
    });
  });

  router.post('/callouts/:id/review', ...editGuards, (req, res) => {
    const b = req.callout;
    if (b.status !== 'proposed') return closed(res, b.id);
    const r = checkEdit(b, req.viewer, req.body);
    const edit = editLocals(b);
    if (r.errors.length) return renderForm(req, res, 400, { edit, errors: r.errors, values: r.redisplay });
    return renderForm(req, res, 200, {
      edit,
      values: r.redisplay,
      review: { ...r.values, opponent: b.opponent_name, opponentElo: b.opponent_elo },
    });
  });

  router.post('/callouts/:id', ...editGuards, async (req, res, next) => {
    try {
      const b = req.callout;
      if (b.status !== 'proposed') return closed(res, b.id);
      const r = checkEdit(b, req.viewer, req.body);
      if (r.errors.length) {
        return renderForm(req, res, 400, { edit: editLocals(b), errors: r.errors, values: r.redisplay });
      }
      const v = r.values;
      // updated_at always moves forward, so an accept holding the old version fails.
      const { rowCount } = await pool.query(
        `UPDATE battles SET scoring = $1, judging = $2, submission_days = $3, elo_band_ok = $4,
                updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
         WHERE id = $5 AND created_by = $6 AND status = 'proposed' AND expires_at > now()`,
        [v.scoring, v.judging, v.submission_days, r.band, b.id, req.viewer.id],
      );
      if (!rowCount) return closed(res, b.id);
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
      const { rowCount } = await pool.query(
        `UPDATE battles SET status = 'accepted', accepted_at = now(),
                submissions_due_at = now() + make_interval(days => submission_days)
         WHERE id = $1 AND opponent_user_id = $2 AND status = 'proposed' AND expires_at > now()
           AND ${VERSION_SQL} = $3`,
        [b.id, req.viewer.id, seen],
      );
      if (rowCount) return res.redirect(303, `/callouts/${b.id}`);
      // Refused: say why. Re-read after marking any expiry.
      await markExpired();
      const now = await loadCallout(b.id);
      return closed(res, b.id, now.status === 'proposed' ? TERMS_CHANGED : CLOSED);
    } catch (err) {
      return next(err);
    }
  });

  const close = (column, status) => async (req, res, next) => {
    try {
      const b = req.callout;
      const { rowCount } = await pool.query(
        `UPDATE battles SET status = $1
         WHERE id = $2 AND ${column} = $3 AND status = 'proposed' AND expires_at > now()`,
        [status, b.id, req.viewer.id],
      );
      if (!rowCount) return closed(res, b.id);
      return res.redirect(303, `/callouts/${b.id}`);
    } catch (err) {
      return next(err);
    }
  };

  router.post('/callouts/:id/decline', requireLogin, participantOnly, onlyRole('opponent'), close('opponent_user_id', 'declined'));
  router.post('/callouts/:id/cancel', requireLogin, participantOnly, onlyRole('creator'), close('created_by', 'cancelled'));

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

// Every 1v1 battle the user is in, split into the four S-B3 tabs.
async function myBattles(userId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.status, b.scoring, b.judging, b.expires_at, b.submissions_due_at, b.created_at,
            b.challenger_user_id = $1 AS mine,
            CASE WHEN b.challenger_user_id = $1 THEN o.username ELSE c.username END AS other_name
     FROM battles b
     JOIN users c ON c.id = b.challenger_user_id
     JOIN users o ON o.id = b.opponent_user_id
     WHERE b.kind = 'single' AND (b.challenger_user_id = $1 OR b.opponent_user_id = $1)
     ORDER BY b.created_at DESC
     LIMIT 200`,
    [userId],
  );
  const lists = { incoming: [], outgoing: [], active: [], past: [] };
  for (const r of rows) {
    if (r.status === 'proposed') lists[r.mine ? 'outgoing' : 'incoming'].push(r);
    else if (ACTIVE.includes(r.status)) lists.active.push(r);
    else if (PAST.includes(r.status)) lists.past.push(r);
  }
  return lists;
}

module.exports = { calloutRoutes, myBattles, markExpired };
