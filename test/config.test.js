// F-A2: the app refuses to start without SESSION_SECRET and DOB_ENC_KEY.
// These tests clear the variables themselves and never print real values.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig } = require('../lib/config');

const good = {
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'), // 64 chars
  DOB_ENC_KEY: crypto.randomBytes(32).toString('base64'),
  NODE_ENV: 'test',
};

test('a full config loads', () => {
  const c = loadConfig(good);
  assert.equal(c.sessionSecret, good.SESSION_SECRET);
  assert.equal(c.dobKey.length, 32);
  assert.equal(c.isProduction, false);
  assert.equal(loadConfig({ ...good, NODE_ENV: 'production' }).isProduction, true);
});

test('missing SESSION_SECRET is refused', () => {
  assert.throws(() => loadConfig({ ...good, SESSION_SECRET: undefined }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ ...good, SESSION_SECRET: '' }), /SESSION_SECRET/);
});

test('a SESSION_SECRET under 32 characters is refused', () => {
  assert.throws(() => loadConfig({ ...good, SESSION_SECRET: 'x'.repeat(31) }), /SESSION_SECRET/);
  assert.ok(loadConfig({ ...good, SESSION_SECRET: 'x'.repeat(32) }));
});

test('missing or malformed DOB_ENC_KEY is refused', () => {
  assert.throws(() => loadConfig({ ...good, DOB_ENC_KEY: undefined }), /DOB_ENC_KEY/);
  assert.throws(() => loadConfig({ ...good, DOB_ENC_KEY: crypto.randomBytes(16).toString('base64') }), /DOB_ENC_KEY/);
});

test('both missing are named in one error', () => {
  assert.throws(() => loadConfig({}), (err) => /SESSION_SECRET/.test(err.message) && /DOB_ENC_KEY/.test(err.message));
});

test('config errors never contain the values', () => {
  const short = 'short-secret-value';
  const badKey = crypto.randomBytes(16).toString('base64');
  assert.throws(() => loadConfig({ SESSION_SECRET: short, DOB_ENC_KEY: badKey }),
    (err) => !err.message.includes(short) && !err.message.includes(badKey));
});

test('node index.js exits with code 1 and a plain message when the keys are missing', () => {
  const env = { ...process.env };
  delete env.SESSION_SECRET;
  delete env.DOB_ENC_KEY;
  const r = spawnSync(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refused to start/);
  assert.match(r.stderr, /SESSION_SECRET/);
  assert.match(r.stderr, /DOB_ENC_KEY/);
  assert.ok(!/\n\s+at /.test(r.stderr), 'no stack trace');
  assert.ok(!r.stdout.includes('listening'), 'never started listening');
});
