// The one-minute worker's entry script (worker slice). Cron runs it every
// minute under flock -n, with absolute paths:
//   /usr/bin/node --env-file=<repo>/.env <repo>/scripts/worker.js
// Node reads the env file into this process only; the shell never sources it.
// The clock is always the real one (no flag or env value can move it).
// Exit code: 0 when the run is clean (or another run holds the lock), 1 when
// anything failed. Output: one line per change on stdout, errors on stderr
// (lib/worker.js makeLog). Dev box by hand: npm run worker:dev
const { pool } = require('../db');
const { runOnce } = require('../lib/worker');

async function main() {
  const out = await runOnce({ now: new Date() });
  return out.errors ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`${new Date().toISOString()} error handler=worker message=${JSON.stringify(String(err.message))}\n${err.stack}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
