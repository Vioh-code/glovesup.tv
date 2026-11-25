// Worker slice: the one-minute worker's timer rules, tested with an injected
// clock and a fake oEmbed fetch (Matt, Nov 25, 2026; 03-state-flows sections 1
// and 8). Decisions:
// - the worker sweeps the due columns; no scheduled_jobs table;
// - call out expiry at expires_at; missed due date: one side in forfeits the
//   other, neither in voids; finalized_at is the due time;
// - a judge past respond_by (no reply) or score_due_at (no pick) is replaced
//   only when a free judge exists; until then a late reply or pick is taken;
// - short official panels are topped up every run;
// - live videos on battles not over are rechecked once per 24 hours, at most
//   20 per run; 3 unreachable answers in a row end the run's checks;
// - every battle runs in its own transaction holding the battle row lock and
//   checks its condition again under the lock, so a second run does nothing.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { pool } = require('../db');
const worker = require('../lib/worker');
const panel = require('../lib/panel');
const judging = require('../lib/judging');
const subs = require('../lib/submissions');
const { clearBattles } = require('./helpers/db');

const H = 3600 * 1000;
const D = 24 * H;
const B = new Date(Math.floor(Date.now() / 1000) * 1000); // base time for every fixture
const at = (ms) => new Date(B.getTime() + ms);
const ids = {};
let vidSeq = 0;

beforeEach(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  for (const n of ['alice', 'bob']) await user(n);
});
after(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.end();
});

async function user(name, { judge = false } = {}) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at, status, email_verified_at)
     VALUES ($1, $2, 'x', '\\x00', true, now(), 'active', now()) RETURNING id`,
    [name, `${name}@example.com`],
  );
  ids[name] = u.id;
  if (judge) await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'judge'", [u.id]);
  return u.id;
}
const judges = async (...names) => { for (const n of names) await user(n, { judge: true }); };

const quiet = () => {
  const lines = [];
  const log = worker.makeLog({ out: (s) => lines.push(s), err: (s) => lines.push(s) });
  return { lines, log };
};
const { log: silent } = quiet();

async function callout(createdAt = B) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days,
                          created_at, updated_at, expires_at)
     VALUES ('single', 'fun', 'official', $1, $2, $1, 5, $3, $3, $3::timestamptz + interval '72 hours') RETURNING id`,
    [ids.alice, ids.bob, createdAt],
  );
  return b.id;
}

