// F-A1: DOB encryption (AES-256-GCM) and password hashing (bcrypt cost 12).
// Keys here are generated per test run. No real key is ever in the repo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dob = require('../lib/dob-crypto');
const pw = require('../lib/passwords');

const newKey = () => crypto.randomBytes(32).toString('base64');

// --- Key loading ---

test('parseKey accepts base64 of exactly 32 bytes', () => {
  const key = dob.parseKey(newKey());
  assert.ok(Buffer.isBuffer(key));
  assert.equal(key.length, 32);
});

test('parseKey refuses missing, short, long or non-base64 keys', () => {
  for (const bad of [undefined, '', crypto.randomBytes(16).toString('base64'),
    crypto.randomBytes(33).toString('base64'), 'not base64 at all!!']) {
    assert.throws(() => dob.parseKey(bad), /DOB_ENC_KEY/, String(bad));
  }
});

test('the key error never contains the key value', () => {
  const short = crypto.randomBytes(16).toString('base64');
  assert.throws(() => dob.parseKey(short), (err) => !err.message.includes(short));
});

// --- DOB encryption ---

test('DOB round trips', () => {
  const key = dob.parseKey(newKey());
  const box = dob.encryptDob('2000-01-31', key);
  assert.ok(Buffer.isBuffer(box));
  assert.equal(dob.decryptDob(box, key), '2000-01-31');
});

test('ciphertext starts with version byte 1 and never contains the plaintext', () => {
  const key = dob.parseKey(newKey());
  const box = dob.encryptDob('2000-01-31', key);
  assert.equal(box[0], 1);
  assert.ok(!box.includes(Buffer.from('2000-01-31')));
  assert.equal(box.length, 1 + 12 + 16 + 10); // version + IV + tag + "YYYY-MM-DD"
});

test('a fresh random IV each time: same DOB, different ciphertext', () => {
  const key = dob.parseKey(newKey());
  const a = dob.encryptDob('2000-01-31', key);
  const b = dob.encryptDob('2000-01-31', key);
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a.subarray(1, 13), b.subarray(1, 13));
});

test('a tampered ciphertext, IV, tag or version is refused', () => {
  const key = dob.parseKey(newKey());
  const box = dob.encryptDob('2000-01-31', key);
  for (const i of [0, 1, 13, box.length - 1]) { // version, IV, tag, ciphertext
    const bad = Buffer.from(box);
    bad[i] ^= 0x01;
    assert.throws(() => dob.decryptDob(bad, key), undefined, `byte ${i}`);
  }
});

test('the wrong key is refused', () => {
  const box = dob.encryptDob('2000-01-31', dob.parseKey(newKey()));
  assert.throws(() => dob.decryptDob(box, dob.parseKey(newKey())));
});

test('truncated or non-buffer input is refused', () => {
  const key = dob.parseKey(newKey());
  assert.throws(() => dob.decryptDob(Buffer.alloc(20), key));
  assert.throws(() => dob.decryptDob('2000-01-31', key));
});

test('encryptDob only takes a YYYY-MM-DD string', () => {
  const key = dob.parseKey(newKey());
  assert.throws(() => dob.encryptDob('Jan 31 2000', key));
  assert.throws(() => dob.encryptDob(undefined, key));
});

// --- Passwords ---

test('hashPassword uses bcrypt cost 12 and a fresh salt', async () => {
  const a = await pw.hashPassword('a long passphrase');
  const b = await pw.hashPassword('a long passphrase');
  assert.match(a, /^\$2b\$12\$/);
  assert.notEqual(a, b);
});

test('verifyPassword accepts the right password and refuses a wrong one', async () => {
  const hash = await pw.hashPassword('a long passphrase');
  assert.equal(await pw.verifyPassword('a long passphrase', hash), true);
  assert.equal(await pw.verifyPassword('a long passphrasE', hash), false);
  assert.equal(await pw.verifyPassword('', hash), false);
});

test('hashPassword refuses over 72 bytes instead of silently truncating', async () => {
  await assert.rejects(pw.hashPassword('a'.repeat(73)));
  await assert.rejects(pw.hashPassword(undefined));
});

test('verifyPassword returns false (not an error) for bad input or a missing hash', async () => {
  assert.equal(await pw.verifyPassword(undefined, '$2b$12$abc'), false);
  assert.equal(await pw.verifyPassword('a'.repeat(73), '$2b$12$abc'), false);
  assert.equal(await pw.verifyPassword('a long passphrase', null), false);
});

test('dummyVerify always returns false and takes real bcrypt time', async () => {
  const t0 = process.hrtime.bigint();
  assert.equal(await pw.dummyVerify('a long passphrase'), false);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms > 20, `took ${ms.toFixed(1)} ms; a cost-12 compare should not be instant`);
});
