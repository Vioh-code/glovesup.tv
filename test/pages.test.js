const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, HOST } = require('../index');
const { pool } = require('../db');

let server;
let base;

before(async () => {
  server = app.listen(0, HOST);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://${HOST}:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function page(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, html: await res.text() };
}

test('S-P8 register form has every field and posts to /register', async () => {
  const { status, html } = await page('/register');
  assert.equal(status, 200);
  assert.ok(html.includes('action="/register"'));
  for (const name of ['username', 'email', 'dob', 'password', 'password_confirm', 'terms', '_csrf']) {
    assert.ok(html.includes(`name="${name}"`), `field ${name}`);
  }
  assert.ok(html.includes('type="date"'));
  assert.ok(html.includes('Free to join. Verify your email'));
  assert.ok(!html.includes('Free to join. Free to join.'));
  assert.ok(html.includes('href="/terms"') && html.includes('href="/privacy"'));
});

test('S-P10 login form posts to /login and has no forgot-password link yet', async () => {
  const { status, html } = await page('/login');
  assert.equal(status, 200);
  assert.ok(html.includes('action="/login"'));
  for (const name of ['identifier', 'password', 'remember', '_csrf']) {
    assert.ok(html.includes(`name="${name}"`), `field ${name}`);
  }
  assert.ok(!/forgot/i.test(html), 'no dead forgot-password link');
});

test('S-P13 terms and privacy placeholders render', async () => {
  for (const [path, heading] of [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy']]) {
    const { status, html } = await page(path);
    assert.equal(status, 200, path);
    assert.ok(html.includes(heading), path);
  }
});

test('visitor nav shows Log in and Register, not Log out', async () => {
  const { html } = await page('/login');
  assert.ok(html.includes('href="/register"'));
  assert.ok(!html.includes('action="/logout"'));
});
