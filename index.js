require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const routes = require('./routes');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

app.locals.db = pool;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', routes);

app.listen(port, () => {
  console.log(`GlovesUp server running on port ${port}`);
});
