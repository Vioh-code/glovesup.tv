// Safeguard (Nov 24): on that day an exported DB_NAME=glovesup_dev overrode
// --env-file=.env.test and the suite wiped the dev database. The test setup
// (npm test preloads test/helpers/guard.js) and the migration tests refuse any
// database whose name does not end in "_test", and say which one.
// The spawned runs use a database that does not exist, so even without the
// guard they cannot touch real data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const BAD = 'glovesup_guardcheck';
const REFUSED = new RegExp(`Refusing to run: DB_NAME is "${BAD}"`);

// NODE_TEST_CONTEXT is set inside a test file; cleared so the spawned run
// behaves like one started from a shell.
const run = (args) => {
  const env = { ...process.env, DB_NAME: BAD };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env, timeout: 60000 });
};

test('the guard accepts only database names ending in "_test" and names the one it refused', () => {
  const { requireTestDatabase } = require('./helpers/guard');
  assert.equal(requireTestDatabase({ DB_NAME: 'glovesup_test' }), 'glovesup_test');
  for (const name of ['glovesup_dev', 'glovesup', 'glovesup_test_old', 'test', '_TEST', '']) {
    assert.throws(() => requireTestDatabase({ DB_NAME: name }), (err) => {
      assert.ok(err.message.includes(`DB_NAME is "${name}"`), err.message);
      assert.match(err.message, /ends in "_test"/);
      return true;
    }, name);
  }
  assert.throws(() => requireTestDatabase({}), /DB_NAME is "\(not set\)"/);
});

test('npm test preloads the guard', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /--require \.\/test\/helpers\/guard\.js/);
});

test('the test setup refuses an exported non-test DB_NAME before any test runs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const args = pkg.scripts.test.split(' ').slice(1); // the npm test command, without "node"
  const r = run([...args, 'test/health.test.js']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, REFUSED);
  assert.doesNotMatch(r.stdout, /✔ runs against/);
});

test('the migration tests refuse on their own, even without the npm test preload', () => {
  for (const file of ['test/migrate.test.js', 'test/battles-schema.test.js', 'test/submissions-schema.test.js']) {
    const r = run(['--env-file=.env.test', '--test', file]);
    assert.notEqual(r.status, 0, file);
    assert.match(r.stderr + r.stdout, REFUSED, file);
  }
});
