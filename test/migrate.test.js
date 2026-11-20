const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pool } = require('../db');

const root = path.join(__dirname, '..');

after(() => pool.end());

// Same command the npm migrate scripts run, pointed at the test env file.
function migrate(direction) {
  return execFileSync(
    process.execPath,
    ['--env-file=.env.test', 'scripts/migrate.js', direction],
    { cwd: root, encoding: 'utf8', stdio: 'pipe' },
  );
}

async function tableExists(name) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
  return rows[0].t !== null;
}

test('migrate script runs down and up cleanly on glovesup_test', () => {
  migrate('up'); // make sure we start fully migrated
  assert.match(migrate('down'), /glovesup_test/);
  assert.match(migrate('up'), /glovesup_test/);
  assert.match(migrate('up'), /No migrations to run/); // up is idempotent
});

test('session and users migrations each revert cleanly, then reapply', async () => {
  migrate('up');
  assert.ok(await tableExists('users'));
  assert.ok(await tableExists('session'));

  migrate('down'); // session
  assert.ok(!(await tableExists('session')));
  assert.ok(await tableExists('users'));

  migrate('down'); // users and its enum
  assert.ok(!(await tableExists('users')));
  const { rows } = await pool.query("SELECT 1 FROM pg_type WHERE typname = 'user_status'");
  assert.equal(rows.length, 0);

  migrate('up');
  assert.ok(await tableExists('users'));
  assert.ok(await tableExists('session'));
});
