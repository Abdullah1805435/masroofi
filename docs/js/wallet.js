import { normalizeSms } from './normalize.js';

// Reads the event the Apple Pay (Wallet "Transaction") automation sends. How Shortcuts formats the
// amount and the card name is not documented, so this accepts a number or text such as
// "SAR 34.50", "34.50 ر.س.", "٣٤٫٥٠" or "1,234.56", and finds the last 4 digits anywhere in the card text.

const CURRENCIES = [
  [/\bSAR\b|\bSR\b|ر\.\s?س|ريال|﷼/i, 'SAR'],
  [/\bUSD\b|US\$|\$/i, 'USD'],
  [/\bEUR\b|€/i, 'EUR'],
  [/\bGBP\b|£/i, 'GBP'],
  [/\bAED\b|د\.\s?إ/i, 'AED'],
];

export function detectCurrency(text) {
  if (typeof text !== 'string') return null;
  for (const [re, code] of CURRENCIES) if (re.test(text)) return code;
  const generic = text.toUpperCase().match(/\b([A-Z]{3})\b/);
  return generic ? generic[1] : null;
}

// Returns {minor, negative} or null. Decimal separator is the last "." or ","; others are thousands marks.
export function parseAmountText(raw) {
  const text = normalizeSms(String(raw)).replace(/[‎‏]/g, '');
  const m = text.match(/\d[\d.,]*/);
  if (!m) return null;
  const negative = /-\s*$/.test(text.slice(0, m.index)) || /^\(.*\)$/.test(text.trim());
  let t = m[0].replace(/[.,]+$/, '');
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalAt = Math.max(lastDot, lastComma);
    t = t.slice(0, decimalAt).replace(/[.,]/g, '') + '.' + t.slice(decimalAt + 1);
  } else if (lastComma >= 0) {
    // "12,50" is a decimal comma; "1,234" or "1,234,567" are thousands marks.
    t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if ((t.match(/\./g) || []).length > 1) {
    const at = t.lastIndexOf('.');
    t = t.slice(0, at).replace(/\./g, '') + t.slice(at);
  }
  const [whole, frac = ''] = t.split('.');
  const minor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isFinite(minor) ? { minor, negative } : null;
}

function parseCard(text) {
  const card = { scheme: null, last4: null, applePay: true };
  if (typeof text !== 'string') return card;
  const clean = normalizeSms(text);
  if (/مدى|\bmada\b/i.test(clean)) card.scheme = 'mada';
  else if (/فيزا|visa/i.test(clean)) card.scheme = 'visa';
  else if (/ماستر|master/i.test(clean)) card.scheme = 'mastercard';
  const last4 = clean.match(/(\d{4})(?!.*\d)/);
  if (last4) card.last4 = last4[1];
  return card;
}

export function parseWallet(item) {
  const flags = [];
  let minor = null;
  let currency = null;

  if (typeof item.amount === 'number') {
    if (!Number.isFinite(item.amount)) return { ok: false, reason: 'no_amount' };
    minor = Math.round(Math.abs(item.amount) * 100);
    if (item.amount < 0) return { ok: false, reason: 'non_positive_amount' };
  } else if (typeof item.amount === 'string') {
    const parsed = parseAmountText(item.amount);
    if (!parsed) return { ok: false, reason: 'no_amount' };
    if (parsed.negative) return { ok: false, reason: 'non_positive_amount' };
    minor = parsed.minor;
    currency = detectCurrency(item.amount);
  } else {
    return { ok: false, reason: 'no_amount' };
  }
  if (!(minor > 0)) return { ok: false, reason: 'non_positive_amount' };

  currency = currency ?? detectCurrency(item.currency);
  if (!currency) {
    currency = 'SAR';
    flags.push('currency_assumed');
  }
  if (currency !== 'SAR') flags.push('foreign_currency');

  const merchant = typeof item.merchant === 'string' ? normalizeSms(item.merchant).replace(/\n/g, ' ').trim() : '';
  if (!merchant) flags.push('no_merchant');

  return {
    ok: true,
    amountMinor: minor,
    amount: minor / 100,
    currency,
    merchant: merchant || null,
    card: parseCard(item.card),
    flags,
  };
}
