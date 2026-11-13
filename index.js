const express = require('express');
const { pool } = require('./db');
const { setupViews, notFound, serverError } = require('./lib/web');

const HOST = '127.0.0.1'; // Nginx proxies to this; never listen on all interfaces.

const app = express();
app.disable('x-powered-by');
setupViews(app);

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.type('text').send('ok');
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).type('text').send('db unavailable');
  }
});

// S-P1 Home (placeholder until the home slice)
app.get('/', (req, res) => res.render('home'));

app.use(notFound);
app.use(serverError);

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, HOST, () => {
    console.log(`GlovesUP listening on http://${HOST}:${port}`);
  });
}

module.exports = { app, HOST };
