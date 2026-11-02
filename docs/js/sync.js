import { processItem } from './ingest.js';

// Pulls new items from the inbox, saves each one on the phone, and only then tells the inbox to delete it.
// If anything fails half-way, the item stays in the inbox and is picked up again next time; items already
// saved are recognised by id (repo.hasRaw), so nothing is ever counted twice.
//
// `repo` is whatever stores data (IndexedDB in the app, a fake in tests):
//   hasRaw(id) -> bool            candidates(eventMs) -> [tx]      recentRaws(eventMs) -> [raw]
//   rules() -> {merchantKey: category}        ownWallets() -> [name]
//   commit({raw, created, updated})           sweep(nowIso)

const MAX_ROUNDS = 10; // 10 x 100 items per sync is far more than a phone accumulates

export class SyncError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'unauthorized' | 'network' | 'server' | 'not_configured'
  }
}

async function call(conn, path, init, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${conn.url.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${conn.pullKey}`, 'content-type': 'application/json' },
    });
  } catch (err) {
    throw new SyncError('network', 'تعذّر الاتصال بالصندوق');
  }
  if (res.status === 401) throw new SyncError('unauthorized', 'مفتاح السحب غير صحيح');
  if (res.status === 500) {
    let body = null;
    try {
      body = await res.json();
    } catch {}
    if (body?.error === 'not_configured') throw new SyncError('not_configured', 'مفاتيح الصندوق غير مضبوطة في Cloudflare');
  }
  if (!res.ok) throw new SyncError('server', `خطأ من الصندوق (${res.status})`);
  return res.json();
}

export const testConnection = (conn, fetchImpl = globalThis.fetch.bind(globalThis)) => call(conn, '/p', { method: 'GET' }, fetchImpl).then((r) => r.items.length);

export async function syncNow({
  conn,
  repo,
  fetchImpl = globalThis.fetch.bind(globalThis),
  now = () => new Date().toISOString(),
  newId,
  process = processItem,
}) {
  const result = { pulled: 0, added: 0, merged: 0, duplicates: 0, ignored: 0, unreadable: 0, error: null };
  try {
    if (!conn?.url || !conn?.pullKey) throw new SyncError('not_configured', 'لم يتم ربط الصندوق بعد');
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const page = await call(conn, '/p', { method: 'GET' }, fetchImpl);
      if (!page.items.length) break;
      const toAck = [];

      for (const item of [...page.items].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        result.pulled += 1;
        if (await repo.hasRaw(item.id)) {
          toAck.push(item.id); // saved earlier, the delete just never got through
          continue;
        }
        const stamp = now();
        const eventMs = Date.parse(item.receivedAt || item.at) || Date.parse(stamp);
        let outcome;
        try {
          outcome = process(item, {
            txs: await repo.candidates(eventMs),
            recentRaws: await repo.recentRaws(eventMs),
            rules: repo.rules(),
            ownWallets: repo.ownWallets(),
            now: stamp,
            newId,
          });
        } catch (err) {
          // One odd item must not block the rest: keep its text for the review screen and move on.
          outcome = {
            raw: { id: item.id, source: item.source, key: `error|${item.id}`, eventTime: new Date(eventMs).toISOString(), item, processedAt: stamp, status: 'unreadable', reason: 'processing_error', txId: null },
            created: null,
            updated: null,
          };
        }
        await repo.commit(outcome); // saved on the phone BEFORE it is deleted from the inbox
        toAck.push(item.id);

        const { status } = outcome.raw;
        if (status === 'duplicate') result.duplicates += 1;
        else if (status === 'ignored') result.ignored += 1;
        else if (status === 'unreadable') result.unreadable += 1;
        else if (outcome.created) result.added += 1;
        else result.merged += 1;
      }

      if (toAck.length) await call(conn, '/a', { method: 'POST', body: JSON.stringify({ ids: toAck }) }, fetchImpl);
      if (!page.more) break;
    }
  } catch (err) {
    result.error = err instanceof SyncError ? { kind: err.kind, message: err.message } : { kind: 'unknown', message: String(err?.message ?? err) };
  }
  await repo.sweep(now());
  return result;
}
