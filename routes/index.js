const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('index', {
    title: 'Gloves Up',
    user: req.user,
  });
});

module.exports = router;
