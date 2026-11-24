// F-C1, F-C2: S-B1 create, S-B2 detail and actions, S-B3 My battles, S-M1 items.
// Permission rules are checked on the server; these tests call the routes
// directly, the way a crafted request would.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, HOST } = require('../index');
const { pool } = require('../db');
const { hashPassword } = require('../lib/passwords');
const { encryptDob, parseKey } = require('../lib/dob-crypto');
const { Browser, listen } = require('./helpers/http');
const { reviewKey } = require('../lib/callouts');

const PASSWORD = 'a long passphrase';
const NOT_AVAILABLE = 'That member cannot be called out.';
const VERIFY = 'Verify your email to send or accept call outs.';

let server;
let base;
let hash;
const ids = {};

before(async () => {
  ({ server, base } = await listen(app, HOST));
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await pool.query('DELETE FROM battles');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  ids.alice = await addUser('Alice');
  ids.bob = await addUser('Bob');
  ids.carol = await addUser('Carol');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.query('DELETE FROM battles');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  await pool.end();
});

async function addUser(username, { verified = true, status = 'active', elo = 1000 } = {}) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at,
                        status, email_verified_at, elo_rating)
     VALUES ($1, $2, $3, $4, true, now(), $5, $6, $7) RETURNING id`,
    [username, `${username.toLowerCase()}@example.com`, hash,
      encryptDob('2000-01-01', parseKey(process.env.DOB_ENC_KEY)), status, verified ? new Date() : null, elo],
  );
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

const terms = { format: 'single', scoring: 'elo', judging: 'official', submission_days: '5' };

// Inserts a call out straight into the table (for tests about later steps).
async function callout(from, to, overrides = {}) {
  const row = {
    kind: 'single', scoring: 'fun', judging: 'official', elo_band_ok: null, submission_days: 5,
    challenger_user_id: ids[from], opponent_user_id: ids[to], created_by: ids[from], ...overrides,
  };
  const cols = Object.keys(row);
  const { rows: [b] } = await pool.query(
    `INSERT INTO battles (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    Object.values(row),
  );
  return b.id;
}

const battle = async (id) => (await pool.query('SELECT * FROM battles WHERE id = $1', [id])).rows[0];
const count = async () => Number((await pool.query('SELECT count(*) FROM battles')).rows[0].count);
const versionFrom = (html) => (/name="terms_version" value="([^"]*)"/.exec(html) || [])[1];

async function expire(id) {
  await pool.query(
    `UPDATE battles SET created_at = now() - interval '73 hours', expires_at = now() - interval '1 hour'
     WHERE id = $1`, [id],
  );
}

const reviewedFrom = (html) => (/name="reviewed" value="([^"]*)"/.exec(html) || [])[1];

// Sends a call out the way the form does: Review, then Send with the reviewed terms.
async function send(b, opponent, fields = {}) {
  const review = await b.post('/callouts/review', { ...terms, ...fields, opponent, _csrf: b.token });
  return b.post('/callouts', { ...terms, ...fields, opponent, reviewed: reviewedFrom(review.html) || '', _csrf: b.token });
}

// Saves an edit the way the form does. The opponent never changes on edit.
const withReview = (opponent, fields) => ({ ...terms, ...fields, reviewed: reviewKey({ ...terms, ...fields, opponent }) });

async function accept(b, id) {
  const page = await b.get(`/callouts/${id}`);
  return b.post(`/callouts/${id}/accept`, { _csrf: b.token, terms_version: versionFrom(page.html) || '' });
}

// --- Logged out ---

test('logged-out visitors are sent to log in from every call out page', async () => {
  const id = await callout('alice', 'bob');
  const v = new Browser(base);
  for (const p of ['/callouts/new', `/callouts/${id}`, `/callouts/${id}/edit`, '/my-battles']) {
    const r = await v.get(p);
    assert.equal(r.status, 302, p);
    assert.equal(r.location, '/login', p);
  }
});

test('logged-out POSTs to call out actions change nothing', async () => {
  const id = await callout('alice', 'bob');
  const v = new Browser(base);
  const token = await v.csrfFrom('/login');
  for (const p of ['/callouts', `/callouts/${id}/accept`, `/callouts/${id}/decline`, `/callouts/${id}/cancel`, `/callouts/${id}`]) {
    const r = await v.post(p, { ...terms, opponent: 'Bob', _csrf: token });
    assert.equal(r.status, 302, p);
  }
  assert.equal((await battle(id)).status, 'proposed');
  assert.equal(await count(), 1);
});

