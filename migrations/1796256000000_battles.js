// F-C1, F-C2: battles table (02-data-model, section 3). A call out is a battle
// in the proposed state; one table holds both.
// Every field from the data model is created now so later slices do not
// reshape the table. Team ids get their foreign keys in the teams slice.
// The `stuck` status is left out until F-H6 (ALTER TYPE ... ADD VALUE then).
// Day counts are fixed 24-hour days (make_interval(hours => 24 * N)) so due
// dates never depend on the session TimeZone or daylight saving.

exports.up = (pgm) => {
  pgm.createType('battle_kind', ['single', 'team']);
  pgm.createType('battle_scoring', ['elo', 'fun']);
  pgm.createType('battle_judging', ['official', 'popular']);
  pgm.createType('battle_status', [
    'proposed', 'accepted', 'declined', 'cancelled', 'expired', 'awaiting_panel',
    'submissions_open', 'judging', 'finalized', 'forfeited', 'voided',
  ]);
  pgm.createType('battle_result', ['challenger', 'opponent', 'void']);
  pgm.createType('forfeit_reason', ['explicit', 'missed_deadline']);

  pgm.createTable('battles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    kind: { type: 'battle_kind', notNull: true },
    scoring: { type: 'battle_scoring', notNull: true },
    judging: { type: 'battle_judging', notNull: true },
    challenger_user_id: { type: 'uuid', references: 'users' },
    opponent_user_id: { type: 'uuid', references: 'users' },
    challenger_team_id: { type: 'uuid' },
    opponent_team_id: { type: 'uuid' },
    created_by: { type: 'uuid', notNull: true, references: 'users' },
    status: { type: 'battle_status', notNull: true, default: 'proposed' },
    // Null on Just for fun battles, where the band does not apply.
    elo_band_ok: { type: 'boolean' },
    submission_days: { type: 'integer', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true, default: pgm.func("now() + interval '72 hours'") },
    accepted_at: { type: 'timestamptz' },
    submissions_due_at: { type: 'timestamptz' },
    judging_due_at: { type: 'timestamptz' },
    finalized_at: { type: 'timestamptz' },
    result: { type: 'battle_result' },
    forfeited_by: { type: 'uuid' },
    forfeit_reason: { type: 'forfeit_reason' },
  });

  pgm.addConstraint('battles', 'battles_elo_needs_official', {
    check: "scoring <> 'elo' OR judging = 'official'",
  });
  pgm.addConstraint('battles', 'battles_elo_band', {
    check: "scoring <> 'elo' OR elo_band_ok IS TRUE",
  });
  pgm.addConstraint('battles', 'battles_submission_days', {
    check: 'submission_days IN (3, 5, 7)',
  });
  pgm.addConstraint('battles', 'battles_participants', {
    check: `(kind = 'single' AND challenger_user_id IS NOT NULL AND opponent_user_id IS NOT NULL
             AND challenger_team_id IS NULL AND opponent_team_id IS NULL
             AND challenger_user_id <> opponent_user_id)
         OR (kind = 'team' AND challenger_team_id IS NOT NULL AND opponent_team_id IS NOT NULL
             AND challenger_user_id IS NULL AND opponent_user_id IS NULL
             AND challenger_team_id <> opponent_team_id)`,
  });
  pgm.addConstraint('battles', 'battles_expiry_72h', {
    check: "expires_at = created_at + interval '72 hours'",
  });
  pgm.addConstraint('battles', 'battles_due_after_accept', {
    check: `(accepted_at IS NULL) = (submissions_due_at IS NULL)
            AND (accepted_at IS NULL OR submissions_due_at = accepted_at + make_interval(hours => 24 * submission_days))
            AND ((accepted_at IS NULL) = (status IN ('proposed', 'declined', 'cancelled', 'expired')))`,
  });

  pgm.createIndex('battles', ['opponent_user_id', 'status']);
  pgm.createIndex('battles', ['challenger_user_id', 'status']);
  // Expiry sweep (page loads now, the worker later) touches only proposed rows.
  pgm.createIndex('battles', 'expires_at', { name: 'battles_proposed_expiry', where: "status = 'proposed'" });
};

exports.down = (pgm) => {
  pgm.dropTable('battles');
  for (const t of ['forfeit_reason', 'battle_result', 'battle_status', 'battle_judging', 'battle_scoring', 'battle_kind']) {
    pgm.dropType(t);
  }
};
