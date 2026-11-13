// Shared web setup: EJS views, static files, and the 404 and 500 handlers (S-P14).
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

function setupViews(app) {
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.static(path.join(ROOT, 'public'), { index: false }));
}

function notFound(req, res) {
  res.status(404).render('error', {
    heading: 'Page not found',
    message: 'That page does not exist or was moved.',
  });
}

// Never send error details to the browser. Log the message and path only:
// no request bodies, passwords or dates of birth.
function serverError(err, req, res, next) {
  console.error(`Error on ${req.method} ${req.path}: ${err.message}`);
  if (res.headersSent) return;
  res.status(500).render('error', {
    heading: 'Something went wrong',
    message: 'Try again in a moment.',
  });
}

module.exports = { setupViews, notFound, serverError };