// An accepted 1v1 with its slot. Due date = acceptedAt + 5 days.
async function accepted({ acceptedAt = B, status = 'awaiting_panel', judgingKind = 'official', judgingDue = null } = {}) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days,
                          status, accepted_at, submissions_due_at, judging_due_at)
     VALUES ('single', 'fun', $3, $1, $2, $1, 5, $4, $5, $5::timestamptz + interval '120 hours', $6) RETURNING id`,
    [ids.alice, ids.bob, judgingKind, status, acceptedAt, judgingDue],
  );
  await pool.query(
    'INSERT INTO battle_slots (battle_id, position, challenger_user_id, opponent_user_id) VALUES ($1, 1, $2, $3)',
    [b.id, ids.alice, ids.bob],
  );
  return b.id;
}
const due = (acceptedAt = B) => new Date(acceptedAt.getTime() + 5 * D);

async function video(battleId, name, { status = 'submitted', locked = null, submittedAt = B, lastCheckedAt = null, videoId } = {}) {
  vidSeq += 1;
  const vid = videoId || `v${String(vidSeq).padStart(10, '0')}`;
  const { rows: [v] } = await pool.query(
    `INSERT INTO submissions (slot_id, user_id, youtube_url, video_id, title_snapshot, thumbnail_snapshot, status,
                              submitted_at, last_checked_at, locked_at)
     SELECT s.id, $2, 'https://www.youtube.com/watch?v=' || $3, $3, 'Saved ' || $3, 'https://i.ytimg.com/vi/' || $3 || '/hq.jpg',
            $4, $5, $6, $7
     FROM battle_slots s WHERE s.battle_id = $1 RETURNING *`,
    [battleId, ids[name], vid, status, submittedAt, lastCheckedAt, locked],
  );
  return v;
}
// Both videos in and locked.
async function bothIn(battleId, lockedAt = B) {
  await video(battleId, 'alice', { locked: lockedAt });
  await video(battleId, 'bob', { locked: lockedAt });
}

async function assign(battleId, name, { status = 'drawn', drawnAt = B, scoreDue = null } = {}) {
  const { rows: [a] } = await pool.query(
    `INSERT INTO judge_assignments (battle_id, judge_user_id, status, drawn_at, respond_by, responded_at, score_due_at)
     VALUES ($1, $2, $3::judge_assignment_status, $4, $4::timestamptz + interval '48 hours', CASE WHEN $3::judge_assignment_status = 'drawn' THEN NULL ELSE $4::timestamptz END, $5)
     RETURNING *`,
    [battleId, ids[name], status, drawnAt, scoreDue],
  );
  if (status === 'scored') await judgmentFor(a, battleId);
  return a;
}
async function judgmentFor(a, battleId, pick = 'challenger') {
  await pool.query(
    `INSERT INTO judgments (assignment_id, slot_id, pick, reason_text)
     SELECT $1, s.id, $3, 'reason' FROM battle_slots s WHERE s.battle_id = $2`,
    [a.id, battleId, pick],
  );
}

const battle = async (id) => (await pool.query('SELECT * FROM battles WHERE id = $1', [id])).rows[0];
const slot = async (id) => (await pool.query('SELECT * FROM battle_slots WHERE battle_id = $1', [id])).rows[0];
const vids = async (id) => (await pool.query(
  'SELECT v.* FROM submissions v JOIN battle_slots s ON s.id = v.slot_id WHERE s.battle_id = $1', [id],
)).rows;
const assignments = async (id) => (await pool.query(
  `SELECT a.*, u.username FROM judge_assignments a JOIN users u ON u.id = a.judge_user_id
   WHERE a.battle_id = $1 ORDER BY a.drawn_at, u.username`, [id],
)).rows;
const live = async (id) => (await assignments(id)).filter((a) => ['drawn', 'accepted', 'scored'].includes(a.status));
const of = async (id, name) => (await assignments(id)).find((a) => a.username === name);
const sameTime = (a, b, msg) => assert.equal(new Date(a).getTime(), new Date(b).getTime(), msg);

// oEmbed answers by video id: 'ok' (default), 'dead', 'down' (unreachable).
function fakeFetch(answers = {}, calls = [], onCall = async () => {}) {
  return async (href) => {
    const id = new URL(new URL(href).searchParams.get('url')).searchParams.get('v');
    calls.push(id);
    await onCall(id);
    const kind = answers[id] || 'ok';
    if (kind === 'down') throw new Error('network down');
    if (kind === 'dead') return new Response('Not Found', { status: 404 });
    return new Response(JSON.stringify({ title: 'A brand new title', thumbnail_url: 'https://i.ytimg.com/vi/new/hq.jpg' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
}

// --- Call out expiry (72h) ---

// 6
test('expiry: 1 ms before expires_at stays proposed; at expires_at it is expired and updated_at moves; other statuses untouched', async () => {
  const id = await callout();
  const declined = await callout();
  await pool.query("UPDATE battles SET status = 'declined' WHERE id = $1", [declined]);
  const before = await battle(id);
  assert.equal((await worker.expireCallouts({ now: at(72 * H - 1), log: silent })).expired, 0);
  assert.equal((await battle(id)).status, 'proposed');
  assert.equal((await worker.expireCallouts({ now: at(72 * H), log: silent })).expired, 1);
  const after1 = await battle(id);
  assert.equal(after1.status, 'expired');
  assert.ok(after1.updated_at > before.updated_at);
  assert.equal((await battle(declined)).status, 'declined');
});

// 7
test('expiry: a second run at the same time changes nothing', async () => {
  const id = await callout();
  await worker.expireCallouts({ now: at(72 * H), log: silent });
  const first = await battle(id);
  assert.equal((await worker.expireCallouts({ now: at(72 * H), log: silent })).expired, 0);
  sameTime((await battle(id)).updated_at, first.updated_at);
});

// --- Missed submission due date ---

// 8
test('due date: 1 ms before submissions_due_at nothing changes', async () => {
  const id = await accepted();
  await video(id, 'alice');
  const out = await worker.closeSubmissions({ now: new Date(due().getTime() - 1), log: silent });
  assert.equal(out.forfeited + out.voided, 0);
  assert.equal((await battle(id)).status, 'awaiting_panel');
});

// 9
test('due date: both videos in, nothing changes', async () => {
  const id = await accepted();
  await bothIn(id);
  const before = await battle(id);
  await worker.closeSubmissions({ now: due(), log: silent });
  const b = await battle(id);
  assert.equal(b.status, 'awaiting_panel');
  sameTime(b.updated_at, before.updated_at);
});

// 10
test('due date: only the challenger\'s video in: the opponent forfeits; the lone video locks at the due time', async () => {
  const id = await accepted({ status: 'submissions_open' });
  await video(id, 'alice');
  const out = await worker.closeSubmissions({ now: at(5 * D + 30 * 1000), log: silent });
  assert.equal(out.forfeited, 1);
  const b = await battle(id);
  assert.equal(b.status, 'forfeited');
  assert.equal(b.forfeited_by, ids.bob);
  assert.equal(b.forfeit_reason, 'missed_deadline');
  assert.equal(b.result, 'challenger');
  sameTime(b.finalized_at, due());
  assert.equal((await slot(id)).result, 'challenger');
  const [v] = await vids(id);
  sameTime(v.locked_at, due());
});

// 11
test('due date: only the opponent\'s video in: the challenger forfeits', async () => {
  const id = await accepted();
  await video(id, 'bob');
  await worker.closeSubmissions({ now: due(), log: silent });
  const b = await battle(id);
  assert.equal(b.status, 'forfeited');
  assert.equal(b.forfeited_by, ids.alice);
  assert.equal(b.result, 'opponent');
  assert.equal((await slot(id)).result, 'opponent');
});

// 12
test('due date: a dead_link video counts as in', async () => {
  const id = await accepted();
  await video(id, 'alice', { status: 'dead_link' });
  await worker.closeSubmissions({ now: due(), log: silent });
  const b = await battle(id);
  assert.equal(b.status, 'forfeited');
  assert.equal(b.forfeited_by, ids.bob);
  assert.equal(b.result, 'challenger');
});

// 13
test('due date: neither video in: voided, result void, slot void, finalized_at the due time', async () => {
  const id = await accepted();
  const out = await worker.closeSubmissions({ now: at(6 * D), log: silent });
  assert.equal(out.voided, 1);
  const b = await battle(id);
  assert.equal(b.status, 'voided');
  assert.equal(b.result, 'void');
  assert.equal(b.forfeited_by, null);
  assert.equal(b.forfeit_reason, null);
  sameTime(b.finalized_at, due());
  assert.equal((await slot(id)).result, 'void');
});

// 14
test('due date: a popular vote battle follows the same rules', async () => {
  const id = await accepted({ judgingKind: 'popular' });
  await video(id, 'bob');
  await worker.closeSubmissions({ now: due(), log: silent });
  const b = await battle(id);
  assert.equal(b.status, 'forfeited');
  assert.equal(b.forfeited_by, ids.alice);
});

// 15
test('due date: judging, finalized, forfeited and voided battles are untouched; a second run is a no-op', async () => {
  const j = await accepted({ status: 'judging', judgingDue: at(10 * D) });
  await bothIn(j);
  const f = await accepted();
  await pool.query("UPDATE battles SET status = 'finalized', result = 'challenger', finalized_at = $2 WHERE id = $1", [f, at(D)]);
  const lone = await accepted();
  await video(lone, 'alice');
  await worker.closeSubmissions({ now: due(), log: silent });
  const first = await battle(lone);
  assert.equal(first.status, 'forfeited');
  const out = await worker.closeSubmissions({ now: at(5 * D + H), log: silent });
  assert.equal(out.forfeited + out.voided, 0);
  sameTime((await battle(lone)).updated_at, first.updated_at);
  assert.equal((await battle(j)).status, 'judging');
  assert.equal((await battle(f)).status, 'finalized');
});

// 16
test('due date: after a forfeit, submit and cancel are refused as over; the panel is left as it was; no top-up', async () => {
  await judges('j1', 'j2', 'j3');
  const id = await accepted({ acceptedAt: at(-6 * D) }); // due a day ago in real time
  await video(id, 'alice');
  await assign(id, 'j1', { drawnAt: at(-6 * D) });
  await worker.closeSubmissions({ now: B, log: silent });
  assert.equal((await battle(id)).status, 'forfeited');
  const s = await slot(id);
  const v = { url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk', title: 't', thumbnail: null };
  assert.equal(await subs.saveVideo({ slotId: s.id, battleId: id, userId: ids.bob, video: v }), 'over');
  assert.equal(await subs.cancelVideo({ slotId: s.id, battleId: id, userId: ids.alice }), 'over');
  await worker.topUpPanels({ now: B, log: silent });
  const p = await assignments(id);
  assert.equal(p.length, 1);
  assert.equal(p[0].status, 'drawn');
});

// --- Judge reply (48h) ---

// 17
test('no reply: 1 ms before respond_by the judge is kept', async () => {
  await judges('j1', 'j2');
  const id = await accepted();
  await assign(id, 'j1');
  assert.equal((await worker.replaceSilentJudges({ now: at(48 * H - 1), log: silent })).replaced, 0);
  assert.equal((await of(id, 'j1')).status, 'drawn');
  assert.equal(await of(id, 'j2'), undefined);
});

// 18
test('no reply: at respond_by with a free judge, the judge is replaced (no_reply) and the new judge gets 48 hours from now', async () => {
  await judges('j1', 'j2');
  const id = await accepted();
  await assign(id, 'j1');
  const now = at(48 * H);
  assert.equal((await worker.replaceSilentJudges({ now, log: silent })).replaced, 1);
  const old = await of(id, 'j1');
  assert.equal(old.status, 'replaced');
  assert.equal(old.replaced_reason, 'no_reply');
  sameTime(old.replaced_at, now);
  const neu = await of(id, 'j2');
  assert.equal(neu.status, 'drawn');
  sameTime(neu.drawn_at, now);
  sameTime(neu.respond_by, new Date(now.getTime() + 48 * H));
});

// 19
test('no reply: with nobody free the judge stays drawn, and a late Accept is still taken', async () => {
  await judges('j1');
  const id = await accepted({ acceptedAt: at(-3 * D) });
  const a = await assign(id, 'j1', { drawnAt: at(-3 * D) });
  assert.equal((await worker.replaceSilentJudges({ now: B, log: silent })).replaced, 0);
  assert.equal((await of(id, 'j1')).status, 'drawn');
  assert.equal(await panel.respond(a.id, ids.j1, 'accept'), 'done');
  assert.equal((await of(id, 'j1')).status, 'accepted');
});

// 20
test('no reply: a replaced judge is never drawn again; the replacement is replaced in turn after its own 48 hours', async () => {
  await judges('j1', 'j2', 'j3');
  const id = await accepted();
  await assign(id, 'j1');
  await worker.replaceSilentJudges({ now: at(48 * H), log: silent });
  const second = (await live(id))[0];
  assert.notEqual(second.username, 'j1');
  await worker.replaceSilentJudges({ now: at(96 * H), log: silent });
  const third = (await live(id))[0];
  assert.notEqual(third.username, 'j1');
  assert.notEqual(third.username, second.username);
  assert.equal((await of(id, second.username)).replaced_reason, 'no_reply');
  // Nobody left: the third stays, and j1 is never drawn again.
  assert.equal((await worker.replaceSilentJudges({ now: at(144 * H), log: silent })).replaced, 0);
  const rows = await assignments(id);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.username === 'j1').length, 1);
});

// 21
test('no reply: popular vote battles and battles that are over are ignored', async () => {
  await judges('j1', 'j2', 'j3');
  const pop = await accepted({ judgingKind: 'popular' });
  await assign(pop, 'j1');
  const over = await accepted();
  await pool.query("UPDATE battles SET status = 'voided', result = 'void', finalized_at = $2 WHERE id = $1", [over, at(D)]);
  await assign(over, 'j2');
  assert.equal((await worker.replaceSilentJudges({ now: at(49 * H), log: silent })).replaced, 0);
  assert.equal((await of(pop, 'j1')).status, 'drawn');
  assert.equal((await of(over, 'j2')).status, 'drawn');
});

// --- Judge decision (5 days) ---

// A battle in judging: j1 due at S, j2 and j3 a day later. Both videos in.
const S = at(5 * D);
async function judgingBattle({ j1 = 'accepted', j2 = 'accepted', j3 = 'accepted' } = {}) {
  const id = await accepted({ status: 'judging', judgingDue: at(6 * D) });
  await bothIn(id);
  await assign(id, 'j1', { status: j1, scoreDue: S });
  await assign(id, 'j2', { status: j2, scoreDue: at(6 * D) });
  await assign(id, 'j3', { status: j3, scoreDue: at(6 * D) });
  return id;
}

// 23
test('no pick: before score_due_at the judge is kept', async () => {
  await judges('j1', 'j2', 'j3', 'j4');
  const id = await judgingBattle();
  assert.equal((await worker.replaceLateJudges({ now: new Date(S.getTime() - 1), log: silent })).replaced, 0);
  assert.equal((await of(id, 'j1')).status, 'accepted');
  assert.equal((await battle(id)).status, 'judging');
});

// 24
test('no pick: at score_due_at with a free judge, replaced (no_pick); back to awaiting_panel; other due dates unchanged', async () => {
  await judges('j1', 'j2', 'j3', 'j4');
  const id = await judgingBattle();
  assert.equal((await worker.replaceLateJudges({ now: S, log: silent })).replaced, 1);
  const old = await of(id, 'j1');
  assert.equal(old.status, 'replaced');
  assert.equal(old.replaced_reason, 'no_pick');
  sameTime(old.replaced_at, S);
  const b = await battle(id);
  assert.equal(b.status, 'awaiting_panel');
  sameTime(b.judging_due_at, at(6 * D));
  sameTime((await of(id, 'j2')).score_due_at, at(6 * D));
  sameTime((await of(id, 'j3')).score_due_at, at(6 * D));
  const neu = await of(id, 'j4');
  assert.equal(neu.status, 'drawn');
  sameTime(neu.drawn_at, S);
});

// 25
test('no pick: the replacement accepts, the battle is judging again, only they get 5 days, judging_due_at is the latest', async () => {
  await judges('j1', 'j2', 'j3', 'j4');
  const id = await judgingBattle();
  await worker.replaceLateJudges({ now: S, log: silent });
  const neu = await of(id, 'j4');
  const t0 = Date.now();
  assert.equal(await panel.respond(neu.id, ids.j4, 'accept'), 'done');
  const b = await battle(id);
  assert.equal(b.status, 'judging');
  const due4 = new Date((await of(id, 'j4')).score_due_at).getTime();
  assert.ok(due4 >= t0 + 5 * D - 5000 && due4 <= Date.now() + 5 * D + 5000, 'fresh 5 days');
  sameTime((await of(id, 'j2')).score_due_at, at(6 * D));
  const latest = Math.max(due4, at(6 * D).getTime());
  sameTime(b.judging_due_at, new Date(latest));
});

// 26
test('no pick: a judge who already submitted is never replaced', async () => {
  await judges('j1', 'j2', 'j3', 'j4', 'j5');
  const id = await judgingBattle({ j1: 'scored' });
  assert.equal((await worker.replaceLateJudges({ now: at(7 * D), log: silent })).replaced, 2); // j2, j3 are late
  assert.equal((await of(id, 'j1')).status, 'scored');
});

// 27
test('no pick: with nobody free the judge stays; a late pick is taken and finalizes', async () => {
  await judges('j1', 'j2', 'j3');
  const id = await judgingBattle({ j2: 'scored', j3: 'scored' });
  assert.equal((await worker.replaceLateJudges({ now: at(5 * D + H), log: silent })).replaced, 0);
  const a = await of(id, 'j1');
  assert.equal(a.status, 'accepted');
  assert.equal(await judging.submit(a.id, ids.j1, { pick: 'opponent', reasonText: 'late but fair', video: null }), 'done');
  const b = await battle(id);
  assert.equal(b.status, 'finalized');
  assert.equal(b.result, 'challenger');
});

// 28
test('no pick: end to end, the replacement and the two others finalize; the replaced judge has no judgment', async () => {
  await judges('j1', 'j2', 'j3', 'j4');
  const id = await judgingBattle();
  await worker.replaceLateJudges({ now: S, log: silent });
  const neu = await of(id, 'j4');
  assert.equal(await panel.respond(neu.id, ids.j4, 'accept'), 'done');
  for (const [name, pick] of [['j2', 'opponent'], ['j3', 'opponent'], ['j4', 'challenger']]) {
    const a = await of(id, name);
    assert.equal(await judging.submit(a.id, ids[name], { pick, reasonText: name, video: null }), 'done', name);
  }
  const b = await battle(id);
  assert.equal(b.status, 'finalized');
  assert.equal(b.result, 'opponent');
  const { rows } = await pool.query(
    'SELECT j.* FROM judgments j JOIN judge_assignments a ON a.id = j.assignment_id WHERE a.battle_id = $1', [id],
  );
  assert.equal(rows.length, 3);
  const j1 = await of(id, 'j1');
  assert.ok(!rows.some((r) => r.assignment_id === j1.id));
});

// --- Panel top-up ---

// 29
test('top-up: official battles with 0, 1 or 2 live judges are filled to 3 as far as judges allow, drawn at now', async () => {
  await judges('j1', 'j2', 'j3');
  const none = await accepted();
  const one = await accepted();
  await assign(one, 'j1');
  const two = await accepted({ status: 'awaiting_panel' });
  await assign(two, 'j1', { status: 'accepted' });
  await assign(two, 'j2');
  const now = at(H);
  const out = await worker.topUpPanels({ now, log: silent });
  assert.equal(out.drawn, 6);
  for (const id of [none, one, two]) assert.equal((await live(id)).length, 3);
  const fresh = (await assignments(none));
  assert.ok(fresh.every((a) => new Date(a.drawn_at).getTime() === now.getTime()));
  // Fewer free than needed: as far as it goes.
  const short = await accepted();
  await pool.query("DELETE FROM user_roles WHERE user_id IN ($1, $2)", [ids.j2, ids.j3]);
  assert.equal((await worker.topUpPanels({ now, log: silent })).drawn, 1);
  assert.equal((await live(short)).length, 1);
});

// 30
test('top-up: declined, recused and replaced judges do not count and are never drawn again', async () => {
  await judges('j1', 'j2', 'j3', 'j4');
  const id = await accepted();
  await pool.query(
    `INSERT INTO judge_assignments (battle_id, judge_user_id, status, responded_at, recused_at, replaced_at, replaced_reason)
     VALUES ($1, $2, 'declined', now(), NULL, NULL, NULL),
            ($1, $3, 'recused', now(), now(), NULL, NULL),
            ($1, $4, 'replaced', NULL, NULL, now(), 'no_reply')`,
    [id, ids.j1, ids.j2, ids.j3],
  );
  assert.equal((await worker.topUpPanels({ now: at(H), log: silent })).drawn, 1);
  const l = await live(id);
  assert.equal(l.length, 1);
  assert.equal(l[0].username, 'j4');
});

// 31
test('top-up: popular vote battles and battles that are over are never topped up', async () => {
  await judges('j1', 'j2', 'j3');
  const pop = await accepted({ judgingKind: 'popular' });
  const voided = await accepted();
  await pool.query("UPDATE battles SET status = 'voided', result = 'void', finalized_at = now() WHERE id = $1", [voided]);
  const callOut = await callout();
  assert.equal((await worker.topUpPanels({ now: at(H), log: silent })).drawn, 0);
  for (const id of [pop, voided, callOut]) assert.equal((await assignments(id)).length, 0);
});

// 32
test('run order: a battle past its due date is forfeited in the same run and gets no judges drawn', async () => {
  await judges('j1', 'j2', 'j3');
  const id = await accepted();
  await video(id, 'alice');
  const out = await worker.runOnce({ now: due(), log: silent, fetch: fakeFetch() });
  assert.equal(out.forfeited, 1);
  assert.equal(out.drawn, 0);
  assert.equal((await assignments(id)).length, 0);
});

// --- Stuck battles ---

// 33
test('stuck: a short panel, a silent judge and a late judge with nobody free are listed; healthy battles are not', async () => {
  await judges('j1', 'j2', 'j3');
  const short = await accepted();
  await assign(short, 'j1');
  const silentOne = await accepted();
  await assign(silentOne, 'j1');
  await assign(silentOne, 'j2', { status: 'accepted' });
  await assign(silentOne, 'j3', { status: 'accepted' });
  const late = await judgingBattle();
  const healthy = await accepted({ status: 'submissions_open' });
  for (const n of ['j1', 'j2', 'j3']) await assign(healthy, n, { status: 'accepted', drawnAt: at(4 * D) });
  const rows = await worker.stuckBattles({ now: at(5 * D) });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.reason]));
  assert.equal(byId[short], 'panel_short');
  assert.equal(byId[silentOne], 'no_reply');
  assert.equal(byId[late], 'no_pick');
  assert.equal(byId[healthy], undefined);
});

// --- Link recheck ---

// 34
test('recheck: only live videos on battles not over, 24 hours after the last check (or submit), oldest first, at most 20', async () => {
  const expected = [];
  for (let i = 0; i < 11; i += 1) {
    const id = await accepted({ status: 'submissions_open' });
    const a = await video(id, 'alice', { submittedAt: at(-50 * H + i * 2 * 60000) });
    const b = await video(id, 'bob', { submittedAt: at(-50 * H + (i * 2 + 1) * 60000) });
    expected.push(a.video_id, b.video_id);
  }
  const fresh = await accepted();
  await video(fresh, 'alice', { submittedAt: at(-23 * H) });
  await video(fresh, 'bob', { submittedAt: at(-60 * H), lastCheckedAt: at(-H) });
  const checkedLongAgo = await accepted();
  const old = await video(checkedLongAgo, 'alice', { submittedAt: at(-30 * H), lastCheckedAt: at(-25 * H) });
  const over = await accepted();
  await video(over, 'alice', { submittedAt: at(-90 * H) });
  await pool.query("UPDATE battles SET status = 'voided', result = 'void', finalized_at = now() WHERE id = $1", [over]);
  const hist = await accepted();
  await video(hist, 'alice', { status: 'replaced', submittedAt: at(-90 * H) });
  const calls = [];
  const out = await worker.recheckLinks({ now: B, log: silent, fetch: fakeFetch({}, calls) });
  assert.equal(out.checked, 20);
  assert.deepEqual(calls, expected.slice(0, 20));
  // The next run takes the rest: the last two, then the one checked 25 hours ago.
  const calls2 = [];
  await worker.recheckLinks({ now: B, log: silent, fetch: fakeFetch({}, calls2) });
  assert.deepEqual(calls2, [...expected.slice(20), old.video_id]);
});

// 35
test('recheck: dead becomes dead_link, alive stays or goes back to submitted; last_checked_at is now', async () => {
  const id = await accepted({ status: 'submissions_open' });
  const gone = await video(id, 'alice', { submittedAt: at(-2 * D) });
  const back = await video(id, 'bob', { status: 'dead_link', submittedAt: at(-2 * D) });
  const id2 = await accepted({ status: 'submissions_open' });
  const fine = await video(id2, 'alice', { submittedAt: at(-2 * D) });
  const out = await worker.recheckLinks({ now: B, log: silent, fetch: fakeFetch({ [gone.video_id]: 'dead' }) });
  assert.equal(out.dead, 1);
  assert.equal(out.alive, 1);
  const rows = Object.fromEntries((await pool.query('SELECT * FROM submissions')).rows.map((r) => [r.id, r]));
  assert.equal(rows[gone.id].status, 'dead_link');
  assert.equal(rows[back.id].status, 'submitted');
  assert.equal(rows[fine.id].status, 'submitted');
  for (const v of [gone, back, fine]) sameTime(rows[v.id].last_checked_at, B);
});

// 36
test('recheck: unreachable changes nothing; 3 unreachable in a row end the run\'s checks', async () => {
  const answers = {};
  const made = [];
  for (let i = 0; i < 3; i += 1) {
    const id = await accepted({ status: 'submissions_open' });
    made.push(await video(id, 'alice', { submittedAt: at(-50 * H + i * 2 * 60000) }));
    made.push(await video(id, 'bob', { submittedAt: at(-50 * H + (i * 2 + 1) * 60000) }));
  }
  // Order: 0 down, 1 ok (resets the count), 2, 3, 4 down -> stops; 5 is never asked.
  for (const i of [0, 2, 3, 4]) answers[made[i].video_id] = 'down';
  const calls = [];
  const out = await worker.recheckLinks({ now: B, log: silent, fetch: fakeFetch(answers, calls) });
  assert.deepEqual(calls, made.slice(0, 5).map((v) => v.video_id));
  assert.equal(out.unreachable, 4);
  const rows = Object.fromEntries((await pool.query('SELECT * FROM submissions')).rows.map((r) => [r.id, r]));
  assert.equal(rows[made[0].id].last_checked_at, null);
  assert.equal(rows[made[0].id].status, 'submitted');
  sameTime(rows[made[1].id].last_checked_at, B);
});

// 37
test('recheck: the saved title and thumbnail never change', async () => {
  const id = await accepted({ status: 'submissions_open' });
  const v = await video(id, 'alice', { submittedAt: at(-2 * D) });
  await worker.recheckLinks({ now: B, log: silent, fetch: fakeFetch() });
  const { rows: [r] } = await pool.query('SELECT * FROM submissions WHERE id = $1', [v.id]);
  assert.equal(r.title_snapshot, v.title_snapshot);
  assert.equal(r.thumbnail_snapshot, v.thumbnail_snapshot);
});

// 38
test('recheck: a video replaced while YouTube is asked is not overwritten', async () => {
  const id = await accepted({ status: 'submissions_open' });
  const v = await video(id, 'alice', { submittedAt: at(-2 * D) });
  const fetch = fakeFetch({ [v.video_id]: 'dead' }, [], async () => {
    await pool.query("UPDATE submissions SET status = 'replaced' WHERE id = $1", [v.id]);
  });
  await worker.recheckLinks({ now: B, log: silent, fetch });
  const { rows: [r] } = await pool.query('SELECT * FROM submissions WHERE id = $1', [v.id]);
  assert.equal(r.status, 'replaced');
  assert.equal(r.last_checked_at, null);
});

// --- runOnce and the script ---

async function mixedScene() {
  await judges('j1', 'j2', 'j3', 'j4');
  const c = await callout(at(-3 * D));
  const lone = await accepted({ acceptedAt: at(-5 * D) });
  await video(lone, 'alice', { submittedAt: at(-5 * D) });
  const empty = await accepted({ acceptedAt: at(-5 * D) });
  const panelBattle = await accepted({ acceptedAt: at(-2 * D) });
  await assign(panelBattle, 'j1', { drawnAt: at(-2 * D) });
  return { c, lone, empty, panelBattle };
}

// 39
test('runOnce: runs every handler in order and returns the counts', async () => {
  const s = await mixedScene();
  const out = await worker.runOnce({ now: B, log: silent, fetch: fakeFetch() });
  assert.equal(out.busy, false);
  assert.equal(out.expired, 1);
  assert.equal(out.forfeited, 1);
  assert.equal(out.voided, 1);
  assert.equal(out.replacedNoReply, 1);
  assert.equal(out.replacedNoPick, 0);
  assert.equal(out.drawn, 2); // panelBattle: 1 replacement live, 2 more drawn
  assert.equal(out.errors, 0);
  assert.equal((await live(s.panelBattle)).length, 3);
  assert.equal((await of(s.panelBattle, 'j1')).status, 'replaced');
});

async function teamBattle(dueAt) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_team_id, opponent_team_id, created_by, submission_days,
                          status, accepted_at, submissions_due_at)
     VALUES ('team', 'fun', 'official', gen_random_uuid(), gen_random_uuid(), $1, 5, 'awaiting_panel',
             $2::timestamptz - interval '120 hours', $2) RETURNING id`,
    [ids.alice, dueAt],
  );
  return b.id;
}

