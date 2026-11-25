// scripts/grant-role.js <username> <role>: stands in for a super admin
// assigning a site role directly (F-E1) until the admin screens exist.
// Idempotent; refuses unverified and non-active accounts, unknown users and
// roles, and team roles. Reads DB settings from the process environment.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pool } = require('../db');
const { clearBattles } = require('./helpers/db');
const { grantRole } = require('../scripts/grant-role');

const root = path.join(__dirname, '..');

async function addUser(username, { status = 'active', verified = true } = {}) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at, status,
                        email_verified_at)
     VALUES ($1, $2, 'x', '\\x00', true, now(), $3, $4) RETURNING id`,
    [username, `${username}@example.com`, status, verified ? new Date() : null],
  );
  return u.id;
}
const roles = async (username) => (await pool.query(
  `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
   WHERE lower(u.username) = lower($1) ORDER BY r.key`, [username],
)).rows.map((r) => r.key);

// The script exactly as Matt runs it, with this process's environment (the
// test DB settings npm test loaded). No env file is read here.
const run = (...args) => spawnSync(process.execPath, ['scripts/grant-role.js', ...args], {
  cwd: root, encoding: 'utf8', env: process.env,
});

before(async () => {
  await clearBattles(pool);
});
beforeEach(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await addUser('Judy');
});
after(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.end();
});

test('grants a site role; username ignores case', async () => {
  const out = await grantRole('judy', 'judge');
  assert.equal(out.result, 'granted');
  assert.deepEqual(await roles('Judy'), ['judge']);
});

test('running it twice grants once and says so', async () => {
  await grantRole('Judy', 'judge');
  const out = await grantRole('Judy', 'judge');
  assert.equal(out.result, 'already');
  assert.deepEqual(await roles('Judy'), ['judge']);
});

test('refuses unknown users, unverified accounts and non-active accounts', async () => {
  await addUser('Unver', { verified: false });
  await addUser('Banned', { status: 'banned' });
  await addUser('Susp', { status: 'suspended' });
  await assert.rejects(grantRole('nobody', 'judge'), /No account named "nobody"/);
  await assert.rejects(grantRole('Unver', 'judge'), /has not verified their email/);
  await assert.rejects(grantRole('Banned', 'judge'), /is banned/);
  await assert.rejects(grantRole('Susp', 'judge'), /is suspended/);
  for (const u of ['Unver', 'Banned', 'Susp']) assert.deepEqual(await roles(u), [], u);
});

test('refuses unknown roles and member (every account is a member already)', async () => {
  await assert.rejects(grantRole('Judy', 'wizard'), /Unknown role "wizard"/);
  await assert.rejects(grantRole('Judy', 'member'), /Every account is a member/);
  assert.deepEqual(await roles('Judy'), []);
});

test('refuses team roles: they need a team and come with the teams slice', async () => {
  await pool.query("INSERT INTO roles (key, name, scope_type) VALUES ('team_test', 'Team test', 'team')");
  try {
    await assert.rejects(grantRole('Judy', 'team_test'), /team role/);
    assert.deepEqual(await roles('Judy'), []);
  } finally {
    await pool.query("DELETE FROM roles WHERE key = 'team_test'");
  }
});

test('command line: grants with exit 0, refuses with exit 1 and a reason, usage without arguments', async () => {
  const ok = run('Judy', 'judge');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Granted judge to Judy/);
  const again = run('Judy', 'judge');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Judy already has judge/);
  const bad = run('nobody', 'judge');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /No account named "nobody"/);
  const usage = run();
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage: node --env-file=<file> scripts\/grant-role\.js <username> <role>/);
  assert.deepEqual(await roles('Judy'), ['judge']);
});
