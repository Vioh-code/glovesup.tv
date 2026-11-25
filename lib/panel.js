// F-C4 judge panel (slice 2c-1): the random draw, judge Accept and Decline,
// and the battle status moves. Decisions (Matt, Nov 25):
// - A free judge holds the site judge role, is active and verified, is not a
//   player in the battle, and has no assignment row on it in any status (so a
//   judge who declined is never drawn again for that battle). No cap.
// - Fewer than 3 free: draw who exists; the battle waits (top-up: worker slice).
// - Decline draws a replacement at once. A reply after respond_by is still
//   taken until the worker slice replaces silent judges.
// - Status: awaiting_panel until 3 judges accepted, then submissions_open,
//   then judging once both videos are in too (judging_due_at = 5 days).
// Every change that can move the status runs in one transaction that first
// locks the battle row (withBattle), and settle() recomputes the status under
// that lock, so the last judge accept and the last video cannot race.
// Lock order everywhere: battle row, then slot row.
const { pool } = require('../db');
const { TOUCH_SQL } = require('./battles');
const { can } = require('./permissions');

const PANEL_SIZE = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Statuses where the panel is still being formed or videos still come in.
const PANEL_OPEN = ['awaiting_panel', 'submissions_open'];
const LIVE = "('submitted', 'dead_link')";

// Runs fn(client, battle) in a transaction holding the battle row lock.
// `battle` is the row as read under the lock (null if there is none).
async function withBattle(battleId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [b] } = await client.query('SELECT * FROM battles WHERE id = $1 FOR UPDATE', [battleId]);
    const out = await fn(client, b || null);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Draws up to n free judges at random for a 1v1 battle. Caller holds the battle lock.
async function drawJudges(client, battle, n) {
  if (n <= 0) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO judge_assignments (battle_id, judge_user_id)
     SELECT $1, u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id AND ur.scope_id IS NULL
     JOIN roles r ON r.id = ur.role_id AND r.key = 'judge'
     WHERE u.status = 'active' AND u.email_verified_at IS NOT NULL
       AND u.id <> $2 AND u.id <> $3
       AND NOT EXISTS (SELECT 1 FROM judge_assignments a WHERE a.battle_id = $1 AND a.judge_user_id = u.id)
     ORDER BY random() LIMIT $4`,
    [battle.id, battle.challenger_user_id, battle.opponent_user_id, n],
  );
  return rowCount;
}

// Recomputes the status of a battle whose panel is still forming. Caller holds
// the battle lock. Moves updated_at only when the status changes.
async function settle(client, battleId) {
  const { rows: [s] } = await client.query(
    `SELECT b.status,
       (SELECT count(*) FROM judge_assignments a WHERE a.battle_id = b.id AND a.status = 'accepted')::int AS accepted,
       (SELECT count(*) FROM battle_slots x WHERE x.battle_id = b.id)::int AS slots,
       (SELECT count(*) FROM submissions v JOIN battle_slots x ON x.id = v.slot_id
        WHERE x.battle_id = b.id AND v.status IN ${LIVE} AND v.locked_at IS NOT NULL)::int AS locked
     FROM battles b WHERE b.id = $1`,
    [battleId],
  );
  if (!s || !PANEL_OPEN.includes(s.status)) return s && s.status;
  const panelFull = s.accepted >= PANEL_SIZE;
  const videosIn = s.slots > 0 && s.locked === 2 * s.slots;
  let next = 'awaiting_panel';
  if (panelFull) next = videosIn ? 'judging' : 'submissions_open';
  if (next === s.status) return next;
  if (next === 'judging') {
    await client.query(
      `UPDATE battles SET status = 'judging', judging_due_at = now() + make_interval(hours => 24 * 5), ${TOUCH_SQL}
       WHERE id = $1`,
      [battleId],
    );
    await client.query(
      `UPDATE judge_assignments SET score_due_at = (SELECT judging_due_at FROM battles WHERE id = $1)
       WHERE battle_id = $1 AND status = 'accepted'`,
      [battleId],
    );
  } else {
    await client.query(`UPDATE battles SET status = $2, ${TOUCH_SQL} WHERE id = $1`, [battleId, next]);
  }
  return next;
}

// A judge's Accept or Decline. Returns one of:
// 'notFound' (no such assignment for this user), 'forbidden' (no longer may
// respond), 'same' (a repeat of their own reply), 'closed' (the battle is no
// longer active), 'refused' (already answered the other way), 'done'.
async function respond(assignmentId, userId, action) {
  if (typeof assignmentId !== 'string' || !UUID_RE.test(assignmentId)) return 'notFound';
  const { rows: [a] } = await pool.query(
    'SELECT battle_id FROM judge_assignments WHERE id = $1 AND judge_user_id = $2', [assignmentId, userId],
  );
  if (!a) return 'notFound';
  if (!(await can(userId, 'judge.assignment.respond'))) return 'forbidden';
  const target = action === 'accept' ? 'accepted' : 'declined';
  return withBattle(a.battle_id, async (client, battle) => {
    const { rows: [row] } = await client.query('SELECT status FROM judge_assignments WHERE id = $1', [assignmentId]);
    if (row.status === target) return 'same';
    if (!PANEL_OPEN.includes(battle.status)) return 'closed';
    if (row.status !== 'drawn') return 'refused';
    await client.query(
      'UPDATE judge_assignments SET status = $2, responded_at = now() WHERE id = $1', [assignmentId, target],
    );
    if (target === 'declined') await drawJudges(client, battle, 1);
    await settle(client, battle.id);
    return 'done';
  });
}

// S-J1 rows for one judge: only their own assignments, never co-judges.
async function assignmentsFor(userId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.status, a.respond_by, a.score_due_at, a.responded_at, a.drawn_at,
            b.kind, b.scoring, b.status AS battle_status, b.submissions_due_at, b.judging_due_at,
            c.username AS challenger_name, o.username AS opponent_name
     FROM judge_assignments a
     JOIN battles b ON b.id = a.battle_id
     JOIN users c ON c.id = b.challenger_user_id
     JOIN users o ON o.id = b.opponent_user_id
     WHERE a.judge_user_id = $1
     ORDER BY CASE WHEN a.status = 'drawn' THEN a.respond_by END ASC NULLS LAST, a.drawn_at DESC`,
    [userId],
  );
  const tabs = { requests: [], accepted: [], history: [] };
  for (const r of rows) {
    if (r.status === 'drawn' && PANEL_OPEN.includes(r.battle_status)) tabs.requests.push(r);
    else if (r.status === 'accepted' && [...PANEL_OPEN, 'judging'].includes(r.battle_status)) tabs.accepted.push(r);
    else tabs.history.push(r);
  }
  return tabs;
}

// S-B4 for the two players: each live judge's status in draw order, no names
// and no ids. Declined rows are left out (they were replaced).
async function panelStatus(battleId) {
  const { rows } = await pool.query(
    `SELECT status, respond_by FROM judge_assignments
     WHERE battle_id = $1 AND status IN ('drawn', 'accepted', 'scored')
     ORDER BY drawn_at, id`,
    [battleId],
  );
  return rows;
}

module.exports = {
  PANEL_SIZE, PANEL_OPEN, withBattle, drawJudges, settle, respond, assignmentsFor, panelStatus,
};
