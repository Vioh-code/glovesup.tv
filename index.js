require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);

const passport = require('./config/passport');

const routes = require('./routes');
const authRoutes = require('./routes/auth');

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const isProd = process.env.NODE_ENV === 'production';
if (isProd && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}
if (isProd) app.set('trust proxy', 1);

const sessionPool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 5,
});

app.use(
  session({
    store: new pgSession({
      pool: sessionPool,
      tableName: 'session',
      createTableIfMissing: !isProd,
    }),
    secret: process.env.SESSION_SECRET || 'glovesup-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => {
  res.locals.user = req.user;
  next();
});

app.use('/auth', authRoutes);
app.use('/', routes);

app.listen(port, () => {
  console.log(`GlovesUp server running on port ${port}`);
});
