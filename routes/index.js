const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const result = await db.query('SELECT NOW() AS now');
    res.render('index', {
      title: 'Gloves Up',
      serverTime: result.rows[0].now,
    });
  } catch (err) {
    console.error('Database error:', err);
    res.render('index', {
      title: 'Gloves Up',
      serverTime: null,
    });
  }
});

module.exports = router;
