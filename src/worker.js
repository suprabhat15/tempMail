'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { createPool } = require('./db');
const { processOne, cleanupExpired } = require('./mail');

async function main() {
  const pool = createPool();
  let stopped = false;
  let nextCleanup = 0;
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopped = true; });
  console.log('Mail processing worker started');
  try {
    while (!stopped) {
      try {
        if (Date.now() >= nextCleanup) {
          await cleanupExpired(pool);
          nextCleanup = Date.now() + 60000;
        }
        if (!await processOne(pool)) await delay(1000);
      } catch (error) {
        console.error('Worker operation failed:', error.code || error.name);
        await delay(2000);
      }
    }
  } finally { await pool.end(); }
}

main().catch(error => { console.error('Worker stopped:', error.code || error.name); process.exitCode = 1; });
