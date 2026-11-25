// F-C4, F-C5 judging (slice 2c-2): S-J2 pick plus reason, the 2-of-3
// majority, finalize, and recusal. Decisions (Matt, Nov 25):
// - a judge picks once their assignment is accepted and both videos are
//   locked (judging, or awaiting_panel after a co-judge recused), with
//   judge.judgment.submit. Submitting locks the judgment (status scored);
// - a reason is typed (1 to 2,000 characters), a checked YouTube review
//   video, or both;
// - finalize only when all 3 seats have submitted, never on fewer picks;
//   judges never produce void. A silent judge is replaced by the worker slice;
// - recusal: an accepted judge who has not submitted, while the battle is in
//   play. A replacement is drawn at once and settle() moves the battle back to
//   awaiting_panel. Due dates: see settle() in lib/panel.js;
// - ELO does not move here. Slice 2d adds its ledger rows inside finalize(),
//   in the same transaction (marked below).
// Every write runs in withBattle (battle row lock first), so a recusal and a
// last pick cannot race.
const { pool } = require('../db');
const { TOUCH_SQL } = require('./battles');
const { can } = require('./permissions');
const {
  PANEL_SIZE, IN_PLAY, videosLockedSql, withBattle, drawJudges, settle,
} = require('./panel');

const PICKS = ['challenger', 'opponent'];
const REASON_MAX = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The majority of exactly 3 picks: { winner, votes }.
function majority(picks) {
  if (!Array.isArray(picks) || picks.length !== PANEL_SIZE || !picks.every((p) => PICKS.includes(p))) {
    throw new Error('majority needs exactly 3 picks, each challenger or opponent');
  }
  const c = picks.filter((p) => p === 'challenger').length;
  return c >= 2 ? { winner: 'challenger', votes: c } : { winner: 'opponent', votes: PANEL_SIZE - c };
}

// A team battle: the side that wins at least 2 of its 3 pairings.
function teamResult(results) {
  if (!Array.isArray(results) || results.length !== 3 || !results.every((r) => PICKS.includes(r))) {
    throw new Error('teamResult needs exactly 3 pairing results, each challenger or opponent');
  }
  return results.filter((r) => r === 'challenger').length >= 2 ? 'challenger' : 'opponent';
}

// Why this judge cannot pick now, or null. `a` is the assignment and
// `b` the battle (both as read; checked again under the lock).
function whyNot(a, b, videosIn) {
  if (a.status === 'scored') return 'locked';
  if (!IN_PLAY.includes(b.status)) return 'closed';
  if (a.status === 'drawn') return 'notAccepted';
  if (a.status !== 'accepted') return 'off';
  if (!videosIn) return 'notReady';
  return null;
}

// The S-J2 context for one judge's own assignment, or null (anyone else's,
// or no such id). Never includes a co-judge's judgment.
async function load(assignmentId, userId) {
  if (typeof assignmentId !== 'string' || !UUID_RE.test(assignmentId)) return null;
  const { rows: [a] } = await pool.query(
    `SELECT a.*, ${videosLockedSql('a.battle_id')} AS videos_in
     FROM judge_assignments a WHERE a.id = $1 AND a.judge_user_id = $2`,
    [assignmentId, userId],
  );
  if (!a) return null;
  const { rows: [b] } = await pool.query(
    `SELECT b.*, c.username AS challenger_name, o.username AS opponent_name
     FROM battles b JOIN users c ON c.id = b.challenger_user_id JOIN users o ON o.id = b.opponent_user_id
     WHERE b.id = $1`,
    [a.battle_id],
  );
  const { rows: [judgment] } = await pool.query('SELECT * FROM judgments WHERE assignment_id = $1', [a.id]);
  // Both videos, once locked (the judge never sees them earlier).
  let videos = null;
  if (a.videos_in) {
    const { rows } = await pool.query(
      `SELECT v.* FROM submissions v JOIN battle_slots x ON x.id = v.slot_id
       WHERE x.battle_id = $1 AND v.status IN ('submitted', 'dead_link')`,
      [b.id],
    );
    videos = {
      challenger: rows.find((v) => v.user_id === b.challenger_user_id),
      opponent: rows.find((v) => v.user_id === b.opponent_user_id),
    };
  }
  return { assignment: a, battle: b, judgment: judgment || null, videos, why: whyNot(a, b, a.videos_in) };
}

// The judgment already stored is the one in this form (a repeat submit).
function sameJudgment(j, form) {
  return Boolean(j) && j.pick === form.pick && (j.reason_text || null) === (form.reasonText || null)
    && (j.reason_video_id || null) === (form.video ? form.video.videoId : null);
}

// Ends the battle once all 3 seats have submitted. Caller holds the battle
// lock and has just settled the status. Returns true when it finalized.
async function finalize(client, battleId) {
  const { rows: [b] } = await client.query(
    `SELECT status, (SELECT count(*) FROM judge_assignments a WHERE a.battle_id = $1 AND a.status = 'scored')::int AS scored
     FROM battles WHERE id = $1`,
    [battleId],
  );
  if (b.status !== 'judging' || b.scored < PANEL_SIZE) return false;
  const { rows: slots } = await client.query(
    'SELECT id FROM battle_slots WHERE battle_id = $1 ORDER BY position FOR UPDATE', [battleId],
  );
  const results = [];
  for (const slot of slots) {
    const { rows } = await client.query(
      `SELECT j.pick FROM judgments j JOIN judge_assignments a ON a.id = j.assignment_id
       WHERE j.slot_id = $1 AND a.status = 'scored'`,
      [slot.id],
    );
    const { winner } = majority(rows.map((r) => r.pick));
    await client.query('UPDATE battle_slots SET result = $2 WHERE id = $1', [slot.id, winner]);
    results.push(winner);
  }
  const result = results.length === 1 ? results[0] : teamResult(results);
  await client.query(
    `UPDATE battles SET status = 'finalized', result = $2, finalized_at = now(), ${TOUCH_SQL} WHERE id = $1`,
    [battleId, result],
  );
  await client.query(
    `UPDATE judgments SET reasons_public_at = now()
     WHERE assignment_id IN (SELECT id FROM judge_assignments WHERE battle_id = $1)`,
    [battleId],
  );
  // Slice 2d hook: on scoring = 'elo', add the elo_ledger rows for both
  // players here (K = 32), in this same transaction. Just for fun never moves
  // ratings. No ELO call outs in production until slice 2d is live (Matt, Nov 25).
  return true;
}

