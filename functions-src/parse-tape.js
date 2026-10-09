// Turns the CREMX loan-tape worksheet into the loan records the dashboard renders.
// Rule of the project: display the file as it is. Nothing here remaps, rounds or
// recomputes the owner's numbers; the only derived fields are Advance % (Basis / TLA,
// the formula the sheet itself carries) and Days to Maturity (from the as-of date).

export const ST_ORDER = ['Performing', 'SS Managed', 'Watchlist', 'Problem Loans', 'Foreclosure', 'REO'];
export const DQ_ORDER = ['Current', '30 Days DQ', '60 Days DQ', '90+ Days DQ', 'Foreclosure', 'REO'];

// header text (lower-case) -> field
const COLUMNS = {
  'loan id': 'id', 'status': 'status', 'delinquency': 'dq', 'originator': 'orig', 'borrower': 'borrower',
  'guarantor 1': 'g1', 'guarantor 2': 'g2', 'address': 'address', 'city': 'city', 'state': 'state',
  'latitude': 'lat', 'longitude': 'lon', 'display latitude': 'dlat', 'display longitude': 'dlon',
  'basis': 'basis', 'tla': 'tla', 'holdback disbursed': 'hbd', 'holdback remaining': 'hbr',
  'interest reserve': 'ires', 'origination': 'orig_date', 'maturity': 'maturity',
  'notes/comments': 'notes', 'notes last updated': 'nupd',
};
const REQUIRED = ['id', 'status', 'dq', 'orig', 'borrower', 'address', 'city', 'state', 'basis', 'tla', 'maturity'];
const LABEL = { id: 'Loan ID', status: 'Status', dq: 'Delinquency', orig: 'Originator', borrower: 'Borrower', address: 'Address',
  city: 'City', state: 'State', basis: 'Basis', tla: 'TLA', maturity: 'Maturity' };

// Placeholders the tape uses where there is no guarantor. They are not names.
const NO_GUARANTOR = /^(single guarantor|n\/a|na|none|-)$/i;

const pad = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Excel serial day number or an ISO / US date string -> 'YYYY-MM-DD', or null
export function toIsoDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (!(v > 20000 && v < 80000)) return null;                       // roughly years 1954 to 2118
    return isoOf(new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 864e5));
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(s);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
  return null;
}

export const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5);

const str = v => (v == null ? null : (String(v).trim() === '' ? null : String(v).trim()));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null));

/**
 * rows: array of arrays as read from the sheet (rows[0] = header row)
 * asOf: 'YYYY-MM-DD'
 * -> { ok:true, loans, warnings } | { ok:false, message }
 */
export function parseTape(rows, asOf) {
  const head = (rows[0] || []).map(h => (h == null ? '' : String(h).trim().toLowerCase()));
  const col = {};
  head.forEach((h, i) => { const f = COLUMNS[h]; if (f && col[f] == null) col[f] = i; });
  const missing = REQUIRED.filter(f => col[f] == null).map(f => LABEL[f]);
  if (missing.length) {
    return { ok: false, message: `Stopped: the first row of the sheet is missing the column${missing.length > 1 ? 's' : ''} ${missing.map(m => '"' + m + '"').join(', ')}. `
      + 'Nothing was changed.' };
  }
  const errors = [], warnings = [], loans = [], seen = new Map();
  const bad = (n, what) => { if (errors.length < 8) errors.push(`row ${n}: ${what}`); else if (errors.length === 8) errors.push('and more'); };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (!row.some(c => c != null && String(c).trim() !== '')) continue;          // blank line
    const get = f => (col[f] == null ? null : row[col[f]]);
    const n = r + 1;                                                              // spreadsheet row number
    const id = str(get('id'));
    if (!id) { bad(n, 'has data but no Loan ID'); continue; }
    if (seen.has(id)) { bad(n, `Loan ID ${id} repeats row ${seen.get(id)}`); continue; }
    seen.set(id, n);

    const status = str(get('status')), dq = str(get('dq'));
    if (!ST_ORDER.includes(status)) bad(n, `${id} has Status "${status ?? ''}", which is not one of ${ST_ORDER.join(', ')}`);
    if (!DQ_ORDER.includes(dq)) bad(n, `${id} has Delinquency "${dq ?? ''}", which is not one of ${DQ_ORDER.join(', ')}`);

    const basis = num(get('basis')), tla = num(get('tla'));
    if (basis == null || basis < 0) bad(n, `${id} has no usable Basis`);
    if (tla == null || tla <= 0) bad(n, `${id} has no usable TLA`);

    const maturity = toIsoDate(get('maturity'));
    if (!maturity) bad(n, `${id} has no readable Maturity date`);
    const origDate = toIsoDate(get('orig_date'));
    const nupd = toIsoDate(get('nupd'));

    let lat = num(get('lat')), lon = num(get('lon'));
    let dlat = num(get('dlat')), dlon = num(get('dlon'));
    if (lat != null && (lat < -90 || lat > 90)) bad(n, `${id} has a Latitude outside -90 to 90`);
    if (lon != null && (lon < -180 || lon > 180)) bad(n, `${id} has a Longitude outside -180 to 180`);
    if (dlat == null || dlon == null) { dlat = lat; dlon = lon; }                 // display pair falls back to the address pair

    const g = f => { const v = str(get(f)); return v && !NO_GUARANTOR.test(v) ? v : null; };

    loans.push({
      id, status, dq,
      orig: str(get('orig')), borrower: str(get('borrower')), g1: g('g1'), g2: g('g2'),
      address: str(get('address')), city: str(get('city')), state: str(get('state')),
      basis, tla, adv: basis != null && tla > 0 ? basis / tla : null,
      hbd: num(get('hbd')), hbr: num(get('hbr')), ires: num(get('ires')),
      orig_date: origDate, maturity, d2m: maturity ? dayDiff(maturity, asOf) : null,
      notes: str(get('notes')) ?? '', nupd,
      lat, lon, dlat, dlon,
    });
  }

  if (!loans.length && !errors.length) errors.push('the sheet has no loan rows under the header');
  if (errors.length) return { ok: false, message: 'Stopped: ' + errors.join('; ') + '. Nothing was changed.' };

  const noCoords = loans.filter(l => l.dlat == null || l.dlon == null).length;
  if (noCoords) warnings.push(`${noCoords} position${noCoords > 1 ? 's have' : ' has'} no coordinates and will not appear on the map`);
  return { ok: true, loans, warnings };
}

/** 32-bit FNV-1a over whitespace-normalised text. Must match the page's own hash. */
export function fnv(t) {
  let h = 0x811c9dc5;
  t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

/** The slim record the change log compares against (what the page calls PRIOR). */
export const priorRecord = l => ({
  id: l.id, status: l.status, dq: l.dq, basis: l.basis, tla: l.tla, maturity: l.maturity,
  address: l.address, city: l.city, state: l.state, orig: l.orig, nh: fnv(l.notes),
});
