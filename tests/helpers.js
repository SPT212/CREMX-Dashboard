// Test helpers: an in-memory store (same interface as Netlify Blobs / KV) and a tiny .xlsx writer.

export function memoryStore() {
  const data = new Map();
  const store = name => ({
    get: async (key, opts = {}) => {
      const v = data.get(`${name}:${key}`);
      if (v === undefined) return null;
      if (opts.type === 'json') return JSON.parse(v);
      if (opts.type === 'arrayBuffer') return v instanceof Uint8Array ? v.slice().buffer : new TextEncoder().encode(v).buffer;
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
    set: async (key, value) => { data.set(`${name}:${key}`, value instanceof ArrayBuffer ? new Uint8Array(value) : value); },
    setJSON: async (key, value) => { data.set(`${name}:${key}`, JSON.stringify(value)); },
    delete: async key => { data.delete(`${name}:${key}`); },
  });
  store.data = data;
  return store;
}

const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

async function deflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function zip(parts, compress) {           // parts: [[name, string]]
  const enc = new TextEncoder(), chunks = [], central = []; let offset = 0;
  const push = b => { chunks.push(b); offset += b.length; };
  for (const [name, content] of parts) {
    const raw = enc.encode(content), nameB = enc.encode(name);
    const comp = compress ? await deflateRaw(raw) : raw, method = compress ? 8 : 0, crc = crc32(raw);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, method, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, comp.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, nameB.length, true);
    central.push({ nameB, method, crc, csize: comp.length, usize: raw.length, offset });
    push(new Uint8Array(lh.buffer)); push(nameB); push(comp);
  }
  const cdStart = offset;
  for (const c of central) {
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(10, c.method, true);
    ch.setUint32(16, c.crc, true); ch.setUint32(20, c.csize, true); ch.setUint32(24, c.usize, true); ch.setUint16(28, c.nameB.length, true);
    ch.setUint32(42, c.offset, true);
    push(new Uint8Array(ch.buffer)); push(c.nameB);
  }
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, central.length, true); eo.setUint16(10, central.length, true);
  eo.setUint32(12, offset - cdStart, true); eo.setUint32(16, cdStart, true);
  push(new Uint8Array(eo.buffer));
  const out = new Uint8Array(offset); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = i => { let s = '', n = i + 1; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

/** rows: array of arrays (string | number | null). opts.shared uses sharedStrings; opts.compress deflates the parts. */
export async function makeXlsx(rows, { shared = false, compress = false } = {}) {
  const ss = []; const ssIndex = new Map();
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">` + row.map((v, c) => {
    const ref = colName(c) + (r + 1);
    if (v == null) return `<c r="${ref}"/>`;
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    if (!shared) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    if (!ssIndex.has(v)) { ssIndex.set(v, ss.length); ss.push(v); }
    return `<c r="${ref}" t="s"><v>${ssIndex.get(v)}</v></c>`;
  }).join('') + '</row>').join('');
  const parts = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'],
    ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Presentation List" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
  ];
  if (shared) parts.push(['xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${ss.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`]);
  return zip(parts, compress);
}

export const HEADERS = ['Loan ID', 'Status', 'Delinquency', 'Originator', 'Borrower', 'Guarantor 1', 'Guarantor 2', 'Address', 'City', 'State',
  'Latitude', 'Longitude', 'Display Latitude', 'Display Longitude', 'Basis', 'TLA', 'Advance %', 'Holdback Disbursed', 'Holdback Remaining',
  'Interest Reserve', 'Origination', 'Maturity', 'Notes/Comments', 'Notes Last Updated'];

/** Excel serial for an ISO date */
export const serial = iso => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 864e5);

/** n synthetic loans. Nothing here is real data. */
export function sampleRows(n, { prefix = 'T', basisBase = 100000, notes = 'Synthetic note' } = {}) {
  const sts = ['Performing', 'SS Managed', 'Watchlist', 'Problem Loans', 'Foreclosure', 'REO'], dqs = ['Current', '30 Days DQ', '60 Days DQ', '90+ Days DQ', 'Foreclosure', 'REO'];
  const rows = [HEADERS];
  for (let i = 0; i < n; i++) {
    const lat = 30 + (i % 10) * 0.7, lon = -100 + (i % 17) * 1.1;
    rows.push([`${prefix}${String(i + 1).padStart(4, '0')}`, sts[i % 6], dqs[i % 6], 'Test Originator ' + (i % 3), `Borrower ${i} & Co`,
      `Guarantor ${i}`, i % 2 ? 'Single Guarantor' : `Second ${i}`, `${100 + i} Test St`, 'Testville', 'TX', lat, lon, lat, lon,
      basisBase + i * 1000, 2 * (basisBase + i * 1000), null, 1000, 500, 0, serial('2025-06-11'), serial('2026-12-01') + i,
      `${notes} ${i}`, i % 2 ? serial('2026-09-29') : null]);
  }
  return rows;
}