// --- Verified email (decision Nov 20: enforced in 2a) ---

test('unverified: S-B1 shows the notice and no form', async () => {
  await addUser('Newbie', { verified: false });
  const b = await as('Newbie');
  const r = await b.get('/callouts/new');
  assert.equal(r.status, 200);
  assert.match(r.html, new RegExp(VERIFY));
  assert.doesNotMatch(r.html, /name="opponent"/);
});

test('unverified: cannot review or send a call out', async () => {
  await addUser('Newbie', { verified: false });
  const b = await as('Newbie');
  assert.equal((await b.post('/callouts/review', { ...terms, opponent: 'Bob', _csrf: b.token })).status, 403);
  assert.equal((await b.post('/callouts', { ...terms, opponent: 'Bob', _csrf: b.token })).status, 403);
  assert.equal(await count(), 0);
});

test('unverified: cannot accept or edit, but can still decline and cancel', async () => {
  ids.newbie = await addUser('Newbie', { verified: false });
  const toNewbie = await callout('alice', 'newbie');
  const fromNewbie = await callout('newbie', 'bob');
  const b = await as('Newbie');

  const page = await b.get(`/callouts/${toNewbie}`);
  assert.match(page.html, new RegExp(VERIFY));
  assert.equal((await accept(b, toNewbie)).status, 403);
  assert.equal((await b.get(`/callouts/${fromNewbie}/edit`)).status, 403);
  assert.equal((await b.post(`/callouts/${fromNewbie}`, { ...terms, _csrf: b.token })).status, 403);

  assert.equal((await b.post(`/callouts/${toNewbie}/decline`, { _csrf: b.token })).status, 303);
  assert.equal((await battle(toNewbie)).status, 'declined');
  assert.equal((await b.post(`/callouts/${fromNewbie}/cancel`, { _csrf: b.token })).status, 303);
  assert.equal((await battle(fromNewbie)).status, 'cancelled');
});

// --- Creating (S-B1) ---

test('S-B1 never lists other members; the opponent is typed', async () => {
  const b = await as('Alice');
  const r = await b.get('/callouts/new');
  assert.equal(r.status, 200);
  assert.match(r.html, /name="opponent"/);
  assert.doesNotMatch(r.html, /Bob|Carol|<datalist/);
});

test('review shows the opponent and rating without saving anything', async () => {
  await pool.query('UPDATE users SET elo_rating = 1234 WHERE id = $1', [ids.bob]);
  const b = await as('Alice');
  const r = await b.post('/callouts/review', { ...terms, opponent: 'bob', _csrf: b.token });
  assert.equal(r.status, 200);
  assert.match(r.html, /Bob/);
  assert.match(r.html, /1234/);
  assert.match(r.html, /Send call out/);
  assert.equal(await count(), 0);
});

test('send creates a proposed call out with the chosen terms; username ignores case', async () => {
  const b = await as('Alice');
  const r = await send(b, 'bOB', { submission_days: '7' });
  assert.equal(r.status, 303);
  const [, id] = /^\/callouts\/([0-9a-f-]{36})$/.exec(r.location);
  const row = await battle(id);
  assert.equal(row.status, 'proposed');
  assert.equal(row.kind, 'single');
  assert.equal(row.scoring, 'elo');
  assert.equal(row.judging, 'official');
  assert.equal(row.submission_days, 7);
  assert.equal(row.challenger_user_id, ids.alice);
  assert.equal(row.created_by, ids.alice);
  assert.equal(row.opponent_user_id, ids.bob);
  assert.equal(row.elo_band_ok, true);
});

test('cannot call out yourself', async () => {
  const b = await as('Alice');
  const r = await b.post('/callouts', { ...terms, opponent: 'alice', _csrf: b.token });
  assert.equal(r.status, 400);
  assert.match(r.html, /You cannot call yourself out\./);
  assert.equal(await count(), 0);
});

test('unknown, unverified, banned, suspended and deleted opponents all get the same message', async () => {
  await addUser('Unverified', { verified: false });
  await addUser('Banned', { status: 'banned' });
  await addUser('Suspended', { status: 'suspended' });
  await addUser('Deleted', { status: 'deleted' });
  const b = await as('Alice');
  for (const opponent of ['Nobody', 'Unverified', 'Banned', 'Suspended', 'Deleted']) {
    for (const p of ['/callouts/review', '/callouts']) {
      const r = await b.post(p, { ...terms, opponent, _csrf: b.token });
      assert.equal(r.status, 400, `${p} ${opponent}`);
      assert.match(r.html, new RegExp(NOT_AVAILABLE), `${p} ${opponent}`);
    }
  }
  assert.equal(await count(), 0);
});

