// F-C4, F-C5 judging (slice 2c-2): S-J2 pick plus reason, the 2-of-3
// majority, finalize without ELO, recusal, and who sees what. Decisions
// (Matt, Nov 25):
// - a judge picks once their assignment is accepted and both videos are
//   locked; judge.judgment.submit is needed; submitting locks the judgment;
// - a reason is typed (1 to 2,000 characters), a checked YouTube review
//   video, or both;
// - the battle is finalized only when all 3 seats have submitted; never on
//   fewer picks. Judges never produce void. ELO does not move (slice 2d);
// - recusal: an accepted judge who has not submitted. A replacement is drawn
//   at once and the battle goes back to awaiting_panel; the others' due dates
//   stay; the replacement gets 5 days when the battle re-enters judging;
// - before finalize players see J1-J3 statuses (Judged), never picks or names;
//   after finalize the outcome card shows usernames, picks and reasons.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, HOST } = require('../index');
const { pool } = require('../db');
const youtube = require('../lib/youtube');
const { hashPassword } = require('../lib/passwords');
const { encryptDob, parseKey } = require('../lib/dob-crypto');
const { Browser, listen } = require('./helpers/http');
const { clearBattles } = require('./helpers/db');

const PASSWORD = 'a long passphrase';
const realCheck = youtube.checkVideo;
const DAY = 24 * 3600 * 1000;
const DEAD_ID = 'deadvideo00';
const DOWN_ID = 'unreachable';
const JUDGES = ['Jupiter', 'Juno', 'Jinx', 'Jade'];

let server;
let base;
let hash;
let ytCalls;
const ids = {};

before(async () => {
  ({ server, base } = await listen(app, HOST));
  hash = await hashPassword(PASSWORD);
  youtube.checkVideo = async (id) => {
    ytCalls += 1;
    if (id === DEAD_ID) return { ok: false, reason: 'dead' };
    if (id === DOWN_ID) return { ok: false, reason: 'unreachable' };
    return { ok: true, title: `Run ${id}`, thumbnail: null };
  };
});

