import { normalizeSms } from './normalize.js';
import { parseSms } from './parser.js';
import { parseWallet } from './wallet.js';
import { mergeSms, mergeWallet, withRule } from './merge.js';
import { DEFAULT_OWN_WALLETS } from './merchants.js';

// Turns one item pulled from the inbox into changes to the transaction list. Pure: the caller loads
// the candidate transactions and recent raw records, and saves whatever comes back.

const OTP_RE = /رمز|كلمة\s*(?:المرور|السر)|\bOTP\b|one[\s-]?time|verification|التحقق/i;
export const SMS_DUPLICATE_WINDOW_MS = 10 * 60 * 1000; // the text carries its own minute, so repeats are real duplicates
export const WALLET_DUPLICATE_WINDOW_MS = 60 * 1000; // two coffees a few minutes apart are two purchases

const ms = (iso) => new Date(iso).getTime();

export const eventTimeOf = (item, now) => {
  const t = item.receivedAt || item.at;
  return Number.isFinite(ms(t)) ? t : now;
};

export function contentKey(item) {
  if (item.source === 'wallet') return `wallet|${item.merchant ?? ''}|${item.amount ?? ''}|${item.card ?? ''}`;
  return `sms|${normalizeSms(item.text ?? '')}`;
}

export function classifyItem(item, { ownWallets = DEFAULT_OWN_WALLETS, eventTime } = {}) {
  if (item.source === 'wallet') {
    const parsed = parseWallet(item);
    return parsed.ok ? { type: 'wallet', parsed } : { type: 'unreadable', reason: parsed.reason };
  }
  const text = item.text ?? '';
  if (!normalizeSms(text)) return { type: 'ignored', reason: 'empty' };
  const parsed = parseSms(text, { sender: item.sender ?? null, receivedAt: eventTime, ownWallets });
  if (parsed.ok) return { type: 'sms', parsed };
  if (OTP_RE.test(text)) return { type: 'ignored', reason: 'otp' };
  return { type: 'unreadable', reason: parsed.reason };
}

// item: one entry from the inbox ({id, source, text|merchant|amount..., receivedAt, at}).
// txs: transactions that could pair with it (recent). recentRaws: raw records from the last few minutes.
// Returns { raw, created, updated } where created/updated are transactions to save (or null).
export function processItem(item, { txs, recentRaws, rules = {}, ownWallets, now, newId }) {
  const eventTime = eventTimeOf(item, now);
  const key = contentKey(item);
  const raw = { id: item.id, source: item.source, key, eventTime, item, processedAt: now, status: null, reason: null, txId: null };

  const window = item.source === 'wallet' ? WALLET_DUPLICATE_WINDOW_MS : SMS_DUPLICATE_WINDOW_MS;
  const dup = recentRaws.find((r) => r.key === key && r.status !== 'duplicate' && Math.abs(ms(r.eventTime) - ms(eventTime)) <= window);
  if (dup) return { raw: { ...raw, status: 'duplicate', txId: dup.txId ?? null }, created: null, updated: null };

  const c = classifyItem(item, { ownWallets, eventTime });
  if (c.type === 'ignored' || c.type === 'unreadable') {
    return { raw: { ...raw, status: c.type, reason: c.reason }, created: null, updated: null };
  }

  const ctx = { rawId: item.id, eventTime, now, id: newId?.() };
  const merged = c.type === 'sms' ? mergeSms(txs, c.parsed, ctx) : mergeWallet(txs, c.parsed, ctx);
  const created = merged.created ? withRule(merged.created, rules) : null;
  const updated = merged.updated ? withRule(merged.updated, rules) : null;
  return { raw: { ...raw, status: 'parsed', txId: (created ?? updated).id }, created, updated };
}