// 40
test('runOnce: a battle that throws is logged; the other battles are still done; the run reports an error', async () => {
  const team = await teamBattle(at(-H));
  const lone = await accepted({ acceptedAt: at(-5 * D) });
  await video(lone, 'alice');
  const { lines, log } = quiet();
  const out = await worker.runOnce({ now: B, log, fetch: fakeFetch() });
  assert.ok(out.errors >= 1);
  assert.equal((await battle(lone)).status, 'forfeited');
  assert.ok(lines.some((l) => /error/.test(l) && l.includes(team)), lines.join('\n'));
});

// 41
test('runOnce: two runs at the same time; the second changes nothing', async () => {
  await mixedScene();
  await worker.runOnce({ now: B, log: silent, fetch: fakeFetch() });
  const out = await worker.runOnce({ now: B, log: silent, fetch: fakeFetch() });
  for (const k of ['expired', 'forfeited', 'voided', 'replacedNoReply', 'replacedNoPick', 'drawn', 'checked']) {
    assert.equal(out[k], 0, k);
  }
});

// 42
test('runOnce: while another run holds the lock, a run does nothing and says busy', async () => {
  const c = await callout(at(-3 * D));
  const holder = await pool.connect();
  try {
    await holder.query('SELECT pg_advisory_lock($1)', [worker.LOCK_KEY]);
    const out = await worker.runOnce({ now: B, log: silent, fetch: fakeFetch() });
    assert.equal(out.busy, true);
    assert.equal((await battle(c)).status, 'proposed');
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [worker.LOCK_KEY]);
    holder.release();
  }
  assert.equal((await worker.runOnce({ now: B, log: silent, fetch: fakeFetch() })).busy, false);
  assert.equal((await battle(c)).status, 'expired');
});

