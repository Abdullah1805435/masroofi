import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWallet, parseAmountText, detectCurrency } from '../docs/js/wallet.js';
import { processItem } from '../docs/js/ingest.js';
import { sweepPending, withRule, needsCategory } from '../docs/js/merge.js';
import { periodFor, shiftPeriod, daysLeft, summarize, countsInTotals } from '../docs/js/periods.js';
import { BARQ, RAJHI, AHLI } from './fixtures.js';

/* ---------- Wallet parser ---------- */

test('wallet amount: numbers and the text shapes Shortcuts might produce', () => {
  const minor = (amount, extra = {}) => parseWallet({ amount, merchant: 'X', ...extra });
  assert.equal(minor(34.5).amountMinor, 3450);
  assert.equal(minor(63.82).amountMinor, 6382); // 63.82 * 100 is 6382.000000000001 in floating point
  assert.equal(minor('SAR 34.50').amountMinor, 3450);
  assert.equal(minor('34.50 ر.س.').currency, 'SAR');
  assert.equal(minor('٣٤٫٥٠').amountMinor, 3450);
  assert.equal(minor('1,234.56').amountMinor, 123456);
  assert.equal(minor('12,50').amountMinor, 1250);
  assert.equal(minor('1,234').amountMinor, 123400);
  assert.equal(parseAmountText('1.234.567,89').minor, 123456789);
  assert.equal(minor('‎34.50‏ SAR').amountMinor, 3450);
});

test('wallet amount: currency detection, assumption and foreign flag', () => {
  assert.equal(parseWallet({ amount: '34.50', merchant: 'X' }).currency, 'SAR');
  assert.ok(parseWallet({ amount: '34.50', merchant: 'X' }).flags.includes('currency_assumed'));
  assert.equal(parseWallet({ amount: 12.99, currency: 'USD', merchant: 'X' }).currency, 'USD');
  const usd = parseWallet({ amount: '$12.99', merchant: 'X' });
  assert.equal(usd.currency, 'USD');
  assert.ok(usd.flags.includes('foreign_currency'));
  assert.equal(detectCurrency('ر.س'), 'SAR');
  assert.equal(detectCurrency('EUR 5'), 'EUR');
});

test('wallet amount: refusals', () => {
  assert.equal(parseWallet({ amount: -5, merchant: 'X' }).reason, 'non_positive_amount');
  assert.equal(parseWallet({ amount: '-5.00 SAR', merchant: 'X' }).reason, 'non_positive_amount');
  assert.equal(parseWallet({ amount: 0, merchant: 'X' }).reason, 'non_positive_amount');
  assert.equal(parseWallet({ amount: '', merchant: 'X' }).reason, 'no_amount');
  assert.equal(parseWallet({ amount: 'free', merchant: 'X' }).reason, 'no_amount');
  assert.equal(parseWallet({ merchant: 'X' }).reason, 'no_amount');
  assert.equal(parseWallet({ amount: null }).ok, false);
});

test('wallet card and merchant', () => {
  const r = parseWallet({ amount: 10, merchant: '  MCDONALDS \n KING FAHD ', card: 'Al Rajhi mada ••9683' });
  assert.deepEqual(r.card, { scheme: 'mada', last4: '9683', applePay: true });
  assert.equal(r.merchant, 'MCDONALDS KING FAHD');
  assert.equal(parseWallet({ amount: 10, merchant: 'X', card: 'Visa' }).card.last4, null);
  assert.ok(parseWallet({ amount: 10 }).flags.includes('no_merchant'));
});

/* ---------- Simulated store for the pipeline ---------- */

function sim({ rules = {}, ownWallets } = {}) {
  const txs = new Map();
  const raws = [];
  let n = 0;
  let k = 0;
  const run = (item, now) => {
    const res = processItem({ id: `m:${String(++k).padStart(13, '0')}:abc`, ...item }, {
      txs: [...txs.values()],
      recentRaws: raws,
      rules,
      ownWallets,
      now: now ?? item.receivedAt,
      newId: () => `tx${++n}`,
    });
    raws.push(res.raw);
    for (const t of [res.created, res.updated]) if (t) txs.set(t.id, t);
    return res;
  };
  return {
    run,
    raws,
    txs,
    list: () => [...txs.values()],
    sweep: (now) => sweepPending([...txs.values()], now).forEach((t) => txs.set(t.id, t)),
  };
}

