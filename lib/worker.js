// The one-minute worker (worker slice, Matt, Nov 25, 2026; 03-state-flows,
// sections 1 and 8). It sweeps the due columns; there is no scheduled_jobs
// table (it returns only if email retries need it, F-H7).
// Each run, in this order, so a battle that ends at its due date never gets
// judges drawn first:
//   1. expire call outs past expires_at (72 hours);
//   2. close submissions past submissions_due_at: one side in, the other
//      forfeits (missed_deadline); neither in, void. finalized_at is the due time;
//   3. replace judges past respond_by (no reply, 48 hours);
//   4. replace judges past score_due_at (no pick, 5 days);
//      3 and 4 replace only when a free judge exists. Until then the judge
//      keeps the seat and a late reply or pick is still taken;
//   5. top up official panels with fewer than 3 live judges;
//   6. recheck saved videos with YouTube oEmbed, each once per 24 hours, at
//      most 20 per run, stopping after 3 unreachable answers in a row.
// Safety: scripts/worker.js runs under flock -n and runOnce takes a Postgres
// advisory lock, so two runs never overlap. Each battle runs in its own
// transaction holding the battle row lock (withBattle) and checks its
// condition again under the lock, so a run that repeats, or races a player or
// judge, changes nothing twice. One battle failing is logged; the rest go on.
// The clock is `now`, passed in (tests inject it; the script passes new Date()).
// Logs: one line per change, ids only (never usernames or emails).
const { pool } = require('../db');
const { TOUCH_SQL, markExpired } = require('./battles');
const { PANEL_SIZE, IN_PLAY, PANEL_OPEN, videosLockedSql, withBattle, drawJudges, settle } = require('./panel');
const youtube = require('./youtube');

const LOCK_KEY = 2026112501; // pg advisory lock id for the worker
const BATCH = 100; // battles per handler per run
const RECHECK_LIMIT = 20; // videos per run
const RECHECK_BUDGET_MS = 30 * 1000;
const UNREACHABLE_STOP = 3;
const LIVE = "('submitted', 'dead_link')";
const LIVE_SEATS = "('drawn', 'accepted', 'scored')";
const sqlList = (xs) => `(${xs.map((x) => `'${x}'`).join(', ')})`;

