require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');

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

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'glovesup-dev-secret',
    resave: false,
    saveUninitialized: false,
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
