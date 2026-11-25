// F-C4 judge panel (slice 2c-1): the draw at accept, judge Accept and Decline
// on S-J1, the battle status moves (awaiting_panel, submissions_open,
// judging), S-B4 as a section of the battle page, the nav link and the S-M1
// judge item. Decisions (Matt, Nov 25):
// - free judge: holds the judge role, active, verified, not a player in the
//   battle, and no assignment row on that battle in any status. No cap;
// - fewer than 3 free: draw who exists, accept never fails;
// - decline: a replacement is drawn at once, no timer;
// - a reply after respond_by is still taken until the worker slice;
// - players see each judge's status, never names; a judge sees only their own row;
// - every status move runs in one transaction holding the battle row lock.
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

let server;
let base;
let hash;
const ids = {};

before(async () => {
  ({ server, base } = await listen(app, HOST));
  hash = await hashPassword(PASSWORD);
  youtube.checkVideo = async (id) => ({ ok: true, title: `Run ${id}`, thumbnail: null });
});

beforeEach(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  ids.alice = await addUser('Alice');
  ids.bob = await addUser('Bob');
  ids.carol = await addUser('Carol');
});

after(async () => {
  youtube.checkVideo = realCheck;
  await new Promise((resolve) => server.close(resolve));
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  await pool.end();
});

async function addUser(username, { verified = true, status = 'active', judge = false } = {}) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at,
                        status, email_verified_at)
     VALUES ($1, $2, $3, $4, true, now(), $5, $6) RETURNING id`,
    [username, `${username.toLowerCase()}@example.com`, hash,
      encryptDob('2000-01-01', parseKey(process.env.DOB_ENC_KEY)), status, verified ? new Date() : null],
  );
  ids[username.toLowerCase()] = u.id;
  if (judge) await grant(username, 'judge');
  return u.id;
}
const grant = (username, key) => pool.query(
  'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2', [ids[username.toLowerCase()], key],
);
const judges = async (...names) => { for (const n of names) await addUser(n, { judge: true }); };

async function as(username) {
  const b = new Browser(base);
  const token = await b.csrfFrom('/login');
  const r = await b.post('/login', { identifier: username, password: PASSWORD, _csrf: token });
  assert.equal(r.status, 303, `login ${username}`);
  b.token = await b.csrfFrom('/dashboard');
  return b;
}

// A Just for fun call out from Alice to Bob, accepted by Bob through the route.
async function acceptedBattle({ scoring = 'fun' } = {}) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days, elo_band_ok)
     VALUES ('single', $3, 'official', $1, $2, $1, 5, $4) RETURNING id`,
    [ids.alice, ids.bob, scoring, scoring === 'elo' ? true : null],
  );
  const bob = await as('Bob');
  const page = await bob.get(`/callouts/${b.id}`);
  const version = (/name="terms_version" value="([^"]*)"/.exec(page.html) || [])[1];
  const r = await bob.post(`/callouts/${b.id}/accept`, { _csrf: bob.token, terms_version: version });
  assert.equal(r.status, 303, 'accept');
  return b.id;
}

const battle = async (id) => (await pool.query('SELECT * FROM battles WHERE id = $1', [id])).rows[0];
const panel = async (id) => (await pool.query(
  `SELECT a.*, u.username FROM judge_assignments a JOIN users u ON u.id = a.judge_user_id
   WHERE a.battle_id = $1 ORDER BY a.drawn_at, u.username`, [id],
)).rows;
const assignment = async (battleId, username) => (await panel(battleId)).find((a) => a.username === username);
const reply = (b, assignmentId, action) => b.post(`/judging/${assignmentId}/${action}`, { _csrf: b.token });

// Every drawn judge accepts, through the route.
async function allAccept(battleId) {
  for (const a of await panel(battleId)) {
    if (a.status === 'drawn') assert.equal((await reply(await as(a.username), a.id, 'accept')).status, 303, a.username);
  }
}

const vid = (n) => `vid${n}`.padEnd(11, 'x');
const submit = (b, battleId, videoId) => b.post(`/battles/${battleId}/video`, {
  youtube_url: `https://www.youtube.com/watch?v=${videoId}`, checked: videoId, _csrf: b.token,
});

// --- Draw at accept ---

