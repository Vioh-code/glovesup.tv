// F-H2: can(userId, key). Roles stack (04-permissions-matrix): every active
// account is a Member without a user_roles row; any held role may add an
// allow; a deny on any held role (the matrix's NO) wins over every allow.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { clearBattles } = require('./helpers/db');
const { can, hasRole } = require('../lib/permissions');

const ids = {};

async function addUser(username, status = 'active') {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at, status,
                        email_verified_at)
     VALUES ($1, $2, 'x', '\\x00', true, now(), $3, now()) RETURNING id`,
    [username, `${username}@example.com`, status],
  );
  return u.id;
}
const grant = (user, key) => pool.query(
  'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2', [user, key],
);

before(async () => {
  await clearBattles(pool);
});
beforeEach(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  ids.mem = await addUser('mem');
  ids.judge = await addUser('judge');
  ids.both = await addUser('both');
  ids.mod = await addUser('mod');
  await grant(ids.judge, 'judge');
  await grant(ids.both, 'judge');
  await grant(ids.both, 'admin');
  await grant(ids.mod, 'moderator');
});
after(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.end();
});

test('a member with no roles may enter ELO battles', async () => {
  assert.equal(await can(ids.mem, 'battle.elo.enter'), true);
});

test('a judge may not enter ELO battles: the deny wins over the member allow', async () => {
  assert.equal(await can(ids.judge, 'battle.elo.enter'), false);
});

test('a judge who is also an admin is still barred from ELO battles', async () => {
  assert.equal(await can(ids.both, 'battle.elo.enter'), false);
});

test('only judges and staff may respond to a judge assignment', async () => {
  assert.equal(await can(ids.mem, 'judge.assignment.respond'), false);
  assert.equal(await can(ids.judge, 'judge.assignment.respond'), true);
  assert.equal(await can(ids.mod, 'judge.assignment.respond'), true);
  assert.equal(await can(ids.mod, 'battle.elo.enter'), true);
});

test('banned, suspended, deleted and unknown users get false for everything', async () => {
  for (const status of ['banned', 'suspended']) {
    await pool.query('UPDATE users SET status = $1 WHERE id = $2', [status, ids.judge]);
    assert.equal(await can(ids.judge, 'judge.assignment.respond'), false, status);
    await pool.query('UPDATE users SET status = $1 WHERE id = $2', [status, ids.mem]);
    assert.equal(await can(ids.mem, 'battle.elo.enter'), false, status);
  }
  assert.equal(await can('00000000-0000-0000-0000-000000000000', 'battle.elo.enter'), false);
  assert.equal(await can(ids.mem, 'no.such.permission'), false);
});

test('a revoked role no longer counts', async () => {
  await pool.query('DELETE FROM user_roles WHERE user_id = $1', [ids.judge]);
  assert.equal(await can(ids.judge, 'battle.elo.enter'), true);
  assert.equal(await can(ids.judge, 'judge.assignment.respond'), false);
});

test('hasRole names held site roles only; member is implicit', async () => {
  assert.equal(await hasRole(ids.judge, 'judge'), true);
  assert.equal(await hasRole(ids.mem, 'judge'), false);
  assert.equal(await hasRole(ids.mod, 'judge'), false);
});
