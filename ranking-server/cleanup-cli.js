'use strict';

const { Pool } = require('pg');
const { cleanupHistory, ensureRetentionSchema } = require('./cleanup');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 5),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 10000),
  ssl: process.env.NODE_ENV === 'production' || /sslmode=require/i.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined
});

(async () => {
  try {
    await ensureRetentionSchema(pool);
    const result = await cleanupHistory(pool, { dryRun: process.env.DRY_RUN === '1' });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('History cleanup failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