beforeEach(async () => {
  ytCalls = 0;
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  await addUser('Alice');
  await addUser('Bob');
  await addUser('Carol');
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
const judges = async (n) => { for (const name of JUDGES.slice(0, n)) await addUser(name, { judge: true }); };

async function as(username) {
  const b = new Browser(base);
  const token = await b.csrfFrom('/login');
  const r = await b.post('/login', { identifier: username, password: PASSWORD, _csrf: token });
  assert.equal(r.status, 303, `login ${username}`);
  b.token = await b.csrfFrom('/dashboard');
  return b;
}

const battle = async (id) => (await pool.query('SELECT * FROM battles WHERE id = $1', [id])).rows[0];
const panel = async (id) => (await pool.query(
  `SELECT a.*, u.username FROM judge_assignments a JOIN users u ON u.id = a.judge_user_id
   WHERE a.battle_id = $1 ORDER BY a.drawn_at, u.username`, [id],
)).rows;
const seated = async (id) => (await panel(id)).filter((a) => ['accepted', 'scored'].includes(a.status));
const byName = async (id, username) => (await panel(id)).find((a) => a.username === username);
const judgments = async (id) => (await pool.query(
  `SELECT j.*, a.judge_user_id FROM judgments j JOIN judge_assignments a ON a.id = j.assignment_id
   WHERE a.battle_id = $1 ORDER BY j.submitted_at`, [id],
)).rows;
const slotOf = async (id) => (await pool.query('SELECT * FROM battle_slots WHERE battle_id = $1', [id])).rows[0];
const elo = async (name) => (await pool.query('SELECT elo_rating FROM users WHERE id = $1', [ids[name]])).rows[0].elo_rating;

const reply = (b, assignmentId, action) => b.post(`/judging/${assignmentId}/${action}`, { _csrf: b.token });
const vid = (n) => `vid${n}`.padEnd(11, 'x');
const submitVideo = (b, battleId, videoId) => b.post(`/battles/${battleId}/video`, {
  youtube_url: `https://www.youtube.com/watch?v=${videoId}`, checked: videoId, _csrf: b.token,
});

// A call out from Alice to Bob, accepted by Bob through the route (draws up to 3 judges).
async function acceptedBattle({ scoring = 'fun' } = {}) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days, elo_band_ok)
     VALUES ('single', $3, 'official', $1, $2, $1, 5, $4) RETURNING id`,
    [ids.Alice, ids.Bob, scoring, scoring === 'elo' ? true : null],
  );
  const bob = await as('Bob');
  const page = await bob.get(`/callouts/${b.id}`);
  const version = (/name="terms_version" value="([^"]*)"/.exec(page.html) || [])[1];
  assert.equal((await bob.post(`/callouts/${b.id}/accept`, { _csrf: bob.token, terms_version: version })).status, 303);
  return b.id;
}
async function allAccept(battleId) {
  for (const a of await panel(battleId)) {
    if (a.status === 'drawn') assert.equal((await reply(await as(a.username), a.id, 'accept')).status, 303, a.username);
  }
}
async function bothVideos(battleId) {
  assert.equal((await submitVideo(await as('Alice'), battleId, vid(1))).status, 303);
  assert.equal((await submitVideo(await as('Bob'), battleId, vid(2))).status, 303);
}
// 3 judges accepted, both videos in: judging.
async function judgingBattle(opts) {
  const id = await acceptedBattle(opts);
  await allAccept(id);
  await bothVideos(id);
  assert.equal((await battle(id)).status, 'judging');
  return id;
}

const judgeForm = (b, form) => ({ _csrf: b.token, pick: 'challenger', reason_text: '', reason_video_url: '', ...form });
const postJudge = (b, assignmentId, form = {}) => b.post(`/judging/${assignmentId}/judge`, judgeForm(b, form));
// The named judge submits a judgment through the route.
async function pick(battleId, username, form = {}) {
  const a = await byName(battleId, username);
  return postJudge(await as(username), a.id, { reason_text: `${username} says so`, ...form });
}
const recuse = (b, assignmentId) => b.post(`/judging/${assignmentId}/recuse`, { _csrf: b.token });

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

// --- Picks: permissions ---

test('pick: logged out goes to log in; no CSRF token is refused; nothing is saved', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a] = await panel(id);
  const v = new Browser(base);
  const token = await v.csrfFrom('/login');
  const r = await v.post(`/judging/${a.id}/judge`, { _csrf: token, pick: 'challenger', reason_text: 'x' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/login');
  const j = await as(a.username);
  assert.equal((await j.post(`/judging/${a.id}/judge`, { pick: 'challenger', reason_text: 'x' })).status, 403);
  assert.equal((await j.get(`/judging/${a.id}`)).status, 200);
  assert.equal((await judgments(id)).length, 0);
  assert.equal((await new Browser(base).get(`/judging/${a.id}`)).status, 302);
});

test('pick: only the assignment\'s own judge; anyone else, and a bad id, get 404; a revoked or banned judge gets 403', async () => {
  await judges(4);
  const id = await judgingBattle();
  const p = await panel(id);
  const mine = p[0];
  const spare = JUDGES.find((n) => !p.some((a) => a.username === n));
  for (const who of [p[1].username, spare, 'Alice', 'Bob', 'Carol']) {
    const b = await as(who);
    assert.equal((await postJudge(b, mine.id, { reason_text: 'x' })).status, 404, who);
    assert.equal((await b.get(`/judging/${mine.id}`)).status, 404, who);
  }
  const j = await as(mine.username);
  assert.equal((await postJudge(j, 'not-a-uuid', { reason_text: 'x' })).status, 404);
  assert.equal((await postJudge(j, '00000000-0000-0000-0000-000000000000', { reason_text: 'x' })).status, 404);
  await pool.query('DELETE FROM user_roles WHERE user_id = $1', [mine.judge_user_id]);
  assert.equal((await postJudge(j, mine.id, { reason_text: 'x' })).status, 403);
  // A banned judge is treated as logged out on the next request.
  const k = await as(p[1].username);
  await pool.query("UPDATE users SET status = 'banned' WHERE id = $1", [p[1].judge_user_id]);
  const banned = await postJudge(k, p[1].id, { reason_text: 'x' });
  assert.equal(banned.status, 302);
  assert.equal(banned.location, '/login');
  assert.equal((await judgments(id)).length, 0);
});

// --- Picks: when ---

test('pick: refused with 409 when drawn, declined or recused, before both videos are in, and once finalized', async () => {
  await judges(4);
  const id = await acceptedBattle();
  const p = await panel(id);
  // drawn
  assert.equal((await postJudge(await as(p[0].username), p[0].id, { reason_text: 'x' })).status, 409);
  // declined
  assert.equal((await reply(await as(p[1].username), p[1].id, 'decline')).status, 303);
  assert.equal((await postJudge(await as(p[1].username), p[1].id, { reason_text: 'x' })).status, 409);
  // accepted, but the videos are not in yet
  await allAccept(id);
  assert.equal((await battle(id)).status, 'submissions_open');
  const live = await seated(id);
  assert.equal((await postJudge(await as(live[0].username), live[0].id, { reason_text: 'x' })).status, 409);
  await submitVideo(await as('Alice'), id, vid(1));
  assert.equal((await postJudge(await as(live[0].username), live[0].id, { reason_text: 'x' })).status, 409);
  assert.equal((await judgments(id)).length, 0);
  // recused
  assert.equal((await recuse(await as(live[0].username), live[0].id)).status, 303);
  await submitVideo(await as('Bob'), id, vid(2));
  assert.equal((await postJudge(await as(live[0].username), live[0].id, { reason_text: 'x' })).status, 409);
  assert.equal((await judgments(id)).length, 0);
});

test('pick: refused once the battle is finalized', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a, b, c] = await panel(id);
  await pick(id, a.username);
  await pick(id, b.username);
  await pick(id, c.username);
  assert.equal((await battle(id)).status, 'finalized');
  assert.equal((await postJudge(await as(a.username), a.id, { pick: 'opponent', reason_text: 'changed' })).status, 409);
});

// --- Picks: the reason ---

test('reason: neither a typed reason nor a review video is refused with the S-J2 message', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a] = await panel(id);
  const r = await postJudge(await as(a.username), a.id, { reason_text: '   ', reason_video_url: '' });
  assert.equal(r.status, 400);
  assert.match(r.html, /Add a reason or a review video to submit\./);
  assert.equal((await byName(id, a.username)).status, 'accepted');
  assert.equal((await judgments(id)).length, 0);
});

test('reason: a pick is required, and only challenger or opponent', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a] = await panel(id);
  const j = await as(a.username);
  for (const bad of ['', 'void', 'both']) {
    const r = await postJudge(j, a.id, { pick: bad, reason_text: 'x' });
    assert.equal(r.status, 400, bad);
    assert.match(r.html, /Pick the winner\./);
  }
  assert.equal((await judgments(id)).length, 0);
});

test('reason: typed only, video only, or both are saved; the text is trimmed; the video is the canonical link', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a, b, c] = await panel(id);
  assert.equal((await pick(id, a.username, { reason_text: '  Cleaner footwork  ' })).status, 303);
  assert.equal((await pick(id, b.username, { reason_text: '', reason_video_url: `https://youtu.be/${vid(7)}` })).status, 303);
  assert.equal((await pick(id, c.username, { pick: 'opponent', reason_text: 'Both', reason_video_url: `https://www.youtube.com/shorts/${vid(8)}` })).status, 303);
  const rows = await judgments(id);
  const of = (x) => rows.find((r) => r.assignment_id === x.id);
  assert.equal(of(a).reason_text, 'Cleaner footwork');
  assert.equal(of(a).reason_video_url, null);
  assert.equal(of(b).reason_text, null);
  assert.equal(of(b).reason_video_id, vid(7));
  assert.equal(of(b).reason_video_url, `https://www.youtube.com/watch?v=${vid(7)}`);
  assert.equal(of(c).reason_text, 'Both');
  assert.equal(of(c).reason_video_id, vid(8));
  assert.equal(of(c).pick, 'opponent');
  // The judgment is on this battle's slot.
  const slot = await slotOf(id);
  assert.ok(rows.every((r) => r.slot_id === slot.id));
});

