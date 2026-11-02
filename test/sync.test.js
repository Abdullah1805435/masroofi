import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';
import { syncNow, testConnection } from '../docs/js/sync.js';
import { sweepPending, LATE_SMS_WINDOW_MS } from '../docs/js/merge.js';
import { countsInTotals } from '../docs/js/periods.js';
import { MockKV } from './mock-kv.js';
import { BARQ, RAJHI, AHLI } from './fixtures.js';

const INGEST = 'ingest-key-0123456789-abcdefghij';
const PULL = 'pull-key-0123456789-abcdefghijklmn';
const URL_BASE = 'https://inbox.example.workers.dev';
const conn = { url: URL_BASE, pullKey: PULL };

const makeEnv = () => ({ INBOX: new MockKV(), INGEST_KEY: INGEST, PULL_KEY: PULL });

// What the phone's Shortcut does: POST the event to the inbox.
const post = (env, body) =>
  worker.fetch(new Request(`${URL_BASE}/i`, { method: 'POST', headers: { authorization: `Bearer ${INGEST}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);

// The app's fetch, wired straight to the real worker code.
const fetchTo = (env, hook) => async (url, init) => {
  hook?.(url, init);
  return worker.fetch(new Request(url, init), env);
};

function fakeRepo({ failCommitOn } = {}) {
  const state = { txs: new Map(), raws: new Map(), rules: {}, ownWallets: ['barq', 'برق'], commits: 0 };
  return {
    state,
    hasRaw: async (id) => state.raws.has(id),
    candidates: (eventMs) => [...state.txs.values()].filter((t) => t.sources.some((s) => Math.abs(Date.parse(s.at) - eventMs) <= LATE_SMS_WINDOW_MS)),
    recentRaws: (eventMs) => [...state.raws.values()].filter((r) => Math.abs(Date.parse(r.eventTime) - eventMs) <= 15 * 60 * 1000),
    rules: () => state.rules,
    ownWallets: () => state.ownWallets,
    commit: async ({ raw, created, updated }) => {
      state.commits += 1;
      if (state.commits === failCommitOn) throw new Error('disk full');
      state.raws.set(raw.id, raw);
      for (const t of [created, updated]) if (t) state.txs.set(t.id, t);
    },
    sweep: async (nowIso) => sweepPending([...state.txs.values()], nowIso).forEach((t) => state.txs.set(t.id, t)),
    list: () => [...state.txs.values()],
  };
}

const sms = (text, receivedAt) => ({ source: 'sms', text, receivedAt });
let ids = 0;
const sync = (env, repo, opts = {}) => syncNow({ conn, repo, fetchImpl: fetchTo(env), now: () => '2026-10-31T17:00:00+03:00', newId: () => `tx${++ids}`, ...opts });

test('end to end: Shortcut posts, app pulls, everything is saved on the phone, then the inbox is emptied', async () => {
  const env = makeEnv();
  const repo = fakeRepo();
  await post(env, { source: 'wallet', merchant: 'MCDONALDS KING FAHD RD', amount: 'SAR 34.50', card: 'مدى ••9683', receivedAt: '2026-10-31T02:45:08+03:00' });
  await post(env, sms(RAJHI, '2026-10-31T02:45:20+03:00'));
  await post(env, sms(BARQ, '2026-10-31T16:23:30+03:00'));
  await post(env, sms(AHLI, '2026-10-05T16:08:00+03:00'));
  assert.equal(env.INBOX.map.size, 4);

  const res = await sync(env, repo);
  assert.equal(res.error, null);
  assert.equal(res.pulled, 4);
  assert.equal(res.added, 3);
  assert.equal(res.merged, 1);
  assert.equal(env.INBOX.map.size, 0, 'inbox is emptied only after saving');

  const by = Object.fromEntries(repo.list().map((t) => [t.merchant, t]));
  assert.equal(repo.list().length, 3);
  assert.equal(by.MCDONALDS.sources.length, 2);
  assert.equal(by.MCDONALDS.status, 'confirmed');
  assert.equal(by.HUNGERSTATION.amountMinor, 6382);
  assert.equal(by.barq.kind, 'wallet_topup');
  assert.equal(repo.list().filter(countsInTotals).length, 2);
});

test('a lost delete is harmless: the next sync recognises what was saved and does not count it twice', async () => {
  const env = makeEnv();
  const repo = fakeRepo();
  await post(env, sms(BARQ, '2026-10-31T16:23:30+03:00'));
  await post(env, sms(RAJHI, '2026-10-31T02:45:20+03:00'));

  const dropAck = (url) => {
    if (url.endsWith('/a')) throw new TypeError('network lost');
  };
  const first = await sync(env, repo, { fetchImpl: fetchTo(env, dropAck) });
  assert.equal(first.error.kind, 'network');
  assert.equal(repo.list().length, 2);
  assert.equal(env.INBOX.map.size, 2, 'still in the inbox because the delete never arrived');

  const second = await sync(env, repo);
  assert.equal(second.error, null);
  assert.equal(second.added, 0);
  assert.equal(repo.list().length, 2);
  assert.equal(env.INBOX.map.size, 0);
});

test('a failed save leaves the item in the inbox and nothing is lost', async () => {
  const env = makeEnv();
  const repo = fakeRepo({ failCommitOn: 2 });
  await post(env, sms(BARQ, '2026-10-31T16:23:30+03:00'));
  await post(env, sms(RAJHI, '2026-10-31T02:45:20+03:00'));

  const first = await sync(env, repo);
  assert.equal(first.error.kind, 'unknown');
  assert.equal(repo.list().length, 1);
  assert.equal(env.INBOX.map.size, 2, 'nothing deleted when the round did not finish');

  const second = await sync(env, repo);
  assert.equal(second.error, null);
  assert.equal(repo.list().length, 2);
  assert.equal(env.INBOX.map.size, 0);
});

test('a wrong key, no connection and a misconfigured inbox each give a clear error and change nothing', async () => {
  const env = makeEnv();
  const repo = fakeRepo();
  await post(env, sms(BARQ, '2026-10-31T16:23:30+03:00'));

  const wrong = await sync(env, repo, { conn: { url: URL_BASE, pullKey: 'wrong-wrong-wrong-wrong' } });
  assert.equal(wrong.error.kind, 'unauthorized');

  const offline = await sync(env, repo, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(offline.error.kind, 'network');

  const unset = await sync({ ...env, PULL_KEY: undefined }, repo);
  assert.equal(unset.error.kind, 'not_configured');

  const none = await sync(env, repo, { conn: null });
  assert.equal(none.error.kind, 'not_configured');

  assert.equal(repo.list().length, 0);
  assert.equal(env.INBOX.map.size, 1);
});

test('more than 100 waiting items are pulled over several rounds', async () => {
  const env = makeEnv();
  const repo = fakeRepo();
  for (let i = 0; i < 120; i++) {
    const text = `شراء PoS\nعبر:9683;مدى-ابل باي\nبـSAR ${i + 1}.00\nلـSHOP ${i}\n31/10/26 10:00`;
    env.INBOX.map.set(`m:${String(1_800_000_000_000 + i).padStart(13, '0')}:${String(i).padStart(12, '0')}`, JSON.stringify({ source: 'sms', text, at: `2026-10-31T10:${String(i % 60).padStart(2, '0')}:00.000Z` }));
  }
  const res = await sync(env, repo);
  assert.equal(res.error, null);
  assert.equal(res.pulled, 120);
  assert.equal(repo.list().length, 120);
  assert.equal(env.INBOX.map.size, 0);
});

test('one item that breaks the parser is kept for review and does not block the others', async () => {
  const env = makeEnv();
  const repo = fakeRepo();
  await post(env, sms(BARQ, '2026-10-31T16:23:30+03:00'));
  await post(env, sms('رسالة غريبة', '2026-10-31T16:30:00+03:00'));
  await post(env, sms(RAJHI, '2026-10-31T02:45:20+03:00'));

  const { processItem } = await import('../docs/js/ingest.js');
  const res = await sync(env, repo, {
    process: (item, ctx) => {
      if (item.text === 'رسالة غريبة') throw new Error('boom');
      return processItem(item, ctx);
    },
  });
  assert.equal(res.error, null);
  assert.equal(res.unreadable, 1);
  assert.equal(repo.list().length, 2);
  const stuck = [...repo.state.raws.values()].find((r) => r.reason === 'processing_error');
  assert.equal(stuck.status, 'unreadable');
  assert.equal(stuck.item.text, 'رسالة غريبة');
  assert.equal(env.INBOX.map.size, 0);
});

test('a wallet-only payment becomes a review item once the sync notices 30 minutes have passed', async () => {
  const env = makeEnv();
  const repo = fakeRepo();
  await post(env, { source: 'wallet', merchant: 'KFC', amount: 25, receivedAt: '2026-10-31T16:00:00+03:00' });
  const res = await sync(env, repo, { now: () => '2026-10-31T16:40:00+03:00' });
  assert.equal(res.error, null);
  assert.equal(repo.list()[0].status, 'review');
  assert.deepEqual(repo.list()[0].reasons, ['wallet_only']);
});

test('testConnection reports how many items are waiting, and rejects a bad key', async () => {
  const env = makeEnv();
  await post(env, sms(BARQ, '2026-10-31T16:23:30+03:00'));
  assert.equal(await testConnection(conn, fetchTo(env)), 1);
  await assert.rejects(() => testConnection({ url: URL_BASE, pullKey: 'wrong-wrong-wrong-wrong' }, fetchTo(env)), (e) => e.kind === 'unauthorized');
});