function makeLog({ out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const line = (now, event, fields) => [now.toISOString(), event, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join(' ');
  return {
    info: (now, event, fields = {}) => out(line(now, event, fields)),
    error: (now, handler, fields, e) => {
      const message = JSON.stringify(String((e && e.message) || e));
      err(`${line(now, 'error', { handler, ...fields, message })}${e && e.stack ? `\n${e.stack}` : ''}`);
    },
  };
}

// Runs fn under each battle's lock. A throw is logged and counted; the rest go on.
async function eachBattle(ids, handler, now, log, fn) {
  let errors = 0;
  for (const id of ids) {
    try {
      await withBattle(id, (client, b) => (b ? fn(client, b) : null));
    } catch (e) {
      errors += 1;
      log.error(now, handler, { battle: id }, e);
    }
  }
  return errors;
}
const idsOf = async (sql, params) => (await pool.query(sql, params)).rows.map((r) => r.id);

// 1. Call out expiry. No penalty in V1.
async function expireCallouts({ now, log = makeLog() }) {
  const ids = await markExpired(now);
  for (const id of ids) log.info(now, 'expired', { battle: id });
  return { expired: ids.length, errors: 0 };
}

// 2. Missed submission due date (official and popular vote battles alike).
async function closeSubmissions({ now, log = makeLog() }) {
  const out = { forfeited: 0, voided: 0, errors: 0 };
  const ids = await idsOf(
    `SELECT b.id FROM battles b
     WHERE b.status IN ${sqlList(PANEL_OPEN)} AND b.submissions_due_at <= $1 AND NOT ${videosLockedSql('b.id')}
     ORDER BY b.submissions_due_at LIMIT ${BATCH}`,
    [now],
  );
  out.errors = await eachBattle(ids, 'closeSubmissions', now, log, async (client, b) => {
    if (!PANEL_OPEN.includes(b.status) || b.submissions_due_at > now) return;
    if (b.kind !== 'single') throw new Error('team battles close from the teams slice on');
    const { rows: [slot] } = await client.query('SELECT * FROM battle_slots WHERE battle_id = $1 FOR UPDATE', [b.id]);
    const { rows: vids } = await client.query(
      `SELECT user_id FROM submissions WHERE slot_id = $1 AND status IN ${LIVE}`, [slot.id],
    );
    const challengerIn = vids.some((v) => v.user_id === slot.challenger_user_id);
    const opponentIn = vids.some((v) => v.user_id === slot.opponent_user_id);
    if (challengerIn && opponentIn) return;
    if (challengerIn || opponentIn) {
      const winner = challengerIn ? 'challenger' : 'opponent';
      const missing = challengerIn ? slot.opponent_user_id : slot.challenger_user_id;
      await client.query(
        `UPDATE submissions SET locked_at = $2 WHERE slot_id = $1 AND status IN ${LIVE} AND locked_at IS NULL`,
        [slot.id, b.submissions_due_at],
      );
      await client.query('UPDATE battle_slots SET result = $2 WHERE id = $1', [slot.id, winner]);
      await client.query(
        `UPDATE battles SET status = 'forfeited', forfeited_by = $2, forfeit_reason = 'missed_deadline', result = $3,
                finalized_at = submissions_due_at, ${TOUCH_SQL}
         WHERE id = $1`,
        [b.id, missing, winner],
      );
      // Slice 2d hook: on scoring = 'elo', add the elo_ledger rows here, in
      // this same transaction: reason 'forfeit', the forfeiting player
      // (forfeited_by) loses, the other wins, K = 32. Production has no ELO
      // battles before 2d (Matt, Nov 25).
      out.forfeited += 1;
      log.info(now, 'forfeit', { battle: b.id, missing: challengerIn ? 'opponent' : 'challenger' });
      return;
    }
    await client.query("UPDATE battle_slots SET result = 'void' WHERE id = $1", [slot.id]);
    await client.query(
      `UPDATE battles SET status = 'voided', result = 'void', finalized_at = submissions_due_at, ${TOUCH_SQL} WHERE id = $1`,
      [b.id],
    );
    // Slice 2d: a void moves no rating; no ledger rows.
    out.voided += 1;
    log.info(now, 'void', { battle: b.id });
  });
  return out;
}

// 3 and 4. Replaces judges past a deadline, one free judge each, while any is
// free. `from`: the assignment status, `due`: its deadline column.
async function replaceJudges({ now, log, from, due, reason, handler }) {
  const out = { replaced: 0, errors: 0 };
  const ids = await idsOf(
    `SELECT a.battle_id AS id FROM judge_assignments a JOIN battles b ON b.id = a.battle_id
     WHERE a.status = '${from}' AND a.${due} <= $1 AND b.judging = 'official' AND b.kind = 'single'
       AND b.status IN ${sqlList(IN_PLAY)}
     GROUP BY a.battle_id ORDER BY min(a.${due}) LIMIT ${BATCH}`,
    [now],
  );
  out.errors = await eachBattle(ids, handler, now, log, async (client, b) => {
    if (!IN_PLAY.includes(b.status) || b.judging !== 'official') return;
    const { rows: late } = await client.query(
      `SELECT id FROM judge_assignments WHERE battle_id = $1 AND status = '${from}' AND ${due} <= $2 ORDER BY ${due}, id`,
      [b.id, now],
    );
    let changed = false;
    for (const a of late) {
      if ((await drawJudges(client, b, 1, now)) === 0) break; // nobody free: the judge keeps the seat
      await client.query(
        "UPDATE judge_assignments SET status = 'replaced', replaced_at = $2, replaced_reason = $3 WHERE id = $1",
        [a.id, now, reason],
      );
      changed = true;
      out.replaced += 1;
      log.info(now, 'replaced', { battle: b.id, assignment: a.id, reason });
    }
    if (changed) await settle(client, b.id, now);
  });
  return out;
}
const replaceSilentJudges = ({ now, log = makeLog() }) => replaceJudges({
  now, log, from: 'drawn', due: 'respond_by', reason: 'no_reply', handler: 'replaceSilentJudges',
});
const replaceLateJudges = ({ now, log = makeLog() }) => replaceJudges({
  now, log, from: 'accepted', due: 'score_due_at', reason: 'no_pick', handler: 'replaceLateJudges',
});

const liveCount = (battle) => `(SELECT count(*) FROM judge_assignments a WHERE a.battle_id = ${battle} AND a.status IN ${LIVE_SEATS})::int`;

// 5. Panel top-up: official battles in play with fewer than 3 live judges.
async function topUpPanels({ now, log = makeLog() }) {
  const out = { drawn: 0, errors: 0 };
  const ids = await idsOf(
    `SELECT b.id FROM battles b
     WHERE b.judging = 'official' AND b.kind = 'single' AND b.status IN ${sqlList(IN_PLAY)} AND ${liveCount('b.id')} < ${PANEL_SIZE}
     ORDER BY b.accepted_at LIMIT ${BATCH}`,
    [],
  );
  out.errors = await eachBattle(ids, 'topUpPanels', now, log, async (client, b) => {
    if (!IN_PLAY.includes(b.status) || b.judging !== 'official') return;
    const { rows: [{ live }] } = await client.query(`SELECT ${liveCount('$1')} AS live`, [b.id]);
    const n = await drawJudges(client, b, PANEL_SIZE - live, now);
    if (!n) return;
    await settle(client, b.id, now);
    out.drawn += n;
    log.info(now, 'drawn', { battle: b.id, count: n });
  });
  return out;
}

// Battles in play that wait on judges nobody can fill (F-H6 lists them later):
// a short panel, a judge past respond_by, or a judge past score_due_at.
async function stuckBattles({ now }) {
  const { rows } = await pool.query(
    `SELECT id, CASE WHEN live < ${PANEL_SIZE} THEN 'panel_short' WHEN no_reply THEN 'no_reply' ELSE 'no_pick' END AS reason
     FROM (SELECT b.id, ${liveCount('b.id')} AS live,
             EXISTS (SELECT 1 FROM judge_assignments a WHERE a.battle_id = b.id AND a.status = 'drawn' AND a.respond_by <= $1) AS no_reply,
             EXISTS (SELECT 1 FROM judge_assignments a WHERE a.battle_id = b.id AND a.status = 'accepted' AND a.score_due_at <= $1) AS no_pick
           FROM battles b
           WHERE b.judging = 'official' AND b.kind = 'single' AND b.status IN ${sqlList(IN_PLAY)}) s
     WHERE live < ${PANEL_SIZE} OR no_reply OR no_pick
     ORDER BY id`,
    [now],
  );
  return rows;
}

// 6. Dead-link recheck. No lock is held while YouTube is asked; the write
// only touches a row that is still live, so a replace or cancel meanwhile wins.
async function recheckLinks({ now, fetch, log = makeLog(), limit = RECHECK_LIMIT, budgetMs = RECHECK_BUDGET_MS }) {
  const out = { checked: 0, dead: 0, alive: 0, unreachable: 0, errors: 0 };
  const { rows } = await pool.query(
    `SELECT v.id, v.video_id, s.battle_id FROM submissions v
     JOIN battle_slots s ON s.id = v.slot_id JOIN battles b ON b.id = s.battle_id
     WHERE v.status IN ${LIVE} AND b.status IN ${sqlList(IN_PLAY)}
       AND coalesce(v.last_checked_at, v.submitted_at) <= $1::timestamptz - interval '24 hours'
     ORDER BY coalesce(v.last_checked_at, v.submitted_at), v.id LIMIT $2`,
    [now, limit],
  );
  const started = Date.now();
  let streak = 0;
  for (const v of rows) {
    if (Date.now() - started > budgetMs || streak >= UNREACHABLE_STOP) break;
    try {
      const r = await youtube.checkVideo(v.video_id, { fetch });
      out.checked += 1;
      if (!r.ok && r.reason === 'unreachable') {
        streak += 1;
        out.unreachable += 1;
        continue;
      }
      streak = 0;
      const next = r.ok ? 'submitted' : 'dead_link';
      const { rows: [w] } = await pool.query(
        `WITH old AS (SELECT status FROM submissions WHERE id = $1 AND status IN ${LIVE} FOR UPDATE)
         UPDATE submissions s SET status = $2, last_checked_at = $3 FROM old WHERE s.id = $1 RETURNING old.status AS was`,
        [v.id, next, now],
      );
      if (!w || w.was === next) continue;
      out[r.ok ? 'alive' : 'dead'] += 1;
      log.info(now, r.ok ? 'alive' : 'dead_link', { battle: v.battle_id, submission: v.id });
    } catch (e) {
      out.errors += 1;
      log.error(now, 'recheckLinks', { submission: v.id }, e);
    }
  }
  return out;
}

// One run. Returns { busy: true } when another run holds the lock.
async function runOnce({ now = new Date(), fetch, log = makeLog() } = {}) {
  const client = await pool.connect();
  try {
    const { rows: [{ ok }] } = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
    if (!ok) return { busy: true };
    try {
      const counts = {
        busy: false, expired: 0, forfeited: 0, voided: 0, replacedNoReply: 0, replacedNoPick: 0, drawn: 0,
        checked: 0, dead: 0, alive: 0, unreachable: 0, errors: 0,
      };
      const steps = [
        ['expireCallouts', () => expireCallouts({ now, log }), {}],
        ['closeSubmissions', () => closeSubmissions({ now, log }), {}],
        ['replaceSilentJudges', () => replaceSilentJudges({ now, log }), { replaced: 'replacedNoReply' }],
        ['replaceLateJudges', () => replaceLateJudges({ now, log }), { replaced: 'replacedNoPick' }],
        ['topUpPanels', () => topUpPanels({ now, log }), {}],
        ['recheckLinks', () => recheckLinks({ now, fetch, log }), {}],
      ];
      for (const [name, step, rename] of steps) {
        try {
          const out = await step();
          for (const [k, v] of Object.entries(out)) counts[rename[k] || k] += v;
        } catch (e) {
          counts.errors += 1;
          log.error(now, name, {}, e);
        }
      }
      if (now.getUTCMinutes() === 0) log.info(now, 'heartbeat');
      if (now.getUTCHours() === 12 && now.getUTCMinutes() === 0) {
        try {
          for (const s of await stuckBattles({ now })) log.info(now, 'stuck', { battle: s.id, reason: s.reason });
        } catch (e) {
          counts.errors += 1;
          log.error(now, 'stuckBattles', {}, e);
        }
      }
      return counts;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

module.exports = {
  LOCK_KEY,
  makeLog,
  expireCallouts,
  closeSubmissions,
  replaceSilentJudges,
  replaceLateJudges,
  topUpPanels,
  stuckBattles,
  recheckLinks,
  runOnce,
};
