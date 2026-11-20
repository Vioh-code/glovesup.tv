const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pool } = require('../db');

before(() => {
  execFileSync(process.execPath, ['--env-file=.env.test', 'scripts/migrate.js', 'up'], {
    cwd: path.join(__dirname, '..'), stdio: 'pipe',
  });
});
beforeEach(() => pool.query('DELETE FROM users'));
after(async () => {
  await pool.query('DELETE FROM users');
  await pool.end();
});

function insert(overrides = {}) {
  const row = {
    username: 'Glover_1',
    email: 'glover@example.com',
    password_hash: 'x',
    dob_encrypted: Buffer.from('x'),
    age_gate_passed: true,
    terms_accepted_at: new Date(),
    ...overrides,
  };
  const cols = Object.keys(row);
  return pool.query(
    `INSERT INTO users (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    Object.values(row),
  );
}

test('a new user defaults to active, ELO 1000, unverified email', async () => {
  const { rows: [u] } = await insert();
  assert.equal(u.status, 'active');
  assert.equal(u.elo_rating, 1000);
  assert.equal(u.email_verified_at, null);
  assert.match(u.id, /^[0-9a-f-]{36}$/);
});

test('username is unique regardless of case', async () => {
  await insert();
  await assert.rejects(insert({ username: 'GLOVER_1', email: 'other@example.com' }), { code: '23505' });
});

test('email is unique regardless of case', async () => {
  await insert();
  await assert.rejects(insert({ username: 'Other', email: 'Glover@Example.COM' }), { code: '23505' });
});

test('a live account must have email, password hash, DOB and terms acceptance', async () => {
  for (const field of ['email', 'password_hash', 'dob_encrypted', 'terms_accepted_at']) {
    await assert.rejects(insert({ [field]: null }), { code: '23514' }, field);
  }
});

test('a row that failed the age gate cannot be stored', async () => {
  await assert.rejects(insert({ age_gate_passed: false }), { code: '23514' });
});
