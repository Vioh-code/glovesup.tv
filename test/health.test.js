const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, HOST } = require('../index');
const { pool } = require('../db');

after(() => pool.end());

test('runs against glovesup_test', () => {
  assert.equal(process.env.DB_NAME, 'glovesup_test');
});

test('GET /health returns ok after a DB query', async () => {
  const server = app.listen(0, HOST);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://${HOST}:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
