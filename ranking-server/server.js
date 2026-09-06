const express = require('express');
const cors = require('cors');
const { createHash, createHmac, timingSafeEqual } = require('crypto');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 10000);
const maxRunScore = 2000000000;
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '')).replace(/\/+$/, '');
const itchOAuthRedirectUri = String(process.env.ITCH_OAUTH_REDIRECT_URI || (publicBaseUrl ? `${publicBaseUrl}/auth/itch/callback` : ''));
const authSecret = String(process.env.AUTH_SECRET || createHash('sha256').update(`crazycombat-auth:${process.env.DATABASE_URL || 'development'}`).digest('hex'));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : undefined
});

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    // itch.io serves HTML5 uploads from *.itch.zone, commonly
    // html-classic.itch.zone. The project page itself is usually *.itch.io.
    const isItchHost = host === 'itch.io'
      || host.endsWith('.itch.io')
      || host === 'itch.zone'
      || host.endsWith('.itch.zone');
    return url.protocol === 'https:' && isItchHost;
  } catch (_) {
    return false;
  }
}

app.use(cors({
  origin(origin, callback) {
    // No Origin header is common for health checks and server-to-server calls.
    // Explicit CORS_ORIGINS entries remain supported; itch.io's official HTTPS
    // page/CDN hosts are also accepted because the game runs inside an iframe.
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS origin is not allowed'));
  }
}));

app.use(express.json({ limit: '10kb' }));

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'crazycombat-ranking' });
});

function signedSession(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(user.id),
    username: user.username,
    displayName: user.displayName,
    iat: now,
    exp: now + 30 * 24 * 60 * 60
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', authSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function authenticatedUser(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = createHmac('sha256', authSecret).update(encoded).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.sub || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return { id: String(payload.sub), username: String(payload.username || '').slice(0, 64), displayName: String(payload.displayName || '').slice(0, 64) };
  } catch (_) {
    return null;
  }
}

app.get('/auth/itch/start', (req, res) => {
  const clientId = String(process.env.ITCH_CLIENT_ID || '').trim();
  const state = String(req.query.state || '').trim();
  if (!clientId || !itchOAuthRedirectUri) {
    return res.status(503).type('text').send('ITCH_CLIENT_ID and ITCH_OAUTH_REDIRECT_URI must be configured.');
  }
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(state)) {
    return res.status(400).type('text').send('Invalid OAuth state.');
  }
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'profile:me',
    redirect_uri: itchOAuthRedirectUri,
    response_type: 'token',
    state
  });
  res.redirect(`https://itch.io/user/oauth?${params.toString()}`);
});

// OAuth implicit flow returns the access token in the URL fragment, so the
// callback page forwards it to the opening game window; it never reaches this server.
app.get('/auth/itch/callback', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Crazy Combat account connection</title><p id="status">Finishing itch.io connection...</p><script>(()=>{const p=new URLSearchParams(location.hash.slice(1)),m={type:'crazycombat-itch-oauth',state:p.get('state')||'',accessToken:p.get('access_token')||'',error:p.get('error')||''};if(window.opener)window.opener.postMessage(m,'*');document.getElementById('status').textContent=m.error?'Connection was cancelled.':'Connection complete. You can close this window.';setTimeout(()=>window.close(),700)})()</script>`);
});

app.post('/auth/itch/exchange', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const accessToken = String(body.accessToken || '').trim();
  if (accessToken.length < 8 || accessToken.length > 4096) {
    return res.status(400).json({ error: 'Invalid itch.io access token' });
  }
  try {
    const response = await fetch('https://api.itch.io/profile', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    if (!response.ok) return res.status(401).json({ error: 'Unable to verify itch.io account' });
    const data = await response.json();
    const user = data?.user;
    const id = String(user?.id || '').trim();
    if (!/^\d+$/.test(id)) return res.status(401).json({ error: 'itch.io account ID was not returned' });
    const username = String(user.username || '').trim().slice(0, 64);
    const displayName = String(user.display_name || username || id).trim().slice(0, 64);
    if (!username) return res.status(401).json({ error: 'itch.io username was not returned' });
    const sessionToken = signedSession({ id, username, displayName });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, sessionToken, expiresIn: 30 * 24 * 60 * 60, user: { id, username, displayName } });
  } catch (error) {
    console.error('POST /auth/itch/exchange failed:', error.message);
    res.status(502).json({ error: 'Unable to contact itch.io' });
  }
});

function entry(row) {
  const totalScore = Number(row.total_score);
  return {
    playerId: row.player_id,
    name: row.pilot_name || row.name,
    pilotName: row.pilot_name || row.name,
    itchUserId: row.itch_user_id || null,
    itchUsername: row.itch_username || null,
    // score remains the public compatibility field; it means accumulated
    // ranking points (stage score multiplied by stage number).
    score: totalScore,
    totalScore,
    stage: Number(row.stage),
    runs: Number(row.runs),
    clearedRuns: Number(row.cleared_runs),
    updatedAt: row.updated_at
  };
}

app.get('/api/ranking', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (ROW_NUMBER() OVER (
          ORDER BY total_score DESC, updated_at ASC, player_id ASC
        ))::int AS rank,
        player_id,
        name,
        pilot_name,
        itch_user_id,
        itch_username,
        total_score::float8 AS total_score,
        stage,
        runs,
        cleared_runs,
        updated_at
      FROM ranking_players
      ORDER BY total_score DESC, updated_at ASC, player_id ASC
      LIMIT 100
    `);

    res.json(result.rows.map(row => ({ rank: Number(row.rank), ...entry(row) })));
  } catch (error) {
    console.error('GET /api/ranking failed:', error);
    res.status(500).json({ error: 'Failed to load ranking' });
  }
});

