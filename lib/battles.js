// Battle queries shared by the call out routes and the dashboard (F-C1).
// Plain SQL over the battles table. Callers enforce permissions.
const { pool } = require('../db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// updated_at as whole microseconds, so the value round-trips exactly through a form.
const VERSION_SQL = '(extract(epoch FROM updated_at) * 1000000)::bigint::text';
// Moves updated_at strictly forward on every change, so an old version never matches.
const TOUCH_SQL = "updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')";

const ACTIVE = ['accepted', 'awaiting_panel', 'submissions_open', 'judging'];
const PAST = ['declined', 'cancelled', 'expired', 'finalized', 'forfeited', 'voided'];
const PAST_LIMIT = 50;
// Videos can come in (and go out, before the lock) only in these statuses.
const SUBMISSIONS_OPEN = ['awaiting_panel', 'submissions_open'];
const OVER = ['finalized', 'forfeited', 'voided'];

// Why a player cannot submit, replace or cancel a video on this battle now, or
// null. One answer for the S-B5 notice and every refusal (review finding 3,
// slice 2b), worded for where the battle is now:
// 'notAccepted', 'over', 'locked' (judging or later) or 'closed' (past due).
function closedReason(b, now = new Date()) {
  if (!b.accepted_at) return 'notAccepted';
  if (OVER.includes(b.status)) return 'over';
  if (!SUBMISSIONS_OPEN.includes(b.status)) return 'locked';
  if (b.submissions_due_at <= now) return 'closed';
  return null;
}

// Marks every past-due proposed call out expired and returns their ids. The
// worker runs it every minute with its clock (`now`); page loads run it too,
// with the database clock, so a page is never a minute behind. One statement:
// accept, edit and decline check expires_at > now() in their own UPDATE.
// Uses the battles_proposed_expiry partial index.
async function markExpired(now = null) {
  const { rows } = await pool.query(
    `UPDATE battles SET status = 'expired', ${TOUCH_SQL}
     WHERE status = 'proposed' AND expires_at <= coalesce($1::timestamptz, now())
     RETURNING id`,
    [now],
  );
  return rows.map((r) => r.id);
}

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
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
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

const LIST_SQL = `
  SELECT b.id, b.status, b.scoring, b.judging, b.expires_at, b.submissions_due_at, b.created_at,
         b.challenger_user_id = $1 AS mine,
         CASE WHEN b.challenger_user_id = $1 THEN o.username ELSE c.username END AS other_name
  FROM battles b
  JOIN users c ON c.id = b.challenger_user_id
  JOIN users o ON o.id = b.opponent_user_id
  WHERE b.kind = 'single' AND (b.challenger_user_id = $1 OR b.opponent_user_id = $1)`;

// Open call outs and active battles: never cut by a limit, so nothing waiting
// on the user can drop off the list. Any status not listed as past (such as
// `stuck` once F-H6 adds it) counts as active rather than vanishing.
async function openBattles(userId) {
  const { rows } = await pool.query(
    `${LIST_SQL} AND b.status <> ALL($2::battle_status[])
     ORDER BY CASE WHEN b.status = 'proposed' THEN b.expires_at END ASC NULLS LAST, b.created_at DESC`,
    [userId, PAST],
  );
  const lists = { incoming: [], outgoing: [], active: [] };
  for (const r of rows) {
    if (r.status === 'proposed') lists[r.mine ? 'outgoing' : 'incoming'].push(r);
    else lists.active.push(r);
  }
  return lists;
}

// The four S-B3 tabs. Open call outs list soonest to expire first. Only the
// past tab is limited, most recently closed first: updated_at moves on every
// status change, except an expiry, which closed at expires_at whenever it was marked.
async function myBattles(userId) {
  const [open, { rows: past }] = await Promise.all([
    openBattles(userId),
    pool.query(
      `${LIST_SQL} AND b.status = ANY($2::battle_status[])
       ORDER BY CASE WHEN b.status = 'expired' THEN b.expires_at ELSE b.updated_at END DESC LIMIT ${PAST_LIMIT}`,
      [userId, PAST],
    ),
  ]);
  return { ...open, past };
}

module.exports = {
  VERSION_SQL, TOUCH_SQL, ACTIVE, PAST, SUBMISSIONS_OPEN, closedReason, markExpired, viewer, findOpponent, loadCallout, openBattles, myBattles,
};
