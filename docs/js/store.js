// IndexedDB layer. Everything the app knows lives here, on the phone.
// Stores: tx (transactions), raw (every item received, with its original text), rules (merchant -> category),
//         kv (settings, connection details, last sync).

import { LATE_SMS_WINDOW_MS, sweepPending } from './merge.js';
import { DEFAULT_OWN_WALLETS } from './merchants.js';

const DB_NAME = 'masroofi';
const DB_VERSION = 1;
const RAW_KEEP_DAYS = 120;
const TX_STATUSES = new Set(['confirmed', 'pending', 'review', 'ignored']);

let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('tx', { keyPath: 'id' });
        db.createObjectStore('raw', { keyPath: 'id' }).createIndex('eventMs', 'eventMs');
        db.createObjectStore('rules', { keyPath: 'key' });
        db.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('database blocked'));
    });
  }
  return dbPromise;
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// Runs `work` against the named stores in one transaction; resolves after the transaction has committed.
async function transact(names, mode, work) {
  const db = await openDb();
  const t = db.transaction(names, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
  const stores = names.map((n) => t.objectStore(n));
  const out = work(...stores); // only issue IDB requests here, no other awaits
  await done;
  return out;
}

export const getAll = (name) => transact([name], 'readonly', (s) => wrap(s.getAll()));

export async function getKv(k, fallback = null) {
  const row = await transact(['kv'], 'readonly', (s) => wrap(s.get(k)));
  return row ? row.v : fallback;
}

export const setKv = (k, v) => transact(['kv'], 'readwrite', (s) => void s.put({ k, v }));

export const putTx = (tx) => transact(['tx'], 'readwrite', (s) => void s.put(tx));
export const putTxs = (list) => transact(['tx'], 'readwrite', (s) => void list.forEach((tx) => s.put(tx)));
export const deleteTx = (id) => transact(['tx'], 'readwrite', (s) => void s.delete(id));

export const getRaw = (id) => transact(['raw'], 'readonly', (s) => wrap(s.get(id)));
export const putRaw = (raw) => transact(['raw'], 'readwrite', (s) => void s.put({ ...raw, eventMs: raw.eventMs ?? Date.parse(raw.eventTime) }));

export function rawsBetween(fromMs, toMs) {
  return transact(['raw'], 'readonly', (s) => wrap(s.index('eventMs').getAll(IDBKeyRange.bound(fromMs, toMs))));
}

// Saving an item = its raw record plus any transaction it created or changed, all or nothing.
export function commitItem({ raw, created, updated }) {
  return transact(['raw', 'tx'], 'readwrite', (rawStore, txStore) => {
    rawStore.put({ ...raw, eventMs: Date.parse(raw.eventTime) });
    if (created) txStore.put(created);
    if (updated) txStore.put(updated);
  });
}

export const putRule = (key, category) => transact(['rules'], 'readwrite', (s) => void s.put({ key, category }));
export const deleteRule = (key) => transact(['rules'], 'readwrite', (s) => void s.delete(key));

export const DEFAULT_SETTINGS = {
  periodStartDay: 1,
  budgets: { overallMinor: null, byCategory: {} },
  ownWallets: [...DEFAULT_OWN_WALLETS],
};

// Old raw records are dropped after a while; unread messages waiting in the review screen are kept.
export async function pruneRaw(nowMs = Date.now()) {
  const cutoff = nowMs - RAW_KEEP_DAYS * 24 * 3600 * 1000;
  const old = await transact(['raw'], 'readonly', (s) => wrap(s.index('eventMs').getAll(IDBKeyRange.upperBound(cutoff))));
  const drop = old.filter((r) => r.status !== 'unreadable');
  if (drop.length) await transact(['raw'], 'readwrite', (s) => void drop.forEach((r) => s.delete(r.id)));
  return drop.length;
}

/* ---------- In-memory copy used by the screens ---------- */

export async function loadState() {
  const [txList, ruleRows, settings, connection, lastSync] = await Promise.all([
    getAll('tx'),
    getAll('rules'),
    getKv('settings', null),
    getKv('connection', null),
    getKv('lastSync', null),
  ]);
  const raws = await getAll('raw');
  return {
    txs: new Map(txList.map((t) => [t.id, t])),
    rules: Object.fromEntries(ruleRows.map((r) => [r.key, r.category])),
    settings: { ...DEFAULT_SETTINGS, ...(settings || {}), budgets: { ...DEFAULT_SETTINGS.budgets, ...(settings?.budgets || {}) } },
    connection,
    lastSync,
    unreadable: raws.filter((r) => r.status === 'unreadable'),
  };
}

// The repo that sync.js talks to: reads from memory, writes to IndexedDB first, then to memory.
export function createRepo(state) {
  return {
    hasRaw: async (id) => !!(await getRaw(id)),
    candidates: (eventMs) =>
      [...state.txs.values()].filter((t) => t.sources.some((s) => Math.abs(Date.parse(s.at) - eventMs) <= LATE_SMS_WINDOW_MS)),
    recentRaws: (eventMs) => rawsBetween(eventMs - 15 * 60 * 1000, eventMs + 15 * 60 * 1000),
    rules: () => state.rules,
    ownWallets: () => state.settings.ownWallets,
    commit: async (outcome) => {
      await commitItem(outcome);
      for (const t of [outcome.created, outcome.updated]) if (t) state.txs.set(t.id, t);
      if (outcome.raw.status === 'unreadable') state.unreadable.push(outcome.raw);
    },
    sweep: async (nowIso) => {
      const changed = sweepPending([...state.txs.values()], nowIso);
      if (!changed.length) return 0;
      await putTxs(changed);
      changed.forEach((t) => state.txs.set(t.id, t));
      return changed.length;
    },
  };
}

/* ---------- Backup ---------- */

export async function exportAll() {
  const [txs, raws, rules, settings] = await Promise.all([getAll('tx'), getAll('raw'), getAll('rules'), getKv('settings', null)]);
  // The connection details (the pull key) are deliberately left out of backups.
  return { app: 'masroofi', version: 1, exportedAt: new Date().toISOString(), txs, raws, rules, settings };
}

export async function importAll(data) {
  if (!data || data.app !== 'masroofi' || !Array.isArray(data.txs)) throw new Error('ملف النسخة الاحتياطية غير صالح');
  const txs = data.txs.filter((t) => t && typeof t.id === 'string' && Number.isInteger(t.amountMinor) && TX_STATUSES.has(t.status) && Array.isArray(t.sources));
  const raws = (data.raws || []).filter((r) => r && typeof r.id === 'string' && r.eventTime);
  const rules = (data.rules || []).filter((r) => r && typeof r.key === 'string' && typeof r.category === 'string');
  await transact(['tx', 'raw', 'rules', 'kv'], 'readwrite', (txS, rawS, ruleS, kvS) => {
    txS.clear();
    rawS.clear();
    ruleS.clear();
    txs.forEach((t) => txS.put(t));
    raws.forEach((r) => rawS.put({ ...r, eventMs: Date.parse(r.eventTime) }));
    rules.forEach((r) => ruleS.put(r));
    if (data.settings) kvS.put({ k: 'settings', v: data.settings });
  });
  return { txs: txs.length, skipped: data.txs.length - txs.length, rules: rules.length };
}

export async function wipeAll({ keepConnection = true } = {}) {
  await transact(['tx', 'raw', 'rules', 'kv'], 'readwrite', (txS, rawS, ruleS, kvS) => {
    txS.clear();
    rawS.clear();
    ruleS.clear();
    if (keepConnection) {
      kvS.delete('settings');
      kvS.delete('lastSync');
    } else kvS.clear();
  });
}
