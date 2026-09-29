# Crazy Combat

Crazy Combat is a static HTML5 arcade game with 1,000 stages, boss battles,
Q-hold special missile charging, local campaign data, and an itch.io-authenticated
global ranking.

## Run the game locally

Open `CrazyCombat.html` in a browser, or serve this folder with any static HTTP
server. The game works offline; without a ranking endpoint it uses local records.

`index.html` redirects to the game and is included for GitHub Pages hosting.

## Downloadable Windows app

The project can also be distributed as a Windows desktop app. Electron runs the
same game locally, so campaign progress and settings continue to work offline.

Install the build dependencies and create both a normal installer and a
portable executable:

```powershell
npm install
npm run dist:win
```

The generated files are placed in `dist`:

- `Crazy-Combat-1.10.0-x64.exe` — Windows installer
- `Crazy-Combat-1.10.0-portable.exe` — no-install portable app

The desktop app opens the itch.io login flow in an in-app child window. Global
ranking still requires an internet connection and a connected itch.io account;
offline gameplay remains available without either.

### GitHub Pages

In the repository settings, open **Pages**, choose **Deploy from a branch**, then
select the main branch and the root folder. The game URL will be similar to:

`https://YOUR-GITHUB-NAME.github.io/YOUR-REPOSITORY/`

## Deploy the global ranking API on Render with Neon PostgreSQL

The `ranking-server` directory contains the Express + PostgreSQL API. Render
continues to host the API while Neon hosts the PostgreSQL database. The existing
`leaderboardEndpoint` and itch.io OAuth callback URL remain unchanged.

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository. Render reads
   the root `render.yaml` and uses `ranking-server` as the service root.
3. Create a Neon PostgreSQL project and copy its pooled connection string.
4. Before switching databases, inspect and back up the current Render database:

   ```powershell
   $env:DATABASE_URL = 'postgresql://...current-render-database...'
   npm --prefix ranking-server run db:inspect
   pg_dump --format=custom --no-owner --no-acl --file=crazycombat-render.dump $env:DATABASE_URL
   ```

   Keep the dump outside the repository. It contains player data and must not be
   committed.

5. Pause score writes in Render by setting `RANKING_WRITES_ENABLED=false`.
6. Create a final dump, restore it into the empty Neon database, and compare the
   row counts and score totals:

   ```powershell
   pg_dump --format=custom --no-owner --no-acl --file=crazycombat-final.dump $env:DATABASE_URL
   $env:NEON_DATABASE_URL = 'postgresql://...neon-pooled-connection...'
   pg_restore --no-owner --no-acl --dbname=$env:NEON_DATABASE_URL crazycombat-final.dump
   $env:DATABASE_URL = $env:NEON_DATABASE_URL
   npm --prefix ranking-server run db:inspect
   ```

7. Set the Web Service environment variables:
   - `DATABASE_URL`: the Neon pooled connection string
   - `DB_POOL_MAX`: `5`
   - `DB_CONNECTION_TIMEOUT_MS`: `10000`
   - `DB_IDLE_TIMEOUT_MS`: `10000`
   - `RANKING_WRITES_ENABLED`: `true`
   - `HISTORY_RETENTION_MONTHS`: `1`
   - `RUN_TOMBSTONE_RETENTION_DAYS`: `90`
   - `CORS_ORIGINS`: `https://luckycloud21.itch.io,https://html-classic.itch.zone,https://html.itch.zone`
   - `AUTH_SECRET`: a long random secret used to sign game login sessions
   - `ITCH_CLIENT_ID`: the Client ID from your itch.io OAuth application
   - `ITCH_OAUTH_REDIRECT_URI`: exactly
     `https://YOUR-SERVICE.onrender.com/auth/itch/callback`
8. In itch.io account settings, create an OAuth application with the same
   callback URL and request the `profile:me` scope.
9. Deploy and verify `/healthz` and `/healthz?db=1`. The normal Render health
   check does not wake an idle Neon compute; the query parameter performs the
   explicit database check.
10. Test itch.io login, a new score, a duplicate `runId`, the public top 100, and
    the authenticated player's personal rank.
11. Re-enable score writes and keep the old database and dump until the new
    deployment has passed its verification period.

If verification fails before new writes resume, set `DATABASE_URL` back to the
old Render connection string, redeploy, and verify `/healthz?db=1` before
re-enabling writes. After new writes have reached Neon, pause submissions and
compare the two databases before choosing a rollback; they must not be merged
blindly.

The game continues to use this existing `leaderboardEndpoint`:

   `https://YOUR-SERVICE.onrender.com/api/ranking`

The API provides `GET /api/ranking`, `POST /api/ranking`, and the itch.io OAuth
routes. The public total is calculated as `highest stage x cumulative score`
for each authenticated itch.io account; the public ranking is sorted by that
total and includes the public
pilot name plus itch.io username. Scores are validated for stages 1–1000 and
stored in PostgreSQL. The server also deduplicates retries by `runId`.

The game cannot read an itch.io page's login cookie directly. Players connect
through the in-game `CONNECT ITCH.IO` button. The server verifies the OAuth
access token against itch.io, issues a signed game session, and does not store
the OAuth access token. Keep `CORS_ORIGINS` restricted to the actual game
origins in production.

## Data retention and cleanup

`ranking_players` stores lifetime account aggregates and is never removed by the
retention job. Detailed `ranking_runs` records and legacy `scores` rows older than
one calendar month are deleted by the server's daily cleanup transaction. The
cleanup runs once after startup and then every 24 hours. A sleeping Render service
may therefore perform the deletion on its next request after the cutoff.

Before deleting a run, the server stores a compact `runId` tombstone for 90 days
to prevent an old retry from being counted again. Tombstones are operational
deduplication metadata, not a copy of the detailed run history.

Inspect the database without changing it:

```powershell
$env:DATABASE_URL = 'postgresql://...'
npm --prefix ranking-server run db:inspect
```

Preview cleanup without deleting rows, then execute it manually:

```powershell
$env:DATABASE_URL = 'postgresql://...'
$env:DRY_RUN = '1'
npm --prefix ranking-server run db:cleanup
$env:DRY_RUN = '0'
npm --prefix ranking-server run db:cleanup
```

The cleanup keeps `cumulative_score`, `total_score`, `stage`, `runs`, and
`cleared_runs` unchanged. Local browser records are independent of this server
retention policy.

Neon's Free plan has finite storage and compute allowances. Measure the current
database before migration and stop if the restored database is too close to the
free storage limit for the expected growth. See [Neon pricing and limits](https://neon.com/pricing).

## Important security note

Scores are submitted by the browser, so a determined user can forge requests.
For a competitive leaderboard, add authentication, rate limiting, abuse review,
and server-authoritative score verification before treating scores as official.
