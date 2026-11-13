const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, HOST } = require('../index');
const { pool } = require('../db');

let server;
let base;

before(async () => {
  server = app.listen(0, HOST);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://${HOST}:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('GET / renders the visitor layout', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  for (const css of ['theme.css', 'components.css', 'screens.css']) {
    assert.ok(html.includes(`href="/css/${css}"`), `links ${css}`);
  }
  assert.ok(html.includes('class="site-header"'));
  assert.ok(html.includes('href="/login"'));
  assert.ok(html.includes('href="/register"'));
  assert.ok(html.includes('class="site-footer"'));
  assert.ok(!html.includes('screen-note'), 'wireframe notes are not shipped');
});

test('theme CSS and fonts are served', async () => {
  const css = await fetch(`${base}/css/theme.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.ok((await css.text()).includes('--color-ember'));

  const font = await fetch(`${base}/fonts/dm-sans-regular.woff2`);
  assert.equal(font.status, 200);
  assert.match(font.headers.get('content-type'), /font\/woff2/);
});

test('unknown path returns the 404 page inside the layout', async () => {
  const res = await fetch(`${base}/no-such-page`);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.ok(html.includes('Page not found'));
  assert.ok(html.includes('class="site-header"'));
});

test('a thrown error returns a 500 page without the error details', async () => {
  // Separate app so no test-only route ships in index.js.
  const express = require('express');
  const { setupViews, serverError } = require('../lib/web');
  const mini = express();
  setupViews(mini);
  mini.get('/boom', () => { throw new Error('secret detail'); });
  mini.use(serverError);
  const s = mini.listen(0, HOST);
  await new Promise((resolve) => s.once('listening', resolve));
  const logged = [];
  const origError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const res = await fetch(`http://${HOST}:${s.address().port}/boom`);
    assert.equal(res.status, 500);
    const html = await res.text();
    assert.ok(html.includes('Something went wrong'));
    assert.ok(html.includes('class="site-header"'));
    assert.ok(!html.includes('secret detail'), 'error message is not sent');
    assert.ok(!html.includes('.js:'), 'stack trace is not sent');
    assert.equal(logged.length, 1);
  } finally {
    console.error = origError;
    await new Promise((resolve) => s.close(resolve));
  }
});