// 43
test('logs: one line per change with ids, never usernames or emails', async () => {
  const s = await mixedScene();
  const id = await accepted({ status: 'submissions_open' });
  const v = await video(id, 'bob', { submittedAt: at(-2 * D) });
  const { lines, log } = quiet();
  await worker.runOnce({ now: B, log, fetch: fakeFetch({ [v.video_id]: 'dead' }) });
  const text = lines.join('\n');
  assert.match(text, new RegExp(`expired battle=${s.c}`));
  assert.match(text, new RegExp(`forfeit battle=${s.lone}`));
  assert.match(text, new RegExp(`void battle=${s.empty}`));
  assert.match(text, /replaced .*reason=no_reply/);
  assert.match(text, new RegExp(`dead_link .*submission=${v.id}`));
  for (const n of ['alice', 'bob', 'j1', 'j2', 'example.com']) assert.ok(!text.includes(n), n);
  assert.ok(lines.every((l) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z /.test(l)), text);
});

// 44
test('logs: a heartbeat at minute 0 of each hour; the stuck report at 12:00 UTC only', async () => {
  await judges('j1');
  const id = await accepted();
  await bothIn(id);
  await assign(id, 'j1', { status: 'accepted' });
  const run = async (iso) => {
    const { lines, log } = quiet();
    await worker.runOnce({ now: new Date(iso), log, fetch: fakeFetch() });
    return lines.join('\n');
  };
  const t1030 = await run('2040-01-01T10:30:00Z');
  assert.doesNotMatch(t1030, /heartbeat/);
  assert.doesNotMatch(t1030, /stuck/);
  const t1000 = await run('2040-01-01T10:00:00Z');
  assert.match(t1000, /heartbeat/);
  assert.doesNotMatch(t1000, /stuck/);
  const t1200 = await run('2040-01-01T12:00:00Z');
  assert.match(t1200, /heartbeat/);
  assert.match(t1200, new RegExp(`stuck battle=${id} reason=panel_short`));
});

