const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 10000);

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

app.use(cors({
  origin(origin, callback) {
    // No Origin header is common for health checks and server-to-server calls.
    // An empty CORS_ORIGINS value allows all origins for first-time testing.
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS origin is not allowed'));
  }
}));

app.use(express.json({ limit: '10kb' }));

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'crazycombat-ranking' });
});

app.get('/api/ranking', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (ROW_NUMBER() OVER (
          ORDER BY score DESC, created_at ASC, id ASC
        ))::int AS rank,
        name,
        score,
        stage
      FROM scores
      ORDER BY score DESC, created_at ASC, id ASC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('GET /api/ranking failed:', error);
    res.status(500).json({ error: 'Failed to load ranking' });
  }
});

app.post('/api/ranking', async (req, res) => {
  try {
    const name = String(req.body.name || 'PILOT')
      .trim()
      .slice(0, 24) || 'PILOT';
    const score = Number(req.body.score);
    const stage = Number(req.body.stage);
    const cleared = req.body.cleared === true;

    if (
      !Number.isInteger(score) ||
      score < 0 ||
      score > 2000000000 ||
      !Number.isInteger(stage) ||
      stage < 1 ||
      stage > 1000
    ) {
      return res.status(400).json({ error: 'Invalid score or stage' });
    }

    const result = await pool.query(
      `INSERT INTO scores (name, score, stage, cleared)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, score, stage, cleared, created_at`,
      [name, score, stage, cleared]
    );

    res.status(201).json({ ok: true, entry: result.rows[0] });
  } catch (error) {
    console.error('POST /api/ranking failed:', error);
    res.status(500).json({ error: 'Failed to save score' });
  }
});

async function start() {
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

  app.listen(port, '0.0.0.0', () => {
    console.log(`Crazy Combat ranking server listening on port ${port}`);
  });
}

start().catch(error => {
  console.error('Server startup failed:', error);
  process.exit(1);
});