test('ELO call out: opponent exactly 400 away is allowed, 401 is refused', async () => {
  await pool.query('UPDATE users SET elo_rating = 1400 WHERE id = $1', [ids.bob]);
  await pool.query('UPDATE users SET elo_rating = 599 WHERE id = $1', [ids.carol]);
  const b = await as('Alice');
  assert.equal((await send(b, 'Bob')).status, 303);
  const r = await b.post('/callouts', { ...terms, opponent: 'Carol', _csrf: b.token });
  assert.equal(r.status, 400);
  assert.match(r.html, /within 400 points/);
  assert.equal(await count(), 1);
});

test('Just for fun ignores the band and stores elo_band_ok as null', async () => {
  await pool.query('UPDATE users SET elo_rating = 2000 WHERE id = $1', [ids.bob]);
  const b = await as('Alice');
  const r = await send(b, 'Bob', { scoring: 'fun', judging: 'popular' });
  assert.equal(r.status, 303);
  const row = (await pool.query('SELECT * FROM battles')).rows[0];
  assert.equal(row.elo_band_ok, null);
  assert.equal(row.judging, 'popular');
});

test('ELO with popular vote, bad due days and team format are refused', async () => {
  const b = await as('Alice');
  for (const bad of [{ judging: 'popular' }, { submission_days: '4' }, { format: 'team' }]) {
    const r = await b.post('/callouts', { ...terms, ...bad, opponent: 'Bob', _csrf: b.token });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(await count(), 0);
});

// --- Who can see and act (S-B2) ---

test('a call out is visible to its two participants only', async () => {
  const id = await callout('alice', 'bob');
  assert.equal((await (await as('Alice')).get(`/callouts/${id}`)).status, 200);
  assert.equal((await (await as('Bob')).get(`/callouts/${id}`)).status, 200);
  const c = await as('Carol');
  assert.equal((await c.get(`/callouts/${id}`)).status, 404);
  assert.equal((await c.get(`/callouts/${id}/edit`)).status, 404);
  assert.equal((await c.get('/callouts/not-a-uuid')).status, 404);
  assert.equal((await c.get('/callouts/00000000-0000-0000-0000-000000000000')).status, 404);
});

test('a stranger gets 404 on every action and nothing changes', async () => {
  const id = await callout('alice', 'bob');
  const c = await as('Carol');
  for (const a of ['accept', 'decline', 'cancel']) {
    assert.equal((await c.post(`/callouts/${id}/${a}`, { _csrf: c.token })).status, 404, a);
  }
  assert.equal((await c.post(`/callouts/${id}`, { ...terms, _csrf: c.token })).status, 404);
  assert.equal((await c.post(`/callouts/${id}/review`, { ...terms, _csrf: c.token })).status, 404);
  assert.equal((await battle(id)).status, 'proposed');
});

test('only the opponent can accept or decline', async () => {
  const id = await callout('alice', 'bob');
  const a = await as('Alice');
  assert.equal((await accept(a, id)).status, 403);
  assert.equal((await a.post(`/callouts/${id}/decline`, { _csrf: a.token })).status, 403);
  assert.equal((await battle(id)).status, 'proposed');
});

test('only the creator can edit or cancel', async () => {
  const id = await callout('alice', 'bob');
  const b = await as('Bob');
  assert.equal((await b.get(`/callouts/${id}/edit`)).status, 403);
  assert.equal((await b.post(`/callouts/${id}`, { ...terms, _csrf: b.token })).status, 403);
  assert.equal((await b.post(`/callouts/${id}/cancel`, { _csrf: b.token })).status, 403);
  assert.equal((await battle(id)).status, 'proposed');
});

test('the opponent sees Accept and Decline; the creator sees Edit and Cancel', async () => {
  const id = await callout('alice', 'bob');
  const asBob = (await (await as('Bob')).get(`/callouts/${id}`)).html;
  assert.match(asBob, /Accept call out/);
  assert.doesNotMatch(asBob, /Cancel call out/);
  const asAlice = (await (await as('Alice')).get(`/callouts/${id}`)).html;
  assert.match(asAlice, /Cancel call out/);
  assert.doesNotMatch(asAlice, /Accept call out/);
  assert.doesNotMatch(asAlice + asBob, /Rating at stake/); // hidden until slice 2d
});

// --- Accept, decline, cancel ---

test('accept starts the videos clock: due exactly N days after acceptance', async () => {
  const id = await callout('alice', 'bob', { submission_days: 3 });
  const r = await accept(await as('Bob'), id);
  assert.equal(r.status, 303);
  assert.equal(r.location, `/callouts/${id}`);
  const row = await battle(id);
  assert.equal(row.status, 'accepted');
  assert.ok(row.accepted_at);
  assert.equal(row.submissions_due_at - row.accepted_at, 3 * 24 * 3600 * 1000);
});

test('decline and cancel close the call out', async () => {
  const d = await callout('alice', 'bob');
  const c = await callout('alice', 'bob');
  const bob = await as('Bob');
  assert.equal((await bob.post(`/callouts/${d}/decline`, { _csrf: bob.token })).status, 303);
  const alice = await as('Alice');
  assert.equal((await alice.post(`/callouts/${c}/cancel`, { _csrf: alice.token })).status, 303);
  assert.equal((await battle(d)).status, 'declined');
  assert.equal((await battle(c)).status, 'cancelled');
});

test('nothing can be done to a call out that is no longer proposed', async () => {
  const id = await callout('alice', 'bob');
  const bob = await as('Bob');
  assert.equal((await accept(bob, id)).status, 303);
  assert.equal((await bob.post(`/callouts/${id}/decline`, { _csrf: bob.token })).status, 409);
  assert.equal((await accept(bob, id)).status, 303); // a repeat of his own accept just shows the battle
  const alice = await as('Alice');
  assert.equal((await alice.post(`/callouts/${id}/cancel`, { _csrf: alice.token })).status, 409);
  assert.equal((await alice.get(`/callouts/${id}/edit`)).status, 409);
  assert.equal((await alice.post(`/callouts/${id}`, { ...terms, _csrf: alice.token })).status, 409);
  assert.equal((await battle(id)).status, 'accepted');
});

// --- 72-hour expiry ---

test('after 72 hours the call out cannot be accepted and shows as expired', async () => {
  const id = await callout('alice', 'bob');
  const bob = await as('Bob');
  const page = await bob.get(`/callouts/${id}`); // terms_version taken before it expires
  await expire(id);
  const r = await bob.post(`/callouts/${id}/accept`, { _csrf: bob.token, terms_version: versionFrom(page.html) });
  assert.equal(r.status, 409);
  assert.equal((await battle(id)).status, 'expired');
  const again = await bob.get(`/callouts/${id}`);
  assert.match(again.html, /Expired/);
  assert.doesNotMatch(again.html, /Accept call out/);
});

test('an expired call out cannot be edited, cancelled or declined', async () => {
  const id = await callout('alice', 'bob');
  await expire(id);
  const alice = await as('Alice');
  assert.equal((await alice.post(`/callouts/${id}/cancel`, { _csrf: alice.token })).status, 409);
  assert.equal((await alice.post(`/callouts/${id}`, { ...terms, _csrf: alice.token })).status, 409);
  const bob = await as('Bob');
  assert.equal((await bob.post(`/callouts/${id}/decline`, { _csrf: bob.token })).status, 409);
  assert.equal((await battle(id)).status, 'expired');
});

// --- Editing ---

test('edit changes the terms but not the opponent or the 72-hour clock', async () => {
  const id = await callout('alice', 'bob');
  const before = await battle(id);
  const alice = await as('Alice');
  const r = await alice.post(`/callouts/${id}`, {
    ...withReview('Bob', { scoring: 'fun', judging: 'popular', submission_days: '3' }), opponent: 'Carol', _csrf: alice.token,
  });
  assert.equal(r.status, 303);
  const after = await battle(id);
  assert.equal(after.opponent_user_id, ids.bob);
  assert.equal(after.judging, 'popular');
  assert.equal(after.submission_days, 3);
  assert.equal(after.expires_at.getTime(), before.expires_at.getTime());
  assert.ok(after.updated_at > before.updated_at);
});

test('edit to ELO rechecks the 400-point band', async () => {
  await pool.query('UPDATE users SET elo_rating = 1401 WHERE id = $1', [ids.bob]);
  const id = await callout('alice', 'bob');
  const alice = await as('Alice');
  const r = await alice.post(`/callouts/${id}`, { ...terms, _csrf: alice.token });
  assert.equal(r.status, 400);
  assert.match(r.html, /within 400 points/);
  assert.equal((await battle(id)).scoring, 'fun');
});

test('accept is refused if the creator changed the terms after the page was opened', async () => {
  const id = await callout('alice', 'bob');
  const bob = await as('Bob');
  const page = await bob.get(`/callouts/${id}`);
  const alice = await as('Alice');
  await alice.post(`/callouts/${id}`, { ...withReview('Bob', { scoring: 'fun', submission_days: '7' }), _csrf: alice.token });
  const r = await bob.post(`/callouts/${id}/accept`, { _csrf: bob.token, terms_version: versionFrom(page.html) });
  assert.equal(r.status, 409);
  assert.match(r.html, /The terms changed\. Review them again\./);
  assert.equal((await battle(id)).status, 'proposed');
  assert.equal((await accept(bob, id)).status, 303); // with the fresh page it works
});

// --- S-B3 My battles and S-M1 Dashboard ---

test('My battles: each tab lists the right call outs, and never anyone else\'s', async () => {
  const incoming = await callout('carol', 'alice');
  const outgoing = await callout('alice', 'bob');
  const active = await callout('bob', 'alice');
  await pool.query(
    `UPDATE battles SET status = 'accepted', accepted_at = now(), submissions_due_at = now() + interval '5 days'
     WHERE id = $1`, [active],
  );
  const past = await callout('alice', 'carol');
  await pool.query("UPDATE battles SET status = 'declined' WHERE id = $1", [past]);
  const stranger = await callout('bob', 'carol');

  const a = await as('Alice');
  const tab = async (t) => (await a.get(`/my-battles?tab=${t}`)).html;
  const expect = { incoming, outgoing, active, past };
  for (const [t, id] of Object.entries(expect)) {
    const html = await tab(t);
    assert.match(html, new RegExp(id), t);
    for (const other of [...Object.values(expect).filter((x) => x !== id), stranger]) {
      assert.doesNotMatch(html, new RegExp(other), `${t} must not list ${other}`);
    }
  }
  assert.equal((await a.get('/my-battles')).status, 200); // default tab
  assert.equal((await a.get('/my-battles?tab=bogus')).status, 200);
});

test('Dashboard lists call outs waiting on me with a countdown', async () => {
  const id = await callout('carol', 'alice');
  const mine = await callout('alice', 'bob');
  const html = (await (await as('Alice')).get('/dashboard')).html;
  assert.match(html, /Logged in as <strong>Alice<\/strong>/);
  assert.match(html, new RegExp(`/callouts/${id}`));
  assert.doesNotMatch(html, new RegExp(`/callouts/${mine}`));
  assert.match(html, /\d+ (days|hours) left/);
});

// --- Atomic state changes (Matt, Nov 20) ---

test('two accepts at the same time: exactly one succeeds', async () => {
  const id = await callout('alice', 'bob');
  const b1 = await as('Bob');
  const b2 = await as('Bob');
  const v1 = versionFrom((await b1.get(`/callouts/${id}`)).html);
  const v2 = versionFrom((await b2.get(`/callouts/${id}`)).html);
  const results = await Promise.all([
    b1.post(`/callouts/${id}/accept`, { _csrf: b1.token, terms_version: v1 }),
    b2.post(`/callouts/${id}/accept`, { _csrf: b2.token, terms_version: v2 }),
  ]);
  // One UPDATE lands; the other finds it already accepted by him and shows the battle.
  assert.deepEqual(results.map((r) => r.status), [303, 303]);
  assert.equal((await battle(id)).status, 'accepted');
});

test('accept and cancel at the same time: exactly one succeeds', async () => {
  for (let i = 0; i < 5; i += 1) {
    const id = await callout('alice', 'bob');
    const bob = await as('Bob');
    const alice = await as('Alice');
    const v = versionFrom((await bob.get(`/callouts/${id}`)).html);
    const [acc, can] = await Promise.all([
      bob.post(`/callouts/${id}/accept`, { _csrf: bob.token, terms_version: v }),
      alice.post(`/callouts/${id}/cancel`, { _csrf: alice.token }),
    ]);
    assert.deepEqual([acc.status, can.status].sort(), [303, 409], `round ${i}`);
    const { status } = await battle(id);
    assert.equal(status, acc.status === 303 ? 'accepted' : 'cancelled', `round ${i}`);
  }
});

test('edit and accept at the same time: the accept never lands on terms the opponent did not see', async () => {
  for (let i = 0; i < 5; i += 1) {
    const id = await callout('alice', 'bob', { submission_days: 5 });
    const bob = await as('Bob');
    const alice = await as('Alice');
    const v = versionFrom((await bob.get(`/callouts/${id}`)).html);
    const [acc, ed] = await Promise.all([
      bob.post(`/callouts/${id}/accept`, { _csrf: bob.token, terms_version: v }),
      alice.post(`/callouts/${id}`, { ...withReview('Bob', { scoring: 'fun', submission_days: '7' }), _csrf: alice.token }),
    ]);
    assert.deepEqual([acc.status, ed.status].sort(), [303, 409], `round ${i}`);
    const row = await battle(id);
    if (acc.status === 303) assert.equal(row.submission_days, 5, `round ${i}`);
    else assert.equal(row.status, 'proposed', `round ${i}`);
  }
});

// --- Review fixes ---

test('every status change moves updated_at forward', async () => {
  const ids2 = [await callout('alice', 'bob'), await callout('alice', 'bob'), await callout('alice', 'bob')];
  const before = await Promise.all(ids2.map(battle));
  const bob = await as('Bob');
  const alice = await as('Alice');
  await bob.post(`/callouts/${ids2[0]}/decline`, { _csrf: bob.token });
  await alice.post(`/callouts/${ids2[1]}/cancel`, { _csrf: alice.token });
  await accept(bob, ids2[2]);
  const after = await Promise.all(ids2.map(battle));
  after.forEach((a, i) => assert.ok(a.updated_at > before[i].updated_at, a.status));
});

test('an old open call out is never pushed off the lists by many newer past ones', async () => {
  const old = await callout('carol', 'alice');
  await pool.query("UPDATE battles SET created_at = now() - interval '1 hour', expires_at = now() + interval '71 hours' WHERE id = $1", [old]);
  await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days, status)
     SELECT 'single', 'fun', 'official', $1, $2, $1, 5, 'declined' FROM generate_series(1, 60)`,
    [ids.alice, ids.bob],
  );
  const a = await as('Alice');
  assert.match((await a.get('/dashboard')).html, new RegExp(old));
  assert.match((await a.get('/my-battles?tab=incoming')).html, new RegExp(old));
  const past = (await a.get('/my-battles?tab=past')).html;
  assert.equal((past.match(/class="strip strip--versus"/g) || []).length, 50);
});

// --- Refusals must not read like success (browser test, Nov 20) ---
// Matt clicked Cancel on a page opened before the opponent accepted. The server
// refused (409), but the page said "Call out closed", which read as a confirmation.

test('a refused cancel says it was not cancelled and why, never "Call out closed"', async () => {
  const id = await callout('alice', 'bob');
  const alice = await as('Alice');
  const stale = await alice.get(`/callouts/${id}`); // page still shows Cancel
  assert.match(stale.html, /Cancel call out/);
  await accept(await as('Bob'), id);
  const r = await alice.post(`/callouts/${id}/cancel`, { _csrf: alice.token });
  assert.equal(r.status, 409);
  assert.match(r.html, /Not cancelled/);
  assert.match(r.html, /was not cancelled\. It has already been accepted\./);
  assert.doesNotMatch(r.html, /Call out closed/);
  assert.equal((await battle(id)).status, 'accepted');
});

test('every refused action names the action and the current status', async () => {
  const id = await callout('alice', 'bob');
  await pool.query("UPDATE battles SET status = 'declined' WHERE id = $1", [id]);
  const alice = await as('Alice');
  const bob = await as('Bob');
  const cases = [
    [bob, 'accept', 'Not accepted', 'was not accepted. It has already been declined.'],
    [alice, 'cancel', 'Not cancelled', 'was not cancelled. It has already been declined.'],
  ];
  for (const [who, action, heading, message] of cases) {
    const r = await who.post(`/callouts/${id}/${action}`, { _csrf: who.token, terms_version: '1' });
    assert.equal(r.status, 409, action);
    assert.match(r.html, new RegExp(heading), action);
    assert.match(r.html, new RegExp(message.replace(/\./g, '\\.')), action);
  }
  const e = await alice.post(`/callouts/${id}`, { ...terms, _csrf: alice.token });
  assert.equal(e.status, 409);
  assert.match(e.html, /Not saved/);
  assert.match(e.html, /changes were not saved\. It has already been declined\./);
  const ex = await callout('alice', 'bob');
  await expire(ex);
  const x = await alice.post(`/callouts/${ex}/cancel`, { _csrf: alice.token });
  assert.match(x.html, /was not cancelled\. It has already expired\./);
  // Decline on a declined call out is his own repeat (it redirects), so check it on a cancelled one.
  const cx = await callout('alice', 'bob');
  await pool.query("UPDATE battles SET status = 'cancelled' WHERE id = $1", [cx]);
  const d = await bob.post(`/callouts/${cx}/decline`, { _csrf: bob.token });
  assert.equal(d.status, 409);
  assert.match(d.html, /Not declined/);
  assert.match(d.html, /was not declined\. It has already been cancelled\./);
});

// --- Browser test step 7 (Nov 24): a cancelled call out shows on Past ---

test('a cancelled call out shows as Cancelled on Past for both accounts, and nowhere else', async () => {
  const alice = await as('Alice');
  const sent = await send(alice, 'Bob');
  assert.equal(sent.status, 303);
  const id = sent.location.split('/').pop();
  const c = await alice.post(`/callouts/${id}/cancel`, { _csrf: alice.token });
  assert.equal(c.status, 303);
  assert.equal((await battle(id)).status, 'cancelled');
  const bob = await as('Bob');
  for (const [who, line] of [[alice, 'You vs Bob'], [bob, 'You vs Alice']]) {
    const past = (await who.get('/my-battles?tab=past')).html;
    assert.match(past, new RegExp(`href="/callouts/${id}"`));
    assert.match(past, new RegExp(line));
    assert.match(past, /<span class="pill">Cancelled<\/span>/);
    for (const tab of ['incoming', 'outgoing', 'active']) {
      assert.doesNotMatch((await who.get(`/my-battles?tab=${tab}`)).html, new RegExp(`/callouts/${id}"`), tab);
    }
  }
});

