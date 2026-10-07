# CREMX Portfolio Dashboard

Static, single-file dashboard (`public/index.html`) hosted on Cloudflare as a
Worker with static assets. No build step — charts, maps and fonts load from
public CDNs (cdnjs, jsDelivr, Google Fonts, CARTO / Esri map tiles).

## Deploy

**Option A — connect the GitHub repo (auto-deploys on every push)**

1. Cloudflare dashboard → *Workers & Pages* → *Create* → *Import a repository*.
2. Pick `spt212/cremx-dashboard`, production branch `main`.
3. Leave the build command empty; the deploy command is `npx wrangler deploy`
   (it reads `wrangler.jsonc`).

**Option B — deploy from your machine**

```sh
npx wrangler login
npx wrangler deploy
```

Preview locally with `npx wrangler dev` (http://localhost:8787).

## Updating the dashboard

Replace `public/index.html` with the new export and push (Option A) or run
`npx wrangler deploy` again (Option B).

## Restricting access

The dashboard contains portfolio data, so it should not be left public.
Cloudflare dashboard → *Zero Trust* → *Access* → *Applications* → add a
self-hosted application for the Worker's hostname (e.g.
`cremx-dashboard.<account>.workers.dev`) with a policy such as
"emails ending in `@churchillre.com`". Alternatively, on the Worker's
*Settings → Domains & Routes*, enable Cloudflare Access for the
`workers.dev` route. `public/_headers` already sets `noindex` so search engines
won't index it.
