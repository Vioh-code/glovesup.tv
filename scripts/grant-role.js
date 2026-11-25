// Grants a site role to a member: stands in for a super admin assigning a role
// directly (F-E1) until the admin screens exist.
// Usage: node --env-file=<file> scripts/grant-role.js <username> <role>
// DB settings come from the process environment (the --env-file you pass).
// Idempotent: a second run grants nothing and says so. Refuses unknown users,
// accounts that are not active or not verified, unknown roles, member (every
// account has it), and team roles (they need a team).
// Production use is a manual Linode step, after Matt says so.
const { pool } = require('../db');

async function grantRole(username, roleKey) {
  const { rows: [user] } = await pool.query(
    'SELECT id, username, status, email_verified_at FROM users WHERE lower(username) = lower($1)', [String(username)],
  );
  if (!user) throw new Error(`No account named "${username}".`);
  if (user.status !== 'active') throw new Error(`${user.username} is ${user.status}. Only active accounts can hold a role.`);
  if (!user.email_verified_at) throw new Error(`${user.username} has not verified their email.`);
  const { rows: [role] } = await pool.query('SELECT id, key, scope_type FROM roles WHERE key = $1', [String(roleKey)]);
  if (!role) throw new Error(`Unknown role "${roleKey}".`);
  if (role.key === 'member') throw new Error('Every account is a member already.');
  if (role.scope_type !== 'site') throw new Error(`"${role.key}" is a team role. Team roles come with the teams slice.`);
  const { rowCount } = await pool.query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
     ON CONFLICT (user_id, role_id) WHERE scope_id IS NULL DO NOTHING`,
    [user.id, role.id],
  );
  return { result: rowCount ? 'granted' : 'already', username: user.username, role: role.key };
}

async function main() {
  const [username, roleKey] = process.argv.slice(2);
  if (!username || !roleKey) {
    throw new Error('Usage: node --env-file=<file> scripts/grant-role.js <username> <role>');
  }
  const out = await grantRole(username, roleKey);
  console.log(out.result === 'granted'
    ? `Granted ${out.role} to ${out.username}.`
    : `${out.username} already has ${out.role}. Nothing changed.`);
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err.message);
      await pool.end().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { grantRole };
