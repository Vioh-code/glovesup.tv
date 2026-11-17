// F-A2: session store and cookie settings.
// Uses a small app with the real session setup (lib/session.js) so no
// test-only route ships in index.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { HOST, app: realApp } = require('../index');
const { pool } = require('../db');
const { configureSessions, rememberDevice, IDLE_SECONDS, REMEMBER_MS } = require('../lib/session');

const SECRET = 'test-secret-'.padEnd(40, 'x');
const servers = [];

async function listen(a) {
  const s = a.listen(0, HOST);
  await new Promise((resolve) => s.once('listening', resolve));
  servers.push(s);
  return `http://${HOST}:${s.address().port}`;
}

function miniApp({ isProduction = false } = {}) {
  const a = express();
  configureSessions(a, { sessionSecret: SECRET, isProduction }, pool);
  a.get('/set', (req, res) => { req.session.n = 1; res.send('set'); });
  a.get('/remember', (req, res) => { req.session.n = 1; rememberDevice(req); res.send('set'); });
  a.get('/get', (req, res) => res.send(String(req.session.n ?? 'none')));
  return a;
}

let dev;
let prod;
let real;

before(async () => {
  dev = await listen(miniApp());
  prod = await listen(miniApp({ isProduction: true }));
  real = await listen(realApp);
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  await pool.query('DELETE FROM session');
  await pool.end();
});

const sidOf = (cookie) => decodeURIComponent(cookie.split(';')[0].split('=')[1]).slice(2).split('.')[0];

async function expireOf(cookie) {
  const { rows } = await pool.query('SELECT expire FROM session WHERE sid = $1', [sidOf(cookie)]);
  return rows[0] && rows[0].expire.getTime();
}

// express-session writes headers before the store save finishes and ends the
// body after it, so always read the whole response before checking the table.
async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  const body = await res.text();
  return { res, body, cookies: res.headers.getSetCookie() };
}

const near = (actual, expected, toleranceMs = 120000) => Math.abs(actual - expected) < toleranceMs;

test('session cookie is glovesup.sid, HttpOnly, SameSite=Lax, Path=/, browser-session by default', async () => {
  const { cookies: [cookie] } = await get(`${dev}/set`);
  assert.match(cookie, /^glovesup\.sid=/);
  assert.match(cookie, /; HttpOnly/i);
  assert.match(cookie, /; SameSite=Lax/i);
  assert.match(cookie, /; Path=\//);
  assert.doesNotMatch(cookie, /Expires=|Max-Age=/i, 'no expiry: ends when the browser closes');
  assert.doesNotMatch(cookie, /; Secure/i, 'not Secure outside production');
});

test('the session is stored in Postgres and read back with the cookie', async () => {
  const { cookies: [cookie] } = await get(`${dev}/set`);
  const { body } = await get(`${dev}/get`, { cookie: cookie.split(';')[0] });
  assert.equal(body, '1');
  assert.ok(await expireOf(cookie), 'row exists in the session table');
});

test('a browser-session login expires after 12 hours idle, pushed forward on each request', async () => {
  assert.equal(IDLE_SECONDS, 12 * 3600);
  const { cookies: [cookie] } = await get(`${dev}/set`);
  assert.ok(near(await expireOf(cookie), Date.now() + IDLE_SECONDS * 1000));

  await pool.query("UPDATE session SET expire = now() + interval '1 hour' WHERE sid = $1", [sidOf(cookie)]);
  await get(`${dev}/get`, { cookie: cookie.split(';')[0] });
  assert.ok(near(await expireOf(cookie), Date.now() + IDLE_SECONDS * 1000), 'touched back to 12 hours');
});

test('keep me logged in: cookie and row last 30 days', async () => {
  assert.equal(REMEMBER_MS, 30 * 24 * 3600 * 1000);
  const { cookies: [cookie] } = await get(`${dev}/remember`);
  const expires = Date.parse(/Expires=([^;]+)/i.exec(cookie)[1]);
  assert.ok(near(expires, Date.now() + REMEMBER_MS));
  assert.ok(near(await expireOf(cookie), Date.now() + REMEMBER_MS));
});

test('an expired session row is not honored', async () => {
  const { cookies: [cookie] } = await get(`${dev}/set`);
  await pool.query("UPDATE session SET expire = now() - interval '1 minute' WHERE sid = $1", [sidOf(cookie)]);
  const { body } = await get(`${dev}/get`, { cookie: cookie.split(';')[0] });
  assert.equal(body, 'none');
});

test('a cookie with a forged signature is ignored', async () => {
  const { cookies: [cookie] } = await get(`${dev}/set`);
  const forged = `glovesup.sid=${encodeURIComponent(`s:${sidOf(cookie)}.forgedsignature`)}`;
  const { body } = await get(`${dev}/get`, { cookie: forged });
  assert.equal(body, 'none');
});

test('production: Secure cookie when Nginx forwards HTTPS from loopback', async () => {
  const { cookies: [cookie] } = await get(`${prod}/set`, { 'x-forwarded-proto': 'https' });
  assert.match(cookie, /; Secure/i);
});

test('production: no cookie is sent over plain HTTP', async () => {
  const { cookies } = await get(`${prod}/set`);
  assert.deepEqual(cookies, []);
});

test('the real app sends no cookie and stores no row for a visitor who has no session data', async () => {
  const { rows: [{ n: beforeCount }] } = await pool.query('SELECT count(*)::int AS n FROM session');
  const { res, cookies } = await get(`${real}/`);
  assert.equal(res.status, 200);
  assert.deepEqual(cookies, []);
  const { rows: [{ n: afterCount }] } = await pool.query('SELECT count(*)::int AS n FROM session');
  assert.equal(afterCount, beforeCount);
});

test('the real app trusts only the loopback proxy', () => {
  const trust = realApp.get('trust proxy fn');
  assert.equal(trust('127.0.0.1', 0), true);
  assert.equal(trust('203.0.113.9', 0), false);
});
