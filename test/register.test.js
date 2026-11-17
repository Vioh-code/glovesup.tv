// F-A1, S-P8: register handler.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, HOST } = require('../index');
const { pool } = require('../db');
const { parseKey, decryptDob } = require('../lib/dob-crypto');
const { verifyPassword } = require('../lib/passwords');
const { Browser, listen } = require('./helpers/http');

let server;
let base;

before(async () => { ({ server, base } = await listen(app, HOST)); });
beforeEach(() => pool.query('DELETE FROM users'));
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  await pool.end();
});

const good = {
  username: 'Glover_1',
  email: 'Glover@Example.com',
  dob: '2000-01-31',
  password: 'a long passphrase',
  password_confirm: 'a long passphrase',
  terms: 'yes',
};

async function register(form, browser = new Browser(base)) {
  const token = await browser.csrfFrom('/register');
  return browser.post('/register', { ...form, _csrf: token });
}

const users = async () => (await pool.query('SELECT * FROM users ORDER BY created_at')).rows;

// 13th birthday relative to the server's UTC date, as YYYY-MM-DD.
function dobYearsAgo(years, extraDays = 0) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() + extraDays));
  return d.toISOString().slice(0, 10);
}

test('a good form creates one active Member with an unverified email and goes to log in', async () => {
  const r = await register(good);
  assert.equal(r.status, 303);
  assert.equal(r.location, '/login?registered=1');

  const [u] = await users();
  assert.equal(u.username, 'Glover_1');
  assert.equal(u.email, 'Glover@Example.com');
  assert.equal(u.status, 'active');
  assert.equal(u.email_verified_at, null);
  assert.equal(u.age_gate_passed, true);
  assert.ok(u.terms_accepted_at instanceof Date);
  assert.equal(u.elo_rating, 1000);
});

test('the password is stored as a bcrypt cost-12 hash, never in plain text', async () => {
  await register(good);
  const [u] = await users();
  assert.match(u.password_hash, /^\$2b\$12\$/);
  assert.ok(!u.password_hash.includes(good.password));
  assert.equal(await verifyPassword(good.password, u.password_hash), true);
});

test('the DOB is stored encrypted and decrypts with DOB_ENC_KEY', async () => {
  await register(good);
  const [u] = await users();
  assert.ok(!u.dob_encrypted.includes(Buffer.from(good.dob)));
  assert.equal(decryptDob(u.dob_encrypted, parseKey(process.env.DOB_ENC_KEY)), good.dob);
});

test('the login page shows an account-created notice after registering', async () => {
  const r = await new Browser(base).get('/login?registered=1');
  assert.match(r.html, /Account created/);
});

test('exactly 13 today is accepted', async () => {
  const r = await register({ ...good, dob: dobYearsAgo(13) });
  assert.equal(r.status, 303);
  assert.equal((await users()).length, 1);
});

test('one day short of 13 is refused with the age message and nothing is written', async () => {
  const r = await register({ ...good, dob: dobYearsAgo(13, 1) });
  assert.equal(r.status, 400);
  assert.match(r.html, /You must be 13 or older to join\./);
  assert.equal((await users()).length, 0);
});

test('a duplicate username (any case) gets the generic message and no second row', async () => {
  await register(good);
  const r = await register({ ...good, username: 'GLOVER_1', email: 'other@example.com' });
  assert.equal(r.status, 400);
  assert.match(r.html, /That username or email is not available\./);
  assert.equal((await users()).length, 1);
});

test('a duplicate email (any case) gets the same generic message', async () => {
  await register(good);
  const r = await register({ ...good, username: 'Other_1', email: 'glover@example.COM' });
  assert.equal(r.status, 400);
  assert.match(r.html, /That username or email is not available\./);
  assert.equal((await users()).length, 1);
});

test('validation errors re-show username and email but never the password or DOB', async () => {
  const r = await register({ ...good, password_confirm: 'something else entirely' });
  assert.equal(r.status, 400);
  assert.match(r.html, /Passwords do not match\./);
  assert.ok(r.html.includes('value="Glover_1"'));
  assert.ok(r.html.includes('value="Glover@Example.com"'));
  assert.ok(!r.html.includes(good.password));
  assert.ok(!r.html.includes(good.dob));
  assert.equal((await users()).length, 0);
});

test('missing terms, bad username, bad email, short password and bad date are each refused', async () => {
  const cases = [
    [{ terms: '' }, /agree to the Terms/],
    [{ username: 'a b' }, /Username must be/],
    [{ email: 'not-an-email' }, /valid email/],
    [{ password: 'short', password_confirm: 'short' }, /at least 12/],
    [{ dob: '2000-02-30' }, /valid date of birth/],
  ];
  for (const [change, message] of cases) {
    const r = await register({ ...good, ...change });
    assert.equal(r.status, 400, JSON.stringify(change));
    assert.match(r.html, message);
  }
  assert.equal((await users()).length, 0);
});

test('user input is HTML-escaped when re-shown', async () => {
  const r = await register({ ...good, username: '<script>x</script>' });
  assert.equal(r.status, 400);
  assert.ok(!r.html.includes('<script>x</script>'));
  assert.ok(r.html.includes('&lt;script&gt;'));
});

test('registration does not log the password, DOB or email', async () => {
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.join(' '));
  try {
    await register(good);
    await register({ ...good, username: 'Glover_2' }); // duplicate email path
  } finally {
    Object.assign(console, orig);
  }
  const all = logged.join('\n');
  for (const secret of [good.password, good.dob, good.email]) {
    assert.ok(!all.includes(secret), 'secret value was logged');
  }
});
