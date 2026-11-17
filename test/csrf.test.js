// CSRF (session-bound token, timing-safe compare) and helmet headers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, HOST } = require('../index');
const { pool } = require('../db');
const { tokensMatch } = require('../lib/csrf');
const { Browser, listen } = require('./helpers/http');

let server;
let base;

before(async () => {
  ({ server, base } = await listen(app, HOST));
  await pool.query('DELETE FROM users');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  await pool.end();
});

const userCount = async () => (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;

const form = {
  username: 'csrf_user',
  email: 'csrf@example.com',
  dob: '2000-01-01',
  password: 'a long passphrase',
  password_confirm: 'a long passphrase',
  terms: 'yes',
};

// --- tokensMatch ---

test('tokensMatch: equal strings match, anything else does not', () => {
  assert.equal(tokensMatch('abc123', 'abc123'), true);
  assert.equal(tokensMatch('abc123', 'abc124'), false);
  assert.equal(tokensMatch('abc123', 'abc1234'), false, 'different length');
  assert.equal(tokensMatch('', ''), false, 'empty never matches');
  assert.equal(tokensMatch(undefined, 'abc'), false);
  assert.equal(tokensMatch('abc', undefined), false);
  assert.equal(tokensMatch(['abc'], 'abc'), false, 'array from a repeated field');
});

// --- Forms get a token bound to the session ---

test('the register and login forms carry a non-empty token and set a session cookie', async () => {
  for (const path of ['/register', '/login']) {
    const b = new Browser(base);
    const token = await b.csrfFrom(path);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, path);
    assert.ok(b.cookies.has('glovesup.sid'), path);
  }
});

test('the token stays the same across pages in one session, differs between sessions', async () => {
  const a = new Browser(base);
  const t1 = await a.csrfFrom('/register');
  const t2 = await a.csrfFrom('/login');
  assert.equal(t1, t2);
  const b = new Browser(base);
  assert.notEqual(await b.csrfFrom('/register'), t1);
});

// --- POSTs without a valid token are refused with 403 and change nothing ---

test('POST with no session and no token is 403', async () => {
  const b = new Browser(base);
  const r = await b.post('/register', form);
  assert.equal(r.status, 403);
  assert.equal(await userCount(), 0);
});

test('POST with a session but no token is 403', async () => {
  const b = new Browser(base);
  await b.get('/register');
  const r = await b.post('/register', form);
  assert.equal(r.status, 403);
  assert.equal(await userCount(), 0);
});

test('POST with a wrong token is 403', async () => {
  const b = new Browser(base);
  const token = await b.csrfFrom('/register');
  const wrong = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  const r = await b.post('/register', { ...form, _csrf: wrong });
  assert.equal(r.status, 403);
  assert.equal(await userCount(), 0);
});

test('a token from another session is 403', async () => {
  const attacker = new Browser(base);
  const token = await attacker.csrfFrom('/register');
  const victim = new Browser(base);
  await victim.get('/register');
  const r = await victim.post('/register', { ...form, _csrf: token });
  assert.equal(r.status, 403);
  assert.equal(await userCount(), 0);
});

test('a repeated _csrf field is 403', async () => {
  const b = new Browser(base);
  const token = await b.csrfFrom('/register');
  const body = new URLSearchParams({ ...form });
  body.append('_csrf', token);
  body.append('_csrf', token);
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { cookie: b.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  await res.text();
  assert.equal(res.status, 403);
});

test('the 403 page is the themed error page and says how to recover', async () => {
  const r = await new Browser(base).post('/register', form);
  assert.ok(r.html.includes('class="site-header"'));
  assert.match(r.html, /reload/i);
});

test('every POST path is checked, even unknown ones', async () => {
  const r = await new Browser(base).post('/no-such-path', {});
  assert.equal(r.status, 403);
});

test('a correct token is accepted', async () => {
  const b = new Browser(base);
  const token = await b.csrfFrom('/register');
  const r = await b.post('/register', { ...form, _csrf: token });
  assert.notEqual(r.status, 403); // what happens next is covered in register.test.js
});

// --- helmet ---

test('helmet security headers are set', async () => {
  const res = await fetch(`${base}/`);
  await res.text();
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'CSP present');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('outside production the CSP does not force HTTPS for assets (dev runs on plain HTTP)', async () => {
  const res = await fetch(`${base}/`);
  await res.text();
  assert.doesNotMatch(res.headers.get('content-security-policy'), /upgrade-insecure-requests/);
});
