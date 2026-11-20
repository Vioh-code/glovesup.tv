// F-A1 rules that cannot be wrong: age gate, password, username, email.
// Pure functions, no database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../lib/validate');

const today = new Date(Date.UTC(2026, 10, 17)); // Nov 17, 2026

// --- Age gate (13 or older on the day of signup) ---

test('age gate: exactly 13 today passes', () => {
  assert.equal(v.isAtLeast13('2013-11-17', today), true);
});

test('age gate: one day short of 13 is refused', () => {
  assert.equal(v.isAtLeast13('2013-11-18', today), false);
});

test('age gate: older passes, much younger is refused', () => {
  assert.equal(v.isAtLeast13('1990-01-01', today), true);
  assert.equal(v.isAtLeast13('2020-05-05', today), false);
});

test('age gate: Feb 29 birthday turns 13 on Mar 1 in a non-leap year', () => {
  // Born Feb 29, 2012. 2025 is not a leap year.
  assert.equal(v.isAtLeast13('2012-02-29', new Date(Date.UTC(2025, 1, 28))), false);
  assert.equal(v.isAtLeast13('2012-02-29', new Date(Date.UTC(2025, 2, 1))), true);
});

test('parseDob rejects bad formats, impossible dates, future dates and pre-1900', () => {
  for (const bad of ['', '2010-13-01', '2010-02-30', '2010-2-3', '17/11/2000', 'abc', '2027-01-01', '1899-12-31', undefined, null, ['2000-01-01']]) {
    assert.equal(v.parseDob(bad, today), null, String(bad));
  }
  assert.ok(v.parseDob('2000-01-01', today));
  assert.ok(v.parseDob('2026-11-17', today), 'today is a valid date (fails the age gate later)');
});

// --- Password: 12 to 72 bytes, not equal to username or email ---

test('password: 12 bytes passes, 11 is refused', () => {
  assert.equal(v.passwordError('a'.repeat(12), {}), null);
  assert.ok(v.passwordError('a'.repeat(11), {}));
});

test('password: 72 bytes passes, 73 is refused (bcrypt limit)', () => {
  assert.equal(v.passwordError('a'.repeat(72), {}), null);
  assert.ok(v.passwordError('a'.repeat(73), {}));
});

test('password length counts UTF-8 bytes, not characters', () => {
  // "é" is 2 bytes. 36 of them = 72 bytes (ok); 37 = 74 bytes (too long).
  assert.equal(v.passwordError('é'.repeat(36), {}), null);
  assert.ok(v.passwordError('é'.repeat(37), {}));
  // 4-byte emoji: 3 of them = 12 bytes (ok), even though it is only 3 characters.
  assert.equal(v.passwordError('🥊🥊🥊', {}), null);
});

test('password may not equal the username or email, ignoring case', () => {
  assert.ok(v.passwordError('LongUsername_1', { username: 'longusername_1' }));
  assert.ok(v.passwordError('Glover@Example.com', { email: 'glover@example.com' }));
  assert.equal(v.passwordError('a different passphrase', { username: 'glover', email: 'g@x.co' }), null);
});

test('password has no composition rules', () => {
  assert.equal(v.passwordError('alllowercaseletters', {}), null);
});

test('password must be a string', () => {
  assert.ok(v.passwordError(undefined, {}));
  assert.ok(v.passwordError(['a'.repeat(20)], {}));
});

// --- Username: 3 to 20 of A-Z a-z 0-9 _ - ---

test('username: allowed characters and lengths', () => {
  for (const ok of ['abc', 'Glover_1', 'a-b_c', 'A'.repeat(20)]) {
    assert.equal(v.usernameError(ok), null, ok);
  }
  for (const bad of ['ab', 'A'.repeat(21), 'has space', 'dot.name', 'émile', 'name!', '', undefined, ['abc']]) {
    assert.ok(v.usernameError(bad), String(bad));
  }
});

// --- Email ---

test('email: basic shape, max 254 characters', () => {
  assert.equal(v.emailError('glover@example.com'), null);
  for (const bad of ['', 'no-at-sign', 'a@b', 'a @b.co', 'a@b.co ', `${'a'.repeat(250)}@b.co`, undefined, ['a@b.co']]) {
    assert.ok(v.emailError(bad), String(bad));
  }
});

// --- Whole form ---

const good = {
  username: 'Glover_1',
  email: ' Glover@Example.com ',
  dob: '2000-01-01',
  password: 'a long passphrase',
  password_confirm: 'a long passphrase',
  terms: 'yes',
};

test('registration: a good form passes and trims username and email', () => {
  const r = v.validateRegistration(good, today);
  assert.deepEqual(r.errors, []);
  assert.equal(r.underAge, false);
  assert.equal(r.values.username, 'Glover_1');
  assert.equal(r.values.email, 'Glover@Example.com');
  assert.equal(r.values.dob, '2000-01-01');
});

test('registration: mismatched confirmation and unticked terms are errors', () => {
  const r = v.validateRegistration({ ...good, password_confirm: 'something else', terms: undefined }, today);
  assert.equal(r.errors.length, 2);
});

test('registration: under 13 is flagged and returns only the age message', () => {
  const r = v.validateRegistration({ ...good, dob: '2013-11-18' }, today);
  assert.equal(r.underAge, true);
  assert.deepEqual(r.errors, ['You must be 13 or older to join.']);
});

test('registration: values to redisplay never include the password or DOB', () => {
  const r = v.validateRegistration({ ...good, password_confirm: 'x' }, today);
  assert.deepEqual(Object.keys(r.redisplay).sort(), ['email', 'username']);
});
