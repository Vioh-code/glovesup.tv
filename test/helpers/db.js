// Test cleanup only. Battles, slots and submissions are never deleted by the
// app (02-data-model: Keep); the foreign keys block it, so tests clear the
// child tables first.
async function clearBattles(pool) {
  await pool.query('DELETE FROM submissions');
  await pool.query('DELETE FROM battle_slots');
  await pool.query('DELETE FROM battles');
}

module.exports = { clearBattles };
