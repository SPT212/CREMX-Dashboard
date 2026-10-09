// Runs in a browser (no Node on this machine): serve the project folder and open tests/run.html.
// The handler under test is the real one; only the store is an in-memory fake.
import { createHandler, asOfFromName } from '../functions-src/handler.js';
import { readXlsx } from '../functions-src/xlsx.js';
import { parseTape, fnv } from '../functions-src/parse-tape.js';
import { deriveKey, unb64 } from '../functions-src/crypto.js';
import templates from '../functions-src/templates.js';
import { memoryStore, makeXlsx, sampleRows, HEADERS, serial } from './helpers.js';

const results = []; let failed = 0;
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };
const ok = (c, msg) => { if (!c) throw new Error(msg || 'assertion failed'); };
async function t(name, fn) {
  try { await fn(); results.push('PASS ' + name); } catch (e) { failed++; results.push('FAIL ' + name + ' :: ' + e.message); }
  const txt = results.join('\n') + '\n...running';
  document.getElementById('RESULT').textContent = txt;
  fetch('/result', { method: 'POST', body: txt }).catch(() => {});
}

const ENV = { UPLOAD_PASSPHRASE: 'pass-upload', DASHBOARD_PASSWORD: 'a-long-viewer-password', OPEN_VIEW: '1', PBKDF2_ITERATIONS: '1000' };
const fresh = (env = {}, clock) => { const store = memoryStore(); return { store, h: createHandler({ store, env: { ...ENV, ...env }, templates, now: clock || (() => new Date('2026-10-09T12:00:00Z')) }) }; };

async function post(h, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) { if (v != null) fd.set(k, v); }
  const res = await h(new Request('https://x.test/api/upload', { method: 'POST', body: fd }));
  const ctype = res.headers.get('content-type') || '';
  return { res, status: res.status, j: ctype.includes('json') ? await res.json() : null };
}
const xfile = async (rows, name, opts) => new File([await makeXlsx(rows, opts)], name, { type: 'application/octet-stream' });
const up = async (h, rows, name, extra = {}) => post(h, { action: 'upload', passphrase: ENV.UPLOAD_PASSPHRASE, file: await xfile(rows, name), ...extra });
const get = (h, path = '/') => h(new Request('https://x.test' + path));
const index = async store => JSON.parse(store.data.get('meta:index') || '{"weeks":[]}').weeks;
const dataOf = html => { const m = /const LOANS =\n(\[.*\]);\n/.exec(html); return m ? JSON.parse(m[1]) : null; };
const priorOf = html => { const m = /const PRIOR =\n(\[.*\]);\n/.exec(html); return m ? JSON.parse(m[1]) : null; };
const flagOf = html => /NO_PRIOR=(true|false)/.exec(html)[1];

// ---- file name dates ----
await t('asOfFromName reads MM.DD.YYYY, MM_DD_YYYY, MM-DD-YY and rejects non-dates', () => {
  eq(asOfFromName('CREMX_Loan_Portfolio_10_02_2026.xlsx'), '2026-10-02');
  eq(asOfFromName('Defaulted Loans - 09.25.2026.xlsx'), '2026-09-25');
  eq(asOfFromName('tape 9-4-26.xlsx'), '2026-09-04');
  eq(asOfFromName('tape 13_45_2026.xlsx'), null);
  eq(asOfFromName('no date here.xlsx'), null);
});

// ---- reader ----
for (const [label, opts] of [['inline strings, stored', {}], ['shared strings, deflated', { shared: true, compress: true }]]) {
  await t(`readXlsx + parseTape round trip (${label})`, async () => {
    const rows = sampleRows(8);
    const { rows: got, sheetName } = await readXlsx(await makeXlsx(rows, opts));
    eq(sheetName, 'Presentation List');
    eq(got[1][0], 'T0001'); eq(got[1][14], 100000); eq(got[2][4], 'Borrower 1 & Co');
    const p = parseTape(got, '2026-10-09');
    ok(p.ok, p.message); eq(p.loans.length, 8);
    const l = p.loans[1];
    eq([l.id, l.status, l.dq, l.g2, l.maturity, l.d2m, l.nupd], ['T0002', 'SS Managed', '30 Days DQ', null, '2026-12-02', 54, '2026-09-29']);
    eq(l.adv, 0.5); eq(p.loans[0].nupd, null); eq(p.loans[0].g2, 'Second 0');
  });
}

