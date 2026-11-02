import { normalizeSms } from './normalize.js';
import { categorize, isOwnWallet, DEFAULT_OWN_WALLETS } from './merchants.js';

// Parser for the bank/wallet SMS formats seen so far (Barq, Al Rajhi, Al Ahli).
// Anything it can't read comes back with ok:false or needsReview:true so the app can put it in
// front of the user instead of guessing.

const TZ = '+03:00'; // Asia/Riyadh, no daylight saving
const DAY_MS = 24 * 3600 * 1000;

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const CUR = String.raw`(SAR|ريال|[A-Z]{3})`;

const RE = {
  kind: /^شراء(?:\s|$)/,
  // "بـSAR 34.50" (Al Rajhi) or "بـ9 SAR" (Al Ahli)
  amountPrefixed: new RegExp(String.raw`^بـ?\s*(?:${CUR}\s*)?${NUM}(?:\s*${CUR})?$`),
  // "فيزا63.82 SAR" (Barq)
  amountScheme: new RegExp(String.raw`^(مدى|فيزا|ماستر(?:كارد)?)\s*${NUM}\s*${CUR}$`),
  balance: new RegExp(String.raw`^رصيد\s*${NUM}$`),
  merchant: [
    /^لدى\s*(.+)$/, // Barq
    /^ل(?:ـ|(?=[A-Za-z]))\s*(.+)$/, // Al Rajhi
    /^من\s+(?!\d+\*?$)(.+)$/, // Al Ahli (a "من 7001*" line is an account reference, not a merchant)
  ],
  accountRef: /^من\s+(\d+)\*?$/,
  cardVia: /^عبر:?\s*(\d{4})\s*(?:;\s*(.+))?$/, // "عبر:9683;مدى-ابل باي"
  cardMask: /^(مدى|فيزا|ماستر(?:كارد)?)[-\s]*(?:([اأ]بل)(?:\s*باي)?)?\s*\*?\s*(\d{4})?$/, // "مدى-ابل *4712"
  dateIso: /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/,
  dateDayMonth: /(?:^|\s)(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})/,
};

const HEADER_ISSUERS = [
  ['barq', /برق|barq/i],
  ['alrajhi', /راجح|rajhi/i],
  ['ahli', /[اأ]هلي|ahli|snb/i],
];

export const REVIEW_FLAGS = new Set([
  'date_order_assumed_dmy',
  'date_far_from_received',
  'no_date_in_message',
  'foreign_currency',
  'no_merchant',
  'issuer_unrecognized',
]);
// 'wallet_topup_inferred' and 'needs_category' are informational: a top-up of the user's own
// wallet is confirmed behaviour, and an unknown merchant is handled by the categorize step.

const p2 = (n) => String(n).padStart(2, '0');

function parseMoney(text) {
  const [whole, frac = ''] = text.replace(/,/g, '').split('.');
  const minor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return { amount: minor / 100, amountMinor: minor };
}

// Builds an ISO timestamp in Riyadh time, or null if the date doesn't exist (e.g. 31/04).
function makeIso(y, mo, d, hh, mm) {
  const iso = `${y}-${p2(mo)}-${p2(d)}T${p2(hh)}:${p2(mm)}:00${TZ}`;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const local = new Date(t.getTime() + 3 * 3600 * 1000).toISOString();
  return local.startsWith(`${y}-${p2(mo)}-${p2(d)}T${p2(hh)}:${p2(mm)}`) ? iso : null;
}

// "10/05/26" can be 10 May or 5 October. Day-first is what Al Rajhi uses (31/10/26 proves it),
// but Al Ahli's order isn't provable from one ambiguous sample, so when the phone also sends the
// time the message arrived, use the reading closest to it.
function resolveDayMonth(a, b, year, hh, mm, receivedAt) {
  const candidates = [];
  const dmy = makeIso(year, b, a, hh, mm);
  const mdy = makeIso(year, a, b, hh, mm);
  if (dmy) candidates.push(dmy);
  if (mdy && mdy !== dmy) candidates.push(mdy);
  if (!candidates.length) return null;
  if (candidates.length === 1) return { iso: candidates[0], flag: null };

  const received = receivedAt ? new Date(receivedAt).getTime() : NaN;
  if (Number.isFinite(received)) {
    const ranked = candidates
      .map((iso) => ({ iso, gap: Math.abs(new Date(iso).getTime() - received) }))
      .sort((x, y) => x.gap - y.gap);
    return { iso: ranked[0].iso, flag: ranked[0].gap > 3 * DAY_MS ? 'date_far_from_received' : null };
  }
  return { iso: candidates[0], flag: 'date_order_assumed_dmy' };
}

function detectIssuer(text) {
  if (!text) return null;
  const hit = HEADER_ISSUERS.find(([, re]) => re.test(text));
  return hit ? hit[0] : null;
}

