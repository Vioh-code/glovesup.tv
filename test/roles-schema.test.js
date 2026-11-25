// F-H2, F-C4: roles, permissions, role_permissions, user_roles and
// judge_assignments (02-data-model, sections 3 and 4). Rules the database
// enforces, and the starting data seeded from 04-permissions-matrix.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { requireTestDatabase } = require('./helpers/guard'); // refuses a non-test DB on load
const { pool } = require('../db');
const { clearBattles } = require('./helpers/db');

let alice;
let bob;
let judy;
let battleId;

async function makeUser(username) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at)
     VALUES ($1, $2, 'x', '\\x00', true, now()) RETURNING id`,
    [username, `${username}@example.com`],
  );
  return u.id;
}

const roleId = async (key) => (await pool.query('SELECT id FROM roles WHERE key = $1', [key])).rows[0].id;

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
                          status, accepted_at, submissions_due_at)
     VALUES ('single', 'fun', 'official', $1, $2, $1, 5, 'awaiting_panel', now(), now() + interval '120 hours') RETURNING id`,
    [alice, bob],
  ));
});
after(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.end();
});

test('the six site roles are seeded, keys unique', async () => {
  const { rows } = await pool.query('SELECT key, scope_type FROM roles ORDER BY key');
  assert.deepEqual(rows.map((r) => r.key), ['admin', 'judge', 'member', 'moderator', 'site_owner', 'super_admin']);
  assert.ok(rows.every((r) => r.scope_type === 'site'));
  await assert.rejects(pool.query("INSERT INTO roles (key, name, scope_type) VALUES ('judge', 'Again', 'site')"), /roles_key/);
});

test('seeded grants: member allows ELO, judge denies it; judge and staff may respond to assignments and judge', async () => {
  const { rows } = await pool.query(
    `SELECT r.key AS role, p.key AS perm, rp.effect FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     ORDER BY p.key, r.key`,
  );
  assert.deepEqual(rows.map((r) => `${r.perm} ${r.role} ${r.effect}`), [
    'battle.elo.enter judge deny',
    'battle.elo.enter member allow',
    'judge.assignment.respond admin allow',
    'judge.assignment.respond judge allow',
    'judge.assignment.respond moderator allow',
    'judge.assignment.respond site_owner allow',
    'judge.assignment.respond super_admin allow',
    'judge.judgment.submit admin allow',
    'judge.judgment.submit judge allow',
    'judge.judgment.submit moderator allow',
    'judge.judgment.submit site_owner allow',
    'judge.judgment.submit super_admin allow',
  ]);
  await assert.rejects(pool.query(
    "INSERT INTO role_permissions (role_id, permission_id, effect) SELECT r.id, p.id, 'maybe' FROM roles r, permissions p LIMIT 1",
  ), /invalid input value/);
});

test('a user holds a site role once; scope type and id are both null or both set', async () => {
  const judge = await roleId('judge');
  await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [judy, judge]);
  await assert.rejects(pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [judy, judge]), /user_roles_one_site/);
  await assert.rejects(pool.query(
    "INSERT INTO user_roles (user_id, role_id, scope_type) VALUES ($1, $2, 'team')", [alice, judge],
  ), /user_roles_scope/);
  const { rows: [r] } = await pool.query('SELECT granted_at, granted_by FROM user_roles WHERE user_id = $1', [judy]);
  assert.ok(r.granted_at instanceof Date);
  assert.equal(r.granted_by, null);
});

test('judge_assignments: respond_by is drawn_at plus 48 hours, one row per judge per battle', async () => {
  const { rows: [a] } = await pool.query(
    'INSERT INTO judge_assignments (battle_id, judge_user_id) VALUES ($1, $2) RETURNING *', [battleId, judy],
  );
  assert.equal(a.status, 'drawn');
  assert.equal(a.respond_by - a.drawn_at, 48 * 3600 * 1000);
  await assert.rejects(pool.query(
    'INSERT INTO judge_assignments (battle_id, judge_user_id) VALUES ($1, $2)', [battleId, judy],
  ), /judge_assignments_battle_judge/);
  await assert.rejects(pool.query(
    "INSERT INTO judge_assignments (battle_id, judge_user_id, respond_by) VALUES ($1, $2, now() + interval '1 hour')",
    [battleId, alice],
  ), /judge_assignments_respond_48h/);
  await assert.rejects(pool.query(
    "UPDATE judge_assignments SET status = 'bored' WHERE id = $1", [a.id],
  ), /invalid input value/);
});

test('battles: status accepted is never stored again; judging needs judging_due_at', async () => {
  await assert.rejects(pool.query("UPDATE battles SET status = 'accepted' WHERE id = $1", [battleId]), /battles_no_accepted/);
  await assert.rejects(pool.query("UPDATE battles SET status = 'judging' WHERE id = $1", [battleId]), /battles_judging_due/);
  await pool.query("UPDATE battles SET status = 'judging', judging_due_at = now() + interval '120 hours' WHERE id = $1", [battleId]);
});
