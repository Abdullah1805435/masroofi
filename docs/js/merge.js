import { merchantKey, categorize } from './merchants.js';
import { REVIEW_FLAGS } from './parser.js';

// Pure functions: take transactions in, return new objects out. The caller (ingest.js / store.js)
// decides what to persist. A Transaction looks like:
//   { id, status: 'confirmed'|'pending'|'review'|'ignored', reasons: [], amountMinor, currency,
//     merchant, merchantKey, category, kind: 'purchase'|'wallet_topup'|'manual', countsAsSpending,
//     issuer, channel, card: {scheme,last4,applePay}, balanceAfter, occurredAt,
//     sources: [{type:'sms'|'wallet', rawId, at}], userEdited, createdAt, updatedAt }

export const MATCH_WINDOW_MS = 10 * 60 * 1000; // an SMS and a Wallet event this close are the same payment
export const WALLET_ONLY_AFTER_MS = 30 * 60 * 1000; // a Wallet event with no SMS after this goes to review
export const LATE_SMS_WINDOW_MS = 3 * 3600 * 1000; // a late SMS can still claim a wallet-only review item

const ms = (iso) => new Date(iso).getTime();
const defaultId = () => globalThis.crypto.randomUUID();
const hasSource = (tx, type) => tx.sources.some((s) => s.type === type);
const reasonsFrom = (flags) => flags.filter((f) => REVIEW_FLAGS.has(f));

export function txFromSms(parsed, { rawId, eventTime, now, id = defaultId() }) {
  const reasons = reasonsFrom(parsed.flags);
  return {
    id,
    status: reasons.length ? 'review' : 'confirmed',
    reasons,
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    merchant: parsed.merchant,
    merchantKey: merchantKey(parsed.merchant),
    category: parsed.category,
    kind: parsed.kind,
    countsAsSpending: parsed.countsAsSpending,
    issuer: parsed.issuer,
    channel: parsed.channel,
    card: { ...parsed.card },
    balanceAfter: parsed.balanceAfter,
    occurredAt: parsed.occurredAt ?? eventTime,
    sources: [{ type: 'sms', rawId, at: eventTime }],
    userEdited: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function txFromWallet(parsed, { rawId, eventTime, now, id = defaultId() }) {
  return {
    id,
    status: 'pending',
    reasons: [],
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    merchant: parsed.merchant,
    merchantKey: merchantKey(parsed.merchant),
    category: parsed.merchant ? categorize(parsed.merchant) : null,
    kind: 'purchase',
    countsAsSpending: true,
    issuer: null,
    channel: null,
    card: { ...parsed.card },
    balanceAfter: null,
    occurredAt: eventTime,
    sources: [{ type: 'wallet', rawId, at: eventTime }],
    userEdited: false,
    createdAt: now,
    updatedAt: now,
  };
}

// Finds the transaction that already holds one half of this payment (`needs`) but not the other (`lacks`),
// so each SMS pairs with at most one Wallet event and the other way round.
function nearestMatch(txs, { amountMinor, currency, eventTime, needs, lacks }) {
  const t = ms(eventTime);
  let best = null;
  let bestGap = Infinity;
  for (const tx of txs) {
    if (tx.status === 'ignored') continue;
    if (tx.amountMinor !== amountMinor || tx.currency !== currency) continue;
    if (!hasSource(tx, needs) || hasSource(tx, lacks)) continue;
    const walletOnlyReview = tx.status === 'review' && tx.reasons.includes('wallet_only');
    const window = walletOnlyReview ? LATE_SMS_WINDOW_MS : MATCH_WINDOW_MS;
    for (const s of tx.sources) {
      const gap = Math.abs(ms(s.at) - t);
      if (gap <= window && gap < bestGap) {
        best = tx;
        bestGap = gap;
      }
    }
  }
  return best;
}

export function mergeSms(txs, parsed, ctx) {
  const match = nearestMatch(txs, {
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    eventTime: ctx.eventTime,
    needs: 'wallet',
    lacks: 'sms',
  });
  if (!match) return { created: txFromSms(parsed, ctx), updated: null };

  const reasons = reasonsFrom(parsed.flags);
  const next = {
    ...match,
    sources: [...match.sources, { type: 'sms', rawId: ctx.rawId, at: ctx.eventTime }],
    card: {
      scheme: parsed.card.scheme ?? match.card.scheme,
      last4: parsed.card.last4 ?? match.card.last4,
      applePay: true,
    },
    issuer: parsed.issuer,
    channel: parsed.channel,
    balanceAfter: parsed.balanceAfter,
    updatedAt: ctx.now,
  };
  if (match.userEdited) {
    // The user already decided the details; the SMS only confirms that the payment went through.
    next.status = 'confirmed';
    next.reasons = [];
  } else {
    next.merchant = parsed.merchant ?? match.merchant;
    next.merchantKey = merchantKey(next.merchant);
    next.category = parsed.category ?? match.category;
    next.kind = parsed.kind;
    next.countsAsSpending = parsed.countsAsSpending;
    next.occurredAt = parsed.occurredAt ?? match.occurredAt;
    next.status = reasons.length ? 'review' : 'confirmed';
    next.reasons = reasons;
  }
  return { created: null, updated: next };
}

export function mergeWallet(txs, parsed, ctx) {
  const match = nearestMatch(txs, {
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    eventTime: ctx.eventTime,
    needs: 'sms',
    lacks: 'wallet',
  });
  if (!match) return { created: txFromWallet(parsed, ctx), updated: null };
  return {
    created: null,
    updated: {
      ...match,
      sources: [...match.sources, { type: 'wallet', rawId: ctx.rawId, at: ctx.eventTime }],
      card: {
        scheme: match.card.scheme ?? parsed.card.scheme,
        last4: match.card.last4 ?? parsed.card.last4,
        applePay: true,
      },
      updatedAt: ctx.now,
    },
  };
}

// Wallet events whose SMS never came. They also fire for declined payments, so they wait for the user.
export function sweepPending(txs, now) {
  const changed = [];
  for (const tx of txs) {
    if (tx.status !== 'pending') continue;
    const first = Math.min(...tx.sources.map((s) => ms(s.at)));
    if (ms(now) - first >= WALLET_ONLY_AFTER_MS) {
      changed.push({ ...tx, status: 'review', reasons: ['wallet_only'], updatedAt: now });
    }
  }
  return changed;
}

// A rule the user saved beats the built-in list, unless they set this transaction's category by hand.
export function withRule(tx, rules) {
  const rule = rules && tx.merchantKey ? rules[tx.merchantKey] : null;
  return rule && !tx.userEdited && tx.category !== rule ? { ...tx, category: rule } : tx;
}

export const needsCategory = (tx) => tx.status === 'confirmed' && tx.countsAsSpending && !tx.category;
