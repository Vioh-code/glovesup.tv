// Test cleanup only. Battles, slots, submissions, judge assignments and judgments are
// never deleted by the app (02-data-model: Keep); the foreign keys block it,
// so tests clear the child tables first. user_roles rows go with their user
// (ON DELETE CASCADE).
async function clearBattles(pool) {
  // judgments (slice 2c-2) is missing while a migration test has reverted it.
  await pool.query("DO $$ BEGIN IF to_regclass('public.judgments') IS NOT NULL THEN DELETE FROM judgments; END IF; END $$");
  await pool.query('DELETE FROM judge_assignments');
  await pool.query('DELETE FROM submissions');
  await pool.query('DELETE FROM battle_slots');
  await pool.query('DELETE FROM battles');
}

module.exports = { clearBattles };