test('accept moves the battle to awaiting_panel and draws 3 judges, 48 hours each to reply', async () => {
  await judges('J1', 'J2', 'J3', 'J4', 'J5');
  const id = await acceptedBattle();
  const b = await battle(id);
  assert.equal(b.status, 'awaiting_panel');
  assert.equal(b.judging_due_at, null);
  const p = await panel(id);
  assert.equal(p.length, 3);
  assert.equal(new Set(p.map((a) => a.judge_user_id)).size, 3);
  for (const a of p) {
    assert.equal(a.status, 'drawn');
    assert.ok(['J1', 'J2', 'J3', 'J4', 'J5'].includes(a.username));
    assert.equal(a.respond_by - a.drawn_at, 2 * DAY);
    assert.equal(a.responded_at, null);
  }
});

test('the pool: only active, verified judges who are not players and have no row on the battle', async () => {
  await judges('Ok1', 'Ok2', 'Ok3');
  await addUser('Plain'); // no judge role
  await addUser('Unver', { judge: true, verified: false });
  await addUser('Banned', { judge: true, status: 'banned' });
  await addUser('Susp', { judge: true, status: 'suspended' });
  await grant('Bob', 'judge'); // a player in this Just for fun battle
  await addUser('Mod');
  await grant('Mod', 'moderator'); // staff sub in by hand later; never drawn at random
  for (let i = 0; i < 5; i += 1) {
    await clearBattles(pool);
    const id = await acceptedBattle();
    assert.deepEqual((await panel(id)).map((a) => a.username).sort(), ['Ok1', 'Ok2', 'Ok3'], `round ${i}`);
  }
});

test('fewer than 3 free judges: draw who exists, accept still succeeds, battle waits', async () => {
  for (const n of [0, 1, 2]) {
    await clearBattles(pool);
    await pool.query("DELETE FROM user_roles WHERE role_id = (SELECT id FROM roles WHERE key = 'judge')");
    for (let i = 0; i < n; i += 1) await addUser(`Few${n}${i}`, { judge: true });
    const id = await acceptedBattle();
    assert.equal((await panel(id)).length, n, `${n} free`);
    assert.equal((await battle(id)).status, 'awaiting_panel', `${n} free`);
  }
});

test('no cap: a judge already on another battle is still drawn', async () => {
  await judges('J1', 'J2', 'J3');
  const first = await acceptedBattle();
  await allAccept(first);
  const second = await acceptedBattle();
  assert.deepEqual((await panel(second)).map((a) => a.username).sort(), ['J1', 'J2', 'J3']);
});

test('the draw is random: over many draws every free judge is picked and the sets differ', async () => {
  await judges('R1', 'R2', 'R3', 'R4', 'R5', 'R6');
  const seen = new Set();
  const sets = new Set();
  for (let i = 0; i < 12; i += 1) {
    const id = await acceptedBattle();
    const names = (await panel(id)).map((a) => a.username).sort();
    names.forEach((n) => seen.add(n));
    sets.add(names.join(','));
  }
  assert.equal(seen.size, 6);
  assert.ok(sets.size > 1);
});

// --- Judge replies: who may ---

test('only the drawn judge may reply: others get 404, a judge whose role was revoked gets 403', async () => {
  await judges('J1', 'J2', 'J3', 'J4');
  const id = await acceptedBattle();
  const p = await panel(id);
  const mine = p[0];
  const otherJudge = p[1].username;
  const offPanel = ['J1', 'J2', 'J3', 'J4'].find((n) => !p.some((a) => a.username === n));
  for (const who of [otherJudge, offPanel, 'Alice', 'Bob', 'Carol']) {
    const b = await as(who);
    for (const action of ['accept', 'decline']) {
      assert.equal((await reply(b, mine.id, action)).status, 404, `${who} ${action}`);
    }
  }
  const j = await as(mine.username);
  assert.equal((await reply(j, 'not-a-uuid', 'accept')).status, 404);
  assert.equal((await reply(j, '00000000-0000-0000-0000-000000000000', 'accept')).status, 404);
  await pool.query('DELETE FROM user_roles WHERE user_id = $1', [mine.judge_user_id]);
  assert.equal((await reply(j, mine.id, 'accept')).status, 403);
  assert.equal((await reply(j, mine.id, 'decline')).status, 403);
  assert.equal((await assignment(id, mine.username)).status, 'drawn');
});