test('reason: over 2,000 characters is refused; exactly 2,000 is saved', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a] = await panel(id);
  const j = await as(a.username);
  const r = await postJudge(j, a.id, { reason_text: 'x'.repeat(2001) });
  assert.equal(r.status, 400);
  assert.match(r.html, /2,000 characters/);
  assert.equal((await judgments(id)).length, 0);
  assert.equal((await postJudge(j, a.id, { reason_text: 'y'.repeat(2000) })).status, 303);
});

test('reason video: a bad link format, a dead video and an unreachable YouTube are refused; nothing is saved', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a] = await panel(id);
  const j = await as(a.username);
  const bad = await postJudge(j, a.id, { reason_text: 'x', reason_video_url: 'https://vimeo.com/123' });
  assert.equal(bad.status, 400);
  assert.match(bad.html, /Paste a YouTube link/);
  const dead = await postJudge(j, a.id, { reason_text: 'x', reason_video_url: `https://youtu.be/${DEAD_ID}` });
  assert.equal(dead.status, 400);
  assert.match(dead.html, /can(&#39;|')t be used/);
  const down = await postJudge(j, a.id, { reason_text: 'x', reason_video_url: `https://youtu.be/${DOWN_ID}` });
  assert.equal(down.status, 503);
  assert.match(down.html, /Couldn(&#39;|')t check the video, try again\./);
  assert.equal((await judgments(id)).length, 0);
  assert.equal((await byName(id, a.username)).status, 'accepted');
});

test('Check link on S-J2: shows the checked title and keeps the typed reason and pick; saves nothing', async () => {
  await judges(4);
  const id = await judgingBattle();
  const [a] = await panel(id);
  const j = await as(a.username);
  const r = await j.post(`/judging/${a.id}/check-link`, judgeForm(j, {
    pick: 'opponent', reason_text: 'Keep this text', reason_video_url: `https://youtu.be/${vid(9)}`,
  }));
  assert.equal(r.status, 200);
  assert.match(r.html, new RegExp(`Run ${vid(9)}`));
  assert.match(r.html, /Link works/);
  assert.match(r.html, /Keep this text/);
  assert.match(r.html, /value="opponent" checked/);
  assert.equal((await judgments(id)).length, 0);
  const dead = await j.post(`/judging/${a.id}/check-link`, judgeForm(j, { reason_video_url: `https://youtu.be/${DEAD_ID}` }));
  assert.equal(dead.status, 400);
  // A judge who may not pick yet cannot make the server ask YouTube.
  const id2 = await acceptedBattle();
  const [d] = await panel(id2);
  const calls = ytCalls;
  const k = await as(d.username);
  assert.equal((await k.post(`/judging/${d.id}/check-link`, judgeForm(k, { reason_video_url: `https://youtu.be/${vid(9)}` }))).status, 409);
  assert.equal(ytCalls, calls);
});

// --- Picks: the lock ---

test('submit locks the judgment: scored; the same judgment again changes nothing; a different one is refused', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a] = await panel(id);
  const j = await as(a.username);
  const r = await postJudge(j, a.id, { reason_text: 'Locked in' });
  assert.equal(r.status, 303);
  assert.equal(r.location, `/judging/${a.id}`);
  assert.equal((await byName(id, a.username)).status, 'scored');
  const [first] = await judgments(id);
  assert.equal((await postJudge(j, a.id, { reason_text: 'Locked in' })).status, 303);
  assert.equal((await postJudge(j, a.id, { pick: 'opponent', reason_text: 'Locked in' })).status, 409);
  assert.equal((await postJudge(j, a.id, { reason_text: 'Another reason' })).status, 409);
  const rows = await judgments(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pick, 'challenger');
  assert.equal(rows[0].reason_text, 'Locked in');
  assert.equal(rows[0].submitted_at.getTime(), first.submitted_at.getTime());
});

