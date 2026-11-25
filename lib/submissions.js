// F-C3 Submit videos: the data rules behind S-B5, the S-B2 battle status card
// and the S-M1 "Submit your video" item.
// - One live submission per player per slot (submitted or dead_link).
// - Open while the battle is awaiting_panel or submissions_open and before
//   submissions_due_at (closedReason in lib/battles).
// - The second video locks both (locked_at, one statement, one timestamp):
//   no replace or cancel after that (01-feature-spec, F-C3).
// - The opponent's video is hidden until both are in or the due date passes.
// Every change runs in a transaction that first locks the battle row, then
// the slot row (lib/panel withBattle), so two players (or two clicks) take
// turns, and a video that completes the battle and the last judge accept
// cannot race: settle() moves the status under the same lock.
const { pool } = require('../db');
const { closedReason } = require('./battles');
const { withBattle, settle } = require('./panel');

const LIVE = "('submitted', 'dead_link')";

async function slotFor(battleId, userId) {
  const { rows } = await pool.query(
    `SELECT id FROM battle_slots WHERE battle_id = $1 AND (challenger_user_id = $2 OR opponent_user_id = $2)
     ORDER BY position LIMIT 1`,
    [battleId, userId],
  );
  return rows[0] || null;
}

// What a player may see of a slot. The opponent's title, link and thumbnail
// leave the database only when `revealed` is true.
async function videoState(slotId, userId, pastDue) {
  const { rows } = await pool.query(
    `SELECT user_id, video_id, youtube_url, title_snapshot, thumbnail_snapshot, status, locked_at
     FROM submissions WHERE slot_id = $1 AND status IN ${LIVE}`,
    [slotId],
  );
  const mine = rows.find((r) => r.user_id === userId) || null;
  const theirsRow = rows.find((r) => r.user_id !== userId) || null;
  const revealed = Boolean(mine && theirsRow) || pastDue;
  return {
    mine,
    theirs: theirsRow && (revealed ? theirsRow : { submitted: true }),
    theirsIn: Boolean(theirsRow),
    locked: Boolean(mine && mine.locked_at),
    revealed,
  };
}

// Runs fn(client, mine, why) holding the battle and slot row locks. `why` is
// closedReason for the battle as read under the lock (null when open), never
// trusted from the page load. The battle status is settled before commit.
function withSlot(slotId, battleId, userId, fn) {
  return withBattle(battleId, async (client, b) => {
    await client.query('SELECT id FROM battle_slots WHERE id = $1 FOR UPDATE', [slotId]);
    const { rows: [mine] } = await client.query(
      `SELECT id, video_id, locked_at FROM submissions WHERE slot_id = $1 AND user_id = $2 AND status IN ${LIVE}`,
      [slotId, userId],
    );
    const out = await fn(client, mine || null, b ? closedReason(b) : 'notAccepted');
    if (b) await settle(client, battleId);
    return out;
  });
}

// Saves a checked video as the player's live submission, replacing an earlier
// one, then locks both if this is the second video in.
// Returns 'saved', 'same' (already the live video), 'locked', or the
// closedReason key.
function saveVideo({ slotId, battleId, userId, video }) {
  return withSlot(slotId, battleId, userId, async (client, mine, why) => {
    // Same video first: a second click on the video that just locked both is
    // the same click, not a refused change.
    if (mine && mine.video_id === video.videoId) return 'same';
    if (why) return why;
    if (mine && mine.locked_at) return 'locked';
    if (mine) await client.query("UPDATE submissions SET status = 'replaced' WHERE id = $1", [mine.id]);
    await client.query(
      `INSERT INTO submissions (slot_id, user_id, youtube_url, video_id, title_snapshot, thumbnail_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [slotId, userId, video.url, video.videoId, video.title, video.thumbnail],
    );
    await client.query(
      `UPDATE submissions SET locked_at = now()
       WHERE slot_id = $1 AND status IN ${LIVE} AND locked_at IS NULL
         AND (SELECT count(*) FROM submissions WHERE slot_id = $1 AND status IN ${LIVE}) = 2`,
      [slotId],
    );
    return 'saved';
  });
}

// Withdraws the player's live video. Returns 'cancelled', 'none' (nothing
// live: a repeat of their own cancel), 'locked', or the closedReason key.
function cancelVideo({ slotId, battleId, userId }) {
  return withSlot(slotId, battleId, userId, async (client, mine, why) => {
    if (!mine) return 'none';
    if (why) return why;
    if (mine.locked_at) return 'locked';
    await client.query("UPDATE submissions SET status = 'cancelled' WHERE id = $1", [mine.id]);
    return 'cancelled';
  });
}

// S-M1: battles still open for videos where the player has no live video,
// soonest due first.
async function videosDue(userId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.scoring, b.judging, b.submissions_due_at,
            CASE WHEN s.challenger_user_id = $1 THEN o.username ELSE c.username END AS other_name
     FROM battle_slots s
     JOIN battles b ON b.id = s.battle_id
     JOIN users c ON c.id = s.challenger_user_id
     JOIN users o ON o.id = s.opponent_user_id
     WHERE (s.challenger_user_id = $1 OR s.opponent_user_id = $1)
       AND b.status IN ('awaiting_panel', 'submissions_open') AND b.submissions_due_at > now()
       AND NOT EXISTS (SELECT 1 FROM submissions x WHERE x.slot_id = s.id AND x.user_id = $1 AND x.status IN ${LIVE})
     ORDER BY b.submissions_due_at ASC`,
    [userId],
  );
  return rows;
}

module.exports = { slotFor, videoState, saveVideo, cancelVideo, videosDue };