const sms = (text, receivedAt) => ({ source: 'sms', text, receivedAt });
const wallet = (receivedAt, extra = {}) => ({
  source: 'wallet',
  merchant: 'MCDONALDS KING FAHD RD',
  amount: 'SAR 34.50',
  card: 'مدى ••9683',
  receivedAt,
  ...extra,
});

test('Apple Pay: wallet event first, then the bank SMS, become one confirmed payment', () => {
  const s = sim();
  const w = s.run(wallet('2026-10-31T02:45:08+03:00'));
  assert.equal(w.created.status, 'pending');
  assert.equal(w.created.category, 'restaurants');
  assert.equal(countsInTotals(w.created), false);

  const m = s.run(sms(RAJHI, '2026-10-31T02:45:20+03:00'));
  assert.equal(s.list().length, 1);
  const tx = s.list()[0];
  assert.equal(m.updated.id, w.created.id);
  assert.equal(tx.status, 'confirmed');
  assert.equal(tx.merchant, 'MCDONALDS');
  assert.equal(tx.category, 'restaurants');
  assert.deepEqual(tx.card, { scheme: 'mada', last4: '9683', applePay: true });
  assert.equal(tx.occurredAt, '2026-10-31T02:45:00+03:00');
  assert.deepEqual(tx.sources.map((x) => x.type), ['wallet', 'sms']);
  assert.equal(countsInTotals(tx), true);
});

test('Apple Pay: SMS first, then the wallet event, still one payment', () => {
  const s = sim();
  s.run(sms(RAJHI, '2026-10-31T02:45:20+03:00'));
  s.run(wallet('2026-10-31T02:45:40+03:00'));
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0].status, 'confirmed');
  assert.deepEqual(s.list()[0].sources.map((x) => x.type), ['sms', 'wallet']);
});

test('a wallet event with no SMS waits, goes to review after 30 minutes, and a late SMS settles it', () => {
  const s = sim();
  s.run(wallet('2026-10-31T02:45:08+03:00'));
  s.sweep('2026-10-31T03:14:00+03:00');
  assert.equal(s.list()[0].status, 'pending');
  s.sweep('2026-10-31T03:16:00+03:00');
  assert.equal(s.list()[0].status, 'review');
  assert.deepEqual(s.list()[0].reasons, ['wallet_only']);
  assert.equal(countsInTotals(s.list()[0]), false);

  s.run(sms(RAJHI, '2026-10-31T04:45:00+03:00'));
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0].status, 'confirmed');
  assert.deepEqual(s.list()[0].reasons, []);
});

test('two same-amount payments minutes apart pair up one-to-one', () => {
  const s = sim();
  const later = RAJHI.replace('02:45', '02:48');
  s.run(wallet('2026-10-31T02:45:05+03:00'));
  s.run(wallet('2026-10-31T02:48:05+03:00'));
  s.run(sms(RAJHI, '2026-10-31T02:45:20+03:00'));
  s.run(sms(later, '2026-10-31T02:48:20+03:00'));
  assert.equal(s.list().length, 2);
  for (const tx of s.list()) {
    assert.equal(tx.status, 'confirmed');
    assert.equal(tx.sources.length, 2);
  }
  assert.deepEqual(s.list().map((t) => t.occurredAt).sort(), ['2026-10-31T02:45:00+03:00', '2026-10-31T02:48:00+03:00']);
});

test('the same SMS posted twice is stored once; two wallet events minutes apart are two purchases', () => {
  const s = sim();
  s.run(sms(BARQ, '2026-10-31T16:23:30+03:00'));
  const again = s.run(sms(BARQ, '2026-10-31T16:23:50+03:00'));
  assert.equal(again.raw.status, 'duplicate');
  assert.equal(again.created, null);
  assert.equal(s.list().length, 1);

  const w = sim();
  w.run(wallet('2026-10-31T02:45:05+03:00'));
  assert.equal(w.run(wallet('2026-10-31T02:45:09+03:00')).raw.status, 'duplicate');
  w.run(wallet('2026-10-31T02:48:30+03:00'));
  assert.equal(w.list().length, 2);
});

test('your three real messages become the right transactions', () => {
  const s = sim();
  s.run(sms(BARQ, '2026-10-31T16:23:30+03:00'));
  s.run(sms(RAJHI, '2026-10-31T02:45:20+03:00'));
  s.run(sms(AHLI, '2026-10-05T16:08:00+03:00'));
  const by = Object.fromEntries(s.list().map((t) => [t.merchant, t]));

  assert.equal(by.HUNGERSTATION.amountMinor, 6382);
  assert.equal(by.HUNGERSTATION.category, 'food_delivery');
  assert.equal(by.HUNGERSTATION.status, 'confirmed');
  assert.equal(countsInTotals(by.HUNGERSTATION), true);

  assert.equal(by.MCDONALDS.status, 'confirmed');
  assert.equal(by.MCDONALDS.card.last4, '9683');

  assert.equal(by.barq.kind, 'wallet_topup');
  assert.equal(by.barq.status, 'confirmed');
  assert.equal(by.barq.occurredAt, '2026-10-05T16:07:00+03:00');
  assert.equal(countsInTotals(by.barq), false);
});