// ---- parser rejections ----
const bad = async (mut, expect) => {
  const rows = sampleRows(5); mut(rows);
  const p = parseTape((await readXlsx(await makeXlsx(rows))).rows, '2026-10-09');
  ok(!p.ok, 'expected a rejection'); ok(p.message.includes(expect), `message "${p.message}" should mention "${expect}"`); ok(p.message.includes('Nothing was changed'));
};
await t('parser: missing column named', () => bad(r => { r[0] = r[0].filter(h => h !== 'Basis'); }, '"Basis"'));
await t('parser: unknown status', () => bad(r => { r[2][1] = 'Mystery'; }, 'Mystery'));
await t('parser: unknown delinquency', () => bad(r => { r[2][2] = '45 Days DQ'; }, '45 Days DQ'));
await t('parser: duplicate loan id', () => bad(r => { r[3][0] = r[2][0]; }, 'repeats'));
await t('parser: no TLA', () => bad(r => { r[2][15] = 0; }, 'TLA'));
await t('parser: unreadable maturity', () => bad(r => { r[2][21] = 'soon'; }, 'Maturity'));
await t('parser: latitude out of range', () => bad(r => { r[2][10] = 123; }, 'Latitude'));
await t('parser: header only', () => bad(r => { r.length = 1; }, 'no loan rows'));
await t('parser: missing coordinates is a warning, not an error', async () => {
  const rows = sampleRows(3); rows[1][10] = rows[1][11] = rows[1][12] = rows[1][13] = null;
  const p = parseTape((await readXlsx(await makeXlsx(rows))).rows, '2026-10-09');
  ok(p.ok); ok(p.warnings[0].includes('1 position has no coordinates'));
});
await t('readXlsx rejects a non-zip', async () => { let m = ''; try { await readXlsx(new TextEncoder().encode('not a zip file at all, just text')); } catch (e) { m = e.message; } ok(m.includes('not an .xlsx'), m); });

