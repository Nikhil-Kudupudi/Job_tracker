# Job Tracker

A single-page job application tracker. Works immediately with no setup (browser
storage), and optionally syncs every row two-ways to a Google Sheet.

```
job_tracker/
  index.html      the app
  styles.css      tokens, status colors, layout
  app.js          state, 30-day rule, table, dashboard, charts
  gas/Code.gs     Google Sheets backend (Apps Script Web App)
```

## Run it

Open `index.html` in your browser. That's it — nothing to install.

If you'd rather serve it (needed only if your browser blocks `file://`):

```bash
cd /d/resumes/job_tracker && python server.py
```

Then visit <http://127.0.0.1:5173>. This also serves the AI proxy used for
job-description parsing; `python -m http.server` will serve the app but not that.

## Connect Google Sheets (about 5 minutes)

1. Create a new Google Sheet (any name).
2. **Extensions ▸ Apps Script**. Delete the placeholder code, paste all of
   `gas/Code.gs`, and save.
3. **Deploy ▸ New deployment ▸ Web app**
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
4. Authorize when prompted, then copy the deployment URL (ends in `/exec`).
5. Give the app the URL, either way:
   - **In the code** — open [`config.js`](config.js) and set `sheetsUrl`. The app
     connects on load with nothing to paste, on every browser you open it in.
   - **In the app** — sidebar ▸ **Settings**, paste the URL, **Save & connect**.
     This is per-browser and overrides `config.js`; **Reset to config.js** undoes it.

   Either way the pill in the header turns to *Google Sheets*.
6. Already have rows saved locally? Click **Push local rows to Sheets** once.

### config.js

Optional file, read once at startup. The app runs fine without it.

```js
window.JT_CONFIG = {
  sheetsUrl: '',   // Apps Script /exec URL — '' means configure it in Settings
  staleDays: 30,   // days before Applied / In Progress roll over to No Reply
};
```

Settings always wins over `config.js`, so a saved URL survives edits to the file
until you hit **Reset to config.js**. Settings shows which of the two the live
URL came from.

Once you put a real URL in there, `config.js` holds a secret — that `/exec` link
is the only thing guarding your sheet. Keep it out of any repo or shared folder.

The script creates an `Applications` tab with these columns and keeps them in
sync by `id`:

`id, company, title, location, jobType, experience, platform, url, resume, status, appliedDate, statusUpdatedAt, notes`

You can edit cells directly in the Sheet — hit **Refresh** in the header to pull
them back in. Don't rename or reorder the header row.

### When it doesn't connect

Hit **Test connection** in Settings — it checks the URL, how the page is served,
and the round trip, and tells you which step failed. The usual causes:

| Symptom | Cause |
|---|---|
| `403 Forbidden` on `/exec` | The live deployment isn't public. *Who has access* must be **Anyone**, and *Execute as* must be **Me** — "User accessing the web app" forces a login and 403s anonymous calls. |
| Worked, then stopped after editing the script | A deployment is pinned to a code **version**. Editing `Code.gs` does nothing to the live URL until you go **Manage deployments ▸ ✏️ ▸ Version: New version ▸ Deploy**. |
| `Unknown action: ping` | The deployed copy of `Code.gs` is out of date — re-paste it and deploy a new version. |
| "Failed to fetch" / blocked | CORS. The app falls back to JSONP automatically, which also works from `file://`. |

The test that settles it: **paste the `/exec` URL into an incognito window.**
Incognito carries no Google login, so if it returns `{"ok":true,"rows":[]}` there,
the deployment is genuinely public. A sign-in page or 403 means it isn't.

Deleting old deployments helps too — it's easy to copy the wrong URL when several
exist.

> **Security note:** a "Anyone" web app is unauthenticated, so that `/exec` URL
> is the only thing protecting the sheet. Treat it like a password, don't commit
> it anywhere public, and re-deploy to rotate it if it leaks. If you'd rather not
> have an open endpoint, set *Who has access* to **Only myself** — the browser
> app then can't reach it, and you'd use the tracker in local-only mode with
> **Export CSV** for the sheet.

## How it behaves

**Add Job** — company, job title, location, job type, experience, status,
platform, resume, URL, notes.

- `appliedDate` is stamped automatically the moment you submit. It only becomes
  editable when you're updating an existing row.
- **Job title**, **location**, **company**, and **resume** are LinkedIn-skill
  style comboboxes: pick from what you've used before, or type something new and
  it's saved to the list for next time. Hover an entry and click `×` to drop it
  from the list.
- Choosing **Remote** as job type lets location be `Remote` or any city — if you
  leave it blank it fills in as `Remote`.
- **Platform** (LinkedIn / Company site) and **URL** are optional and may be empty.
- After adding, the form clears but keeps the company, so batching several roles
  at one employer is fast.

**The 30-day rule** — on every load, any application still sitting at *Applied*
or *In Progress* whose status hasn't changed in more than 30 days flips to
**No Reply**, and the change is pushed to your sheet. Terminal outcomes
(*Rejected*, *Accepted*) are never touched. `statusUpdatedAt` is intentionally
left alone so the "Days idle" column keeps reporting the row's true age; changing
a status by hand resets that clock.

**Job Tracker** — the table. Click any cell (company, title, location,
experience, resume) to edit it in place; change status from the dropdown inside
the badge. Sort by any column header, search across all text, filter by status
or job type, export the filtered view to CSV. Every edit writes locally first and
then to Sheets, so a flaky connection never loses data — unsynced rows are counted
under the heading, and **Push local rows to Sheets** flushes them.

**Dashboard** — KPI tiles (all values in gold): total applications, applied,
in progress, rejected, accepted, no reply, response rate, decided. Below them:
applications by status, applications per month, top companies, and job type mix.
Bars carry hover tooltips.

