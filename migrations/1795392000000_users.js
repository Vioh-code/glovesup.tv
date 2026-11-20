// F-A1, F-A2: users table (02-data-model, section 1).
// Email and username are unique regardless of case (unique indexes on lower()).
// email, password_hash and dob_encrypted are hard-deleted on account deletion
// (F-A5), so they are nullable, but required while the account is not deleted.

exports.up = (pgm) => {
  pgm.createType('user_status', ['active', 'suspended', 'banned', 'deleted']);

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    username: { type: 'text', notNull: true },
    glover_name: { type: 'text' },
    email: { type: 'text' },
    email_verified_at: { type: 'timestamptz' },
    password_hash: { type: 'text' },
    dob_encrypted: { type: 'bytea' },
    age_gate_passed: { type: 'boolean', notNull: true },
    terms_accepted_at: { type: 'timestamptz' },
    mfa_secret: { type: 'bytea' },
    recovery_codes: { type: 'bytea' },
    avatar_url: { type: 'text' },
    bio: { type: 'text' },
    status: { type: 'user_status', notNull: true, default: 'active' },
    elo_rating: { type: 'integer', notNull: true, default: 1000 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('users', 'users_live_account_fields', {
    check: `status = 'deleted' OR (email IS NOT NULL AND password_hash IS NOT NULL
            AND dob_encrypted IS NOT NULL AND terms_accepted_at IS NOT NULL)`,
  });
  pgm.addConstraint('users', 'users_age_gate', { check: 'age_gate_passed' });

  pgm.createIndex('users', 'lower(username)', { name: 'users_username_lower_key', unique: true });
  pgm.createIndex('users', 'lower(email)', { name: 'users_email_lower_key', unique: true });
};

exports.down = (pgm) => {
  pgm.dropTable('users');
  pgm.dropType('user_status');
};
