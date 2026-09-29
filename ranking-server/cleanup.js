'use strict';

const CLEANUP_LOCK_KEY = 81273491;

const retentionMonths = () => {
  const value = Number(process.env.HISTORY_RETENTION_MONTHS || 1);
  return Number.isInteger(value) && value > 0 && value <= 24 ? value : 1;
};

const tombstoneRetentionDays = () => {
  const value = Number(process.env.RUN_TOMBSTONE_RETENTION_DAYS || 90);
  return Number.isInteger(value) && value >= 30 && value <= 3650 ? value : 90;
};

async function ensureRetentionSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranking_run_tombstones (
      run_id VARCHAR(100) PRIMARY KEY,
      player_id VARCHAR(80) NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ranking_players_rank_idx
      ON ranking_players (total_score DESC, updated_at ASC, player_id ASC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ranking_runs_ended_at_idx
      ON ranking_runs (ended_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ranking_runs_player_id_idx
      ON ranking_runs (player_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ranking_run_tombstones_expiry_idx
      ON ranking_run_tombstones (expires_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS scores_created_at_idx
      ON scores (created_at)
  `);
}

async function cleanupHistory(pool, { dryRun = false } = {}) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    // Score writes use the same transaction lock so cleanup cannot delete a
    // run between the duplicate check and its aggregate update.
    await client.query('SELECT pg_advisory_xact_lock($1)', [CLEANUP_LOCK_KEY]);

    const months = retentionMonths();
    const tombstoneDays = tombstoneRetentionDays();
    const cutoffResult = await client.query(
      `SELECT CURRENT_TIMESTAMP - make_interval(months => $1::int) AS cutoff`,
      [months]
    );
    const cutoff = cutoffResult.rows[0].cutoff;

    // Legacy scores are only safe to remove after the one-time cumulative
    // migration has completed. This guard also makes the manual CLI safe to
    // run against an older database during the migration window.
    const metaTable = await client.query(`SELECT to_regclass('public.ranking_meta') AS table_name`);
    let scoresCleanupReady = false;
    if (metaTable.rows[0].table_name) {
      const marker = await client.query(
        `SELECT 1 FROM ranking_meta WHERE key = 'stage-multiplied-cumulative-v3' LIMIT 1`
      );
      scoresCleanupReady = marker.rowCount > 0;
    }

    const [runs, scores, tombstones] = await Promise.all([
      client.query('SELECT COUNT(*)::int AS count FROM ranking_runs WHERE ended_at < $1', [cutoff]),
      scoresCleanupReady
        ? client.query('SELECT COUNT(*)::int AS count FROM scores WHERE created_at < $1', [cutoff])
        : Promise.resolve({ rows: [{ count: '0' }] }),
      client.query('SELECT COUNT(*)::int AS count FROM ranking_run_tombstones WHERE expires_at <= CURRENT_TIMESTAMP')
    ]);
    const result = {
      dryRun: Boolean(dryRun),
      cutoff: new Date(cutoff).toISOString(),
      runs: Number(runs.rows[0].count),
      scores: Number(scores.rows[0].count),
      tombstones: Number(tombstones.rows[0].count),
      scoresCleanupReady,
      tombstoneRetentionDays: tombstoneDays
    };

    if (dryRun) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return result;
    }

    await client.query(
      `INSERT INTO ranking_run_tombstones (run_id, player_id, deleted_at, expires_at)
       SELECT run_id, player_id, CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP + make_interval(days => $1::int)
       FROM ranking_runs
       WHERE ended_at < $2
       ON CONFLICT (run_id) DO NOTHING`,
      [tombstoneDays, cutoff]
    );
    await client.query('DELETE FROM ranking_runs WHERE ended_at < $1', [cutoff]);
    if (scoresCleanupReady) {
      await client.query('DELETE FROM scores WHERE created_at < $1', [cutoff]);
    }
    await client.query('DELETE FROM ranking_run_tombstones WHERE expires_at <= CURRENT_TIMESTAMP');
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  CLEANUP_LOCK_KEY,
  cleanupHistory,
  ensureRetentionSchema,
  retentionMonths,
  tombstoneRetentionDays
};