// --- Second review fixes (Nov 24) ---

test('double-clicking Send creates one call out and both clicks land on it', async () => {
  const alice = await as('Alice');
  const body = { ...terms, opponent: 'Bob', _csrf: alice.token, reviewed: reviewKey({ ...terms, opponent: 'Bob' }) };
  const [r1, r2] = await Promise.all([alice.post('/callouts', body), alice.post('/callouts', body)]);
  assert.equal(r1.status, 303);
  assert.equal(r2.status, 303);
  assert.equal(r1.location, r2.location);
  const r3 = await alice.post('/callouts', body); // resubmitted after a slow response
  assert.equal(r3.location, r1.location);
  assert.equal(await count(), 1);
});

test('a second identical call out sent later is a new call out', async () => {
  const alice = await as('Alice');
  const first = await send(alice, 'Bob');
  await pool.query("UPDATE battles SET created_at = created_at - interval '1 minute', expires_at = expires_at - interval '1 minute' WHERE id = $1",
    [first.location.split('/').pop()]);
  const second = await send(alice, 'Bob');
  assert.notEqual(second.location, first.location);
  assert.equal(await count(), 2);
});

test('repeating a successful accept, decline or cancel shows the call out, not a refusal', async () => {
  const bob = await as('Bob');
  const alice = await as('Alice');
  const a = await callout('alice', 'bob');
  assert.equal((await accept(bob, a)).status, 303);
  const a2 = await bob.post(`/callouts/${a}/accept`, { _csrf: bob.token, terms_version: '1' });
  assert.equal(a2.status, 303);
  assert.equal(a2.location, `/callouts/${a}`);
  for (const [who, action, status] of [[bob, 'decline', 'declined'], [alice, 'cancel', 'cancelled']]) {
    const id = await callout('alice', 'bob');
    assert.equal((await who.post(`/callouts/${id}/${action}`, { _csrf: who.token })).status, 303);
    const again = await who.post(`/callouts/${id}/${action}`, { _csrf: who.token });
    assert.equal(again.status, 303, action);
    assert.equal(again.location, `/callouts/${id}`, action);
    assert.equal((await battle(id)).status, status);
  }
});

