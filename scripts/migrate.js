'use strict';

const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createPool } = require('../src/db');

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(74638219)');
    await client.query(await readFile(join(__dirname, '../migrations/001-inboxes.sql'), 'utf8'));
    await client.query('COMMIT');
    console.log('Database schema ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => { console.error('Migration failed:', error.code || error.name); process.exitCode = 1; });