test('a pick after score_due_at is still taken (the worker slice replaces silent judges)', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a] = await panel(id);
  await pool.query("UPDATE judge_assignments SET score_due_at = now() - interval '1 hour' WHERE id = $1", [a.id]);
  assert.equal((await pick(id, a.username)).status, 303);
  assert.equal((await byName(id, a.username)).status, 'scored');
});

// --- Majority and finalize ---

test('2 of 3: two agreeing picks do not finalize; the third does, with the majority result; ELO does not move', async () => {
  await judges(3);
  const id = await judgingBattle({ scoring: 'elo' });
  const [a, b, c] = await panel(id);
  await pick(id, a.username, { pick: 'opponent' });
  await pick(id, b.username, { pick: 'opponent' });
  let now = await battle(id);
  assert.equal(now.status, 'judging');
  assert.equal(now.result, null);
  assert.equal(now.finalized_at, null);
  assert.equal((await slotOf(id)).result, null);
  assert.ok((await judgments(id)).every((j) => j.reasons_public_at === null));
  await pick(id, c.username, { pick: 'challenger' });
  now = await battle(id);
  assert.equal(now.status, 'finalized');
  assert.equal(now.result, 'opponent');
  assert.ok(now.finalized_at instanceof Date);
  assert.equal((await slotOf(id)).result, 'opponent');
  const rows = await judgments(id);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((j) => j.reasons_public_at && j.reasons_public_at.getTime() === rows[0].reasons_public_at.getTime()));
  assert.ok((await panel(id)).every((x) => x.status === 'scored'));
  for (const n of ['Alice', 'Bob', a.username, b.username, c.username]) assert.equal(await elo(n), 1000, n);
});

