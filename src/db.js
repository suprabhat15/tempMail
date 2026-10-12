'use strict';

const { Pool } = require('pg');

function createPool() {
  const pool = new Pool({
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    // Mail may only be acknowledged after WAL is flushed, regardless of server defaults.
    options: '-c synchronous_commit=on',
    application_name: 'temp-mail-haraka',
  });
  pool.on('error', error => console.error('Database connection error:', error.code || error.name));
  return pool;
}

module.exports = { createPool };
