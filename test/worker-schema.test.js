// Worker slice: the rules the database enforces for replaced judges, forfeits
// and voids, and the partial indexes the worker's sweeps use
// (02-data-model, section 3; migration 1799712000000_worker).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { requireTestDatabase } = require('./helpers/guard'); // refuses a non-test DB on load
const { pool } = require('../db');
const { clearBattles } = require('./helpers/db');

const root = path.join(__dirname, '..');
let alice;
let bob;
let judy;
let battleId;
let assignmentId;

const migrate = (direction) => {
  requireTestDatabase();
  return execFileSync(process.execPath, ['--env-file=.env.test', 'scripts/migrate.js', direction], {
    cwd: root, encoding: 'utf8', stdio: 'pipe',
  });
};

async function makeUser(username) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at)
     VALUES ($1, $2, 'x', '\\x00', true, now()) RETURNING id`,
    [username, `${username}@example.com`],
  );
  return u.id;
}
const setBattle = (sql, params = []) => pool.query(`UPDATE battles SET ${sql} WHERE id = $1`, [battleId, ...params]);
const setAssignment = (sql) => pool.query(`UPDATE judge_assignments SET ${sql} WHERE id = $1`, [assignmentId]);

before(() => migrate('up'));
beforeEach(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  alice = await makeUser('alice');
  bob = await makeUser('bob');
  judy = await makeUser('judy');
  ({ rows: [{ id: battleId }] } = await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days,
                          status, accepted_at, submissions_due_at)
     VALUES ('single', 'fun', 'official', $1, $2, $1, 5, 'submissions_open', now(), now() + interval '120 hours')
     RETURNING id`,
    [alice, bob],
  ));
  ({ rows: [{ id: assignmentId }] } = await pool.query(
    'INSERT INTO judge_assignments (battle_id, judge_user_id) VALUES ($1, $2) RETURNING id', [battleId, judy],
  ));
});
after(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.end();
});

// 1
test('judge_assignments: replaced needs replaced_at and a reason; others have neither; only no_reply or no_pick', async () => {
  await assert.rejects(setAssignment("status = 'replaced'"), /judge_assignments_replaced/);
  await assert.rejects(setAssignment("status = 'replaced', replaced_at = now()"), /judge_assignments_replaced_reason/);
  await assert.rejects(setAssignment("status = 'replaced', replaced_reason = 'no_reply'"), /judge_assignments_replaced_at/);
  await assert.rejects(setAssignment('replaced_at = now()'), /judge_assignments_replaced_at/);
  await assert.rejects(setAssignment("replaced_reason = 'no_pick'"), /judge_assignments_replaced_reason/);
  await assert.rejects(setAssignment("status = 'replaced', replaced_at = now(), replaced_reason = 'bored'"),
    /judge_assignments_replaced_reason/);
  await setAssignment("status = 'replaced', replaced_at = now(), replaced_reason = 'no_reply'");
  await setAssignment("replaced_reason = 'no_pick'");
});

// 2
test('battles: forfeited needs forfeited_by, a reason, a challenger or opponent result and finalized_at; forfeit fields only on forfeits', async () => {
  const full = "status = 'forfeited', forfeited_by = $2, forfeit_reason = 'missed_deadline', result = 'challenger', finalized_at = now()";
  await assert.rejects(setBattle("status = 'forfeited'"), /battles_forfeit/);
  await assert.rejects(setBattle(full.replace(', forfeited_by = $2', '')), /battles_forfeit/);
  await assert.rejects(setBattle(full.replace(", forfeit_reason = 'missed_deadline'", ''), [bob]), /battles_forfeit/);
  await assert.rejects(setBattle(full.replace(", result = 'challenger'", ''), [bob]), /battles_forfeit/);
  await assert.rejects(setBattle(full.replace("result = 'challenger'", "result = 'void'"), [bob]), /battles_forfeit/);
  await assert.rejects(setBattle(full.replace(', finalized_at = now()', ''), [bob]), /battles_forfeit/);
  await assert.rejects(setBattle('forfeited_by = $2', [bob]), /battles_forfeit/);
  await assert.rejects(setBattle("forfeit_reason = 'explicit'"), /battles_forfeit/);
  await setBattle(full, [bob]);
});

// 3
test('battles: voided needs result void and finalized_at', async () => {
  await assert.rejects(setBattle("status = 'voided'"), /battles_voided/);
  await assert.rejects(setBattle("status = 'voided', result = 'void'"), /battles_voided/);
  await assert.rejects(setBattle("status = 'voided', result = 'challenger', finalized_at = now()"), /battles_voided/);
  await assert.rejects(setBattle("status = 'voided', finalized_at = now()"), /battles_voided/);
  await setBattle("status = 'voided', result = 'void', finalized_at = now()");
});

// 4
test('the four partial indexes for the worker sweeps exist with their conditions', async () => {
  const { rows } = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN
     ('judge_assignments_reply_due', 'judge_assignments_pick_due', 'battles_submissions_due', 'submissions_recheck_due')`,
  );
  const def = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
  assert.match(def.judge_assignments_reply_due, /\(respond_by\) WHERE \(status = 'drawn'/);
  assert.match(def.judge_assignments_pick_due, /\(score_due_at\) WHERE \(status = 'accepted'/);
  assert.match(def.battles_submissions_due, /\(submissions_due_at\) WHERE \(status = ANY/);
  assert.match(def.battles_submissions_due, /awaiting_panel/);
  assert.match(def.battles_submissions_due, /submissions_open/);
  assert.match(def.submissions_recheck_due, /COALESCE\(last_checked_at, submitted_at\)/);
  assert.match(def.submissions_recheck_due, /dead_link/);
});

// 5
test('the worker migration reverts cleanly and reapplies', async () => {
  await clearBattles(pool);
  migrate('down');
  const { rows: col } = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'judge_assignments' AND column_name = 'replaced_at'",
  );
  assert.equal(col.length, 0);
  const { rows: chk } = await pool.query(
    `SELECT conname FROM pg_constraint WHERE conname IN
     ('battles_forfeit', 'battles_voided', 'judge_assignments_replaced_at', 'judge_assignments_replaced_reason')`,
  );
  assert.equal(chk.length, 0);
  const { rows: idx } = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'submissions_recheck_due'");
  assert.equal(idx.length, 0);
  migrate('up');
  const { rows: back } = await pool.query("SELECT 1 FROM pg_constraint WHERE conname = 'battles_forfeit'");
  assert.equal(back.length, 1);
});
