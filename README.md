# Crazy Combat

Crazy Combat is a static HTML5 arcade game with 1,000 stages, boss battles,
Q-hold special missile charging, local records, and an optional global ranking.

## Run the game locally

Open `CrazyCombat.html` in a browser, or serve this folder with any static HTTP
server. The game works offline; without a ranking endpoint it uses local records.

`index.html` redirects to the game and is included for GitHub Pages hosting.

### GitHub Pages

In the repository settings, open **Pages**, choose **Deploy from a branch**, then
select the main branch and the root folder. The game URL will be similar to:

`https://YOUR-GITHUB-NAME.github.io/YOUR-REPOSITORY/`

## Deploy the global ranking API on Render

The `ranking-server` directory contains an Express + PostgreSQL API. The root
`render.yaml` is a Render Blueprint for the Web Service.

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository. Render reads
   the root `render.yaml` and uses `ranking-server` as the service root.
3. Open your existing Render Postgres database and copy its Internal Database URL.
4. Set the Web Service environment variables:
   - `DATABASE_URL`: the copied Internal Database URL
   - `CORS_ORIGINS`: the HTTPS origin where the game is hosted, for example
     `https://YOUR-GITHUB-NAME.github.io`
5. Deploy the service and verify `/healthz`.
6. Set `leaderboardEndpoint` in `CrazyCombat.html` to:

   `https://YOUR-SERVICE.onrender.com/api/ranking`

The API provides `GET /api/ranking` and `POST /api/ranking`. Scores are validated
for stages 1–1000 and stored in PostgreSQL.

The Blueprint intentionally does not create a database. This avoids the Render
workspace limit of one active Free Postgres database. Reuse an existing database,
or create a paid database if you need a separate production environment.

## Important security note

Scores are submitted by the browser, so a determined user can forge requests.
For a competitive leaderboard, add authentication, rate limiting, abuse review,
and server-authoritative score verification before treating scores as official.
