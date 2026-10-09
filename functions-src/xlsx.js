// Minimal .xlsx reader: a zip of XML parts. No dependencies and no Node-only APIs
// (Uint8Array, TextDecoder, DecompressionStream), so the same code runs in a Netlify
// Function, a Cloudflare Worker and a browser test page.
//
// Reads the first worksheet only. Handles shared strings, inline strings, numbers
// and booleans. A formula cell is read as its cached value; a formula that was never
// calculated has no cached value and comes back as null.

const MAX_PART = 64 * 1024 * 1024;           // refuse a part that inflates past this (zip-bomb guard)

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PART) throw new Error('The workbook contains a part that is too large to read.');
    chunks.push(value);
  }
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// -> Map(name -> { method, csize, usize, offset })
function zipEntries(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not an .xlsx workbook (no zip directory found).');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const dec = new TextDecoder();
  const map = new Map();
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('The workbook\'s zip directory is damaged.');
    const method = u16(b, p + 10), csize = u32(b, p + 20), usize = u32(b, p + 24);
    const nl = u16(b, p + 28), el = u16(b, p + 30), cl = u16(b, p + 32), offset = u32(b, p + 42);
    map.set(dec.decode(b.subarray(p + 46, p + 46 + nl)), { method, csize, usize, offset });
    p += 46 + nl + el + cl;
  }
  return map;
}

async function zipRead(b, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  if (e.usize > MAX_PART) throw new Error('The workbook contains a part that is too large to read.');
  if (u32(b, e.offset) !== 0x04034b50) throw new Error('The workbook\'s zip entry is damaged.');
  const start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
  const raw = b.subarray(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRaw(raw);
  throw new Error('The workbook uses a zip compression this reader does not support.');
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = s => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, g) =>
  g[0] === '#' ? String.fromCodePoint(g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)) : ENT[g]);

// Text of every <t> inside an element's XML, skipping phonetic runs (<rPh>).
function textOf(xml) {
  xml = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '', m; const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  while ((m = re.exec(xml))) out += m[1] ? unescapeXml(m[1]) : '';
  return out;
}

const colIndex = ref => {
  const letters = /^[A-Z]+/.exec(ref)[0]; let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function parseSharedStrings(xml) {
  const out = []; let m; const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  while ((m = re.exec(xml))) out.push(m[1] ? textOf(m[1]) : '');
  return out;
}

const attr = (tag, name) => { const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag); return m ? unescapeXml(m[1]) : null; };

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g; let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowNo = parseInt(attr(rm[1], 'r') || String(rows.length + 1), 10);
    const cells = [];
    if (rm[2]) {
      const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
      while ((cm = cRe.exec(rm[2]))) {
        const ref = attr(cm[1], 'r'); if (!ref) continue;
        const t = attr(cm[1], 't'), body = cm[2] || '';
        let val = null;
        if (t === 'inlineStr') val = textOf(body);
        else {
          const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
          if (v) {
            const raw = unescapeXml(v[1]);
            if (t === 's') val = shared[parseInt(raw, 10)] ?? null;
            else if (t === 'str' || t === 'e' || t === 'd') val = raw;
            else if (t === 'b') val = raw === '1';
            else { const n = Number(raw); val = raw !== '' && Number.isFinite(n) ? n : raw; }
          }
        }
        cells[colIndex(ref)] = val;
      }
    }
    rows[rowNo - 1] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

// bytes: Uint8Array -> { sheetName, rows: [[cell, ...], ...] }   (rows[0] is sheet row 1)
export async function readXlsx(bytes) {
  const entries = zipEntries(bytes);
  const dec = new TextDecoder();
  const wbBytes = await zipRead(bytes, entries, 'xl/workbook.xml');
  if (!wbBytes) throw new Error('This is not an Excel workbook (xl/workbook.xml is missing).');
  const wb = dec.decode(wbBytes);
  const first = /<sheet\b[^>]*>/.exec(wb);
  if (!first) throw new Error('The workbook has no worksheets.');
  const sheetName = attr(first[0], 'name');
  const rid = attr(first[0], 'r:id');
  let target = 'worksheets/sheet1.xml';
  const relBytes = await zipRead(bytes, entries, 'xl/_rels/workbook.xml.rels');
  if (relBytes && rid) {
    for (const r of dec.decode(relBytes).match(/<Relationship\b[^>]*>/g) || []) {
      if (attr(r, 'Id') === rid) { target = attr(r, 'Target'); break; }
    }
  }
  target = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  const sheetBytes = await zipRead(bytes, entries, target);
  if (!sheetBytes) throw new Error('The first worksheet could not be found inside the workbook.');
  const ssBytes = await zipRead(bytes, entries, 'xl/sharedStrings.xml');
  const shared = ssBytes ? parseSharedStrings(dec.decode(ssBytes)) : [];
  return { sheetName, rows: parseSheet(dec.decode(sheetBytes), shared) };
}