## Parsing a job description

On **Add Job**, expand *Paste a job description*, drop in the posting, and hit
**Parse & fill**. It extracts company, job title, location, job type, experience,
skills, platform, and URL.

It only ever **pre-fills the form** — no row is created until you press *Add job*,
and **Undo fill** restores exactly what was there before. Fields the posting
doesn't state are left blank and listed back to you rather than guessed at, so a
missing job type stays empty instead of becoming a plausible-looking wrong answer.
Your existing job-title and location lists are sent along so it reuses
`Data Engineer` rather than inventing `Data Engineer (DE)`.

### Setup

All AI configuration lives in `.env`, server-side. Nothing to set in `config.js`.
Run the app with `python server.py` — the plain `python -m http.server` serves
the page but has no parse route, so parsing will be disabled under it.

**Claude (default):**

```
ANTHROPIC_API_KEY=sk-ant-...
AI_MODEL=claude-haiku-4-5
```

Needs the SDK once: `pip install anthropic`. Key from
[console.anthropic.com](https://console.anthropic.com/settings/keys).
Haiku is the cheapest Claude and ample for field extraction; `claude-sonnet-5`
or `claude-opus-5` are one-line swaps if you ever want more.

**Or any OpenAI-compatible provider** — Hugging Face, Google AI Studio, Groq,
a local Ollama. Clear `ANTHROPIC_API_KEY` and set:

```
AI_API_KEY=hf_...
AI_UPSTREAM_URL=https://router.huggingface.co/v1/chat/completions
AI_MODEL=meta-llama/Llama-3.3-70B-Instruct
```

The provider is inferred — an `sk-ant-…` key or a `claude-…` model means
Anthropic — and `AI_PROVIDER=anthropic|openai` forces it. Restart after any
change; the startup banner prints the provider, model, whether a key was found,
and whether parsing is ready. The app asks the server the same question, so the
panel says *"not configured"* with the reason rather than failing when you click.

`http://127.0.0.1:5173/api/ai/models` lists what an OpenAI-compatible key can
actually reach.

### How the two providers differ

On Claude the request uses **structured outputs** — a JSON schema goes with the
request and the response is guaranteed to match it, so the job type can only ever
be one of the three allowed values and skills only ever an array of strings. There
is no JSON to fish out of prose.

OpenAI-compatible providers get the schema in the prompt and `response_format:
json_object` where supported, with a retry without it for backends that reject it
(Hugging Face's router fronts many, and they differ). The reply is then parsed out
of whatever prose surrounds it. Same fields either way, less margin for error on
Claude.

### Why there is a proxy at all

Three reasons, any one of them sufficient. Providers generally do not send CORS
headers, so a browser cannot call them directly. A key in front-end code is
readable by anyone who opens devtools. And keeping the prompt, the schema and the
provider logic in one file means switching models touches `.env` and nothing else —
the browser only ever posts text and receives fields.

## Deploying to Cloudflare Pages

Cloudflare Pages serves the app **and** runs the parse endpoint, so the deployed
site has everything the local one does. The API key lives in Cloudflare, never in
the repo.

1. **Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git**,
   and pick this repository.
2. Build settings: **no build command**, output directory `/` (the repo root).
   Pages picks up `functions/` automatically.
3. **Settings → Variables and secrets**, add:

   | Name | Value |
   |---|---|
   | `AI_API_KEY` | your key — mark it **Secret** |
   | `AI_UPSTREAM_URL` | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
   | `AI_MODEL` | `gemini-3.5-flash-lite` |

4. Deploy. Then open the site, go to **Settings**, and paste your Apps Script
   `/exec` URL so it syncs with your sheet. That is stored in the browser, not in
   the repo — do it once per device.

Every push to `main` redeploys.

### Why the URL is not in the repo

This repository is **public**. The Apps Script `/exec` URL is an unauthenticated
endpoint with full read/write on your sheet, so committing it would hand your data
to anyone who found the repo. `config.js` is in `.gitignore` for that reason, and
the Settings page exists so you never need to commit it. Same for `.env`.

### Running locally

Two options, same routes either way:

```bash
python server.py                      # stdlib only, reads .env
npx wrangler pages dev .              # runs the real Pages Functions
```

`server.py` is the quick one. `wrangler pages dev` exercises the exact code that
Cloudflare will run, so use it before a deploy you care about.

> The parse logic exists twice on purpose — `server.py` for local, and
> `functions/api/ai/_lib.js` for Cloudflare. They serve identical routes and share
> the same prompt, schema and normalisation. **Change one, change the other.**

### GitHub Pages

It would serve the app, but Pages is static-only — there is no server to hold the
key or run `/api/ai/parse`, so job-description parsing would be dead. Everything
else (Sheets sync, dashboard, the 30-day rule) is client-side and would work. Use
Cloudflare if you want parsing on the deployed site.

## Theme

The sun/moon button in the header switches light and dark. Your choice is
remembered; until you pick one, the app follows your OS setting and keeps
following it live. Theme is resolved by an inline script before first paint, so
there's no flash of the wrong theme on load.

Both themes are a deliberate set of steps, not an inversion — each status hue is
re-chosen against its own surface. The color budget is kept small on purpose: one
neutral ramp, one gold accent, and the five status hues. Anything that isn't a
status wears ink, not a hue.

## Status colors

| Status | Color |
|---|---|
| Applied | normal ink / black |
| In Progress | muted gold |
| Rejected | muted red |
| Accepted | muted green |
| No Reply | muted gray |

The same palette is used in the table badges, the KPI dots, and the status chart.
Every color is paired with its text label, so status is never color-alone. Dark
mode is a separately chosen set of steps, not an automatic inversion.
