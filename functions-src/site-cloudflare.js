// Cloudflare Pages "Advanced Mode" adapter (_worker.js), for the planned move off Netlify.
// Not used on Netlify. Needs one Workers KV namespace bound as DATA_KV; PBKDF2_ITERATIONS must be
// at most 100000 there (Workers refuse more). Build: esbuild --bundle --format=esm --platform=browser
// functions-src/site-cloudflare.js --outfile=cf-public/_worker.js
import { createHandler } from './handler.js';
import templates from './templates.js';

function kvStore(kv) {
  return name => ({
    get: (key, opts) => kv.get(`${name}:${key}`, opts),        // opts.type: 'json' | 'arrayBuffer' | undefined
    set: (key, value) => kv.put(`${name}:${key}`, value),
    setJSON: (key, value) => kv.put(`${name}:${key}`, JSON.stringify(value)),
    delete: key => kv.delete(`${name}:${key}`),
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/' || pathname === '/api/upload') {
      return createHandler({ store: kvStore(env.DATA_KV), env, templates })(request);
    }
    return env.ASSETS.fetch(request);                          // robots.txt, _headers
  },
};
