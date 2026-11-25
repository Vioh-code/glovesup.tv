// F-C3: battle_slots and submissions (02-data-model, section 3).
// A 1v1 battle has one slot (position 1); team battles get three in the teams
// slice. A slot collects each player's submissions: one live row per player
// (submitted or dead_link), plus replaced and cancelled rows as history.
// Battles, slots and submissions are kept for history, so the foreign keys
// have no cascade and block deletes.
// Backfill: every 1v1 battle accepted before this slice gets its slot.

exports.up = (pgm) => {
  pgm.createType('submission_status', ['submitted', 'replaced', 'cancelled', 'dead_link']);

  pgm.createTable('battle_slots', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    battle_id: { type: 'uuid', notNull: true, references: 'battles' },
    position: { type: 'integer', notNull: true },
    challenger_user_id: { type: 'uuid', notNull: true, references: 'users' },
    opponent_user_id: { type: 'uuid', notNull: true, references: 'users' },
    result: { type: 'battle_result' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('battle_slots', 'battle_slots_battle_id_position', { unique: ['battle_id', 'position'] });
  pgm.addConstraint('battle_slots', 'battle_slots_position', { check: 'position BETWEEN 1 AND 3' });
  pgm.addConstraint('battle_slots', 'battle_slots_participants', { check: 'challenger_user_id <> opponent_user_id' });
  // A player's slots (dashboard "Submit your video", slot lookups), as battles has.
  pgm.createIndex('battle_slots', ['challenger_user_id']);
  pgm.createIndex('battle_slots', ['opponent_user_id']);

  pgm.createTable('submissions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    slot_id: { type: 'uuid', notNull: true, references: 'battle_slots' },
    user_id: { type: 'uuid', notNull: true, references: 'users' },
    youtube_url: { type: 'text', notNull: true },
    video_id: { type: 'text', notNull: true },
    title_snapshot: { type: 'text', notNull: true },
    // Null when oEmbed gave no thumbnail on i.ytimg.com (the only image host the CSP allows).
    thumbnail_snapshot: { type: 'text' },
    status: { type: 'submission_status', notNull: true, default: 'submitted' },
    last_checked_at: { type: 'timestamptz' },
    submitted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    locked_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('submissions', 'submissions_video_id', { check: "video_id ~ '^[A-Za-z0-9_-]{11}$'" });
  pgm.addConstraint('submissions', 'submissions_canonical_url', {
    check: "youtube_url = 'https://www.youtube.com/watch?v=' || video_id",
  });
  pgm.createIndex('submissions', ['slot_id', 'user_id'], {
    name: 'submissions_one_live', unique: true, where: "status IN ('submitted', 'dead_link')",
  });
  pgm.createIndex('submissions', ['slot_id']);

  pgm.sql(`
    INSERT INTO battle_slots (battle_id, position, challenger_user_id, opponent_user_id)
    SELECT id, 1, challenger_user_id, opponent_user_id FROM battles
    WHERE kind = 'single' AND accepted_at IS NOT NULL`);
};

exports.down = (pgm) => {
  pgm.dropTable('submissions');
  pgm.dropTable('battle_slots');
  pgm.dropType('submission_status');
};
