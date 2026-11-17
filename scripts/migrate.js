// Runs node-pg-migrate against the database named in the env file.
// Usage: node --env-file=<file> scripts/migrate.js [up|down]
//   up   applies all pending migrations (default)
//   down reverts the most recent migration
const path = require('node:path');
const { runner } = require('node-pg-migrate');
const { dbConfig } = require('../db');

async function main() {
  const direction = process.argv[2] || 'up';
  if (direction !== 'up' && direction !== 'down') {
    throw new Error(`Unknown direction "${direction}". Use up or down.`);
  }
  const config = dbConfig();
  console.log(`Migrating ${direction} on ${config.database}@${config.host}`);
  await runner({
    databaseUrl: config,
    dir: path.join(__dirname, '..', 'migrations'),
    migrationsTable: 'pgmigrations',
    direction,
    count: direction === 'down' ? 1 : Infinity,
    checkOrder: true,
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
