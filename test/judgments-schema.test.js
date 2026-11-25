// F-C4, F-C5: judgments, recused_at, the finalized check and the
// judge.judgment.submit seed (02-data-model, section 3; slice 2c-2). Rules the
// database enforces, whatever the app does.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { requireTestDatabase } = require('./helpers/guard'); // refuses a non-test DB on load
const { pool } = require('../db');
const { can } = require('../lib/permissions');
const { clearBattles } = require('./helpers/db');

let alice;
let bob;
let judy;
let battleId;
let slotId;
let assignmentId;

async function makeUser(username, status = 'active') {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at, status)
     VALUES ($1, $2, 'x', '\\x00', true, now(), $3) RETURNING id`,
    [username, `${username}@example.com`, status],
  );
  return u.id;
}
const grant = (userId, key) => pool.query(
  'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2', [userId, key],
);
const insertJudgment = (fields) => {
  const cols = { assignment_id: assignmentId, slot_id: slotId, pick: 'challenger', ...fields };
  const keys = Object.keys(cols);
  return pool.query(
    `INSERT INTO judgments (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => cols[k]),
  );
};

before(async () => {
  requireTestDatabase();
  execFileSync(process.execPath, ['--env-file=.env.test', 'scripts/migrate.js', 'up'], {
    cwd: path.join(__dirname, '..'), stdio: 'pipe',
  });
});
beforeEach(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  alice = await makeUser('alice');
  bob = await makeUser('bob');
  judy = await makeUser('judy');
  ({ rows: [{ id: battleId }] } = await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days,
                          status, accepted_at, submissions_due_at, judging_due_at)
     VALUES ('single', 'fun', 'official', $1, $2, $1, 5, 'judging', now(), now() + interval '120 hours',
             now() + interval '120 hours') RETURNING id`,
    [alice, bob],
  ));
  ({ rows: [{ id: slotId }] } = await pool.query(
    `INSERT INTO battle_slots (battle_id, position, challenger_user_id, opponent_user_id)
     VALUES ($1, 1, $2, $3) RETURNING id`, [battleId, alice, bob],
  ));
  ({ rows: [{ id: assignmentId }] } = await pool.query(
    "INSERT INTO judge_assignments (battle_id, judge_user_id, status) VALUES ($1, $2, 'accepted') RETURNING id",
    [battleId, judy],
  ));
});
after(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.end();
});

test('judgments: a typed reason, a review video, or both; submitted_at defaults, reasons_public_at starts null', async () => {
  const { rows: [j] } = await insertJudgment({ reason_text: 'Cleaner flow' });
  assert.equal(j.pick, 'challenger');
  assert.ok(j.submitted_at instanceof Date);
  assert.equal(j.reasons_public_at, null);
  await pool.query('DELETE FROM judgments');
  await insertJudgment({ reason_video_url: 'https://www.youtube.com/watch?v=abcdefghijk', reason_video_id: 'abcdefghijk' });
  await pool.query('DELETE FROM judgments');
  await insertJudgment({
    pick: 'opponent', reason_text: 'Both', reason_video_url: 'https://www.youtube.com/watch?v=abcdefghijk', reason_video_id: 'abcdefghijk',
  });
});

test('judgments: no reason at all, a blank reason, or a reason over 2,000 characters is refused', async () => {
  await assert.rejects(insertJudgment({}), /judgments_reason_required/);
  await assert.rejects(insertJudgment({ reason_text: '   ' }), /judgments_reason_text_length/);
  await assert.rejects(insertJudgment({ reason_text: 'x'.repeat(2001) }), /judgments_reason_text_length/);
  await insertJudgment({ reason_text: 'x'.repeat(2000) });
});

test('judgments: review video url and id come together, and the id is a YouTube id', async () => {
  await assert.rejects(insertJudgment({ reason_text: 'a', reason_video_url: 'https://www.youtube.com/watch?v=abcdefghijk' }),
    /judgments_reason_video_pair/);
  await assert.rejects(insertJudgment({ reason_text: 'a', reason_video_id: 'abcdefghijk' }), /judgments_reason_video_pair/);
  await assert.rejects(insertJudgment({ reason_video_url: 'https://x', reason_video_id: 'short' }), /judgments_reason_video_id/);
});

test('judgments: pick is challenger or opponent; one row per assignment per slot', async () => {
  await assert.rejects(insertJudgment({ reason_text: 'a', pick: 'void' }), /invalid input value/);
  await assert.rejects(insertJudgment({ reason_text: 'a', pick: null }), /null value/);
  await insertJudgment({ reason_text: 'a' });
  await assert.rejects(insertJudgment({ reason_text: 'b', pick: 'opponent' }), /judgments_assignment_slot/);
});

test('judge_assignments: recused_at is set exactly when the status is recused', async () => {
  await assert.rejects(pool.query("UPDATE judge_assignments SET status = 'recused' WHERE id = $1", [assignmentId]),
    /judge_assignments_recused_at/);
  await assert.rejects(pool.query('UPDATE judge_assignments SET recused_at = now() WHERE id = $1', [assignmentId]),
    /judge_assignments_recused_at/);
  await pool.query("UPDATE judge_assignments SET status = 'recused', recused_at = now() WHERE id = $1", [assignmentId]);
});

test('battles: finalized needs a result and finalized_at', async () => {
  await assert.rejects(pool.query("UPDATE battles SET status = 'finalized' WHERE id = $1", [battleId]), /battles_finalized_result/);
  await assert.rejects(pool.query("UPDATE battles SET status = 'finalized', result = 'challenger' WHERE id = $1", [battleId]),
    /battles_finalized_result/);
  await assert.rejects(pool.query("UPDATE battles SET status = 'finalized', finalized_at = now() WHERE id = $1", [battleId]),
    /battles_finalized_result/);
  await pool.query("UPDATE battles SET status = 'finalized', result = 'opponent', finalized_at = now() WHERE id = $1", [battleId]);
});

test('seed: judge.judgment.submit for judge, moderator, admin, super admin and site owner; not members or banned judges', async () => {
  const { rows } = await pool.query(
    `SELECT r.key, rp.effect FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
     JOIN permissions p ON p.id = rp.permission_id WHERE p.key = 'judge.judgment.submit' ORDER BY r.key`,
  );
  assert.deepEqual(rows.map((r) => `${r.key} ${r.effect}`),
    ['admin allow', 'judge allow', 'moderator allow', 'site_owner allow', 'super_admin allow']);
  await grant(judy, 'judge');
  assert.equal(await can(judy, 'judge.judgment.submit'), true);
  assert.equal(await can(alice, 'judge.judgment.submit'), false);
  const banned = await makeUser('banjo', 'banned');
  await grant(banned, 'judge');
  assert.equal(await can(banned, 'judge.judgment.submit'), false);
  const mod = await makeUser('modi');
  await grant(mod, 'moderator');
  assert.equal(await can(mod, 'judge.judgment.submit'), true);
});
