// F-C4, F-C5 result rules (slice 2c-2), pure functions, no database:
// - each pairing is decided by the majority of exactly 3 judge picks; never
//   fewer (a silent judge is replaced by the worker slice, the battle waits);
// - a team battle goes to the side that wins at least 2 of its 3 pairings.
// Judges never produce `void`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { majority, teamResult } = require('../lib/judging');

test('majority: 3-0 and 2-1 either way, with the winning vote count', () => {
  assert.deepEqual(majority(['challenger', 'challenger', 'challenger']), { winner: 'challenger', votes: 3 });
  assert.deepEqual(majority(['opponent', 'opponent', 'opponent']), { winner: 'opponent', votes: 3 });
  assert.deepEqual(majority(['challenger', 'opponent', 'challenger']), { winner: 'challenger', votes: 2 });
  assert.deepEqual(majority(['opponent', 'challenger', 'opponent']), { winner: 'opponent', votes: 2 });
  assert.deepEqual(majority(['challenger', 'opponent', 'opponent']), { winner: 'opponent', votes: 2 });
});

test('majority: never decides on fewer or more than 3 picks, or on a bad pick', () => {
  for (const picks of [[], ['challenger'], ['challenger', 'challenger'], ['challenger', 'opponent'],
    ['challenger', 'challenger', 'opponent', 'opponent'], ['challenger', 'challenger', 'void'],
    ['challenger', 'challenger', undefined], 'challenger', null]) {
    assert.throws(() => majority(picks), /3 picks/, JSON.stringify(picks));
  }
});

test('team result: the side that wins at least 2 of the 3 pairings', () => {
  assert.equal(teamResult(['challenger', 'challenger', 'opponent']), 'challenger');
  assert.equal(teamResult(['opponent', 'challenger', 'opponent']), 'opponent');
  assert.equal(teamResult(['challenger', 'challenger', 'challenger']), 'challenger');
  assert.equal(teamResult(['opponent', 'opponent', 'opponent']), 'opponent');
});

test('team result: needs exactly 3 pairing results, each challenger or opponent', () => {
  for (const results of [[], ['challenger', 'challenger'], ['challenger', 'opponent', 'void'],
    ['challenger', 'challenger', 'challenger', 'opponent'], null]) {
    assert.throws(() => teamResult(results), /3 pairing/, JSON.stringify(results));
  }
});
