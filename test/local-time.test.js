// public/js/local-time.js: rewrites each <time datetime> in the browser's time
// zone. Run here in a VM with a stand-in document. Node's own time zone plays
// the browser's, so the expected text comes from the same Intl options.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'local-time.js'), 'utf8');
const OPTS = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };

function element(datetime, text) {
  return { textContent: text, title: '', getAttribute: (n) => (n === 'datetime' ? datetime : null) };
}

function run(elements, Intl = globalThis.Intl) {
  const document = { querySelectorAll: (sel) => (sel === 'time[datetime]' ? elements : []) };
  vm.runInNewContext(SRC, { document, Intl, Date, isNaN });
}

test('rewrites each date in the local time zone with the short zone name, keeps UTC on hover', () => {
  const iso = '2026-11-25T22:54:00.000Z';
  const el = element(iso, 'Nov 25, 22:54 UTC');
  run([el]);
  assert.equal(el.textContent, new Intl.DateTimeFormat('en-US', OPTS).format(new Date(iso)));
  assert.match(el.textContent, /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [AP]M \S+$/);
  assert.equal(el.title, 'Nov 25, 22:54 UTC');
});

test('the format matches the example in America/Chicago: "Nov 25, 4:54 PM CST"', () => {
  const chicago = { DateTimeFormat: function DateTimeFormat(locale, opts) { return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'America/Chicago' }); } };
  const el = element('2026-11-25T22:54:00.000Z', 'Nov 25, 22:54 UTC');
  run([el], chicago);
  assert.equal(el.textContent, 'Nov 25, 4:54 PM CST');
});

test('a bad datetime, or no Intl, leaves the UTC fallback text alone', () => {
  const bad = element('not a date', 'Nov 25, 22:54 UTC');
  run([bad]);
  assert.equal(bad.textContent, 'Nov 25, 22:54 UTC');
  const el = element('2026-11-25T22:54:00.000Z', 'Nov 25, 22:54 UTC');
  run([el], { DateTimeFormat() { throw new Error('no Intl'); } });
  assert.equal(el.textContent, 'Nov 25, 22:54 UTC');
});
