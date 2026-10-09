// Fills the dashboard template from stored weeks. Pure string work: no platform imports.
import { priorRecord } from './parse-tape.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const labelOf = iso => `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}`;
export const mdy = iso => `${iso.slice(5, 7)}.${iso.slice(8, 10)}.${iso.slice(0, 4)}`;

// JSON that is safe inside an inline <script>: a "</script>" or "<!--" in a note must not end the block.
const js = v => JSON.stringify(v).replace(/</g, '\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');

// One pass with a function replacer: "$&" in a note is never interpreted, and text that was
// inserted is never scanned again, so a note containing "{{LOANS}}" stays a note.
const fill = (text, map) => text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in map ? map[k] : m));

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function withUploadUi(html, templates, ctx) {
  const ui = templates.uploadUi.replace(/\/\*@@UPLOAD_CTX@@\*\/\{[^}]*\}/, () => js(ctx));
  return html.replace('<!--UPLOAD_UI-->', () => ui);
}

/** current / prior: { asOf: 'YYYY-MM-DD', loans: [...] }; prior may be null (first week on file). */
export function renderDashboard({ templates, current, prior, canUpload = true, mapboxToken = '' }) {
  const base = prior || current;                                  // first week: compared with itself, so the change log is empty
  const html = fill(templates.template, {
    CURR_LABEL: escHtml(labelOf(current.asOf)),
    CURR_ISO: escHtml(current.asOf),
    CURR_N: String(current.loans.length),
    PRIOR_FOOT: prior ? `Prior period ${escHtml(prior.asOf)} (${prior.loans.length} positions)` : 'First week on file, no prior period',
    LOANS: js(current.loans),
    PRIOR: js(base.loans.map(priorRecord)),
    PRIOR_LABEL_JS: js(labelOf(base.asOf)),
    CURR_LABEL_JS: js(labelOf(current.asOf)),
    NO_PRIOR_JS: prior ? 'false' : 'true',
    CURR_ISO_JS: js(current.asOf),
    PRIOR_ISO_JS: js(base.asOf),
    MAPBOX_TOKEN_JS: js(mapboxToken),
  });
  return withUploadUi(html, templates, { asOf: current.asOf, canUpload });
}

/** The same page shell with nothing in it, so an empty site looks like a populated one from outside. */
export function renderEmpty({ templates, canUpload = true }) {
  return withUploadUi(templates.empty, templates, { asOf: null, canUpload });
}

export function loginPage(templates, payload) {
  return fill(templates.login, { PAYLOAD: js(payload) });
}
