// F-C3: battle_slots and submissions (02-data-model, section 3). Rules the
// database enforces, so no code path can store a slot or submission that
// breaks them.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pool } = require('../db');
const { clearBattles } = require('./helpers/db');

let alice;
let bob;
let battleId;

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
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  alice = await makeUser('alice');
  bob = await makeUser('bob');
});
beforeEach(async () => {
  await clearBattles(pool);
  ({ rows: [{ id: battleId }] } = await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days,
                          status, accepted_at, submissions_due_at)
     VALUES ('single', 'fun', 'official', $1, $2, $1, 5, 'accepted', now(), now() + interval '120 hours') RETURNING id`,
    [alice, bob],
  ));
});
after(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.end();
});

const slot = (overrides = {}) => {
  const row = { battle_id: battleId, position: 1, challenger_user_id: alice, opponent_user_id: bob, ...overrides };
  const cols = Object.keys(row);
  return pool.query(
    `INSERT INTO battle_slots (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    Object.values(row),
  );
};

const VIDEO = 'dQw4w9WgXcQ';
const submission = (slotId, overrides = {}) => {
  const row = {
    slot_id: slotId, user_id: alice, youtube_url: `https://www.youtube.com/watch?v=${VIDEO}`, video_id: VIDEO,
    title_snapshot: 'A run', thumbnail_snapshot: `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`, ...overrides,
  };
  const cols = Object.keys(row);
  return pool.query(
    `INSERT INTO submissions (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    Object.values(row),
  );
};

test('a slot belongs to a battle, at position 1 to 3, once per position', async () => {
  const { rows: [s] } = await slot();
  assert.equal(s.position, 1);
  assert.equal(s.result, null);
  await assert.rejects(slot(), /battle_slots_battle_id_position/);
  await assert.rejects(slot({ position: 0 }), /battle_slots_position/);
  await assert.rejects(slot({ position: 4 }), /battle_slots_position/);
  await assert.rejects(slot({ position: 2, opponent_user_id: alice }), /battle_slots_participants/);
});

test('a new submission is submitted, stamped now, and keeps its snapshots', async () => {
  const { rows: [s] } = await slot();
  const { rows: [sub] } = await submission(s.id);
  assert.equal(sub.status, 'submitted');
  assert.ok(Math.abs(sub.submitted_at - Date.now()) < 60 * 1000);
  assert.equal(sub.title_snapshot, 'A run');
  assert.equal(sub.locked_at, null);
  assert.equal(sub.last_checked_at, null);
});

test('one live submission per player per slot; replaced and cancelled rows are history', async () => {
  const { rows: [s] } = await slot();
  const { rows: [first] } = await submission(s.id);
  await assert.rejects(submission(s.id), /submissions_one_live/);
  await pool.query("UPDATE submissions SET status = 'replaced' WHERE id = $1", [first.id]);
  const { rows: [second] } = await submission(s.id);
  await pool.query("UPDATE submissions SET status = 'cancelled' WHERE id = $1", [second.id]);
  await submission(s.id);
  await submission(s.id, { user_id: bob }); // the opponent has their own
  await pool.query("UPDATE submissions SET status = 'dead_link' WHERE user_id = $1", [bob]);
  await assert.rejects(submission(s.id, { user_id: bob }), /submissions_one_live/); // dead_link still counts as live
});

test('video_id is an 11-character YouTube id and the url is its canonical watch link', async () => {
  const { rows: [s] } = await slot();
  await assert.rejects(submission(s.id, { video_id: 'short', youtube_url: 'https://www.youtube.com/watch?v=short' }), /submissions_video_id/);
  await assert.rejects(submission(s.id, { youtube_url: 'https://example.com/watch?v=dQw4w9WgXcQ' }), /submissions_canonical_url/);
});

test('battles with slots, and slots with submissions, cannot be deleted', async () => {
  const { rows: [s] } = await slot();
  await submission(s.id);
  await assert.rejects(pool.query('DELETE FROM battle_slots WHERE id = $1', [s.id]), /foreign key/);
  await assert.rejects(pool.query('DELETE FROM battles WHERE id = $1', [battleId]), /foreign key/);
});
