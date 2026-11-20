// F-C1, F-C2 rules that cannot be wrong: the 400-point band, ELO needs
// official judges, due days 3/5/7, and the countdown shown on every timer.
// Pure functions, no database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/callouts');

const good = { opponent: 'Rival_1', format: 'single', scoring: 'elo', judging: 'official', submission_days: '5' };

// --- 400-point band (inclusive, both directions) ---

test('band: exactly 400 above or below is allowed', () => {
  assert.equal(c.withinEloBand(1000, 1400), true);
  assert.equal(c.withinEloBand(1400, 1000), true);
  assert.equal(c.withinEloBand(1000, 1000), true);
});

test('band: 401 above or below is refused', () => {
  assert.equal(c.withinEloBand(1000, 1401), false);
  assert.equal(c.withinEloBand(1401, 1000), false);
});

test('band: applies to ELO call outs only; Just for fun stores null', () => {
  assert.equal(c.eloBandOk('elo', 1000, 1400), true);
  assert.equal(c.eloBandOk('elo', 1000, 2000), false);
  assert.equal(c.eloBandOk('fun', 1000, 2000), null);
});

// --- Form rules ---

test('form: a good ELO call out passes and the username is trimmed', () => {
  const r = c.parseCalloutForm({ ...good, opponent: '  Rival_1 ' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.values, { opponent: 'Rival_1', kind: 'single', scoring: 'elo', judging: 'official', submission_days: 5 });
});

test('form: Just for fun may use popular vote or official judges', () => {
  assert.deepEqual(c.parseCalloutForm({ ...good, scoring: 'fun', judging: 'popular' }).errors, []);
  assert.deepEqual(c.parseCalloutForm({ ...good, scoring: 'fun', judging: 'official' }).errors, []);
});

test('form: ELO with popular vote is refused', () => {
  const r = c.parseCalloutForm({ ...good, judging: 'popular' });
  assert.deepEqual(r.errors, ['ELO battles must use official judges.']);
});

test('form: due days must be 3, 5 or 7', () => {
  for (const d of ['3', '5', '7']) assert.deepEqual(c.parseCalloutForm({ ...good, submission_days: d }).errors, [], d);
  for (const d of ['0', '4', '6', '8', '5.0', '', undefined, ['5']]) {
    assert.deepEqual(c.parseCalloutForm({ ...good, submission_days: d }).errors, ['Pick 3, 5 or 7 days.'], String(d));
  }
});

test('form: scoring, judging and format come from fixed sets only', () => {
  assert.ok(c.parseCalloutForm({ ...good, scoring: 'ranked' }).errors.length);
  assert.ok(c.parseCalloutForm({ ...good, judging: 'ai' }).errors.length);
  assert.ok(c.parseCalloutForm({ ...good, scoring: undefined }).errors.length);
});

test('form: team (3v3) call outs are not open until the teams slice', () => {
  assert.deepEqual(c.parseCalloutForm({ ...good, format: 'team' }).errors, ['Team call outs open once teams are available.']);
});

test('form: opponent must look like a username', () => {
  for (const o of ['', 'ab', 'has space', 'x'.repeat(21), undefined, ['Rival_1']]) {
    assert.deepEqual(c.parseCalloutForm({ ...good, opponent: o }).errors, ["Enter your opponent's username."], String(o));
  }
});

test('form: values to redisplay never contain anything outside the fixed sets', () => {
  const r = c.parseCalloutForm({ opponent: 'Rival_1', scoring: '<b>', judging: 'x', submission_days: '9' });
  assert.deepEqual(r.redisplay, { opponent: 'Rival_1', scoring: '', judging: '', submission_days: '' });
});

// --- Countdown (shared element) ---

const now = new Date(Date.UTC(2026, 10, 20, 12, 0, 0));
const after = (h) => new Date(now.getTime() + h * 3600 * 1000);

test('countdown: 72 hours out shows days and is not urgent', () => {
  assert.deepEqual(c.timeLeft(after(72), now), { expired: false, text: '3 days left', urgent: false });
});

test('countdown: under 48 hours shows whole hours', () => {
  assert.deepEqual(c.timeLeft(after(47.9), now), { expired: false, text: '47 hours left', urgent: false });
});

test('countdown: urgent in the last 24 hours, inclusive', () => {
  assert.equal(c.timeLeft(after(24.01), now).urgent, false);
  assert.equal(c.timeLeft(after(24), now).urgent, true);
  assert.deepEqual(c.timeLeft(after(1), now), { expired: false, text: '1 hour left', urgent: true });
  assert.deepEqual(c.timeLeft(after(0.5), now), { expired: false, text: 'Under 1 hour left', urgent: true });
});

test('countdown: at or past the due time it is expired', () => {
  assert.deepEqual(c.timeLeft(after(0), now), { expired: true, text: 'Time is up', urgent: false });
  assert.equal(c.timeLeft(after(-5), now).expired, true);
});
