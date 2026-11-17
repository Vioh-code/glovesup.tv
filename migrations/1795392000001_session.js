// F-A2: session store table for connect-pg-simple.
// Same shape as connect-pg-simple's table.sql. The app never auto-creates it
// (createTableIfMissing stays off).

exports.up = (pgm) => {
  pgm.createTable('session', {
    sid: { type: 'varchar', notNull: true, primaryKey: true },
    sess: { type: 'json', notNull: true },
    expire: { type: 'timestamp(6)', notNull: true },
  });
  pgm.createIndex('session', 'expire', { name: 'IDX_session_expire' });
};

exports.down = (pgm) => {
  pgm.dropTable('session');
};
