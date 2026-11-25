// F-H2 permission checks over the roles tables (04-permissions-matrix).
// Roles stack: every active account is a Member (no user_roles row needed);
// site roles held in user_roles add to that. An action is allowed when some
// role the user has allows it and none denies it: a deny (the matrix's NO)
// wins. Inactive and unknown accounts can do nothing.
// Team-scoped roles are not checked here; they come with the teams slice.
const { pool } = require('../db');

const HELD_ROLES = `
  SELECT r.id FROM roles r WHERE r.key = 'member'
  UNION
  SELECT ur.role_id FROM user_roles ur WHERE ur.user_id = $1 AND ur.scope_id IS NULL`;

async function can(userId, key, db = pool) {
  const { rows: [r] } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND status = 'active')
        AND bool_or(rp.effect = 'allow') IS TRUE
        AND NOT (bool_or(rp.effect = 'deny') IS TRUE) AS ok
     FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
     WHERE p.key = $2 AND rp.role_id IN (${HELD_ROLES})`,
    [userId, key],
  );
  return Boolean(r && r.ok);
}

// A site role the user holds in user_roles. Member is implicit and never stored.
async function hasRole(userId, key, db = pool) {
  const { rows } = await db.query(
    `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.key = $2 AND ur.scope_id IS NULL`,
    [userId, key],
  );
  return rows.length > 0;
}

module.exports = { can, hasRole };