// 45
function runScript() {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--env-file=.env.test', 'scripts/worker.js'], { cwd: path.join(__dirname, '..') },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
test('scripts/worker.js: exits 0 on a clean run and 1 when a battle throws', async () => {
  const c = await callout(at(-4 * D));
  const ok = await runScript();
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal((await battle(c)).status, 'expired');
  await teamBattle(at(-H));
  const bad = await runScript();
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /error/);
});

// --- panel.js `at` ---

// 46
test('drawJudges and settle: without `at` they use the database clock; with `at` they use it', async () => {
  await judges('j1', 'j2', 'j3', 'j4');
  const id = await accepted();
  await panel.withBattle(id, async (client, b) => {
    await panel.drawJudges(client, b, 1);
    await panel.drawJudges(client, b, 1, at(10 * D));
  });
  const rows = await assignments(id);
  const [dbClock, injected] = rows; // ordered by drawn_at
  assert.ok(Math.abs(new Date(dbClock.drawn_at).getTime() - Date.now()) < 60000);
  sameTime(injected.drawn_at, at(10 * D));
  sameTime(injected.respond_by, at(12 * D));
  // settle with `at`: entering judging gives score_due_at = at + 5 days.
  await pool.query("UPDATE judge_assignments SET status = 'accepted', responded_at = now() WHERE battle_id = $1", [id]);
  await panel.withBattle(id, (client, b) => panel.drawJudges(client, b, 1));
  await pool.query("UPDATE judge_assignments SET status = 'accepted', responded_at = now() WHERE battle_id = $1", [id]);
  await bothIn(id);
  await panel.withBattle(id, (client) => panel.settle(client, id, at(20 * D)));
  const b = await battle(id);
  assert.equal(b.status, 'judging');
  for (const a of await live(id)) sameTime(a.score_due_at, at(25 * D));
  sameTime(b.judging_due_at, at(25 * D));
});
