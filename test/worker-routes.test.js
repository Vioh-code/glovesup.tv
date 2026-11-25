// Worker slice, what people see: the late-reply message on a replaced judge
// request (S-J1), the gravestone on dead videos (S-B5, S-B2, S-J2), the forfeit
// and void lines on S-B2, and the two races between a person and the worker
// (Matt, Nov 25, 2026).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, HOST } = require('../index');
const { pool } = require('../db');
const youtube = require('../lib/youtube');
const worker = require('../lib/worker');
const { hashPassword } = require('../lib/passwords');
const { encryptDob, parseKey } = require('../lib/dob-crypto');
const { Browser, listen } = require('./helpers/http');
const { clearBattles } = require('./helpers/db');

const PASSWORD = 'a long passphrase';
const realCheck = youtube.checkVideo;
const H = 3600 * 1000;
const D = 24 * H;
const GONE = 'This video is gone. The link is dead or the video was made private.';
const ids = {};
let server;
let base;
let hash;
const silent = worker.makeLog({ out: () => {}, err: () => {} });

before(async () => {
  ({ server, base } = await listen(app, HOST));
  hash = await hashPassword(PASSWORD);
  youtube.checkVideo = async (id) => ({ ok: true, title: `Run ${id}`, thumbnail: null });
});
beforeEach(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  await addUser('Alice');
  await addUser('Bob');
});
after(async () => {
  youtube.checkVideo = realCheck;
  await new Promise((resolve) => server.close(resolve));
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  await pool.end();
});

async function addUser(username, { judge = false } = {}) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at,
                        status, email_verified_at)
     VALUES ($1, $2, $3, $4, true, now(), 'active', now()) RETURNING id`,
    [username, `${username.toLowerCase()}@example.com`, hash, encryptDob('2000-01-01', parseKey(process.env.DOB_ENC_KEY))],
  );
  ids[username] = u.id;
  if (judge) await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'judge'", [u.id]);
  return u.id;
}
async function as(username) {
  const b = new Browser(base);
  const token = await b.csrfFrom('/login');
  const r = await b.post('/login', { identifier: username, password: PASSWORD, _csrf: token });
  assert.equal(r.status, 303, `login ${username}`);
  b.token = await b.csrfFrom('/dashboard');
  return b;
}

// An accepted 1v1 with its slot. Due date = acceptedAt + 5 days.
async function accepted({ acceptedAt = new Date(), status = 'awaiting_panel', judgingDue = null } = {}) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days,
                          status, accepted_at, submissions_due_at, judging_due_at)
     VALUES ('single', 'fun', 'official', $1, $2, $1, 5, $3, $4, $4::timestamptz + interval '120 hours', $5) RETURNING id`,
    [ids.Alice, ids.Bob, status, acceptedAt, judgingDue],
  );
  await pool.query(
    'INSERT INTO battle_slots (battle_id, position, challenger_user_id, opponent_user_id) VALUES ($1, 1, $2, $3)',
    [b.id, ids.Alice, ids.Bob],
  );
  return b.id;
}
async function video(battleId, name, { status = 'submitted', locked = null } = {}) {
  const vid = `${name.toLowerCase()}video`.padEnd(11, 'x').slice(0, 11);
  await pool.query(
    `INSERT INTO submissions (slot_id, user_id, youtube_url, video_id, title_snapshot, status, locked_at)
     SELECT s.id, $2, 'https://www.youtube.com/watch?v=' || $3, $3, $4, $5, $6 FROM battle_slots s WHERE s.battle_id = $1`,
    [battleId, ids[name], vid, `${name}'s saved title`, status, locked],
  );
}
async function assign(battleId, name, { status = 'accepted', scoreDue = null, drawnAt = new Date() } = {}) {
  const { rows: [a] } = await pool.query(
    `INSERT INTO judge_assignments (battle_id, judge_user_id, status, drawn_at, respond_by, responded_at, score_due_at)
     VALUES ($1, $2, $3, $4, $4::timestamptz + interval '48 hours', CASE WHEN $3 = 'drawn' THEN NULL ELSE $4::timestamptz END, $5)
     RETURNING *`,
    [battleId, ids[name], status, drawnAt, scoreDue],
  );
  if (status === 'scored') {
    await pool.query(
      `INSERT INTO judgments (assignment_id, slot_id, pick, reason_text)
       SELECT $1, s.id, 'challenger', 'reason' FROM battle_slots s WHERE s.battle_id = $2`, [a.id, battleId],
    );
  }
  return a;
}
const battle = async (id) => (await pool.query('SELECT * FROM battles WHERE id = $1', [id])).rows[0];
const assignment = async (id) => (await pool.query('SELECT * FROM judge_assignments WHERE id = $1', [id])).rows[0];

