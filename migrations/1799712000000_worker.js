// Worker slice (Matt, Nov 25, 2026): the one-minute worker sweeps the due
// columns (expires_at, submissions_due_at, respond_by, score_due_at); there is
// no scheduled_jobs table. This migration adds:
// - judge_assignments.replaced_at, and replaced_reason limited to the
//   worker's two reasons (no_reply after 48 hours, no_pick after 5 days).
//   Staff sub-in reasons are added with their slice;
// - the forfeit and void rules on battles (a missed due date: one side in
//   forfeits the other, neither in voids; finalized_at is the due time);
// - one partial index per sweep.
// The checks avoid NULL comparisons (a NULL CHECK passes): IS NOT NULL and
// IS NOT DISTINCT FROM.
// No data changes: no row is replaced, forfeited or voided before this slice.

exports.up = (pgm) => {
  pgm.addColumn('judge_assignments', { replaced_at: { type: 'timestamptz' } });
  pgm.addConstraint('judge_assignments', 'judge_assignments_replaced_at', {
    check: "(status = 'replaced') = (replaced_at IS NOT NULL)",
  });
  pgm.addConstraint('judge_assignments', 'judge_assignments_replaced_reason', {
    check: "(status = 'replaced') = (replaced_reason IS NOT NULL) AND (replaced_reason IS NULL OR replaced_reason IN ('no_reply', 'no_pick'))",
  });

  pgm.addConstraint('battles', 'battles_forfeit', {
    check: `(status = 'forfeited') = (forfeited_by IS NOT NULL)
            AND (forfeited_by IS NULL) = (forfeit_reason IS NULL)
            AND (status <> 'forfeited' OR (result IS NOT NULL AND result <> 'void' AND finalized_at IS NOT NULL))`,
  });
  pgm.addConstraint('battles', 'battles_voided', {
    check: "status <> 'voided' OR (result IS NOT DISTINCT FROM 'void' AND finalized_at IS NOT NULL)",
  });

  pgm.createIndex('judge_assignments', 'respond_by', { name: 'judge_assignments_reply_due', where: "status = 'drawn'" });
  pgm.createIndex('judge_assignments', 'score_due_at', { name: 'judge_assignments_pick_due', where: "status = 'accepted'" });
  pgm.createIndex('battles', 'submissions_due_at', {
    name: 'battles_submissions_due', where: "status IN ('awaiting_panel', 'submissions_open')",
  });
  pgm.sql(`CREATE INDEX submissions_recheck_due ON submissions (coalesce(last_checked_at, submitted_at))
           WHERE status IN ('submitted', 'dead_link')`);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX submissions_recheck_due');
  pgm.dropIndex('battles', 'submissions_due_at', { name: 'battles_submissions_due' });
  pgm.dropIndex('judge_assignments', 'score_due_at', { name: 'judge_assignments_pick_due' });
  pgm.dropIndex('judge_assignments', 'respond_by', { name: 'judge_assignments_reply_due' });
  pgm.dropConstraint('battles', 'battles_voided');
  pgm.dropConstraint('battles', 'battles_forfeit');
  pgm.dropConstraint('judge_assignments', 'judge_assignments_replaced_reason');
  pgm.dropConstraint('judge_assignments', 'judge_assignments_replaced_at');
  pgm.dropColumn('judge_assignments', 'replaced_at');
};
