// Test cleanup only. Battles, slots, submissions and judge assignments are
// never deleted by the app (02-data-model: Keep); the foreign keys block it,
// so tests clear the child tables first. user_roles rows go with their user
// (ON DELETE CASCADE).
async function clearBattles(pool) {
  await pool.query('DELETE FROM judge_assignments');
  await pool.query('DELETE FROM submissions');
  await pool.query('DELETE FROM battle_slots');
  await pool.query('DELETE FROM battles');
}

module.exports = { clearBattles };
