// F-A2, S-P10: log in, log out, /dashboard stub.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, HOST } = require('../index');
const { pool } = require('../db');
const { hashPassword } = require('../lib/passwords');
const { encryptDob, parseKey } = require('../lib/dob-crypto');
const { IDLE_SECONDS, REMEMBER_MS } = require('../lib/session');
const { Browser, listen } = require('./helpers/http');

const PASSWORD = 'a long passphrase';
const GENERIC = 'Wrong email, username or password.';

let server;
let base;
let hash;

before(async () => {
  ({ server, base } = await listen(app, HOST));
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  await addUser('Glover_1', 'glover@example.com');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  await pool.end();
});

async function addUser(username, email, status = 'active') {
  await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at, status)
     VALUES ($1, $2, $3, $4, true, now(), $5)`,
    [username, email, hash, encryptDob('2000-01-01', parseKey(process.env.DOB_ENC_KEY)), status],
  );
}

async function login(form, browser = new Browser(base)) {
  const token = await browser.csrfFrom('/login');
  const r = await browser.post('/login', { ...form, _csrf: token });
  return { r, browser };
}

const sid = (b) => decodeURIComponent(b.cookies.get('glovesup.sid') || '').slice(2).split('.')[0];

async function rowExpire(b) {
  const { rows } = await pool.query('SELECT expire FROM session WHERE sid = $1', [sid(b)]);
  return rows[0] ? rows[0].expire.getTime() : null;
}

const near = (actual, expected, toleranceMs = 120000) => Math.abs(actual - expected) < toleranceMs;

// --- Logging in ---

test('log in with username, then /dashboard shows who is logged in', async () => {
  const { r, browser } = await login({ identifier: 'Glover_1', password: PASSWORD });
  assert.equal(r.status, 303);
  assert.equal(r.location, '/dashboard');
  const d = await browser.get('/dashboard');
  assert.equal(d.status, 200);
  assert.match(d.html, /Logged in as <strong>Glover_1<\/strong>/);
});

test('log in with email, ignoring case and surrounding spaces', async () => {
  const { r } = await login({ identifier: '  GLOVER@example.com ', password: PASSWORD });
  assert.equal(r.status, 303);
});

test('username lookup ignores case', async () => {
  const { r } = await login({ identifier: 'glover_1', password: PASSWORD });
  assert.equal(r.status, 303);
});

test('wrong password, unknown user, banned, suspended and deleted all get the same message', async () => {
  await addUser('Banned_1', 'banned@example.com', 'banned');
  await addUser('Suspended_1', 'suspended@example.com', 'suspended');
  await addUser('Deleted_1', 'deleted@example.com', 'deleted');
  const attempts = [
    { identifier: 'Glover_1', password: 'not the password' },
    { identifier: 'nobody_here', password: PASSWORD },
    { identifier: 'nobody@example.com', password: PASSWORD },
    { identifier: 'Banned_1', password: PASSWORD },
    { identifier: 'Suspended_1', password: PASSWORD },
    { identifier: 'Deleted_1', password: PASSWORD },
    { identifier: '', password: '' },
  ];
  for (const form of attempts) {
    const { r, browser } = await login(form);
    assert.equal(r.status, 401, form.identifier);
    assert.ok(r.html.includes(GENERIC), form.identifier);
    assert.ok(!/banned|suspended|deleted|not found|no account/i.test(r.html.replace(/value="[^"]*"/g, '')), form.identifier);
    assert.equal((await browser.get('/dashboard')).status, 302, `${form.identifier} is not logged in`);
  }
});

test('a failed login re-shows the identifier but never the password', async () => {
  const { r } = await login({ identifier: 'Glover_1', password: 'not the password' });
  assert.ok(r.html.includes('value="Glover_1"'));
  assert.ok(!r.html.includes('not the password'));
});

test('an unknown user still pays for a bcrypt compare (no timing shortcut)', async () => {
  const time = async (form) => {
    const b = new Browser(base);
    const token = await b.csrfFrom('/login');
    const t0 = process.hrtime.bigint();
    await b.post('/login', { ...form, _csrf: token });
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const wrong = await time({ identifier: 'Glover_1', password: 'not the password' });
  const unknown = await time({ identifier: 'nobody_here', password: 'not the password' });
  assert.ok(unknown > wrong * 0.5, `unknown ${unknown.toFixed(0)} ms vs wrong password ${wrong.toFixed(0)} ms`);
});

// --- Session handling ---

test('the session id changes on login (no session fixation)', async () => {
  const b = new Browser(base);
  const token = await b.csrfFrom('/login');
  const before = sid(b);
  assert.ok(before);
  await b.post('/login', { identifier: 'Glover_1', password: PASSWORD, _csrf: token });
  assert.ok(sid(b));
  assert.notEqual(sid(b), before);
  const { rows } = await pool.query('SELECT 1 FROM session WHERE sid = $1', [before]);
  assert.equal(rows.length, 0, 'the pre-login session row is gone');
});

test('without keep-me-logged-in: browser-session cookie, row expires in 12 hours', async () => {
  const { r, browser } = await login({ identifier: 'Glover_1', password: PASSWORD });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('glovesup.sid='));
  assert.doesNotMatch(cookie, /Expires=|Max-Age=/i);
  assert.ok(near(await rowExpire(browser), Date.now() + IDLE_SECONDS * 1000));
});

test('with keep-me-logged-in: cookie and row last 30 days', async () => {
  const { r, browser } = await login({ identifier: 'Glover_1', password: PASSWORD, remember: 'yes' });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('glovesup.sid='));
  const expires = Date.parse(/Expires=([^;]+)/i.exec(cookie)[1]);
  assert.ok(near(expires, Date.now() + REMEMBER_MS));
  assert.ok(near(await rowExpire(browser), Date.now() + REMEMBER_MS));
});

test('the session stores only the user id, never the password hash or email', async () => {
  const { browser } = await login({ identifier: 'Glover_1', password: PASSWORD });
  const { rows: [row] } = await pool.query('SELECT sess::text AS s FROM session WHERE sid = $1', [sid(browser)]);
  assert.ok(!row.s.includes('glover@example.com'));
  assert.ok(!row.s.includes('$2b$'));
  assert.ok(!row.s.includes('Glover_1'));
});

test('a user banned while logged in is treated as logged out on the next request', async () => {
  const { browser } = await login({ identifier: 'Glover_1', password: PASSWORD });
  await pool.query("UPDATE users SET status = 'banned' WHERE username = 'Glover_1'");
  assert.equal((await browser.get('/dashboard')).status, 302);
});

// --- Pages for logged-in users and visitors ---

test('visitors are sent from /dashboard to /login', async () => {
  const r = await new Browser(base).get('/dashboard');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/login');
});

test('logged-in users are sent from /login and /register to /dashboard', async () => {
  const { browser } = await login({ identifier: 'Glover_1', password: PASSWORD });
  for (const path of ['/login', '/register']) {
    const r = await browser.get(path);
    assert.equal(r.status, 302, path);
    assert.equal(r.location, '/dashboard', path);
  }
});

test('a logged-in user cannot register another account', async () => {
  const { browser } = await login({ identifier: 'Glover_1', password: PASSWORD });
  const token = /name="_csrf" value="([^"]*)"/.exec((await browser.get('/dashboard')).html)[1];
  const r = await browser.post('/register', {
    username: 'Second_1', email: 'second@example.com', dob: '2000-01-01',
    password: PASSWORD, password_confirm: PASSWORD, terms: 'yes', _csrf: token,
  });
  assert.equal(r.status, 303);
  assert.equal(r.location, '/dashboard');
  const { rows } = await pool.query("SELECT 1 FROM users WHERE username = 'Second_1'");
  assert.equal(rows.length, 0);
});

test('the dashboard has the member nav and a logout button with a token', async () => {
  const { browser } = await login({ identifier: 'Glover_1', password: PASSWORD });
  const { html } = await browser.get('/dashboard');
  assert.ok(html.includes('href="/dashboard"'));
  assert.ok(html.includes('action="/logout"'));
  assert.match(html, /name="_csrf" value="[A-Za-z0-9_-]{43}"/);
  assert.ok(!html.includes('href="/register"'), 'no Register button for members');
});

// --- Logging out ---

test('logout destroys the session, clears the cookie and goes home', async () => {
  const { browser } = await login({ identifier: 'Glover_1', password: PASSWORD });
  const oldCookie = browser.cookies.get('glovesup.sid');
  const oldSid = sid(browser);
  const token = /name="_csrf" value="([^"]*)"/.exec((await browser.get('/dashboard')).html)[1];

  const r = await browser.post('/logout', { _csrf: token });
  assert.equal(r.status, 303);
  assert.equal(r.location, '/');
  assert.ok(r.headers.getSetCookie().some((c) => /^glovesup\.sid=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c)));
  const { rows } = await pool.query('SELECT 1 FROM session WHERE sid = $1', [oldSid]);
  assert.equal(rows.length, 0);

  // Replaying the old cookie does not get back in.
  const replay = new Browser(base);
  replay.cookies.set('glovesup.sid', oldCookie);
  assert.equal((await replay.get('/dashboard')).status, 302);
});

test('logout without a valid token is refused and the user stays logged in', async () => {
  const { browser } = await login({ identifier: 'Glover_1', password: PASSWORD });
  const r = await browser.post('/logout', { _csrf: 'wrong' });
  assert.equal(r.status, 403);
  assert.equal((await browser.get('/dashboard')).status, 200);
});

test('logging in does not log the password or identifier', async () => {
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.join(' '));
  try {
    await login({ identifier: 'glover@example.com', password: PASSWORD });
    await login({ identifier: 'glover@example.com', password: 'not the password' });
  } finally {
    Object.assign(console, orig);
  }
  const all = logged.join('\n');
  for (const secret of [PASSWORD, 'not the password', 'glover@example.com']) {
    assert.ok(!all.includes(secret), 'secret value was logged');
  }
});
