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

// Marks every past-due proposed call out expired. Stands in for the worker
// until the worker slice. Uses the battles_proposed_expiry partial index.
const markExpired = () => pool.query(
  `UPDATE battles SET status = 'expired', ${TOUCH_SQL}
   WHERE status = 'proposed' AND expires_at <= now()`,
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
    `${LIST_SQL} AND b.status <> ALL($2::battle_status[]) ORDER BY b.created_at DESC`,
    [userId, PAST],
  );
  const lists = { incoming: [], outgoing: [], active: [] };
  for (const r of rows) {
    if (r.status === 'proposed') lists[r.mine ? 'outgoing' : 'incoming'].push(r);
    else lists.active.push(r);
  }
  return lists;
}

// The four S-B3 tabs. Only the past tab is limited (newest first).
async function myBattles(userId) {
  const [open, { rows: past }] = await Promise.all([
    openBattles(userId),
    pool.query(
      `${LIST_SQL} AND b.status = ANY($2::battle_status[]) ORDER BY b.created_at DESC LIMIT ${PAST_LIMIT}`,
      [userId, PAST],
    ),
  ]);
  return { ...open, past };
}

module.exports = {
  VERSION_SQL, TOUCH_SQL, ACTIVE, PAST, markExpired, viewer, findOpponent, loadCallout, openBattles, myBattles,
};
