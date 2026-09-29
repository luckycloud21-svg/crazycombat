'use strict';

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
  ssl: process.env.NODE_ENV === 'production' || /sslmode=require/i.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined
});

(async () => {
  try {
    const [summary, tableSizes, orphanRuns, topPlayers] = await Promise.all([
      pool.query(`
      SELECT
        pg_database_size(current_database())::bigint AS database_bytes,
        (SELECT COUNT(*) FROM scores)::bigint AS scores_count,
        (SELECT COUNT(*) FROM ranking_players)::bigint AS players_count,
        (SELECT COUNT(*) FROM ranking_runs)::bigint AS runs_count,
        (SELECT MIN(created_at) FROM scores) AS oldest_score,
        (SELECT MAX(created_at) FROM scores) AS newest_score,
        (SELECT MIN(ended_at) FROM ranking_runs) AS oldest_run,
        (SELECT MAX(ended_at) FROM ranking_runs) AS newest_run,
        (SELECT COALESCE(SUM(cumulative_score), 0)::bigint FROM ranking_players) AS cumulative_score_sum,
        (SELECT COALESCE(SUM(total_score), 0)::bigint FROM ranking_players) AS total_score_sum
      `),
      pool.query(`
        SELECT relname AS table_name,
               pg_total_relation_size(('public.' || quote_ident(relname))::regclass)::bigint AS bytes
        FROM pg_class
        WHERE relkind = 'r'
          AND relnamespace = 'public'::regnamespace
          AND relname IN ('scores', 'ranking_players', 'ranking_runs', 'ranking_run_tombstones')
        ORDER BY bytes DESC
      `),
      pool.query(`
        SELECT COUNT(*)::bigint AS orphan_runs
        FROM ranking_runs AS runs
        LEFT JOIN ranking_players AS players ON players.player_id = runs.player_id
        WHERE players.player_id IS NULL
      `),
      pool.query(`
        SELECT player_id, name, total_score, stage, runs, updated_at
        FROM ranking_players
        ORDER BY total_score DESC, updated_at ASC, player_id ASC
        LIMIT 10
      `)
    ]);
    const databaseBytes = Number(summary.rows[0].database_bytes || 0);
    const freePlanGuardBytes = 450 * 1024 * 1024;
    console.log(JSON.stringify({
      summary: summary.rows[0],
      neonFreePlanGuard: {
        guardBytes: freePlanGuardBytes,
        warning: databaseBytes >= freePlanGuardBytes,
        message: databaseBytes >= freePlanGuardBytes
          ? 'Database is at or above the conservative Neon Free storage guard; review capacity before migration.'
          : 'Database is below the conservative Neon Free storage guard.'
      },
      tableSizes: tableSizes.rows,
      orphanRuns: orphanRuns.rows[0].orphan_runs,
      topPlayers: topPlayers.rows
    }, null, 2));
  } catch (error) {
    console.error('Database inspection failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