function isHeaderLine(line) {
  return !/\d/.test(line) && line.length <= 40 && !RE.kind.test(line) && detectIssuer(line) !== null;
}

function applyMethod(card, text) {
  if (/مدى/.test(text)) card.scheme = 'mada';
  else if (/فيزا|visa/i.test(text)) card.scheme = 'visa';
  else if (/ماستر|master/i.test(text)) card.scheme = 'mastercard';
  if (/[اأ]بل/.test(text)) card.applePay = true;
}

const fail = (reason) => ({ ok: false, reason, needsReview: true });

export function parseSms(
  rawText,
  { sender = null, receivedAt = null, ownWallets = DEFAULT_OWN_WALLETS } = {},
) {
  let lines = normalizeSms(rawText).split('\n').filter(Boolean);

  // The first line may be the bank's name (a header pasted with the body). The Shortcut can also
  // pass the sender separately; either one identifies the issuer.
  let header = sender;
  if (lines.length && isHeaderLine(lines[0])) {
    header = header ?? lines[0];
    lines = lines.slice(1);
  }

  const find = (re) => {
    for (const line of lines) {
      const m = line.match(re);
      if (m) return m;
    }
    return null;
  };

  const kindLine = lines.find((l) => RE.kind.test(l));
  if (!kindLine) return fail('unsupported_kind'); // refunds, transfers, OTPs, withdrawals: not seen yet

  const flags = [];
  const channel = /PoS/i.test(kindLine) ? 'pos' : /[اإ]نترنت|online/i.test(kindLine) ? 'online' : null;

  const card = { scheme: null, last4: null, applePay: false };
  let money;
  let currency;

  let m = find(RE.amountPrefixed);
  if (m) {
    money = parseMoney(m[2]);
    currency = m[1] ?? m[3];
  } else if ((m = find(RE.amountScheme))) {
    applyMethod(card, m[1]);
    money = parseMoney(m[2]);
    currency = m[3];
  } else {
    return fail('no_amount');
  }
  if (currency === 'ريال') currency = 'SAR';
  if (currency !== 'SAR') flags.push('foreign_currency');

  const balanceMatch = find(RE.balance);
  const balanceAfter = balanceMatch ? parseMoney(balanceMatch[1]).amount : null;

  let merchant = null;
  for (const line of lines) {
    for (const re of RE.merchant) {
      const hit = line.match(re);
      if (hit) {
        merchant = hit[1].trim();
        break;
      }
    }
    if (merchant) break;
  }
  if (!merchant) flags.push('no_merchant');

  const via = find(RE.cardVia);
  if (via) {
    card.last4 = via[1];
    applyMethod(card, via[2] ?? '');
  }
  const mask = find(RE.cardMask);
  if (mask) {
    applyMethod(card, mask[1]);
    if (mask[2]) card.applePay = true;
    if (mask[3]) card.last4 = mask[3];
  }

  const accountMatch = find(RE.accountRef);
  const accountRef = accountMatch ? accountMatch[1] : null;

  let occurredAt = null;
  const iso = find(RE.dateIso);
  if (iso) {
    occurredAt = makeIso(+iso[1], +iso[2], +iso[3], +iso[4], +iso[5]);
  } else {
    const dm = find(RE.dateDayMonth);
    if (dm) {
      const year = dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3]);
      const resolved = resolveDayMonth(Number(dm[1]), Number(dm[2]), year, Number(dm[4]), Number(dm[5]), receivedAt);
      if (resolved) {
        occurredAt = resolved.iso;
        if (resolved.flag) flags.push(resolved.flag);
      }
    }
  }
  if (!occurredAt) flags.push('no_date_in_message');

  let issuer = detectIssuer(header);
  if (!issuer) {
    if (iso && balanceMatch) issuer = 'barq';
    else if (via) issuer = 'alrajhi';
    else if (accountRef) issuer = 'ahli';
  }
  if (!issuer) {
    issuer = 'unknown';
    flags.push('issuer_unrecognized');
  }

  const isTopUp = merchant !== null && isOwnWallet(merchant, ownWallets);
  let category = null;
  if (isTopUp) {
    flags.push('wallet_topup_inferred');
  } else if (merchant) {
    category = categorize(merchant);
    if (!category) flags.push('needs_category');
  }

  return {
    ok: true,
    issuer,
    kind: isTopUp ? 'wallet_topup' : 'purchase',
    countsAsSpending: !isTopUp,
    channel,
    amount: money.amount,
    amountMinor: money.amountMinor,
    currency,
    merchant,
    category,
    card,
    accountRef,
    balanceAfter,
    occurredAt,
    flags,
    needsReview: flags.some((f) => REVIEW_FLAGS.has(f)),
  };
}
