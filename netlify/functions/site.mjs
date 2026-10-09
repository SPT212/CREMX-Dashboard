// Netlify adapter: about 25 lines of glue. All behaviour is in functions-src/handler.js.
// Storage is Netlify Blobs, which has the same get/set/setJSON/delete shape the handler expects.
import { getStore } from '@netlify/blobs';
import { createHandler } from '../../functions-src/handler.js';
import templates from '../../functions-src/templates.js';

// strong consistency: a read right after an upload sees it (the default is eventual)
const store = name => getStore({ name: `cremx-${name}`, consistency: 'strong' });

const ENV_KEYS = ['DASHBOARD_PASSWORD', 'UPLOAD_PASSPHRASE', 'PBKDF2_ITERATIONS', 'MIN_PASSWORD_LENGTH', 'OPEN_VIEW', 'MAPBOX_TOKEN'];

export default async request => {
  const env = {};
  for (const k of ENV_KEYS) { const v = Netlify.env.get(k); if (v != null) env[k] = v; }
  return createHandler({ store, env, templates })(request);
};

// The function answers the page itself and the upload API. Nothing else is routed here.
export const config = { path: ['/', '/api/upload'] };