test('3 of 3: a unanimous panel finalizes and the card says 3 of 3', async () => {
  await judges(3);
  const id = await judgingBattle();
  for (const a of await panel(id)) await pick(id, a.username, { pick: 'challenger' });
  const b = await battle(id);
  assert.equal(b.status, 'finalized');
  assert.equal(b.result, 'challenger');
  assert.match((await (await as('Alice')).get(`/callouts/${id}`)).html, /3 of 3/);
});

test('a 1-1 split with a silent third judge stays in judging, even past judging_due_at', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a, b] = await panel(id);
  await pick(id, a.username, { pick: 'challenger' });
  await pick(id, b.username, { pick: 'opponent' });
  await pool.query("UPDATE battles SET judging_due_at = now() - interval '1 hour' WHERE id = $1", [id]);
  await (await as('Alice')).get(`/callouts/${id}`);
  await (await as('Alice')).get('/dashboard');
  const now = await battle(id);
  assert.equal(now.status, 'judging');
  assert.equal(now.result, null);
});

test('a revoked judge cannot pick and still holds the seat; a judgment submitted before a revoke still counts', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a, b, c] = await panel(id);
  await pick(id, a.username, { pick: 'opponent' });
  await pool.query('DELETE FROM user_roles WHERE user_id = $1', [a.judge_user_id]); // revoked after submitting
  await pool.query('DELETE FROM user_roles WHERE user_id = $1', [b.judge_user_id]); // revoked before submitting
  assert.equal((await pick(id, b.username)).status, 403);
  assert.equal((await byName(id, b.username)).status, 'accepted');
  assert.equal((await battle(id)).status, 'judging');
  // Give b back the role: a's earlier judgment still counts toward the 3.
  await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'judge'", [b.judge_user_id]);
  await pick(id, b.username, { pick: 'opponent' });
  await pick(id, c.username, { pick: 'challenger' });
  const now = await battle(id);
  assert.equal(now.status, 'finalized');
  assert.equal(now.result, 'opponent');
});

test('race: the last two picks at the same moment finalize the battle exactly once', async () => {
  await judges(3);
  for (let round = 0; round < 3; round += 1) {
    await clearBattles(pool);
    const id = await judgingBattle();
    const [a, b, c] = await panel(id);
    await pick(id, a.username, { pick: 'challenger' });
    const jb = await as(b.username);
    const jc = await as(c.username);
    const results = await racing(id, [
      () => postJudge(jb, b.id, { pick: 'opponent', reason_text: 'b' }),
      () => postJudge(jc, c.id, { pick: 'challenger', reason_text: 'c' }),
    ]);
    assert.deepEqual(results.map((r) => r.status), [303, 303], `round ${round}`);
    const now = await battle(id);
    assert.equal(now.status, 'finalized', `round ${round}`);
    assert.equal(now.result, 'challenger', `round ${round}`);
    assert.equal((await judgments(id)).length, 3, `round ${round}`);
  }
});

// --- Recusal ---

test('recuse: logged out goes to log in; no CSRF token, another judge, a stranger or a bad id are refused', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a, b] = await panel(id);
  const v = new Browser(base);
  const token = await v.csrfFrom('/login');
  const r = await v.post(`/judging/${a.id}/recuse`, { _csrf: token });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/login');
  const j = await as(a.username);
  assert.equal((await j.post(`/judging/${a.id}/recuse`, {})).status, 403);
  for (const who of [b.username, 'Alice', 'Carol']) assert.equal((await recuse(await as(who), a.id)).status, 404, who);
  assert.equal((await recuse(j, 'nope')).status, 404);
  await pool.query('DELETE FROM user_roles WHERE user_id = $1', [a.judge_user_id]);
  assert.equal((await recuse(j, a.id)).status, 403);
  assert.equal((await byName(id, a.username)).status, 'accepted');
});

test('recuse: refused for a drawn judge (use Decline) and after submitting; a repeat changes nothing; refused once the battle is over', async () => {
  await judges(4);
  const id = await acceptedBattle();
  const [d] = await panel(id);
  const r = await recuse(await as(d.username), d.id);
  assert.equal(r.status, 409);
  assert.match(r.html, /Decline/);
  assert.equal((await byName(id, d.username)).status, 'drawn');

  await clearBattles(pool);
  const id2 = await judgingBattle();
  const [a, b, c] = await panel(id2);
  await pick(id2, a.username);
  assert.equal((await recuse(await as(a.username), a.id)).status, 409);
  assert.equal((await byName(id2, a.username)).status, 'scored');
  const jb = await as(b.username);
  assert.equal((await recuse(jb, b.id)).status, 303);
  const once = await byName(id2, b.username);
  assert.equal((await recuse(jb, b.id)).status, 303);
  assert.equal((await byName(id2, b.username)).recused_at.getTime(), once.recused_at.getTime());
  assert.equal((await panel(id2)).length, 4); // one replacement only

  // A battle that is over: an accepted judge can no longer recuse.
  assert.equal(c.status, 'accepted');
  await pool.query("UPDATE battles SET status = 'voided' WHERE id = $1", [id2]);
  assert.equal((await recuse(await as(c.username), c.id)).status, 409);
  assert.equal((await byName(id2, c.username)).status, 'accepted');
});

