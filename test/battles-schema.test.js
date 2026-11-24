// F-C1, F-C2: battles table (02-data-model, section 3). A call out is a
// battle in the proposed state. These are the rules the database itself
// enforces, so no code path can store a battle that breaks them.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pool } = require('../db');

let alice;
let bob;

async function makeUser(username) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at)
     VALUES ($1, $2, 'x', '\\x00', true, now()) RETURNING id`,
    [username, `${username}@example.com`],
  );
  return u.id;
}

before(async () => {
  execFileSync(process.execPath, ['--env-file=.env.test', 'scripts/migrate.js', 'up'], {
    cwd: path.join(__dirname, '..'), stdio: 'pipe',
  });
  await pool.query('DELETE FROM battles');
  await pool.query('DELETE FROM users');
  alice = await makeUser('alice');
  bob = await makeUser('bob');
});
beforeEach(() => pool.query('DELETE FROM battles'));
after(async () => {
  await pool.query('DELETE FROM battles');
  await pool.query('DELETE FROM users');
  await pool.end();
});

function insert(overrides = {}) {
  const row = {
    kind: 'single',
    scoring: 'elo',
    judging: 'official',
    challenger_user_id: alice,
    opponent_user_id: bob,
    created_by: alice,
    elo_band_ok: true,
    submission_days: 5,
    ...overrides,
  };
  const cols = Object.keys(row);
  return pool.query(
    `INSERT INTO battles (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    Object.values(row),
  );
}

test('a new call out is proposed and expires exactly 72 hours after creation', async () => {
  const { rows: [b] } = await insert();
  assert.equal(b.status, 'proposed');
  assert.equal(b.expires_at - b.created_at, 72 * 3600 * 1000);
  assert.equal(b.accepted_at, null);
  assert.equal(b.result, null);
});

test('expires_at cannot be set to anything other than creation plus 72 hours', async () => {
  await assert.rejects(insert({ expires_at: new Date(Date.now() + 96 * 3600 * 1000) }), { code: '23514' });
});

test('an ELO battle must use official judges', async () => {
  await assert.rejects(insert({ judging: 'popular' }), { code: '23514' });
  await insert({ scoring: 'fun', judging: 'popular', elo_band_ok: null });
});

test('an ELO battle must have passed the 400-point band check', async () => {
  await assert.rejects(insert({ elo_band_ok: false }), { code: '23514' });
  await assert.rejects(insert({ elo_band_ok: null }), { code: '23514' });
});

test('due days are 3, 5 or 7 only', async () => {
  for (const d of [3, 5, 7]) await insert({ submission_days: d });
  for (const d of [0, 4, 6, 8]) await assert.rejects(insert({ submission_days: d }), { code: '23514' }, String(d));
});

test('nobody can call themselves out', async () => {
  await assert.rejects(insert({ opponent_user_id: alice }), { code: '23514' });
});

test('a single battle names two users and no teams', async () => {
  await assert.rejects(insert({ opponent_user_id: null }), { code: '23514' });
  await assert.rejects(insert({ challenger_team_id: alice }), { code: '23514' });
});

test('participants must be real users', async () => {
  await assert.rejects(insert({ opponent_user_id: '00000000-0000-0000-0000-000000000000' }), { code: '23503' });
});

test('stuck is not a battle status yet (added with F-H6)', async () => {
  await assert.rejects(insert({ status: 'stuck' }), { code: '22P02' });
});

test('an accepted battle has its videos due exactly N days after acceptance', async () => {
  const { rows: [b] } = await insert({ submission_days: 3 });
  await assert.rejects(pool.query(
    `UPDATE battles SET status = 'accepted', accepted_at = now(),
     submissions_due_at = now() + interval '5 days' WHERE id = $1`, [b.id],
  ), { code: '23514' });
  await assert.rejects(pool.query(
    "UPDATE battles SET status = 'accepted', accepted_at = now() WHERE id = $1", [b.id],
  ), { code: '23514' });
  const { rows: [a] } = await pool.query(
    `UPDATE battles SET status = 'accepted', accepted_at = now(),
     submissions_due_at = now() + interval '3 days' WHERE id = $1 RETURNING *`, [b.id],
  );
  assert.equal(a.submissions_due_at - a.accepted_at, 3 * 24 * 3600 * 1000);
});

test('due dates are fixed 24-hour days, whatever the session timezone (DST week)', async () => {
  const { rows: [b] } = await insert({ submission_days: 5 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL TimeZone = 'America/Chicago'"); // DST ends Nov 1, 2026
    await client.query(
      `UPDATE battles SET status = 'accepted', accepted_at = '2026-10-31 12:00-05',
       submissions_due_at = timestamptz '2026-10-31 12:00-05' + interval '120 hours' WHERE id = $1`, [b.id],
    );
    await client.query("UPDATE battles SET judging_due_at = now() WHERE id = $1", [b.id]); // later updates still pass
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const { rows: [a] } = await pool.query('SELECT * FROM battles WHERE id = $1', [b.id]);
  assert.equal(a.submissions_due_at - a.accepted_at, 120 * 3600 * 1000);
});