test('the received time stamped by the inbox is used when the phone sent none', () => {
  const s = sim();
  const res = s.run({ source: 'sms', text: AHLI, at: '2026-10-05T16:08:10.000Z' });
  assert.equal(res.raw.eventTime, '2026-10-05T16:08:10.000Z');
  assert.equal(res.created.occurredAt, '2026-10-05T16:07:00+03:00');
  assert.equal(res.created.status, 'confirmed');
});

test('OTP and unsupported messages create no transaction', () => {
  const s = sim();
  const otp = s.run(sms('رمز التحقق 123456 لعملية شراء بمبلغ 50 SAR من NOON', '2026-10-31T10:00:00+03:00'));
  assert.equal(otp.raw.status, 'ignored');
  assert.equal(otp.raw.reason, 'otp');
  const deposit = s.run(sms('تم إيداع 5000 ريال في حسابك', '2026-10-31T10:01:00+03:00'));
  assert.equal(deposit.raw.status, 'unreadable');
  assert.equal(deposit.raw.reason, 'unsupported_kind');
  assert.equal(s.run(sms('   ', '2026-10-31T10:02:00+03:00')).raw.status, 'ignored');
  assert.equal(s.list().length, 0);
});

test('an unreadable wallet event is kept for review, not guessed', () => {
  const s = sim();
  const res = s.run({ source: 'wallet', merchant: 'X', amount: 'free', receivedAt: '2026-10-31T10:00:00+03:00' });
  assert.equal(res.raw.status, 'unreadable');
  assert.equal(res.raw.reason, 'no_amount');
});

test('foreign currency goes to review and stays out of the totals', () => {
  const s = sim();
  const res = s.run(sms('شراء انترنت\nبـUSD 12.99\nلـNETFLIX.COM\n31/10/26 10:00', '2026-10-31T10:00:30+03:00'));
  assert.equal(res.created.status, 'review');
  assert.ok(res.created.reasons.includes('foreign_currency'));
  assert.equal(countsInTotals(res.created), false);
});

test('your category rule beats the built-in list, but not a category you set by hand', () => {
  const s = sim({ rules: { HUNGERSTATION: 'groceries' } });
  const res = s.run(sms(BARQ, '2026-10-31T16:23:30+03:00'));
  assert.equal(res.created.category, 'groceries');

  const edited = { ...res.created, userEdited: true, category: 'shopping' };
  assert.equal(withRule(edited, { HUNGERSTATION: 'groceries' }).category, 'shopping');
});

test('an SMS does not overwrite what you already edited on a pending wallet payment', () => {
  const s = sim();
  const w = s.run(wallet('2026-10-31T02:45:08+03:00'));
  s.txs.set(w.created.id, { ...w.created, userEdited: true, merchant: 'مطعمي المفضل', merchantKey: 'مطعميالمفضل', category: 'other' });
  s.run(sms(RAJHI, '2026-10-31T02:45:20+03:00'));
  const tx = s.list()[0];
  assert.equal(s.list().length, 1);
  assert.equal(tx.merchant, 'مطعمي المفضل');
  assert.equal(tx.category, 'other');
  assert.equal(tx.status, 'confirmed');
});

test('an unknown merchant is confirmed but listed as needing a category', () => {
  const s = sim();
  const res = s.run(sms('شراء PoS\nعبر:9683;مدى-ابل باي\nبـSAR 15.00\nلـCORNER SHOP 12\n31/10/26 10:00', '2026-10-31T10:00:30+03:00'));
  assert.equal(res.created.status, 'confirmed');
  assert.equal(res.created.category, null);
  assert.equal(needsCategory(res.created), true);
  assert.equal(countsInTotals(res.created), true);
});

test('wallets you own (from settings) are top-ups', () => {
  const s = sim({ ownWallets: ['barq', 'stc pay'] });
  const res = s.run(sms('شراء انترنت\nبـ20 SAR\nمن STCPAY\nفي 31/10/26 10:00', '2026-10-31T10:00:30+03:00'));
  assert.equal(res.created.kind, 'wallet_topup');
  assert.equal(res.created.countsAsSpending, false);
});

