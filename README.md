# School Catering Jobs — GU14 9LJ

A simple search app for **catering-assistant jobs at schools**, within **10 miles of
GU14 9LJ (Farnborough)**. Press **Search** and it queries multiple job boards at once,
then lists each vacancy with its **own individual posting link**, distance, hourly
salary, description and the date it was first seen — **newest first**, with brand-new
roles flagged **New** at the top.

## Why links go to the right place now

The earlier mock-up linked some "View job" buttons to a **search-results page** (many
jobs) instead of the one vacancy. This version fixes that at the source: it pulls from
real job-board **APIs** (Adzuna, optionally Reed) that return a **per-vacancy URL** and
the **real posted date** for each job. So every "View job" opens that single posting,
and the date-ordering / "New" badge is based on real data, not a guess.

## How it works

| Piece | File | Role |
|-------|------|------|
| Frontend | `index.html` | The UI. Calls `/api/jobs`, renders results, sorts newest-seen first. Works offline against a verified snapshot if no backend is deployed. |
| Backend | `functions/api/jobs.js` | Cloudflare Pages Function. Queries Adzuna (+ Reed), keeps only school catering-assistant roles in range of GU14 9LJ, tracks first-seen in KV, returns each job with its individual URL. |
| Config | `wrangler.toml` | Pages + KV binding + API-key secrets. |

**School filter:** a role is kept only if it matches catering-assistant *and* a school
signal (school/academy/college/term-time/pupils, or a known school caterer such as
Chartwells / Caterlink / Aspens), and is not a chef/hospital/care-home role.

**"New" + date order:** a KV namespace records the first time each job ID is seen.
Jobs first seen in the last 36 h show a **New** badge and sort to the top; the rest sort
newest-seen → oldest.

## Run / deploy

### 1. Get free API keys
- **Adzuna** (primary): https://developer.adzuna.com → create an app → note `app_id` + `app_key`.
- **Reed** (optional, adds council/agency jobs): https://www.reed.co.uk/developers → get an API key.

### 2. Create the KV namespace
```bash
npm i -g wrangler        # or use: npx wrangler ...
wrangler login
wrangler kv namespace create JOBS_KV
```
Paste the returned `id` into `wrangler.toml` (replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`).

### 3. Add the keys as secrets
```bash
wrangler pages secret put ADZUNA_APP_ID
wrangler pages secret put ADZUNA_APP_KEY
wrangler pages secret put REED_API_KEY      # optional
```

### 4. Deploy
```bash
wrangler pages deploy .
```
Open the deployed URL and press **Search** — you'll see live, multi-site results.

### Local preview
```bash
wrangler pages dev .     # runs the function locally with your bindings
```
Or just open `index.html` in a browser — with no backend it shows the **verified
snapshot** so the page is never empty.

## Notes
- Origin coordinates for distance are set in `functions/api/jobs.js` (`ORIGIN`) — GU14 9LJ ≈ 51.2845, -0.7596. Adjust if you want a different centre.
- Distances are approximate; a role can close at any time, so always confirm on the employer's page.
- No keys configured? `/api/jobs` returns `live:false` and the page falls back to the snapshot automatically.
