const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { requireTestDatabase } = require('./helpers/guard'); // refuses a non-test DB on load
const { pool } = require('../db');

const root = path.join(__dirname, '..');

after(() => pool.end());

// Same command the npm migrate scripts run, pointed at the test env file.
function migrate(direction) {
  requireTestDatabase();
  return execFileSync(
    process.execPath,
    ['--env-file=.env.test', 'scripts/migrate.js', direction],
    { cwd: root, encoding: 'utf8', stdio: 'pipe' },
  );
}

async function tableExists(name) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
  return rows[0].t !== null;
}

test('migrate script runs down and up cleanly on glovesup_test', () => {
  migrate('up'); // make sure we start fully migrated
  assert.match(migrate('down'), /glovesup_test/);
  assert.match(migrate('up'), /glovesup_test/);
  assert.match(migrate('up'), /No migrations to run/); // up is idempotent
});

async function typeExists(name) {
  const { rows } = await pool.query('SELECT 1 FROM pg_type WHERE typname = $1', [name]);
  return rows.length > 0;
}

test('judge panel, submissions, battles, session and users migrations each revert cleanly, then reapply', async () => {
  migrate('up');
  for (const t of ['roles', 'permissions', 'role_permissions', 'user_roles', 'judge_assignments']) {
    assert.ok(await tableExists(t), t);
  }
  assert.ok(await tableExists('users'));
  assert.ok(await tableExists('session'));
  assert.ok(await tableExists('battles'));
  assert.ok(await tableExists('battle_slots'));
  assert.ok(await tableExists('submissions'));

  migrate('down'); // roles tables, judge_assignments and their enums
  for (const t of ['roles', 'permissions', 'role_permissions', 'user_roles', 'judge_assignments']) {
    assert.ok(!(await tableExists(t)), t);
  }
  for (const t of ['role_scope', 'permission_effect', 'judge_assignment_status']) {
    assert.ok(!(await typeExists(t)), t);
  }
  assert.ok(await tableExists('submissions'));

  migrate('down'); // battle_slots, submissions and submission_status
  assert.ok(!(await tableExists('submissions')));
  assert.ok(!(await tableExists('battle_slots')));
  assert.ok(!(await typeExists('submission_status')));
  assert.ok(await tableExists('battles'));

  migrate('down'); // battles and its enums
  assert.ok(!(await tableExists('battles')));
  for (const t of ['battle_kind', 'battle_scoring', 'battle_judging', 'battle_status', 'battle_result', 'forfeit_reason']) {
    assert.ok(!(await typeExists(t)), t);
  }
  assert.ok(await tableExists('session'));

  migrate('down'); // session
  assert.ok(!(await tableExists('session')));
  assert.ok(await tableExists('users'));

  migrate('down'); // users and its enum
  assert.ok(!(await tableExists('users')));
  assert.ok(!(await typeExists('user_status')));

  migrate('up');
  assert.ok(await tableExists('users'));
  assert.ok(await tableExists('session'));
  assert.ok(await tableExists('battles'));
  assert.ok(await tableExists('battle_slots'));
  assert.ok(await tableExists('submissions'));
  assert.ok(await tableExists('judge_assignments'));
});

// Battles accepted before slice 2b have no slot. The migration adds one to
// each accepted 1v1 battle, and none to call outs that were never accepted.
test('the submissions migration backfills one slot per accepted 1v1 battle', async () => {
  migrate('up');
  await pool.query('DELETE FROM judge_assignments');
  await pool.query('DELETE FROM submissions');
  await pool.query('DELETE FROM battle_slots');
  await pool.query('DELETE FROM battles');
  await pool.query("DELETE FROM users WHERE username IN ('mig_a', 'mig_b')");
  const { rows: [a] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at)
     VALUES ('mig_a', 'mig_a@example.com', 'x', '\\x00', true, now()) RETURNING id`);
  const { rows: [b] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at)
     VALUES ('mig_b', 'mig_b@example.com', 'x', '\\x00', true, now()) RETURNING id`);
  migrate('down'); // judge panel
  migrate('down'); // drop slots and submissions, as on the Linode before 2b
  const insert = (status, accepted) => pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days,
                          status, accepted_at, submissions_due_at)
     VALUES ('single', 'fun', 'official', $1, $2, $1, 5, $3, $4::timestamptz, $4::timestamptz + interval '120 hours') RETURNING id`,
    [a.id, b.id, status, accepted ? new Date() : null]);
  const { rows: [acc] } = await insert('accepted', true);
  const { rows: [prop] } = await insert('proposed', false);
  migrate('up');
  const { rows } = await pool.query('SELECT * FROM battle_slots ORDER BY battle_id');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].battle_id, acc.id);
  assert.equal(rows[0].position, 1);
  assert.equal(rows[0].challenger_user_id, a.id);
  assert.equal(rows[0].opponent_user_id, b.id);
  assert.ok(prop.id);
  await pool.query('DELETE FROM battle_slots');
  await pool.query('DELETE FROM battles');
  await pool.query("DELETE FROM users WHERE username IN ('mig_a', 'mig_b')");
});

// Slice 2c-1: `accepted` is no longer a stored status. Battles accepted before
// it move to awaiting_panel (no judges drawn; top-up waits for the worker
// slice). Down moves them back. Other statuses are untouched.
test('the judge panel migration moves accepted battles to awaiting_panel, and down moves them back', async () => {
  migrate('up');
  await pool.query('DELETE FROM judge_assignments');
  await pool.query('DELETE FROM submissions');
  await pool.query('DELETE FROM battle_slots');
  await pool.query('DELETE FROM battles');
  await pool.query("DELETE FROM users WHERE username IN ('mig_a', 'mig_b')");
  const { rows: [a] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at)
     VALUES ('mig_a', 'mig_a@example.com', 'x', '\\x00', true, now()) RETURNING id`);
  const { rows: [b] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at)
     VALUES ('mig_b', 'mig_b@example.com', 'x', '\\x00', true, now()) RETURNING id`);
  migrate('down'); // judge panel: `accepted` may be stored again
  const insert = (status, accepted) => pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days,
                          status, accepted_at, submissions_due_at)
     VALUES ('single', 'fun', 'official', $1, $2, $1, 5, $3, $4::timestamptz, $4::timestamptz + interval '120 hours') RETURNING id`,
    [a.id, b.id, status, accepted ? new Date() : null]);
  const { rows: [acc] } = await insert('accepted', true);
  const { rows: [prop] } = await insert('proposed', false);
  migrate('up');
  const status = async (id) => (await pool.query('SELECT status FROM battles WHERE id = $1', [id])).rows[0].status;
  assert.equal(await status(acc.id), 'awaiting_panel');
  assert.equal(await status(prop.id), 'proposed');
  migrate('down');
  assert.equal(await status(acc.id), 'accepted');
  assert.equal(await status(prop.id), 'proposed');
  migrate('up');
  await pool.query('DELETE FROM battles');
  await pool.query("DELETE FROM users WHERE username IN ('mig_a', 'mig_b')");
});