test('logged out: replies go to log in and change nothing; a reply without the CSRF token is refused', async () => {
  await judges('J1', 'J2', 'J3');
  const id = await acceptedBattle();
  const [a] = await panel(id);
  const v = new Browser(base);
  const token = await v.csrfFrom('/login');
  const r = await v.post(`/judging/${a.id}/accept`, { _csrf: token });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/login');
  const j = await as(a.username);
  assert.equal((await j.post(`/judging/${a.id}/accept`, {})).status, 403);
  assert.equal((await j.post(`/judging/${a.id}/decline`, { _csrf: 'wrong' })).status, 403);
  assert.equal((await assignment(id, a.username)).status, 'drawn');
});

// --- Accept and decline ---

test('accept: drawn becomes accepted with responded_at; a repeat click changes nothing', async () => {
  await judges('J1', 'J2', 'J3');
  const id = await acceptedBattle();
  const [a] = await panel(id);
  const j = await as(a.username);
  const r = await reply(j, a.id, 'accept');
  assert.equal(r.status, 303);
  assert.equal(r.location, '/judging');
  const after1 = await assignment(id, a.username);
  assert.equal(after1.status, 'accepted');
  assert.ok(after1.responded_at instanceof Date);
  assert.equal((await reply(j, a.id, 'accept')).status, 303);
  assert.equal((await assignment(id, a.username)).responded_at.getTime(), after1.responded_at.getTime());
  // Recusal comes in slice 2c-2: decline after accept is refused.
  assert.equal((await reply(j, a.id, 'decline')).status, 409);
  assert.equal((await assignment(id, a.username)).status, 'accepted');
});

test('decline: the judge is out and a replacement is drawn at once, never the decliner', async () => {
  await judges('J1', 'J2', 'J3', 'J4');
  const id = await acceptedBattle();
  const p = await panel(id);
  const out = p[0];
  const spare = ['J1', 'J2', 'J3', 'J4'].find((n) => !p.some((a) => a.username === n));
  const j = await as(out.username);
  assert.equal((await reply(j, out.id, 'decline')).status, 303);
  assert.equal((await reply(j, out.id, 'decline')).status, 303); // repeat: same click
  assert.equal((await reply(j, out.id, 'accept')).status, 409); // declined is final
  const now = await panel(id);
  assert.equal(now.length, 4);
  assert.equal((await assignment(id, out.username)).status, 'declined');
  const active = now.filter((a) => a.status === 'drawn');
  assert.equal(active.length, 3);
  assert.ok(active.some((a) => a.username === spare));
  assert.ok(!active.some((a) => a.username === out.username));
});

test('decline with nobody free: the panel stays short, nothing errors, the battle waits', async () => {
  await judges('J1', 'J2', 'J3');
  const id = await acceptedBattle();
  const [a] = await panel(id);
  assert.equal((await reply(await as(a.username), a.id, 'decline')).status, 303);
  const live = (await panel(id)).filter((x) => x.status !== 'declined');
  assert.equal(live.length, 2);
  assert.equal((await battle(id)).status, 'awaiting_panel');
});

test('a judge who declined is never drawn again for that battle', async () => {
  await judges('J1', 'J2', 'J3', 'J4');
  const id = await acceptedBattle();
  const declined = [];
  // Two declines use up the one spare; the second leaves the panel short.
  for (let i = 0; i < 2; i += 1) {
    const a = (await panel(id)).find((x) => x.status === 'drawn');
    declined.push(a.username);
    await reply(await as(a.username), a.id, 'decline');
  }
  const live = (await panel(id)).filter((x) => x.status === 'drawn');
  assert.equal(live.length, 2);
  for (const n of declined) assert.ok(!live.some((x) => x.username === n), n);
});

test('a reply after respond_by is still taken (the worker slice replaces silent judges)', async () => {
  await judges('J1', 'J2', 'J3');
  const id = await acceptedBattle();
  const [a] = await panel(id);
  await pool.query(
    "UPDATE judge_assignments SET drawn_at = now() - interval '49 hours', respond_by = now() - interval '1 hour' WHERE id = $1",
    [a.id],
  );
  assert.equal((await reply(await as(a.username), a.id, 'accept')).status, 303);
  assert.equal((await assignment(id, a.username)).status, 'accepted');
});

test('a reply on a battle that is no longer active is refused', async () => {
  await judges('J1', 'J2', 'J3');
  const id = await acceptedBattle();
  const [a] = await panel(id);
  await pool.query("UPDATE battles SET status = 'voided' WHERE id = $1", [id]);
  assert.equal((await reply(await as(a.username), a.id, 'accept')).status, 409);
  assert.equal((await assignment(id, a.username)).status, 'drawn');
});

