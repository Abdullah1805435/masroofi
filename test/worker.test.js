import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';
import { MockKV } from './mock-kv.js';

const INGEST = 'ingest-key-0123456789-abcdefghij';
const PULL = 'pull-key-0123456789-abcdefghijklmn';

const makeEnv = (extra = {}) => ({ INBOX: new MockKV(), INGEST_KEY: INGEST, PULL_KEY: PULL, ...extra });

function call(env, method, path, { key, body, type = 'application/json', headers = {} } = {}) {
  const h = { ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  if (body !== undefined) h['content-type'] = type;
  const init = { method, headers: h };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request(`https://inbox.example.workers.dev${path}`, init), env);
}

const sms = (text, extra = {}) => ({ source: 'sms', text, receivedAt: '2026-10-31T16:23:30+03:00', ...extra });

test('health check needs no key and reveals nothing', async () => {
  const res = await call(makeEnv(), 'GET', '/');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'masroofi inbox');
});

test('adding an item needs the ingest key', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'POST', '/i', { body: sms('x') })).status, 401);
  assert.equal((await call(env, 'POST', '/i', { key: 'wrong-key-wrong-key-wrong', body: sms('x') })).status, 401);
  assert.equal((await call(env, 'POST', '/i', { key: PULL, body: sms('x') })).status, 401);
  assert.equal(env.INBOX.map.size, 0);
});

test('reading and deleting need the pull key; the ingest key cannot read', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'GET', '/p')).status, 401);
  assert.equal((await call(env, 'GET', '/p', { key: INGEST })).status, 401);
  assert.equal((await call(env, 'POST', '/a', { key: INGEST, body: { ids: [] } })).status, 401);
});

test('a missing or short key is a configuration error, never an open door', async () => {
  for (const bad of [undefined, '', 'short']) {
    const env = makeEnv({ INGEST_KEY: bad, PULL_KEY: bad });
    const res = await call(env, 'POST', '/i', { key: bad ?? '', body: sms('x') });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'not_configured');
    assert.equal((await call(env, 'GET', '/p', { key: bad ?? '' })).status, 500);
  }
});

test('sms round trip: add, pull, delete after saving', async () => {
  const env = makeEnv();
  const text = 'شراء PoS\nبـSAR 34.50\nلـMCDONALDS\n31/10/26 02:45';
  const added = await call(env, 'POST', '/i', { key: INGEST, body: sms(text, { sender: 'AlRajhiBank' }) });
  assert.equal(added.status, 201);
  const { id } = await added.json();
  assert.match(id, /^m:\d{13}:[0-9a-f]{12}$/);

  const pulled = await (await call(env, 'GET', '/p', { key: PULL })).json();
  assert.equal(pulled.more, false);
  assert.equal(pulled.items.length, 1);
  assert.equal(pulled.items[0].id, id);
  assert.equal(pulled.items[0].source, 'sms');
  assert.equal(pulled.items[0].text, text);
  assert.equal(pulled.items[0].sender, 'AlRajhiBank');
  assert.equal(pulled.items[0].receivedAt, '2026-10-31T13:23:30.000Z');
  assert.ok(pulled.items[0].at);

  // Pulling does not delete: the item stays until the app confirms it saved it.
  assert.equal((await (await call(env, 'GET', '/p', { key: PULL })).json()).items.length, 1);

  const acked = await call(env, 'POST', '/a', { key: PULL, body: { ids: [id] } });
  assert.equal((await acked.json()).deleted, 1);
  assert.equal((await (await call(env, 'GET', '/p', { key: PULL })).json()).items.length, 0);
});

test('items expire on their own after 14 days', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/i', { key: INGEST, body: sms('x') });
  assert.equal(env.INBOX.puts[0].options.expirationTtl, 14 * 24 * 3600);
});

test('items come back oldest first', async () => {
  const env = makeEnv();
  const realNow = Date.now;
  try {
    for (const [t, text] of [[1_800_000_000_300, 'ثالث'], [1_800_000_000_100, 'أول'], [1_800_000_000_200, 'ثان']]) {
      Date.now = () => t;
      await call(env, 'POST', '/i', { key: INGEST, body: sms(text, { receivedAt: undefined }) });
    }
  } finally {
    Date.now = realNow;
  }
  const { items } = await (await call(env, 'GET', '/p', { key: PULL })).json();
  assert.deepEqual(items.map((i) => i.text), ['أول', 'ثان', 'ثالث']);
});

test('the same message posted twice in the same millisecond is stored once', async () => {
  const env = makeEnv();
  const realNow = Date.now;
  try {
    Date.now = () => 1_800_000_000_000;
    await call(env, 'POST', '/i', { key: INGEST, body: sms('نفس الرسالة') });
    await call(env, 'POST', '/i', { key: INGEST, body: sms('نفس الرسالة') });
  } finally {
    Date.now = realNow;
  }
  assert.equal(env.INBOX.map.size, 1);
});

