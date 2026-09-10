require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function init() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  try {
    await pool.query(schema);
    console.log('Database schema initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize database schema:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

init();
