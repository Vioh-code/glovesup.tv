const express = require('express');
const { pool } = require('./db');
const { loadConfig } = require('./lib/config');
const { configureSessions } = require('./lib/session');
const { setupViews, notFound, serverError } = require('./lib/web');
const pages = require('./routes/pages');

const HOST = '127.0.0.1'; // Nginx proxies to this; never listen on all interfaces.

// Throws (and the app does not start) without SESSION_SECRET and DOB_ENC_KEY.
// Keep config out of app.locals and app.set: both are visible to views.
function createApp(env) {
  const config = loadConfig(env);

  const app = express();
  app.disable('x-powered-by');
  setupViews(app); // static files are served before sessions, so they never touch the store

  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.type('text').send('ok');
    } catch (err) {
      console.error('Health check failed:', err.message);
      res.status(503).type('text').send('db unavailable');
    }
  });

  configureSessions(app, config, pool);

  // S-P1 Home (placeholder until the home slice)
  app.get('/', (req, res) => res.render('home'));
  app.use(pages);

  app.use(notFound);
  app.use(serverError);
  return app;
}

let app;
try {
  app = createApp(process.env);
} catch (err) {
  if (require.main !== module) throw err;
  console.error(`GlovesUP refused to start: ${err.message}`);
  process.exit(1);
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, HOST, () => {
    console.log(`GlovesUP listening on http://${HOST}:${port}`);
  });
}

module.exports = { app, createApp, HOST };