// ---- handler ----
await t('empty site: page says no packet yet and offers upload', async () => {
  const { h } = fresh();
  const html = await (await get(h)).text();
  ok(html.includes('No packet uploaded yet')); ok(html.includes('upOpen')); ok(html.includes('"canUpload":true'));
});
await t('security headers are set on the page', async () => {
  const { h } = fresh(); const r = await get(h);
  eq(r.headers.get('referrer-policy'), 'strict-origin'); eq(r.headers.get('x-frame-options'), 'DENY'); eq(r.headers.get('cache-control'), 'no-store');
});
await t('wrong or missing passphrase: 401, nothing stored', async () => {
  const { h, store } = fresh();
  const r = await post(h, { action: 'upload', passphrase: 'nope', file: await xfile(sampleRows(3), 'CREMX_10_09_2026.xlsx') });
  eq(r.status, 401); eq((await post(h, { action: 'log' })).status, 401); eq(store.data.size, 0);
});
await t('uploads are off when UPLOAD_PASSPHRASE is not set', async () => {
  const { h } = fresh({ UPLOAD_PASSPHRASE: '' }); eq((await post(h, { action: 'log', passphrase: '' })).status, 500);
});
await t('first upload publishes; page shows it with no prior week', async () => {
  const { h, store } = fresh();
  const r = await up(h, sampleRows(12), 'CREMX_Loan_Portfolio_10_02_2026.xlsx');
  eq(r.status, 200); eq(r.j.verb, 'Published'); ok(r.j.message.includes('12 positions')); ok(r.j.message.includes('No earlier week'));
  eq(await index(store), ['2026-10-02']);
  const html = await (await get(h)).text();
  eq(dataOf(html).length, 12); eq(flagOf(html), 'true'); ok(html.includes('October 2, 2026'));
});
await t('second upload: page shows the new week against the first', async () => {
  const { h } = fresh();
  await up(h, sampleRows(12), 'CREMX_Loan_Portfolio_10_02_2026.xlsx');
  const r = await up(h, sampleRows(13), 'CREMX_Loan_Portfolio_10_09_2026.xlsx');
  eq(r.j.verb, 'Published'); ok(r.j.message.includes('Compared with 10.02.2026'));
  const html = await (await get(h)).text();
  eq(dataOf(html).length, 13); eq(priorOf(html).length, 12); eq(flagOf(html), 'false');
  eq(priorOf(html)[0].nh, fnv('Synthetic note 0'));
});
await t('backfill is filed as history and never changes what is displayed', async () => {
  const { h, store } = fresh();
  await up(h, sampleRows(12), 'CREMX_Loan_Portfolio_10_09_2026.xlsx');
  const before = await (await get(h)).text();
  const r = await up(h, sampleRows(12, { notes: 'older' }), 'CREMX_Loan_Portfolio_10_02_2026.xlsx');
  eq(r.j.verb, 'Filed in as history'); ok(r.j.message.includes('still shows 10.09.2026'));
  eq(await index(store), ['2026-10-02', '2026-10-09']);
  eq(dataOf(await (await get(h)).text()), dataOf(before));
});
await t('same date again is Replaced', async () => {
  const { h } = fresh();
  await up(h, sampleRows(12), 'CREMX_Loan_Portfolio_10_02_2026.xlsx');
  const r = await up(h, sampleRows(12, { notes: 'changed' }), 'CREMX_Loan_Portfolio_10_02_2026.xlsx');
  eq(r.j.verb, 'Replaced'); ok(dataOf(await (await get(h)).text())[0].notes.startsWith('changed'));
});
await t('upload order does not matter', async () => {
  const a = fresh(), b = fresh();
  for (const d of ['09_25', '09_11', '09_21']) await up(a.h, sampleRows(12), `T_${d}_2026.xlsx`);
  for (const d of ['09_11', '09_21', '09_25']) await up(b.h, sampleRows(12), `T_${d}_2026.xlsx`);
  eq(await index(a.store), await index(b.store)); eq(await index(a.store), ['2026-09-11', '2026-09-21', '2026-09-25']);
});
await t('typed date wins over the file name; a name with no date needs one', async () => {
  const { h, store } = fresh();
  const a = await up(h, sampleRows(5), 'tape.xlsx'); eq(a.status, 400); ok(a.j.message.includes('Type the as-of date'));
  const b = await up(h, sampleRows(5), 'tape.xlsx', { asOf: '2026-10-05' }); eq(b.status, 200); eq(await index(store), ['2026-10-05']);
  const c = await up(h, sampleRows(5), 'CREMX_10_09_2026.xlsx', { asOf: '2026-10-06' }); eq(c.status, 200); eq(await index(store), ['2026-10-05', '2026-10-06']);
  eq((await up(h, sampleRows(5), 'x.xlsx', { asOf: '2026-13-40' })).status, 400);
  eq((await up(h, sampleRows(5), 'CREMX_12_31_2027.xlsx')).status, 400);              // in the future
});
await t('rejected uploads store nothing but are logged', async () => {
  const { h, store } = fresh();
  const rows = sampleRows(5); rows[2][1] = 'Mystery';
  const r = await up(h, rows, 'CREMX_10_09_2026.xlsx'); eq(r.status, 422); ok(r.j.message.includes('Mystery'));
  eq([...store.data.keys()].filter(k => k.startsWith('weeks:') || k.startsWith('files:')).length, 0);
  eq(await index(store), []);
  const log = (await post(h, { action: 'log', passphrase: ENV.UPLOAD_PASSPHRASE })).j.log;
  eq(log.length, 1); eq(log[0].result, 'rejected'); ok(!log[0].fileKey);
});
await t('a not-an-xlsx file is rejected with a plain message', async () => {
  const { h } = fresh();
  const r = await post(h, { action: 'upload', passphrase: ENV.UPLOAD_PASSPHRASE, file: new File(['hello'], 'CREMX_10_09_2026.xlsx') });
  eq(r.status, 422); ok(r.j.message.includes('Could not read the workbook'));
});
await t('a large swing asks first; right token publishes; wrong token is refused', async () => {
  const { h, store } = fresh();
  await up(h, sampleRows(20), 'CREMX_10_02_2026.xlsx');
  const r1 = await up(h, sampleRows(40), 'CREMX_10_09_2026.xlsx'); eq(r1.status, 409); ok(r1.j.needsConfirm); eq(await index(store), ['2026-10-02']);
  const r2 = await up(h, sampleRows(40), 'CREMX_10_09_2026.xlsx', { confirmChange: 'n:1>2' }); eq(r2.status, 409);
  const r3 = await up(h, sampleRows(40), 'CREMX_10_09_2026.xlsx', { confirmChange: r1.j.confirmToken }); eq(r3.status, 200);
  eq(await index(store), ['2026-10-02', '2026-10-09']);
});
await t('undo removes only the latest week, down to empty; files and log are kept', async () => {
  const { h, store } = fresh();
  await up(h, sampleRows(12), 'CREMX_10_02_2026.xlsx'); await up(h, sampleRows(12), 'CREMX_10_09_2026.xlsx');
  const u1 = await post(h, { action: 'undo', passphrase: ENV.UPLOAD_PASSPHRASE }); eq(u1.status, 200);
  eq(await index(store), ['2026-10-02']); eq(dataOf(await (await get(h)).text()).length, 12);
  await post(h, { action: 'undo', passphrase: ENV.UPLOAD_PASSPHRASE });
  eq(await index(store), []); ok((await (await get(h)).text()).includes('No packet uploaded yet'));
  eq((await post(h, { action: 'undo', passphrase: ENV.UPLOAD_PASSPHRASE })).status, 409);
  eq([...store.data.keys()].filter(k => k.startsWith('files:')).length, 2);
  const log = (await post(h, { action: 'log', passphrase: ENV.UPLOAD_PASSPHRASE })).j.log;
  eq(log.map(x => x.verb), ['Undo', 'Undo', 'Published', 'Published']);                    // newest first
});
await t('download returns the exact original bytes; other keys are unreachable', async () => {
  const { h } = fresh();
  const rows = sampleRows(6), bytes = await makeXlsx(rows);
  await post(h, { action: 'upload', passphrase: ENV.UPLOAD_PASSPHRASE, file: new File([bytes], 'CREMX_10_09_2026.xlsx') });
  const log = (await post(h, { action: 'log', passphrase: ENV.UPLOAD_PASSPHRASE })).j.log;
  const res = await post(h, { action: 'file', passphrase: ENV.UPLOAD_PASSPHRASE, key: log[0].fileKey });
  eq(res.status, 200); ok(res.res.headers.get('content-disposition').includes('CREMX_10_09_2026.xlsx'));
  eq(Array.from(new Uint8Array(await res.res.arrayBuffer())), Array.from(bytes));
  for (const key of ['../meta/salt', 'meta:salt', 'meta:log', '2026-10-09_20261009T120000000Z_../x']) eq((await post(h, { action: 'file', passphrase: ENV.UPLOAD_PASSPHRASE, key })).status, 400);
});
await t('notes containing </script>, {{LOANS}} and $& cannot break the page or the template', async () => {
  const { h } = fresh();
  const rows = sampleRows(4); rows[1][22] = 'evil </script><script>window.__x=1</script> {{LOANS}} $& $1 <!--';
  await up(h, rows, 'CREMX_10_09_2026.xlsx');
  const html = await (await get(h)).text();
  ok(!html.includes('window.__x=1</script>')); eq(dataOf(html)[0].notes, rows[1][22]);
});
await t('encrypted page: wrong password fails, right password decrypts to the dashboard', async () => {
  const { h } = fresh({ OPEN_VIEW: '0' });
  await up(h, sampleRows(5), 'CREMX_10_09_2026.xlsx', {});
  // uploads work with OPEN_VIEW off; now fetch the locked page
  const html = await (await get(h)).text();
  ok(!html.includes('Borrower 0')); ok(html.includes('id="payload"'));
  const P = JSON.parse(/<script type="application\/json" id="payload">(.*?)<\/script>/s.exec(html)[1]);
  eq(P.iter, 1000);
  const dec = async pw => new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(P.iv) }, await deriveKey(pw, unb64(P.salt), P.iter), unb64(P.data)));
  let threw = false; try { await dec('wrong-password-xx'); } catch { threw = true; } ok(threw, 'wrong password must fail');
  ok((await dec(ENV.DASHBOARD_PASSWORD)).includes('Borrower 0'));
  const html2 = await (await get(h)).text();
  eq(JSON.parse(/id="payload">(.*?)<\/script>/s.exec(html2)[1]).salt, P.salt);            // salt is stable across requests
});
await t('a short or missing viewer password is explained, not a bare 500', async () => {
  const a = fresh({ OPEN_VIEW: '0', DASHBOARD_PASSWORD: 'short' }); const r = await get(a.h); eq(r.status, 500); ok((await r.text()).includes('shorter than the required 16'));
  const b = fresh({ OPEN_VIEW: '0', DASHBOARD_PASSWORD: '' }); ok((await (await get(b.h)).text()).includes('DASHBOARD_PASSWORD'));
});
window.__RESULT = results.join('\n') + `\n${failed ? 'FAILED: ' + failed : 'ALL PASSED'} (${results.length} tests)`;
document.getElementById('RESULT').textContent = window.__RESULT;
await fetch('/result', { method: 'POST', body: window.__RESULT + '\nDONE' }).catch(() => {});