// Saves a judge's judgment. `form`: { pick, reasonText (trimmed or null),
// video ({ url, videoId } already checked with YouTube, or null) }.
// Returns 'notFound', 'forbidden', 'same', or a whyNot key, or 'done'.
async function submit(assignmentId, userId, form) {
  if (typeof assignmentId !== 'string' || !UUID_RE.test(assignmentId)) return 'notFound';
  const { rows: [found] } = await pool.query(
    'SELECT battle_id FROM judge_assignments WHERE id = $1 AND judge_user_id = $2', [assignmentId, userId],
  );
  if (!found) return 'notFound';
  if (!(await can(userId, 'judge.judgment.submit'))) return 'forbidden';
  return withBattle(found.battle_id, async (client, battle) => {
    const { rows: [a] } = await client.query(
      `SELECT a.*, ${videosLockedSql('a.battle_id')} AS videos_in FROM judge_assignments a WHERE a.id = $1`, [assignmentId],
    );
    if (a.status === 'scored') {
      const { rows: [j] } = await client.query('SELECT * FROM judgments WHERE assignment_id = $1', [assignmentId]);
      return sameJudgment(j, form) ? 'same' : 'locked';
    }
    const why = whyNot(a, battle, a.videos_in);
    if (why) return why;
    const { rows: slots } = await client.query('SELECT id FROM battle_slots WHERE battle_id = $1', [battle.id]);
    // One pick per pairing; the team form (three picks) comes with the teams slice.
    if (slots.length !== 1) throw new Error('team battles are judged from the teams slice on');
    await client.query(
      `INSERT INTO judgments (assignment_id, slot_id, pick, reason_text, reason_video_url, reason_video_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [assignmentId, slots[0].id, form.pick, form.reasonText || null,
        form.video ? form.video.url : null, form.video ? form.video.videoId : null],
    );
    await client.query("UPDATE judge_assignments SET status = 'scored' WHERE id = $1", [assignmentId]);
    await settle(client, battle.id);
    await finalize(client, battle.id);
    return 'done';
  });
}

// A judge's recusal. Returns 'notFound', 'forbidden', 'same' (already
// recused), 'closed' (the battle is over), 'drawn' (not accepted: use
// Decline), 'locked' (already submitted), 'off' (declined or replaced), 'done'.
async function recuse(assignmentId, userId) {
  if (typeof assignmentId !== 'string' || !UUID_RE.test(assignmentId)) return 'notFound';
  const { rows: [found] } = await pool.query(
    'SELECT battle_id FROM judge_assignments WHERE id = $1 AND judge_user_id = $2', [assignmentId, userId],
  );
  if (!found) return 'notFound';
  if (!(await can(userId, 'judge.assignment.respond'))) return 'forbidden';
  return withBattle(found.battle_id, async (client, battle) => {
    const { rows: [a] } = await client.query('SELECT status FROM judge_assignments WHERE id = $1', [assignmentId]);
    if (a.status === 'recused') return 'same';
    if (a.status === 'scored') return 'locked';
    if (!IN_PLAY.includes(battle.status)) return 'closed';
    if (a.status === 'drawn') return 'drawn';
    if (a.status !== 'accepted') return 'off';
    await client.query(
      "UPDATE judge_assignments SET status = 'recused', recused_at = now() WHERE id = $1", [assignmentId],
    );
    await drawJudges(client, battle, 1);
    await settle(client, battle.id);
    return 'done';
  });
}

// The judging outcome of a finalized battle: the winner, how many of the 3
// judges picked them, and each judge's name, pick and reason. Public once
// all judging is complete (reasons_public_at). Null before that.
async function outcome(battleId) {
  const { rows: [b] } = await pool.query(
    `SELECT b.status, b.result, c.username AS challenger_name, o.username AS opponent_name
     FROM battles b JOIN users c ON c.id = b.challenger_user_id JOIN users o ON o.id = b.opponent_user_id
     WHERE b.id = $1`,
    [battleId],
  );
  if (!b || b.status !== 'finalized') return null;
  const { rows } = await pool.query(
    `SELECT u.username AS judge, j.pick, j.reason_text, j.reason_video_url
     FROM judgments j JOIN judge_assignments a ON a.id = j.assignment_id JOIN users u ON u.id = a.judge_user_id
     WHERE a.battle_id = $1 AND j.reasons_public_at IS NOT NULL
     ORDER BY a.drawn_at, u.username`,
    [battleId],
  );
  if (!rows.length) return null;
  const name = (side) => (side === 'challenger' ? b.challenger_name : b.opponent_name);
  return {
    winner: name(b.result),
    votes: rows.filter((r) => r.pick === b.result).length,
    of: rows.length,
    verdicts: rows.map((r) => ({ ...r, pickName: name(r.pick) })),
  };
}

module.exports = {
  REASON_MAX, PICKS, majority, teamResult, whyNot, load, sameJudgment, finalize, submit, recuse, outcome,
};