// Holds the battle row so every request reaches its transaction, then lets go.
async function racing(battleId, requests) {
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM battles WHERE id = $1 FOR UPDATE', [battleId]);
    const pending = Promise.all(requests.map((f) => f()));
    await new Promise((r) => { setTimeout(r, 400); });
    await holder.query('COMMIT');
    return await pending;
  } finally {
    holder.release();
  }
}

// 22
test('S-J1: Accept or Decline on a request the worker replaced says time ran out', async () => {
  await addUser('Jo', { judge: true });
  await addUser('Kai', { judge: true });
  const id = await accepted({ acceptedAt: new Date(Date.now() - 3 * D) });
  const a = await assign(id, 'Jo', { status: 'drawn', drawnAt: new Date(Date.now() - 3 * D) });
  await worker.replaceSilentJudges({ now: new Date(), log: silent });
  assert.equal((await assignment(a.id)).status, 'replaced');
  const jo = await as('Jo');
  for (const action of ['accept', 'decline']) {
    const r = await jo.post(`/judging/${a.id}/${action}`, { _csrf: jo.token });
    assert.equal(r.status, 409, action);
    assert.match(r.html, /Time ran out on this request\. Another judge took the seat\./, action);
  }
  assert.equal((await assignment(a.id)).status, 'replaced');
});

// 47
test('gravestone: a dead video shows the gravestone and its saved title on S-B5, S-B2 and S-J2', async () => {
  await addUser('Jo', { judge: true });
  const id = await accepted({ status: 'judging', judgingDue: new Date(Date.now() + 5 * D) });
  await video(id, 'Alice', { status: 'dead_link', locked: new Date() });
  await video(id, 'Bob', { locked: new Date() });
  const a = await assign(id, 'Jo', { scoreDue: new Date(Date.now() + 5 * D) });
  const alice = await as('Alice');
  for (const page of [`/battles/${id}/video`, `/callouts/${id}`]) {
    const r = await alice.get(page);
    assert.equal(r.status, 200, page);
    assert.match(r.html, /video-frame--gone/, page);
    assert.ok(r.html.includes(GONE), page);
    assert.ok(r.html.includes('Alice&#39;s saved title'), page);
  }
  // The opponent sees Alice's dead video as a gravestone too (both are in).
  const bob = await as('Bob');
  const r2 = await bob.get(`/callouts/${id}`);
  assert.ok(r2.html.includes(GONE));
  assert.ok(r2.html.includes('Alice&#39;s saved title'));
  const jo = await as('Jo');
  const r3 = await jo.get(`/judging/${a.id}`);
  assert.equal(r3.status, 200);
  assert.ok(r3.html.includes(GONE));
  assert.ok(r3.html.includes('Alice&#39;s saved title'));
  // A live video is not a gravestone.
  assert.equal((r3.html.match(/video-frame--gone/g) || []).length, 1);
});

// 48
test('S-B2: a forfeited battle says who missed the due date and who wins; a voided one says it is void', async () => {
  const f = await accepted({ acceptedAt: new Date(Date.now() - 6 * D) });
  await video(f, 'Alice');
  const v = await accepted({ acceptedAt: new Date(Date.now() - 6 * D) });
  await worker.closeSubmissions({ now: new Date(), log: silent });
  assert.equal((await battle(f)).status, 'forfeited');
  assert.equal((await battle(v)).status, 'voided');
  const bob = await as('Bob');
  const rf = await bob.get(`/callouts/${f}`);
  assert.match(rf.html, /Bob missed the due date\. Alice wins by forfeit\./);
  const rv = await bob.get(`/callouts/${v}`);
  assert.match(rv.html, /Neither video came in\. The battle is void\./);
});