// --- Battle status moves ---

test('3 accepted with no videos: submissions_open, no judging clock', async () => {
  await judges('J1', 'J2', 'J3');
  const id = await acceptedBattle();
  await allAccept(id);
  const b = await battle(id);
  assert.equal(b.status, 'submissions_open');
  assert.equal(b.judging_due_at, null);
  await submit(await as('Alice'), id, vid(1));
  assert.equal((await battle(id)).status, 'submissions_open');
});

test('both videos in, then the third accept: judging, due 5 days later', async () => {
  await judges('J1', 'J2', 'J3');
  const id = await acceptedBattle();
  const p = await panel(id);
  await reply(await as(p[0].username), p[0].id, 'accept');
  await reply(await as(p[1].username), p[1].id, 'accept');
  assert.equal((await submit(await as('Alice'), id, vid(1))).status, 303);
  assert.equal((await submit(await as('Bob'), id, vid(2))).status, 303);
  assert.equal((await battle(id)).status, 'awaiting_panel');
  const before3 = Date.now();
  await reply(await as(p[2].username), p[2].id, 'accept');
  const b = await battle(id);
  assert.equal(b.status, 'judging');
  assert.ok(b.judging_due_at.getTime() >= before3 + 5 * DAY - 1000);
  assert.ok(b.judging_due_at.getTime() <= Date.now() + 5 * DAY + 1000);
  for (const a of await panel(id)) assert.equal(a.score_due_at.getTime(), b.judging_due_at.getTime());
});

test('3 accepted, then the second video: judging', async () => {
  await judges('J1', 'J2', 'J3');
  const id = await acceptedBattle();
  await allAccept(id);
  await submit(await as('Alice'), id, vid(1));
  await submit(await as('Bob'), id, vid(2));
  const b = await battle(id);
  assert.equal(b.status, 'judging');
  assert.ok(b.judging_due_at);
});

test('a cancelled video before the lock leaves the status as it was', async () => {
  await judges('J1', 'J2', 'J3');
  const id = await acceptedBattle();
  await allAccept(id);
  const alice = await as('Alice');
  await submit(alice, id, vid(1));
  assert.equal((await alice.post(`/battles/${id}/video/cancel`, { _csrf: alice.token })).status, 303);
  assert.equal((await battle(id)).status, 'submissions_open');
});

test('race: the last judge accept and the last video at the same moment end in judging exactly once', async () => {
  await judges('J1', 'J2', 'J3');
  for (let round = 0; round < 3; round += 1) {
    await clearBattles(pool);
    const id = await acceptedBattle();
    const p = await panel(id);
    await reply(await as(p[0].username), p[0].id, 'accept');
    await reply(await as(p[1].username), p[1].id, 'accept');
    await submit(await as('Alice'), id, vid(1));
    const lastJudge = await as(p[2].username);
    const bob = await as('Bob');
    // Hold the battle row so both requests reach their transactions, then let go.
    const holder = await pool.connect();
    let results;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM battles WHERE id = $1 FOR UPDATE', [id]);
      const pending = Promise.all([reply(lastJudge, p[2].id, 'accept'), submit(bob, id, vid(2))]);
      await new Promise((r) => { setTimeout(r, 400); });
      await holder.query('COMMIT');
      results = await pending;
    } finally {
      holder.release();
    }
    assert.deepEqual(results.map((r) => r.status), [303, 303], `round ${round}`);
    const b = await battle(id);
    assert.equal(b.status, 'judging', `round ${round}`);
    assert.ok(b.judging_due_at, `round ${round}`);
  }
});

// --- Screens ---

test('S-J1 /judging: judges only; requests, accepted and history tabs list only their own rows', async () => {
  await judges('J1', 'J2', 'J3', 'J4');
  const id = await acceptedBattle();
  const p = await panel(id);
  await reply(await as(p[1].username), p[1].id, 'accept');
  await reply(await as(p[2].username), p[2].id, 'decline');

  assert.equal((await (await as('Alice')).get('/judging')).status, 403);
  const v = new Browser(base);
  assert.equal((await v.get('/judging')).status, 302);

  const j0 = await as(p[0].username);
  const req = await j0.get('/judging');
  assert.equal(req.status, 200);
  assert.match(req.html, /Alice vs Bob/);
  assert.match(req.html, new RegExp(`/judging/${p[0].id}/accept`));
  assert.match(req.html, new RegExp(`/judging/${p[0].id}/decline`));
  for (const other of p.slice(1)) assert.doesNotMatch(req.html, new RegExp(other.username), 'no co-judge names');

  const j1 = await as(p[1].username);
  assert.doesNotMatch((await j1.get('/judging')).html, /Alice vs Bob/);
  assert.match((await j1.get('/judging?tab=accepted')).html, /Alice vs Bob/);
  const j2 = await as(p[2].username);
  assert.match((await j2.get('/judging?tab=history')).html, /Alice vs Bob[\s\S]*Declined/);
});

