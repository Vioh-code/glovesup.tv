const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');

// Same command the npm migrate scripts run, pointed at the test env file.
function migrate(direction) {
  return execFileSync(
    process.execPath,
    ['--env-file=.env.test', 'scripts/migrate.js', direction],
    { cwd: root, encoding: 'utf8', stdio: 'pipe' },
  );
}

test('migrate script runs down and up cleanly on glovesup_test', () => {
  migrate('up'); // make sure we start fully migrated
  assert.match(migrate('down'), /glovesup_test/);
  assert.match(migrate('up'), /glovesup_test/);
  assert.match(migrate('up'), /No migrations to run/); // up is idempotent
});
