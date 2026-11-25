// F-H2, F-C4: roles, permissions, role_permissions, user_roles and
// judge_assignments (02-data-model, sections 3 and 4). Slice 2c-1.
// - Every account is a Member without a user_roles row. The member role holds
//   the baseline permissions.
// - role_permissions.effect: allow or deny. A deny on any held role wins
//   (the matrix's NO: judges barred from ELO battles).
// - Seeds only the permissions enforced so far; each later slice adds its own.
//   Team roles come with the teams slice.
// - judge_assignments: one row per judge per battle, ever, so a judge who
//   declined is never drawn again for that battle.
// - `accepted` is no longer stored: accept goes straight to awaiting_panel.
//   Battles accepted before this slice move there (production had 0).
// Battles and assignments are kept for history (no cascade). A role grant
// means nothing without its user, so user_roles rows go with the user.

const ROLES = [
  ['member', 'Member'],
  ['judge', 'Judge'],
  ['moderator', 'Moderator'],
  ['admin', 'Admin'],
  ['super_admin', 'Super Admin'],
  ['site_owner', 'Site Owner'],
];
const PERMISSIONS = [
  ['battle.elo.enter', 'Create or accept an ELO call out'],
  ['judge.assignment.respond', 'Accept, decline, or recuse from a judge assignment'],
];
const GRANTS = [
  ['member', 'battle.elo.enter', 'allow'],
  ['judge', 'battle.elo.enter', 'deny'],
  ['judge', 'judge.assignment.respond', 'allow'],
  ['moderator', 'judge.assignment.respond', 'allow'],
  ['admin', 'judge.assignment.respond', 'allow'],
  ['super_admin', 'judge.assignment.respond', 'allow'],
  ['site_owner', 'judge.assignment.respond', 'allow'],
];

const q = (s) => `'${s.replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  pgm.createType('role_scope', ['site', 'team']);
  pgm.createType('permission_effect', ['allow', 'deny']);
  pgm.createType('judge_assignment_status', ['drawn', 'accepted', 'declined', 'recused', 'replaced', 'scored']);

  pgm.createTable('roles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    key: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    scope_type: { type: 'role_scope', notNull: true },
  });
  pgm.addConstraint('roles', 'roles_key', { unique: ['key'] });

  pgm.createTable('permissions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    key: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true },
  });
  pgm.addConstraint('permissions', 'permissions_key', { unique: ['key'] });

  pgm.createTable('role_permissions', {
    role_id: { type: 'uuid', notNull: true, references: 'roles', primaryKey: true },
    permission_id: { type: 'uuid', notNull: true, references: 'permissions', primaryKey: true },
    effect: { type: 'permission_effect', notNull: true, default: 'allow' },
  });

  pgm.createTable('user_roles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    role_id: { type: 'uuid', notNull: true, references: 'roles' },
    scope_type: { type: 'role_scope' },
    scope_id: { type: 'uuid' },
    // Null when granted outside the app (scripts/grant-role.js).
    granted_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    granted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('user_roles', 'user_roles_scope', { check: '(scope_type IS NULL) = (scope_id IS NULL)' });
  pgm.createIndex('user_roles', ['user_id', 'role_id'], {
    name: 'user_roles_one_site', unique: true, where: 'scope_id IS NULL',
  });
  pgm.createIndex('user_roles', ['user_id', 'role_id', 'scope_id'], {
    name: 'user_roles_one_scoped', unique: true, where: 'scope_id IS NOT NULL',
  });
  pgm.createIndex('user_roles', ['role_id']);

  pgm.createTable('judge_assignments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    battle_id: { type: 'uuid', notNull: true, references: 'battles' },
    judge_user_id: { type: 'uuid', notNull: true, references: 'users' },
    status: { type: 'judge_assignment_status', notNull: true, default: 'drawn' },
    drawn_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    respond_by: { type: 'timestamptz', notNull: true, default: pgm.func("now() + interval '48 hours'") },
    responded_at: { type: 'timestamptz' },
    score_due_at: { type: 'timestamptz' },
    // Staff sub-ins (deferred). Created now so later slices do not reshape the table.
    replaced_by: { type: 'uuid', references: 'users' },
    replaced_reason: { type: 'text' },
  });
  pgm.addConstraint('judge_assignments', 'judge_assignments_battle_judge', { unique: ['battle_id', 'judge_user_id'] });
  pgm.addConstraint('judge_assignments', 'judge_assignments_respond_48h', {
    check: "respond_by = drawn_at + interval '48 hours'",
  });
  pgm.createIndex('judge_assignments', ['judge_user_id', 'status']);

  pgm.sql(`INSERT INTO roles (key, name, scope_type) VALUES
    ${ROLES.map(([k, n]) => `(${q(k)}, ${q(n)}, 'site')`).join(',\n    ')}`);
  pgm.sql(`INSERT INTO permissions (key, description) VALUES
    ${PERMISSIONS.map(([k, d]) => `(${q(k)}, ${q(d)})`).join(',\n    ')}`);
  for (const [role, perm, effect] of GRANTS) {
    pgm.sql(`INSERT INTO role_permissions (role_id, permission_id, effect)
      SELECT r.id, p.id, ${q(effect)} FROM roles r, permissions p WHERE r.key = ${q(role)} AND p.key = ${q(perm)}`);
  }

  pgm.sql("UPDATE battles SET status = 'awaiting_panel' WHERE status = 'accepted'");
  pgm.addConstraint('battles', 'battles_no_accepted', { check: "status <> 'accepted'" });
  pgm.addConstraint('battles', 'battles_judging_due', { check: "status <> 'judging' OR judging_due_at IS NOT NULL" });
};

exports.down = (pgm) => {
  pgm.dropConstraint('battles', 'battles_judging_due');
  pgm.dropConstraint('battles', 'battles_no_accepted');
  pgm.sql("UPDATE battles SET status = 'accepted' WHERE status = 'awaiting_panel'");
  pgm.dropTable('judge_assignments');
  pgm.dropTable('user_roles');
  pgm.dropTable('role_permissions');
  pgm.dropTable('permissions');
  pgm.dropTable('roles');
  pgm.dropType('judge_assignment_status');
  pgm.dropType('permission_effect');
  pgm.dropType('role_scope');
};