test('recuse from submissions_open: recused with recused_at, a new judge is drawn at once, back to awaiting_panel', async () => {
  await judges(4);
  const id = await acceptedBattle();
  await allAccept(id);
  assert.equal((await battle(id)).status, 'submissions_open');
  const [a] = await panel(id);
  const r = await recuse(await as(a.username), a.id);
  assert.equal(r.status, 303);
  assert.equal(r.location, '/judging');
  const out = await byName(id, a.username);
  assert.equal(out.status, 'recused');
  assert.ok(out.recused_at instanceof Date);
  const drawn = (await panel(id)).filter((x) => x.status === 'drawn');
  assert.equal(drawn.length, 1);
  assert.notEqual(drawn[0].username, a.username);
  assert.equal((await seated(id)).length, 2);
  assert.equal((await battle(id)).status, 'awaiting_panel');
});

test('recuse from judging: back to awaiting_panel, due dates kept; others can still pick; the replacement gets 5 days', async () => {
  await judges(4);
  const id = await judgingBattle();
  const [a, b, c] = await panel(id);
  // Two days pass.
  await pool.query("UPDATE battles SET judging_due_at = judging_due_at - interval '2 days' WHERE id = $1", [id]);
  await pool.query("UPDATE judge_assignments SET score_due_at = score_due_at - interval '2 days' WHERE battle_id = $1", [id]);
  const was = await battle(id);
  const dueB = (await byName(id, b.username)).score_due_at.getTime();
  await pick(id, c.username, { pick: 'opponent' });
  assert.equal((await recuse(await as(a.username), a.id)).status, 303);
  let now = await battle(id);
  assert.equal(now.status, 'awaiting_panel');
  assert.equal(now.judging_due_at.getTime(), was.judging_due_at.getTime());
  assert.equal((await byName(id, b.username)).score_due_at.getTime(), dueB);
  // b still picks while the battle waits for the replacement.
  assert.equal((await pick(id, b.username, { pick: 'opponent' })).status, 303);
  assert.equal((await battle(id)).status, 'awaiting_panel');
  const fresh = (await panel(id)).find((x) => x.status === 'drawn');
  const t0 = Date.now();
  assert.equal((await reply(await as(fresh.username), fresh.id, 'accept')).status, 303);
  now = await battle(id);
  assert.equal(now.status, 'judging');
  const rep = await byName(id, fresh.username);
  assert.ok(rep.score_due_at.getTime() >= t0 + 5 * DAY - 2000);
  assert.ok(rep.score_due_at.getTime() <= Date.now() + 5 * DAY + 2000);
  assert.equal((await byName(id, b.username)).score_due_at.getTime(), dueB);
  assert.equal(now.judging_due_at.getTime(), rep.score_due_at.getTime());
  assert.equal(now.result, null);
});

test('recuse with nobody free: the panel stays short in awaiting_panel and nothing errors', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a] = await panel(id);
  assert.equal((await recuse(await as(a.username), a.id)).status, 303);
  assert.equal((await panel(id)).length, 3);
  assert.equal((await seated(id)).length, 2);
  assert.equal((await battle(id)).status, 'awaiting_panel');
  assert.match((await (await as('Alice')).get(`/callouts/${id}`)).html, /Waiting for judges\./);
});

test('a recused judge is never drawn again for that battle', async () => {
  await judges(4);
  const id = await judgingBattle();
  const [a] = await panel(id);
  await recuse(await as(a.username), a.id);
  const fresh = (await panel(id)).find((x) => x.status === 'drawn');
  // The replacement declines; nobody else is free (a recused, the rest seated).
  assert.equal((await reply(await as(fresh.username), fresh.id, 'decline')).status, 303);
  const rows = await panel(id);
  assert.equal(rows.filter((x) => x.username === a.username).length, 1);
  assert.equal(rows.filter((x) => x.status === 'drawn').length, 0);
});

