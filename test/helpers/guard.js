// Safeguard: tests and test migrations run only against a database whose name
// ends in "_test". On Nov 24, 2026 an exported DB_NAME=glovesup_dev (Node's
// --env-file does not override a variable already set) made the suite wipe the
// dev database. npm test preloads this file (--require), so the check runs in
// the runner and in every test file's process before any test. The migration
// tests also call requireTestDatabase() themselves before each migration.
function requireTestDatabase(env = process.env) {
  const name = env.DB_NAME;
  if (typeof name === 'string' && name.endsWith('_test')) return name;
  throw new Error(
    `Refusing to run: DB_NAME is "${name === undefined ? '(not set)' : name}". Tests and test migrations only run `
    + 'against a database whose name ends in "_test" (glovesup_test). If DB_NAME is exported in this shell, '
    + 'unset it: node --env-file does not override a variable that is already set.',
  );
}

try {
  requireTestDatabase();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

module.exports = { requireTestDatabase };