test('the Judging nav link shows for judges only', async () => {
  await judges('J1');
  assert.match((await (await as('J1')).get('/dashboard')).html, /href="\/judging"/);
  assert.doesNotMatch((await (await as('Alice')).get('/dashboard')).html, /href="\/judging"/);
});

test('S-B4 on the battle page: each judge\'s status, never a name; strangers get 404', async () => {
  await judges('Jx1', 'Jx2', 'Jx3');
  const id = await acceptedBattle();
  const p = await panel(id);
  await reply(await as(p[0].username), p[0].id, 'accept');
  for (const who of ['Alice', 'Bob']) {
    const html = (await (await as(who)).get(`/callouts/${id}`)).html;
    const section = html.slice(html.indexOf('id="panel-h"'));
    assert.match(section, /Judge panel/, who);
    assert.match(section, /J1[\s\S]*Accepted/, who);
    assert.equal((section.match(/Waiting for reply/g) || []).length, 2, who);
    assert.doesNotMatch(html, /Jx[123]/, `${who} sees no judge names`);
  }
  assert.equal((await (await as('Carol')).get(`/callouts/${id}`)).status, 404);
  // A judge on the panel is not a player: the battle page stays closed to them.
  assert.equal((await (await as(p[0].username)).get(`/callouts/${id}`)).status, 404);
});

test('S-B4 with fewer than 3 judges shows the waiting message', async () => {
  await judges('J1');
  const id = await acceptedBattle();
  const html = (await (await as('Alice')).get(`/callouts/${id}`)).html;
  assert.match(html, /Waiting for judges\./);
  assert.match(html, /Not enough free judges are available right now/);
});

test('S-M1: a judge sees a judge request with the reply countdown; players do not', async () => {
  await judges('J1', 'J2', 'J3');
  const id = await acceptedBattle();
  const [a] = await panel(id);
  const html = (await (await as(a.username)).get('/dashboard')).html;
  assert.match(html, /Judge request: Alice vs Bob/);
  assert.match(html, /1 day left to reply|47 hours left to reply/);
  assert.doesNotMatch((await (await as('Alice')).get('/dashboard')).html, /Judge request/);
  await reply(await as(a.username), a.id, 'accept');
  assert.doesNotMatch((await (await as(a.username)).get('/dashboard')).html, /Judge request: Alice vs Bob/);
});

test('Terms card: judging shows "Judging due" from judging_due_at instead of "Videos due"', async () => {
  await judges('J1', 'J2', 'J3');
  const id = await acceptedBattle();
  const termsOf = (html) => html.slice(html.indexOf('id="d"'), html.indexOf('</dl>'));
  for (const stage of ['awaiting_panel', 'submissions_open']) {
    if (stage === 'submissions_open') await allAccept(id);
    assert.equal((await battle(id)).status, stage);
    const terms = termsOf((await (await as('Alice')).get(`/callouts/${id}`)).html);
    assert.match(terms, /<dt>Videos due<\/dt>[\s\S]*4 days left/, stage);
    assert.doesNotMatch(terms, /Judging due/, stage);
  }
  await submit(await as('Alice'), id, vid(1));
  await submit(await as('Bob'), id, vid(2));
  const b = await battle(id);
  assert.equal(b.status, 'judging');
  for (const who of ['Alice', 'Bob']) {
    const terms = termsOf((await (await as(who)).get(`/callouts/${id}`)).html);
    assert.doesNotMatch(terms, /Videos due/, who);
    assert.match(terms, /<dt>Judging due<\/dt>[\s\S]*4 days left/, who);
    assert.match(terms, new RegExp(`datetime="${b.judging_due_at.toISOString()}"`), who);
    assert.doesNotMatch(terms, new RegExp(`datetime="${b.submissions_due_at.toISOString()}"`), who);
  }
});
