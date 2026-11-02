import { merchantKey } from './merchants.js';
import { parseAmountText } from './wallet.js';

// What a tap on a transaction does. Pure: each function returns a new transaction (or a list of them);
// the app saves them and keeps the previous version so the change can be undone.

const edited = (tx, now, patch) => ({ ...tx, ...patch, userEdited: true, updatedAt: now });

export const setCategory = (tx, category, now) => edited(tx, now, { category: category || null });
export const confirmTx = (tx, now) => edited(tx, now, { status: 'confirmed', reasons: [] });
export const ignoreTx = (tx, now) => edited(tx, now, { status: 'ignored' });
export const setCounts = (tx, counts, now) => edited(tx, now, { countsAsSpending: !!counts });

export function editDetails(tx, { merchant, amountMinor, currency }, now) {
  const patch = {};
  if (merchant !== undefined) {
    const name = String(merchant).trim() || null;
    patch.merchant = name;
    patch.merchantKey = merchantKey(name);
  }
  if (amountMinor !== undefined) patch.amountMinor = amountMinor;
  if (currency) patch.currency = currency;
  return edited(tx, now, patch);
}

// A payment the user types in themselves (cash, or something no message was sent for).
export function manualTx({ amountMinor, merchant, category, occurredAt, counts = true }, { now, id }) {
  const name = String(merchant ?? '').trim() || null;
  return {
    id: id ?? globalThis.crypto.randomUUID(),
    status: 'confirmed',
    reasons: [],
    amountMinor,
    currency: 'SAR',
    merchant: name,
    merchantKey: merchantKey(name),
    category: category || null,
    kind: 'manual',
    countsAsSpending: !!counts,
    issuer: null,
    channel: null,
    card: { scheme: null, last4: null, applePay: false },
    balanceAfter: null,
    occurredAt,
    sources: [{ type: 'manual', rawId: null, at: occurredAt }],
    userEdited: true,
    createdAt: now,
    updatedAt: now,
  };
}

// After the user picks a category for a merchant, the same merchant elsewhere follows,
// except where they already chose a category by hand.
export function categoryRuleChanges(txs, key, category, now, exceptId) {
  if (!key) return [];
  return txs
    .filter((t) => t.id !== exceptId && t.merchantKey === key && t.status !== 'ignored' && t.category !== category && !(t.userEdited && t.category))
    .map((t) => ({ ...t, category, updatedAt: now }));
}

// What the user typed in an amount box: "34.5", "٣٤٫٥", "1,234.50". Returns whole halalas, or null.
export function parseUserAmount(text) {
  const parsed = parseAmountText(String(text ?? ''));
  return parsed && !parsed.negative && parsed.minor > 0 ? parsed.minor : null;
}