app.post('/api/ranking', async (req, res) => {
  const user = authenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'itch.io account connection required' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = String(body.pilotName || body.name || 'PILOT')
    .trim()
    .slice(0, 24) || 'PILOT';
  const runScore = Number(body.runScore ?? body.score);
  const stage = Number(body.stage);
  const cleared = body.cleared === true;
  const playerId = `itch-${user.id}`;
  const suppliedRunId = String(body.runId || '').trim();
  // New clients send a stable runId. The fallback keeps older builds compatible,
  // although an old client without runId cannot be deduplicated on retry.
  const runId = /^[A-Za-z0-9._:-]{8,100}$/.test(suppliedRunId)
    ? suppliedRunId
    : `legacy-run-${playerId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const suppliedEndedAt = String(body.endedAt || '');
  const endedAt = !Number.isNaN(Date.parse(suppliedEndedAt))
    ? new Date(suppliedEndedAt).toISOString()
    : new Date().toISOString();

  if (
    !Number.isInteger(runScore) ||
    runScore < 0 ||
    runScore > maxRunScore ||
    !Number.isInteger(stage) ||
    stage < 1 ||
    stage > 1000
  ) {
    return res.status(400).json({ error: 'Invalid score or stage' });
  }

  // Later stages contribute more to the global ranking:
  // ranking points = this stage's score × stage number.
  const rankingScore = runScore * stage;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO ranking_runs (run_id, player_id, run_score, stage, cleared, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id) DO NOTHING
       RETURNING run_id`,
      [runId, playerId, runScore, stage, cleared, endedAt]
    );

    if (!inserted.rowCount) {
      const existing = await client.query(
        `SELECT player_id, name, pilot_name, itch_user_id, itch_username, total_score::float8 AS total_score, stage, runs, cleared_runs, updated_at
         FROM ranking_players
         WHERE player_id = (SELECT player_id FROM ranking_runs WHERE run_id = $1)`,
        [runId]
      );
      await client.query('COMMIT');
      return res.status(200).json({
        ok: true,
        duplicate: true,
        entry: existing.rowCount ? entry(existing.rows[0]) : null
      });
    }

    const result = await client.query(
      `INSERT INTO ranking_players
         (player_id, name, pilot_name, itch_user_id, itch_username, total_score, stage, runs, cleared_runs)
       VALUES ($1, $2, $2, $3, $4, $5, $6, 1, $7)
       ON CONFLICT (player_id) DO UPDATE SET
         name = EXCLUDED.name,
         pilot_name = EXCLUDED.pilot_name,
         itch_user_id = EXCLUDED.itch_user_id,
         itch_username = EXCLUDED.itch_username,
         total_score = ranking_players.total_score + EXCLUDED.total_score,
         stage = GREATEST(ranking_players.stage, EXCLUDED.stage),
         runs = ranking_players.runs + 1,
         cleared_runs = ranking_players.cleared_runs + EXCLUDED.cleared_runs,
         updated_at = NOW()
       RETURNING player_id, name, pilot_name, itch_user_id, itch_username, total_score::float8 AS total_score, stage, runs, cleared_runs, updated_at`,
      [playerId, name, user.id, user.username, rankingScore, stage, cleared ? 1 : 0]
    );

    await client.query('COMMIT');
    res.status(201).json({ ok: true, entry: entry(result.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/ranking failed:', error);
    res.status(500).json({ error: 'Failed to save score' });
  } finally {
    client.release();
  }
});

app.use((error, req, res, next) => {
  if (error?.message === 'CORS origin is not allowed') {
    return res.status(403).json({ error: 'CORS origin is not allowed' });
  }
  return next(error);
});

async function start() {
  // Keep the original table so existing deployments start safely. New scores are
  // written to the cumulative tables below.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(24) NOT NULL,
      score INTEGER NOT NULL CHECK (score >= 0),
      stage INTEGER NOT NULL CHECK (stage BETWEEN 1 AND 1000),
      cleared BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranking_players (
      player_id VARCHAR(80) PRIMARY KEY,
      name VARCHAR(24) NOT NULL,
      pilot_name VARCHAR(24),
      itch_user_id VARCHAR(64),
      itch_username VARCHAR(64),
      total_score BIGINT NOT NULL DEFAULT 0 CHECK (total_score >= 0),
      stage INTEGER NOT NULL CHECK (stage BETWEEN 1 AND 1000),
      runs INTEGER NOT NULL DEFAULT 0 CHECK (runs >= 0),
      cleared_runs INTEGER NOT NULL DEFAULT 0 CHECK (cleared_runs >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Add account columns when upgrading a database created by v1.1.
  await pool.query(`ALTER TABLE ranking_players ADD COLUMN IF NOT EXISTS pilot_name VARCHAR(24)`);
  await pool.query(`ALTER TABLE ranking_players ADD COLUMN IF NOT EXISTS itch_user_id VARCHAR(64)`);
  await pool.query(`ALTER TABLE ranking_players ADD COLUMN IF NOT EXISTS itch_username VARCHAR(64)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranking_runs (
      run_id VARCHAR(100) PRIMARY KEY,
      player_id VARCHAR(80) NOT NULL,
      run_score INTEGER NOT NULL CHECK (run_score >= 0),
      stage INTEGER NOT NULL CHECK (stage BETWEEN 1 AND 1000),
      cleared BOOLEAN NOT NULL DEFAULT FALSE,
      ended_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranking_meta (
      key VARCHAR(100) PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // One-time migration: preserve scores already submitted by the previous
  // version by grouping them under a deterministic legacy player identity.
  const migration = await pool.query(
    `SELECT key FROM ranking_meta WHERE key = 'legacy-scores-v1'`
  );
  if (!migration.rowCount) {
    await pool.query(`
      INSERT INTO ranking_players
        (player_id, name, pilot_name, total_score, stage, runs, cleared_runs, created_at, updated_at)
      SELECT
        'legacy-' || md5(lower(trim(name))),
        MAX(name),
        MAX(name),
        SUM(score::bigint * stage::bigint)::bigint,
        MAX(stage),
        COUNT(*)::int,
        SUM(CASE WHEN cleared THEN 1 ELSE 0 END)::int,
        MIN(created_at),
        MAX(created_at)
      FROM scores
      GROUP BY lower(trim(name))
      ON CONFLICT (player_id) DO NOTHING
    `);
    await pool.query(
      `INSERT INTO ranking_meta (key) VALUES ('legacy-scores-v1')
       ON CONFLICT (key) DO NOTHING`
    );
    console.log('Migrated legacy scores into cumulative rankings.');
  }

  // One-time migration for accounts already stored in ranking_runs. Older
  // versions accumulated the raw stage score, so rebuild totals using the new
  // weighted formula without changing the individual run history.
  const weightedMigration = await pool.query(
    `SELECT key FROM ranking_meta WHERE key = 'weighted-score-v2'`
  );
  if (!weightedMigration.rowCount) {
    await pool.query(`
      UPDATE ranking_players AS players
      SET total_score = weighted.total_score
      FROM (
        SELECT player_id, SUM(run_score::bigint * stage::bigint)::bigint AS total_score
        FROM ranking_runs
        GROUP BY player_id
      ) AS weighted
      WHERE players.player_id = weighted.player_id
    `);
    await pool.query(`
      UPDATE ranking_players AS players
      SET total_score = legacy.total_score
      FROM (
        SELECT
          'legacy-' || md5(lower(trim(name))) AS player_id,
          SUM(score::bigint * stage::bigint)::bigint AS total_score
        FROM scores
        GROUP BY lower(trim(name))
      ) AS legacy
      WHERE players.player_id = legacy.player_id
    `);
    await pool.query(
      `INSERT INTO ranking_meta (key) VALUES ('weighted-score-v2')
       ON CONFLICT (key) DO NOTHING`
    );
    console.log('Rebuilt ranking totals with stage-weighted scores.');
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Crazy Combat ranking server listening on port ${port}`);
  });
}

start().catch(error => {
  console.error('Server startup failed:', error);
  process.exit(1);
});
