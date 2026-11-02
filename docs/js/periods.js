// Budget periods and totals. Saudi Arabia has no daylight saving, so Riyadh is a fixed UTC+3.

const OFFSET_MS = 3 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export const pad2 = (n) => String(n).padStart(2, '0');

export function riyadhParts(input) {
  const d = new Date(new Date(input).getTime() + OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

// Midnight in Riyadh of the given calendar day, as epoch ms. Month overflow (13 -> January) is handled by Date.UTC.
const midnightMs = (y, m, d) => Date.UTC(y, m - 1, d) - OFFSET_MS;

function periodAt(y, m, startDay) {
  return { y, m, startDay, key: `${y}-${pad2(m)}`, start: midnightMs(y, m, startDay), end: midnightMs(y, m + 1, startDay) };
}

// The period is named after the month it starts in, so with startDay 25, 1 Nov 2026 is in period 2026-10.
export function periodFor(input, startDay = 1) {
  const p = riyadhParts(input);
  let { y, m } = p;
  if (p.d < startDay) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return periodAt(y, m, startDay);
}

export function shiftPeriod(period, delta) {
  const index = period.y * 12 + (period.m - 1) + delta;
  return periodAt(Math.floor(index / 12), (index % 12) + 1, period.startDay);
}

export const inPeriod = (iso, period) => {
  const t = new Date(iso).getTime();
  return t >= period.start && t < period.end;
};

export function daysLeft(period, nowMs) {
  if (nowMs >= period.end) return 0;
  if (nowMs < period.start) return Math.round((period.end - period.start) / DAY_MS);
  return Math.max(1, Math.ceil((period.end - nowMs) / DAY_MS));
}

// Only confirmed, SAR purchases count. Pending, in-review and foreign-currency items wait for the user.
export const countsInTotals = (tx) => tx.status === 'confirmed' && tx.countsAsSpending && tx.currency === 'SAR';

export function summarize(txs, period, { budgets = {}, now = Date.now() } = {}) {
  let spentMinor = 0;
  let count = 0;
  const byCategory = {};
  for (const tx of txs) {
    if (!countsInTotals(tx) || !inPeriod(tx.occurredAt, period)) continue;
    spentMinor += tx.amountMinor;
    count += 1;
    const key = tx.category || 'uncategorized';
    byCategory[key] = (byCategory[key] || 0) + tx.amountMinor;
  }
  const budgetMinor = budgets.overallMinor ?? null;
  const remainingMinor = budgetMinor == null ? null : budgetMinor - spentMinor;
  const left = daysLeft(period, now);
  return {
    spentMinor,
    count,
    byCategory,
    budgetMinor,
    remainingMinor,
    pctUsed: budgetMinor ? spentMinor / budgetMinor : null,
    daysLeft: left,
    dailyAllowanceMinor: remainingMinor != null && left > 0 ? Math.max(0, Math.floor(remainingMinor / left)) : null,
  };
}