test('Past lists battles by when they closed, so one closed today is never cut off', async () => {
  const old = await callout('alice', 'bob');
  await pool.query("UPDATE battles SET created_at = now() - interval '2 days', expires_at = now() + interval '1 day' WHERE id = $1", [old]);
  await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days,
                          status, created_at, expires_at, updated_at)
     SELECT 'single', 'fun', 'official', $1, $2, $1, 5, 'declined', now() - interval '1 day',
            now() + interval '2 days', now() - interval '1 hour' FROM generate_series(1, 60)`,
    [ids.alice, ids.bob],
  );
  const bob = await as('Bob');
  assert.equal((await bob.post(`/callouts/${old}/decline`, { _csrf: bob.token })).status, 303);
  const past = (await bob.get('/my-battles?tab=past')).html;
  assert.match(past, new RegExp(`/callouts/${old}"`));
  assert.equal((past.match(/class="strip strip--versus"/g) || []).length, 50);
});

test('Send uses only the terms shown on the Review card', async () => {
  const alice = await as('Alice');
  const review = await alice.post('/callouts/review', { ...terms, opponent: 'Bob', _csrf: alice.token });
  const reviewed = reviewedFrom(review.html);
  assert.ok(reviewed);
  const r = await alice.post('/callouts', { ...terms, opponent: 'Carol', reviewed, _csrf: alice.token });
  assert.equal(r.status, 400);
  assert.match(r.html, /changed the terms after Review/);
  assert.match(r.html, /Carol/); // the Review card now shows what would be sent
  assert.equal(await count(), 0);
  const missing = await alice.post('/callouts', { ...terms, opponent: 'Bob', _csrf: alice.token });
  assert.equal(missing.status, 400);
  assert.equal(await count(), 0);
  const ok = await alice.post('/callouts', { ...terms, opponent: 'Bob', reviewed, _csrf: alice.token });
  assert.equal(ok.status, 303);
  assert.equal(await count(), 1);
});