test('after a recusal in judging the videos stay locked: S-B5 says so, replace and cancel are refused', async () => {
  await judges(4);
  const id = await judgingBattle();
  const [a] = await panel(id);
  await recuse(await as(a.username), a.id);
  assert.equal((await battle(id)).status, 'awaiting_panel');
  const alice = await as('Alice');
  assert.match((await alice.get(`/battles/${id}/video`)).html, /Both videos are in, so submissions are locked\./);
  assert.equal((await submitVideo(alice, id, vid(5))).status, 409);
  assert.equal((await alice.post(`/battles/${id}/video/cancel`, { _csrf: alice.token })).status, 409);
});

test('after a recusal, the two original judges and the replacement finalize the battle', async () => {
  await judges(4);
  const id = await judgingBattle();
  const [a, b, c] = await panel(id);
  await recuse(await as(a.username), a.id);
  const fresh = (await panel(id)).find((x) => x.status === 'drawn');
  await reply(await as(fresh.username), fresh.id, 'accept');
  await pick(id, b.username, { pick: 'challenger' });
  await pick(id, c.username, { pick: 'opponent' });
  assert.equal((await battle(id)).status, 'judging');
  await pick(id, fresh.username, { pick: 'opponent' });
  const now = await battle(id);
  assert.equal(now.status, 'finalized');
  assert.equal(now.result, 'opponent');
  assert.equal((await judgments(id)).length, 3);
});

test('race: a recusal and the last open judge\'s submit at the same moment never finalize on fewer than 3 picks', async () => {
  await judges(4);
  for (let round = 0; round < 3; round += 1) {
    await clearBattles(pool);
    // Two different judges: one recuses while the other submits.
    const id = await judgingBattle();
    const [a, b, c] = await panel(id);
    await pick(id, a.username);
    const jb = await as(b.username);
    const jc = await as(c.username);
    const results = await racing(id, [() => recuse(jb, b.id), () => postJudge(jc, c.id, { reason_text: 'c' })]);
    assert.deepEqual(results.map((r) => r.status), [303, 303], `round ${round}`);
    let now = await battle(id);
    assert.equal(now.status, 'awaiting_panel', `round ${round}`);
    assert.equal(now.result, null, `round ${round}`);
    assert.equal((await byName(id, b.username)).status, 'recused');
    assert.equal((await byName(id, c.username)).status, 'scored');
    assert.equal((await judgments(id)).length, 2, `round ${round}`);

    // One judge recusing and submitting at once: exactly one wins.
    await clearBattles(pool);
    const id2 = await judgingBattle();
    const [x, y, z] = await panel(id2);
    await pick(id2, x.username);
    await pick(id2, y.username);
    const jz = await as(z.username);
    const both = await racing(id2, [() => recuse(jz, z.id), () => postJudge(jz, z.id, { reason_text: 'z' })]);
    const statuses = both.map((r) => r.status).sort();
    assert.deepEqual(statuses, [303, 409], `round ${round}: ${statuses}`);
    now = await battle(id2);
    const zNow = await byName(id2, z.username);
    if (zNow.status === 'scored') {
      assert.equal(now.status, 'finalized', `round ${round}`);
      assert.equal((await judgments(id2)).length, 3);
    } else {
      assert.equal(zNow.status, 'recused', `round ${round}`);
      assert.equal(now.status, 'awaiting_panel', `round ${round}`);
      assert.equal(now.result, null);
      assert.equal((await judgments(id2)).length, 2);
    }
  }
});

// --- Who sees what ---

test('before finalize: players see J1-J3 with Judged, never a pick, reason or name; a judge sees only their own judgment', async () => {
  await judges(4);
  const id = await judgingBattle();
  const [a, b, c] = await panel(id);
  await pick(id, a.username, { pick: 'opponent', reason_text: 'Mine reason' });
  await pick(id, b.username, { pick: 'challenger', reason_text: 'Theirs reason' });
  await recuse(await as(c.username), c.id);
  for (const who of ['Alice', 'Bob']) {
    const html = (await (await as(who)).get(`/callouts/${id}`)).html;
    const section = html.slice(html.indexOf('id="panel-h"'));
    assert.equal((section.match(/>Judged</g) || []).length, 2, who);
    assert.doesNotMatch(html, /Mine reason|Theirs reason|Judging outcome|Recused/, who);
    for (const n of JUDGES) assert.doesNotMatch(html, new RegExp(n), `${who}: ${n}`);
  }
  const mine = (await (await as(a.username)).get(`/judging/${a.id}`)).html;
  assert.match(mine, /Mine reason/);
  assert.doesNotMatch(mine, /Theirs reason/);
  assert.doesNotMatch(mine, /Judging outcome/);
  for (const n of [b.username, c.username]) assert.doesNotMatch(mine, new RegExp(n));
});