/* ---------- Periods and totals ---------- */

test('period boundaries use Riyadh time', () => {
  const p = periodFor('2026-10-31T23:30:00+03:00');
  assert.equal(p.key, '2026-10');
  assert.equal(new Date(p.start).toISOString(), '2026-09-30T21:00:00.000Z'); // 1 Oct 00:00 Riyadh
  assert.equal(new Date(p.end).toISOString(), '2026-10-31T21:00:00.000Z'); // 1 Nov 00:00 Riyadh
  assert.equal(periodFor('2026-10-31T21:30:00Z').key, '2026-11'); // already 1 Nov in Riyadh
});

test('period with a salary-day start, year rollover, and shifting', () => {
  assert.equal(periodFor('2026-11-01T12:00:00+03:00', 25).key, '2026-10');
  assert.equal(periodFor('2026-11-25T00:00:00+03:00', 25).key, '2026-11');
  const jan = periodFor('2027-01-03T12:00:00+03:00', 25);
  assert.equal(jan.key, '2026-12');
  assert.equal(shiftPeriod(jan, 1).key, '2027-01');
  assert.equal(shiftPeriod(jan, -1).key, '2026-11');
  assert.equal(shiftPeriod(periodFor('2026-01-10T12:00:00+03:00'), -1).key, '2025-12');
  assert.equal(shiftPeriod(shiftPeriod(jan, 1), 1).start, shiftPeriod(jan, 2).start);
});

test('days left counts today', () => {
  const p = periodFor('2026-10-10T12:00:00+03:00');
  assert.equal(daysLeft(p, Date.parse('2026-10-31T16:00:00+03:00')), 1);
  assert.equal(daysLeft(p, Date.parse('2026-10-01T00:00:00+03:00')), 31);
  assert.equal(daysLeft(p, Date.parse('2026-11-01T00:00:00+03:00')), 0);
});

test('totals count only confirmed SAR purchases inside the period', () => {
  const base = { status: 'confirmed', countsAsSpending: true, currency: 'SAR', occurredAt: '2026-10-20T12:00:00+03:00', category: 'restaurants' };
  const txs = [
    { ...base, amountMinor: 3450 },
    { ...base, amountMinor: 6382, category: 'food_delivery' },
    { ...base, amountMinor: 1000, category: null },
    { ...base, amountMinor: 900, countsAsSpending: false }, // wallet top-up
    { ...base, amountMinor: 5000, status: 'pending' },
    { ...base, amountMinor: 7000, status: 'review' },
    { ...base, amountMinor: 1299, currency: 'USD' },
    { ...base, amountMinor: 9999, occurredAt: '2026-09-30T12:00:00+03:00' },
  ];
  const period = periodFor('2026-10-31T12:00:00+03:00');
  const sum = summarize(txs, period, { budgets: { overallMinor: 100000 }, now: Date.parse('2026-10-31T12:00:00+03:00') });
  assert.equal(sum.spentMinor, 10832);
  assert.equal(sum.count, 3);
  assert.deepEqual(sum.byCategory, { restaurants: 3450, food_delivery: 6382, uncategorized: 1000 });
  assert.equal(sum.remainingMinor, 89168);
  assert.equal(sum.daysLeft, 1);
  assert.equal(sum.dailyAllowanceMinor, 89168);
  assert.ok(Math.abs(sum.pctUsed - 0.10832) < 1e-9);

  const early = summarize(txs, period, { budgets: { overallMinor: 100000 }, now: Date.parse('2026-10-10T12:00:00+03:00') });
  assert.equal(early.daysLeft, 22);
  assert.equal(early.dailyAllowanceMinor, Math.floor(89168 / 22));
});

test('with no budget there is no remaining or daily allowance, and overspending floors at zero', () => {
  const tx = { status: 'confirmed', countsAsSpending: true, currency: 'SAR', occurredAt: '2026-10-20T12:00:00+03:00', amountMinor: 50000, category: 'shopping' };
  const period = periodFor('2026-10-20T12:00:00+03:00');
  const none = summarize([tx], period, { now: Date.parse('2026-10-20T12:00:00+03:00') });
  assert.equal(none.remainingMinor, null);
  assert.equal(none.dailyAllowanceMinor, null);
  const over = summarize([tx], period, { budgets: { overallMinor: 10000 }, now: Date.parse('2026-10-20T12:00:00+03:00') });
  assert.equal(over.remainingMinor, -40000);
  assert.equal(over.dailyAllowanceMinor, 0);
});
