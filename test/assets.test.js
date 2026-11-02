import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { processItem } from '../docs/js/ingest.js';
import { TEST_MESSAGE, normalizeWorkerUrl, generateKey } from '../docs/js/guide.js';

const docs = new URL('../docs/', import.meta.url);
const read = (p) => readFileSync(new URL(p, docs), 'utf8');

test('the Worker the guide hands out is byte-for-byte the tested one', () => {
  assert.equal(read('worker.js'), readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8'));
});

test('every file the page, the manifest and the offline cache name exists', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1]);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const sw = read('sw.js');
  const cached = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter((p) => p && !/^masroofi/.test(p));

  for (const p of [...refs, ...manifest.icons.map((i) => i.src), ...cached]) {
    assert.ok(existsSync(new URL(p, docs)), `${p} is referenced but missing`);
  }
  assert.equal(manifest.dir, 'rtl');
  assert.equal(manifest.display, 'standalone');
  assert.ok(/<html lang="ar" dir="rtl">/.test(html));
});

test('every script in docs/js is in the offline cache, so the app opens without a connection', () => {
  const sw = read('sw.js');
  for (const f of readdirSync(new URL('js/', docs))) assert.ok(sw.includes(`'./js/${f}'`), `${f} is not cached`);
});

test('the connection test message is silently dropped, never turned into a transaction', () => {
  const out = processItem(
    { id: 'm:1', source: 'sms', text: TEST_MESSAGE, receivedAt: '2026-11-01T10:00:00+03:00', at: '2026-11-01T10:00:00+03:00' },
    { txs: [], recentRaws: [], rules: {}, now: '2026-11-01T10:00:01+03:00' },
  );
  assert.equal(out.created, null);
  assert.equal(out.raw.status, 'ignored');
  assert.equal(out.raw.reason, 'otp');
});

test('worker addresses are cleaned up and anything unsafe is refused', () => {
  assert.equal(normalizeWorkerUrl('masroofi.me.workers.dev'), 'https://masroofi.me.workers.dev');
  assert.equal(normalizeWorkerUrl('  https://masroofi.me.workers.dev/ '), 'https://masroofi.me.workers.dev');
  assert.equal(normalizeWorkerUrl('https://masroofi.me.workers.dev/i'), 'https://masroofi.me.workers.dev');
  assert.equal(normalizeWorkerUrl('http://masroofi.me.workers.dev'), null); // keys must not travel in the clear
  assert.equal(normalizeWorkerUrl('localhost'), null);
  assert.equal(normalizeWorkerUrl(''), null);
  assert.equal(normalizeWorkerUrl('not a url'), null);
});

test('generated keys are 32 URL-safe characters and different each time', () => {
  const a = generateKey();
  const b = generateKey();
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a, b);
});