// 49
test('race: the last video and the due-date close at the same moment: either the video is in or the battle is forfeited, never both', async () => {
  const outcomes = new Set();
  const bob = await as('Bob');
  for (let round = 0; round < 4; round += 1) {
    await clearBattles(pool);
    const due = new Date(Date.now() + 5000);
    const id = await accepted({ acceptedAt: new Date(due.getTime() - 5 * D) });
    await video(id, 'Alice');
    const [res] = await racing(id, [
      () => bob.post(`/battles/${id}/video`, {
        youtube_url: 'https://www.youtube.com/watch?v=bobsvideo01', checked: 'bobsvideo01', _csrf: bob.token,
      }),
      () => worker.closeSubmissions({ now: due, log: silent }),
    ]);
    const b = await battle(id);
    const { rows: bobLive } = await pool.query(
      `SELECT v.* FROM submissions v JOIN battle_slots s ON s.id = v.slot_id
       WHERE s.battle_id = $1 AND v.user_id = $2 AND v.status IN ('submitted', 'dead_link')`, [id, ids.Bob],
    );
    if (res.status === 303) {
      outcomes.add('video');
      assert.equal(bobLive.length, 1, `round ${round}`);
      assert.notEqual(b.status, 'forfeited', `round ${round}`);
      assert.equal(b.forfeited_by, null, `round ${round}`);
    } else {
      outcomes.add('forfeit');
      assert.equal(res.status, 409, `round ${round}`);
      assert.match(res.html, /This battle is over\./);
      assert.equal(bobLive.length, 0, `round ${round}`);
      assert.equal(b.status, 'forfeited', `round ${round}`);
      assert.equal(b.forfeited_by, ids.Bob, `round ${round}`);
    }
  }
  assert.ok(outcomes.size >= 1);
});

// 50
test('race: a pick and the no-pick replacement at score_due_at: the pick counts or the judge is replaced, never both; never finalized on fewer than 3', async () => {
  for (const n of ['J1', 'J2', 'J3', 'J4']) await addUser(n, { judge: true });
  const j1 = await as('J1');
  for (let round = 0; round < 4; round += 1) {
    await clearBattles(pool);
    const scoreDue = new Date(Date.now() + 60 * 1000);
    const id = await accepted({ status: 'judging', judgingDue: new Date(Date.now() + D) });
    await video(id, 'Alice', { locked: new Date() });
    await video(id, 'Bob', { locked: new Date() });
    const a = await assign(id, 'J1', { scoreDue });
    await assign(id, 'J2', { status: 'scored', scoreDue: new Date(Date.now() + D) });
    await assign(id, 'J3', { status: 'scored', scoreDue: new Date(Date.now() + D) });
    const [res] = await racing(id, [
      () => j1.post(`/judging/${a.id}/judge`, {
        _csrf: j1.token, pick: 'opponent', reason_text: 'my pick', reason_video_url: '',
      }),
      () => worker.replaceLateJudges({ now: scoreDue, log: silent }),
    ]);
    const b = await battle(id);
    const mine = await assignment(a.id);
    const { rows: picks } = await pool.query(
      'SELECT j.* FROM judgments j JOIN judge_assignments x ON x.id = j.assignment_id WHERE x.battle_id = $1', [id],
    );
    if (res.status === 303) {
      assert.equal(mine.status, 'scored', `round ${round}`);
      assert.equal(b.status, 'finalized', `round ${round}`);
      assert.equal(picks.length, 3, `round ${round}`);
      const { rows: extra } = await pool.query('SELECT 1 FROM judge_assignments WHERE battle_id = $1 AND judge_user_id = $2', [id, ids.J4]);
      assert.equal(extra.length, 0, `round ${round}`);
    } else {
      assert.equal(res.status, 409, `round ${round}`);
      assert.match(res.html, /You are no longer on this panel\./);
      assert.equal(mine.status, 'replaced', `round ${round}`);
      assert.notEqual(b.status, 'finalized', `round ${round}`);
      assert.equal(b.status, 'awaiting_panel', `round ${round}`);
      assert.equal(picks.length, 2, `round ${round}`);
    }
  }
});
