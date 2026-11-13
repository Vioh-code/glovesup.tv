// Postgres connection settings come from the env file (DB_* values).
// Node loads the file with --env-file; see the npm scripts.
const { Pool } = require('pg');

function dbConfig() {
  const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing database settings: ${missing.join(', ')}`);
  }
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
}

const pool = new Pool(dbConfig());

module.exports = { pool, dbConfig };
