// F-C4, F-C5: judgments, recusal and finalize (02-data-model, section 3).
// Slice 2c-2. Decisions (Matt, Nov 25):
// - one judgment per judge per slot; the pick is challenger or opponent
//   (judges never produce void); a reason is typed (1 to 2,000 characters
//   after trimming), a YouTube review video (canonical url plus id), or both;
// - reasons_public_at is set on every judgment of the battle at finalize;
// - recused_at records when a judge recused (status recused);
// - a finalized battle has its result and finalized_at;
// - permission judge.judgment.submit: judge and staff (04-permissions-matrix,
//   "Pick a winner and give a reason").
// Judgments are kept for history (no cascade).

const ROLES = ['judge', 'moderator', 'admin', 'super_admin', 'site_owner'];

exports.up = (pgm) => {
  pgm.createType('judgment_pick', ['challenger', 'opponent']);

  pgm.createTable('judgments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    assignment_id: { type: 'uuid', notNull: true, references: 'judge_assignments' },
    slot_id: { type: 'uuid', notNull: true, references: 'battle_slots' },
    pick: { type: 'judgment_pick', notNull: true },
    reason_text: { type: 'text' },
    reason_video_url: { type: 'text' },
    reason_video_id: { type: 'text' },
    submitted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    reasons_public_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('judgments', 'judgments_assignment_slot', { unique: ['assignment_id', 'slot_id'] });
  pgm.addConstraint('judgments', 'judgments_reason_required', {
    check: 'reason_text IS NOT NULL OR reason_video_url IS NOT NULL',
  });
  pgm.addConstraint('judgments', 'judgments_reason_text_length', {
    check: 'reason_text IS NULL OR char_length(btrim(reason_text)) BETWEEN 1 AND 2000',
  });
  pgm.addConstraint('judgments', 'judgments_reason_video_pair', {
    check: '(reason_video_url IS NULL) = (reason_video_id IS NULL)',
  });
  pgm.addConstraint('judgments', 'judgments_reason_video_id', {
    check: "reason_video_id IS NULL OR reason_video_id ~ '^[A-Za-z0-9_-]{11}$'",
  });
  pgm.createIndex('judgments', ['slot_id']);

  pgm.addColumn('judge_assignments', { recused_at: { type: 'timestamptz' } });
  pgm.addConstraint('judge_assignments', 'judge_assignments_recused_at', {
    check: "(status = 'recused') = (recused_at IS NOT NULL)",
  });

  pgm.addConstraint('battles', 'battles_finalized_result', {
    check: "status <> 'finalized' OR (result IS NOT NULL AND finalized_at IS NOT NULL)",
  });

  pgm.sql("INSERT INTO permissions (key, description) VALUES ('judge.judgment.submit', 'Pick a winner and give a reason')");
  pgm.sql(`INSERT INTO role_permissions (role_id, permission_id, effect)
    SELECT r.id, p.id, 'allow' FROM roles r, permissions p
    WHERE p.key = 'judge.judgment.submit' AND r.key IN (${ROLES.map((k) => `'${k}'`).join(', ')})`);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM role_permissions WHERE permission_id IN
    (SELECT id FROM permissions WHERE key = 'judge.judgment.submit')`);
  pgm.sql("DELETE FROM permissions WHERE key = 'judge.judgment.submit'");
  pgm.dropConstraint('battles', 'battles_finalized_result');
  pgm.dropConstraint('judge_assignments', 'judge_assignments_recused_at');
  pgm.dropColumn('judge_assignments', 'recused_at');
  pgm.dropTable('judgments');
  pgm.dropType('judgment_pick');
};