test('wallet events accept a number or a string amount and keep the fields', async () => {
  const env = makeEnv();
  const a = await call(env, 'POST', '/i', {
    key: INGEST,
    body: { source: 'wallet', amount: 34.5, merchant: 'MCDONALDS', card: 'mada 4712', currency: 'SAR', receivedAt: '2026-10-31T02:45:10+03:00' },
  });
  const b = await call(env, 'POST', '/i', { key: INGEST, body: { source: 'wallet', amount: 'SAR 12.00', merchant: 'KFC' } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const { items } = await (await call(env, 'GET', '/p', { key: PULL })).json();
  const byMerchant = Object.fromEntries(items.map((i) => [i.merchant, i]));
  assert.equal(byMerchant.MCDONALDS.amount, 34.5);
  assert.equal(byMerchant.MCDONALDS.card, 'mada 4712');
  assert.equal(byMerchant.KFC.amount, 'SAR 12.00');
  assert.equal(byMerchant.KFC.source, 'wallet');
});

test('a bare text/plain body is accepted as an sms', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/i', { key: INGEST, body: 'شراء انترنت\nبـ9 SAR', type: 'text/plain' });
  assert.equal(res.status, 201);
  const { items } = await (await call(env, 'GET', '/p', { key: PULL })).json();
  assert.equal(items[0].source, 'sms');
  assert.equal(items[0].text, 'شراء انترنت\nبـ9 SAR');
});

test('bad requests are refused with a reason and store nothing', async () => {
  const env = makeEnv();
  const cases = [
    [{ body: '{not json' }, 400, 'invalid_json'],
    [{ body: '[1,2]' }, 400, 'invalid_json'],
    [{ body: { source: 'sms' } }, 400, 'text_required'],
    [{ body: { source: 'sms', text: '   ' } }, 400, 'text_required'],
    [{ body: { source: 'email', text: 'x' } }, 400, 'unknown_source'],
    [{ body: { source: 'wallet', merchant: 'X' } }, 400, 'amount_required'],
    [{ body: { source: 'sms', text: 'x'.repeat(2001) } }, 413, 'text_too_long'],
    [{ body: 'x'.repeat(5000), type: 'text/plain' }, 413, 'too_large'],
    [{ body: '{not json', type: 'application/json' }, 400, 'invalid_json'],
  ];
  for (const [opts, status, error] of cases) {
    const res = await call(env, 'POST', '/i', { key: INGEST, ...opts });
    assert.equal(res.status, status, error);
    assert.equal((await res.json()).error, error);
  }
  assert.equal(env.INBOX.map.size, 0);
});

test('an invalid receivedAt is dropped rather than stored', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/i', { key: INGEST, body: sms('x', { receivedAt: 'yesterday-ish' }) });
  const { items } = await (await call(env, 'GET', '/p', { key: PULL })).json();
  assert.equal('receivedAt' in items[0], false);
});

test('pulling is capped at 100 and says when there is more', async () => {
  const env = makeEnv();
  for (let i = 0; i < 105; i++) {
    env.INBOX.map.set(`m:${String(1_800_000_000_000 + i).padStart(13, '0')}:${String(i).padStart(12, '0')}`, JSON.stringify({ source: 'sms', text: `t${i}` }));
  }
  const first = await (await call(env, 'GET', '/p', { key: PULL })).json();
  assert.equal(first.items.length, 100);
  assert.equal(first.more, true);
  await call(env, 'POST', '/a', { key: PULL, body: { ids: first.items.map((i) => i.id) } });
  const second = await (await call(env, 'GET', '/p', { key: PULL })).json();
  assert.equal(second.items.length, 5);
  assert.equal(second.more, false);
});

test('delete only accepts inbox item ids', async () => {
  const env = makeEnv();
  env.INBOX.map.set('secret-config', 'keep');
  for (const ids of [['secret-config'], ['m:1:2'], 'nope', [123], Array(101).fill('m:1800000000000:abcdef012345')]) {
    const res = await call(env, 'POST', '/a', { key: PULL, body: { ids } });
    assert.equal(res.status, 400);
  }
  assert.equal(env.INBOX.map.get('secret-config'), 'keep');
});

test('deleting an id that is already gone is fine (retries after a lost response)', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/a', { key: PULL, body: { ids: ['m:1800000000000:abcdef012345'] } });
  assert.equal(res.status, 200);
});

test('CORS: preflight answers, ALLOW_ORIGIN is honoured, default is open', async () => {
  const open = await call(makeEnv(), 'OPTIONS', '/p');
  assert.equal(open.status, 204);
  assert.equal(open.headers.get('access-control-allow-origin'), '*');
  assert.match(open.headers.get('access-control-allow-headers'), /authorization/);

  const locked = await call(makeEnv({ ALLOW_ORIGIN: 'https://abdullah1805435.github.io' }), 'GET', '/p', { key: PULL });
  assert.equal(locked.headers.get('access-control-allow-origin'), 'https://abdullah1805435.github.io');
  assert.equal(locked.headers.get('cache-control'), 'no-store');
});

test('unknown paths and wrong methods are 404', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'GET', '/nope')).status, 404);
  assert.equal((await call(env, 'GET', '/i', { key: INGEST })).status, 404);
  assert.equal((await call(env, 'POST', '/p', { key: PULL, body: {} })).status, 404);
});

test('a storage failure returns a clean 500 instead of leaking details', async () => {
  const env = makeEnv();
  env.INBOX.put = async () => {
    throw new Error('KV put() limit exceeded for the day. secret-detail');
  };
  const res = await call(env, 'POST', '/i', { key: INGEST, body: sms('x') });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(JSON.parse(text).error, 'server_error');
  assert.ok(!text.includes('secret-detail'));
});