test('Save changes uses only the terms shown on the Review card', async () => {
  const id = await callout('alice', 'bob');
  const alice = await as('Alice');
  const review = await alice.post(`/callouts/${id}/review`, { ...terms, scoring: 'fun', _csrf: alice.token });
  const reviewed = reviewedFrom(review.html);
  const r = await alice.post(`/callouts/${id}`, { ...terms, scoring: 'fun', submission_days: '7', reviewed, _csrf: alice.token });
  assert.equal(r.status, 400);
  assert.match(r.html, /changed the terms after Review/);
  assert.equal((await battle(id)).submission_days, 5);
  const ok = await alice.post(`/callouts/${id}`, { ...terms, scoring: 'fun', reviewed, _csrf: alice.token });
  assert.equal(ok.status, 303);
});

// --- Countdown and list order (Nov 24 decisions) ---

const dueOf = (d) => `Due ${d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${d.toISOString().slice(11, 16)} UTC`;
// The due date is page text, not only a title tooltip.
const shownAsText = (html, text) => new RegExp(`>[^<]*${text}[^<]*<`).test(html);

test('the exact due date shows as page text on S-B2, the dashboard and My battles', async () => {
  const id = await callout('alice', 'bob');
  const { expires_at: due } = await battle(id);
  const bob = await as('Bob');
  for (const page of [`/callouts/${id}`, '/dashboard', '/my-battles?tab=incoming']) {
    assert.ok(shownAsText((await bob.get(page)).html, dueOf(due)), page);
  }
});