test('after finalize: the players\' battle page shows the winner, 2 of 3, and each judge\'s name, pick and reason', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a, b, c] = await panel(id);
  await pick(id, a.username, { pick: 'opponent', reason_text: 'Smoother transitions' });
  await pick(id, b.username, { pick: 'opponent', reason_text: '', reason_video_url: `https://youtu.be/${vid(6)}` });
  await pick(id, c.username, { pick: 'challenger', reason_text: 'Bigger tricks' });
  for (const who of ['Alice', 'Bob']) {
    const html = (await (await as(who)).get(`/callouts/${id}`)).html;
    const card = html.slice(html.indexOf('Judging outcome'));
    assert.match(card, /Winner[\s\S]*Bob/, who);
    assert.match(card, /2 of 3/, who);
    for (const x of [a, b, c]) assert.match(card, new RegExp(x.username), `${who}: ${x.username}`);
    assert.match(card, /Smoother transitions/);
    assert.match(card, /Bigger tricks/);
    assert.match(card, new RegExp(`href="https://www.youtube.com/watch\\?v=${vid(6)}"`));
    assert.match(card, /Pick: Bob[\s\S]*Pick: Bob[\s\S]*Pick: Alice/);
  }
  assert.equal((await (await as('Carol')).get(`/callouts/${id}`)).status, 404);
});

test('S-J1: Accepted shows Waiting on videos with Recuse, then Ready to judge with Judge; History has View; View shows the outcome', async () => {
  await judges(4);
  const id = await acceptedBattle();
  await allAccept(id);
  const [a, b, c] = await panel(id);
  const ja = await as(a.username);
  let html = (await ja.get('/judging?tab=accepted')).html;
  assert.match(html, /Waiting on videos/);
  assert.match(html, new RegExp(`action="/judging/${a.id}/recuse"`));
  await bothVideos(id);
  html = (await ja.get('/judging?tab=accepted')).html;
  assert.match(html, /Ready to judge/);
  assert.match(html, new RegExp(`href="/judging/${a.id}"`));
  await pick(id, a.username);
  html = (await ja.get('/judging?tab=history')).html;
  assert.match(html, /Submitted/);
  assert.match(html, new RegExp(`href="/judging/${a.id}"`));
  assert.doesNotMatch((await ja.get('/judging?tab=accepted')).html, /Alice vs Bob/);
  await pick(id, b.username);
  await pick(id, c.username);
  const view = (await ja.get(`/judging/${a.id}`)).html;
  assert.match(view, /Judging outcome/);
  for (const x of [a, b, c]) assert.match(view, new RegExp(x.username));
});

test('S-J2 page: the form shows both videos, the pick, the reason fields, Submit and Recuse', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a] = await panel(id);
  const html = (await (await as(a.username)).get(`/judging/${a.id}`)).html;
  assert.match(html, /Judge this battle/);
  assert.match(html, new RegExp(`Run ${vid(1)}`));
  assert.match(html, new RegExp(`Run ${vid(2)}`));
  assert.match(html, /name="pick" value="challenger"/);
  assert.match(html, /name="pick" value="opponent"/);
  assert.match(html, /name="reason_text"[^>]*maxlength="2000"/);
  assert.match(html, /name="reason_video_url"/);
  assert.match(html, /Submit judgment/);
  assert.match(html, new RegExp(`action="/judging/${a.id}/recuse"`));
  assert.match(html, /Submitting locks your judgment\./);
});

test('S-M1: a judge with a battle ready to judge sees "Judge this battle" until they submit; players never do', async () => {
  await judges(3);
  const id = await judgingBattle();
  const [a] = await panel(id);
  const ja = await as(a.username);
  let html = (await ja.get('/dashboard')).html;
  assert.match(html, /Judge this battle: Alice vs Bob/);
  assert.match(html, /left to judge/);
  assert.match(html, new RegExp(`href="/judging/${a.id}"`));
  assert.doesNotMatch((await (await as('Alice')).get('/dashboard')).html, /Judge this battle/);
  await pick(id, a.username);
  html = (await ja.get('/dashboard')).html;
  assert.doesNotMatch(html, /Judge this battle: Alice vs Bob/);
});
