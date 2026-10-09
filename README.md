# CREMX dashboard: weekly upload system

The dashboard is no longer a file with data baked in. A Netlify Function serves it, and every week enters through the
**Upload new packet** button (top right). Uploading a code deploy never changes data.

## How it works

1. The page is served **encrypted** (AES-256-GCM, key from `DASHBOARD_PASSWORD`) and decrypted in the browser after the
   viewer types the password. Nothing readable is in the served file.
2. **Upload new packet** takes the weekly `.xlsx`, an optional as-of date, and the **upload passphrase** (a second,
   separate secret checked on the server). Buttons: Upload, Undo last upload, Upload history, Cancel.
3. The as-of date comes from the **file name** (`CREMX_Loan_Portfolio_10_09_2026.xlsx`; `.`, `_` or `-` separators, two- or
   four-digit year). A date typed in the dialog wins.
4. The page always shows the **latest** stored week and compares it with the latest week **before** it (the change log is
   computed in the browser from `LOANS` and `PRIOR`). Upload order does not matter.
   - older date = *Filed in as history* (never changes what is shown)
   - newer date = *Published*
   - same date again = *Replaced*
   - **Undo** removes only the latest week. Saved original files and log entries are kept.
5. With nothing uploaded the site shows "No packet uploaded yet" and the Upload button. The first week on file shows an
   empty change log ("First week on file").
6. **Upload history** lists every action (when, what, week, file, result, reason) with a **Download** button that returns the
   exact original file.

## What is checked at upload

The sheet has no totals or summary tab to reconcile against, so the checks are structural (the handoff's rule: don't invent
an invariant). A file is refused, and nothing stored, when: a required column is missing; Loan IDs repeat; a Status or
Delinquency value is not one the dashboard knows; Basis / TLA / Maturity cannot be read; a coordinate is out of range; the
date cannot be read or is in the future; the file is not a real `.xlsx`.
Two things ask "are you sure?" instead of refusing: the number of positions or total Basis moving more than 25% / 35%
from the week before (usually the wrong file). Missing coordinates are a warning (those loans stay in the tape, not on the map).
Values are shown exactly as in the file. Only Advance % (Basis / TLA) and Days-to-Maturity are derived.
"Single Guarantor" and "N/A" in the guarantor columns are placeholders and are dropped, as before.

## Layout

```
netlify.toml                      publish=public (robots.txt only), functions=netlify/functions
netlify/functions/site.mjs        Netlify adapter (Blobs store), routes / and /api/upload
functions-src/handler.js          ALL behaviour (page, upload, undo, history, download). No platform imports
functions-src/xlsx.js             dependency-free .xlsx reader (zip + XML)
functions-src/parse-tape.js       sheet rows -> loan records, validation
functions-src/render.js           fills the template from stored weeks
functions-src/crypto.js           PBKDF2 + AES-GCM, constant-time compare
functions-src/templates.js        GENERATED from src/*.html (do not edit)
functions-src/site-cloudflare.js  adapter for the planned Cloudflare move (KV), not used on Netlify
src/template.html                 the dashboard (source of truth for its design)
src/upload-ui.html  login.html  empty.html
scripts/build_templates.py        src/*.html -> functions-src/templates.js   (run after editing src/)
scripts/make_template.py          one-time: standalone dashboard -> src/template.html
tests/run.html                    31 handler tests, run in a browser
archive/                          the old standalone dashboard and the feature handoff (not deployed)
```

**To change the dashboard's design, edit `src/template.html`, then run `python scripts/build_templates.py`** and redeploy.
The old standalone `CREMX_Portfolio_Dashboard_10_09_2026.html` is now only a snapshot.

## Settings

| Name | Kind | Meaning |
|---|---|---|
| `DASHBOARD_PASSWORD` | secret | Viewer password, 16+ characters. Password strength is the whole defence against offline guessing, because the encrypted file can be downloaded by anyone. |
| `UPLOAD_PASSPHRASE` | secret | Gates upload, undo, history, download. Never in the page's code. |
| `PBKDF2_ITERATIONS` | optional | Default 250000. Cloudflare needs 100000 or less. Travels inside the encrypted payload. |
| `MIN_PASSWORD_LENGTH` | optional | Lowers the 16-character minimum. |
| `MAPBOX_TOKEN` | needed for the map | Mapbox public token (`pk.…`). Without it the map shows "Map needs a Mapbox public token". Restrict the token to the site URL in the Mapbox account. |
| `OPEN_VIEW` | optional | `1` serves the page unencrypted with no login. Off by default. |

Set them in Netlify: Site configuration > Environment variables. **A changed secret only applies after the next deploy.**

## Deploying to Netlify

Drag-and-drop deploys do **not** run functions or install `@netlify/blobs`. Use either:

- **Git:** put this folder in a repo, connect it to the site; Netlify installs `package.json` and bundles the function, or
- **CLI:** `npm i -g netlify-cli`, then `netlify deploy --build --prod` from this folder.

Netlify Blobs needs no setup; the site gets it automatically. Request bodies are limited to 6 MB on Netlify (the handler
limits uploads to 5 MB; a weekly tape is about 60 KB). Keep the Mapbox token's URL restriction on the Netlify address.
Test locally with `netlify dev` (the Mapbox token will be refused on localhost).

First run: open the site, enter the viewer password, click **Upload new packet**, upload the first week.

## Moving to Cloudflare later

`handler.js` only needs the Fetch API, WebCrypto and a `store(name)` with `get / set / setJSON / delete`.
`functions-src/site-cloudflare.js` is the adapter (Workers KV bound as `DATA_KV`). Set `PBKDF2_ITERATIONS=100000`.
KV is eventually consistent (a stale page right after an upload fixes itself on refresh); the Netlify adapter asks for strong consistency.
Existing weeks do not move automatically: re-upload them, or copy the `weeks:`, `meta:` and `files:` keys across.

## Tests

No Node is needed:

```
python -m http.server 8765        # from this folder
# open http://localhost:8765/tests/run.html   -> ends with "ALL PASSED (31 tests)"
```

## Known limits

- One shared upload passphrase: the log records what happened, not who did it.
- The log is one capped JSON array (1000 entries); two actions in the same instant could drop one entry.
- The Netlify adapter and the Cloudflare adapter have not been run against the real services from this machine; the
  handler behind them is what the tests cover.