test('dashboard Active rows show the countdown for videos and its due date', async () => {
  const id = await callout('alice', 'bob', { submission_days: 3 });
  await accept(await as('Bob'), id);
  const { submissions_due_at: due } = await battle(id);
  const html = (await (await as('Alice')).get('/dashboard')).html;
  const row = html.slice(html.indexOf('id="active-h"'));
  assert.match(row, /2 days left for videos/);
  assert.ok(shownAsText(row, dueOf(due)));
});

test('open call outs list soonest to expire first (dashboard, Incoming, Outgoing)', async () => {
  const newer = await callout('alice', 'bob');
  const older = await callout('alice', 'bob');
  await pool.query("UPDATE battles SET created_at = now() - interval '70 hours', expires_at = now() + interval '2 hours' WHERE id = $1", [older]);
  const first = (html) => html.indexOf(`/callouts/${older}"`) < html.indexOf(`/callouts/${newer}"`);
  const bob = await as('Bob');
  const alice = await as('Alice');
  assert.ok(first((await bob.get('/dashboard')).html), 'dashboard');
  assert.ok(first((await bob.get('/my-battles?tab=incoming')).html), 'incoming');
  assert.ok(first((await alice.get('/my-battles?tab=outgoing')).html), 'outgoing');
});

test('Past lists an expired call out by when it expired, not when it was marked', async () => {
  const expired = await callout('alice', 'bob');
  await pool.query("UPDATE battles SET created_at = now() - interval '75 hours', expires_at = now() - interval '3 hours' WHERE id = $1", [expired]);
  const declined = await callout('alice', 'bob');
  await pool.query("UPDATE battles SET status = 'declined', updated_at = now() - interval '1 hour' WHERE id = $1", [declined]);
  const past = (await (await as('Bob')).get('/my-battles?tab=past')).html; // this load marks it expired
  assert.equal((await battle(expired)).status, 'expired');
  assert.ok(past.indexOf(`/callouts/${declined}"`) < past.indexOf(`/callouts/${expired}"`));
});
