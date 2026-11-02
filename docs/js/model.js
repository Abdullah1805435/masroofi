import { periodFor, shiftPeriod, inPeriod, summarize, countsInTotals } from './periods.js';
import { needsCategory } from './merge.js';
import { CATEGORIES } from './merchants.js';
import { dayHeading, dayKeyOf } from './format.js';

// Turns the stored state into exactly what the screens show. Pure, so it can be tested without a browser.

const DAY_MS = 24 * 3600 * 1000;

// One entry per day of the period, for the day strip.
export function dayBars(txs, period, nowMs) {
  const n = Math.round((period.end - period.start) / DAY_MS);
  const bars = Array.from({ length: n }, (_, i) => {
    const start = period.start + i * DAY_MS;
    return { i, start, spentMinor: 0, count: 0, today: nowMs >= start && nowMs < start + DAY_MS, future: start > nowMs };
  });
  for (const tx of txs) {
    if (!countsInTotals(tx) || !inPeriod(tx.occurredAt, period)) continue;
    const bar = bars[Math.floor((Date.parse(tx.occurredAt) - period.start) / DAY_MS)];
    if (bar) {
      bar.spentMinor += tx.amountMinor;
      bar.count += 1;
    }
  }
  return bars;
}

export function categoryLabel(key) {
  return key === 'uncategorized' || !key ? 'غير مصنف' : CATEGORIES[key] ?? key;
}

export function categoryRows(summary, budgets) {
  const byCat = budgets?.byCategory ?? {};
  const keys = new Set([...Object.keys(summary.byCategory), ...Object.keys(byCat).filter((k) => byCat[k] > 0)]);
  return [...keys]
    .map((key) => {
      const spentMinor = summary.byCategory[key] || 0;
      const budgetMinor = byCat[key] > 0 ? byCat[key] : null;
      return {
        key,
        label: categoryLabel(key),
        spentMinor,
        budgetMinor,
        pct: budgetMinor ? spentMinor / budgetMinor : null,
        share: summary.spentMinor ? spentMinor / summary.spentMinor : 0,
      };
    })
    .sort((a, b) => b.spentMinor - a.spentMinor || a.label.localeCompare(b.label, 'ar'));
}

export function groupByDay(txs, nowMs) {
  const sorted = [...txs].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const groups = [];
  for (const tx of sorted) {
    const ms = Date.parse(tx.occurredAt);
    const key = dayKeyOf(ms);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, heading: dayHeading(ms, nowMs), totalMinor: 0, items: [] };
      groups.push(g);
    }
    g.items.push(tx);
    if (countsInTotals(tx)) g.totalMinor += tx.amountMinor;
  }
  return groups;
}

const latestSource = (txs, type) => {
  let best = null;
  for (const tx of txs) for (const s of tx.sources) if (s.type === type) best = Math.max(best ?? 0, Date.parse(s.at));
  return best;
};

// ui: { periodOffset (0 = current, -1 = previous ...), category (filter key or ''), showIgnored }
export function buildModel(state, ui, nowMs) {
  const settings = state.settings;
  const offset = Math.min(0, ui.periodOffset || 0);
  const period = shiftPeriod(periodFor(nowMs, settings.periodStartDay), offset);
  const all = [...state.txs.values()];
  const summary = summarize(all, period, { budgets: settings.budgets, now: nowMs });

  const inThisPeriod = all.filter((t) => inPeriod(t.occurredAt, period));
  const listed = inThisPeriod
    .filter((t) => (ui.showIgnored ? t.status === 'ignored' : t.status !== 'ignored'))
    .filter((t) => !ui.category || (ui.category === 'uncategorized' ? !t.category : t.category === ui.category));

  const decide = all.filter((t) => t.status === 'review').sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const categorize = all.filter(needsCategory).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const unreadable = (state.unreadable || []).filter((r) => r.status === 'unreadable');
  const pending = all.filter((t) => t.status === 'pending');

  return {
    nowMs,
    period,
    isCurrent: offset === 0,
    summary,
    bars: dayBars(all, period, nowMs),
    cats: categoryRows(summary, settings.budgets),
    groups: groupByDay(listed, nowMs),
    listedCount: listed.length,
    categoriesInPeriod: [...new Set(inThisPeriod.filter((t) => t.status !== 'ignored').map((t) => t.category || 'uncategorized'))],
    review: { decide, categorize, unreadable, pending, count: decide.length + categorize.length + unreadable.length },
    capture: { sms: latestSource(all, 'sms'), wallet: latestSource(all, 'wallet') },
    hasAny: all.some((t) => t.status !== 'ignored'),
    settings,
    connection: state.connection,
    lastSync: state.lastSync,
    rules: state.rules,
  };
}
