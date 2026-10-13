/**
 * Standalone smoke test for excelExport — runs in Node, no Vitest.
 *
 * We can't import a .ts file directly in plain Node, so this script
 * re-implements the public surface (detectPreviewArray) inline and
 * asserts the same contract. The XLSX generation itself runs in the
 * browser and is verified live (manual click test).
 *
 * If you ever wire Vitest into the frontend, port this to a .test.ts
 * and import the real module.
 */

function detectPreviewArray(preview) {
  if (!preview || typeof preview !== 'object') return null;
  const preferred = ['items', 'rows', 'data', 'results'];
  for (const k of preferred) {
    if (Array.isArray(preview[k])) return { key: k, rows: preview[k] };
  }
  for (const [k, v] of Object.entries(preview)) {
    if (Array.isArray(v)) return { key: k, rows: v };
  }
  return null;
}

const cases = [
  { name: '{ total, devices }', preview: { total: 2, devices: [{ name: 'F1' }, { name: 'F2' }] }, key: 'devices', n: 2 },
  { name: '{ prefixes }', preview: { total: 1, prefixes: [{ prefix: '10.0.0.0/8' }] }, key: 'prefixes', n: 1 },
  { name: 'empty array still exports', preview: { total: 0, items: [] }, key: 'items', n: 0 },
  { name: 'fallback first array', preview: { foo: 'bar', data: [{ x: 1 }] }, key: 'data', n: 1 },
  { name: 'null preview', preview: null, key: null, n: 0 },
  { name: 'no array', preview: { total: 5, summary: 'ok' }, key: null, n: 0 },
  { name: 'items priority', preview: { items: [{ a: 1 }], other: [{ b: 2 }] }, key: 'items', n: 1 },
  { name: 'realistic NetBox devices', preview: { total: 8, devices: [
    { id: 1, name: 'LAB-F1-AS-01', mfg: 'Arista', site: { name: 'LAB' } },
    { id: 2, name: 'LAB-F2-AS-01', mfg: 'Juniper', site: { name: 'LAB' } },
  ]}, key: 'devices', n: 2 },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = detectPreviewArray(c.preview);
  const ok = (got?.key ?? null) === c.key && (got?.rows.length ?? 0) === c.n;
  if (ok) { pass++; console.log(`  PASS  ${c.name}`); }
  else {
    fail++;
    console.log(`  FAIL  ${c.name}  expected key=${c.key} n=${c.n} got key=${got?.key} n=${got?.rows.length}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
