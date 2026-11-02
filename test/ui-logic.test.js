import test from 'node:test';
import assert from 'node:assert/strict';
import { processItem } from '../docs/js/ingest.js';
import { summarize, periodFor } from '../docs/js/periods.js';
import { DEFAULT_SETTINGS } from '../docs/js/store.js';
import {
  esc, fmtMoney, periodLabel, dayHeading, timeLabel, agoLabel, daysPhrase, riyadhInputToIso, isoToRiyadhInput,
} from '../docs/js/format.js';
import { setCategory, confirmTx, ignoreTx, editDetails, manualTx, categoryRuleChanges, parseUserAmount } from '../docs/js/actions.js';
import { buildModel, dayBars, groupByDay } from '../docs/js/model.js';
import { toCsv, backupName } from '../docs/js/export.js';
import { BARQ, RAJHI, AHLI } from './fixtures.js';

const NOW_ISO = '2026-10-31T17:00:00+03:00';
const NOW = Date.parse(NOW_ISO);

let batch = 0;
function ingestAll(items) {
  const txs = [];
  const prefix = `b${++batch}-`; // ids must differ between batches, as they do in the app
  for (const item of items) {
    const out = processItem(item, { txs: [...txs], recentRaws: [], rules: {}, now: NOW_ISO, newId: () => `${prefix}${txs.length + 1}` });
    if (out.created) txs.push(out.created);
    else if (out.updated) txs[txs.findIndex((t) => t.id === out.updated.id)] = out.updated;
  }
  return txs;
}

const sms = (id, text, receivedAt) => ({ id, source: 'sms', text, receivedAt, at: receivedAt });

const realTxs = () =>
  ingestAll([
    sms('a', AHLI, '2026-10-05T16:08:00+03:00'),
    sms('b', RAJHI, '2026-10-31T02:45:30+03:00'),
    sms('c', BARQ, '2026-10-31T16:23:30+03:00'),
  ]);

const stateOf = (txs, extra = {}) => ({
  txs: new Map(txs.map((t) => [t.id, t])),
  rules: {},
  settings: { ...DEFAULT_SETTINGS },
  connection: null,
  lastSync: null,
  unreadable: [],
  ...extra,
});

test('format: money, escaping and Arabic number agreement', () => {
  assert.equal(fmtMoney(3450), '34.50');
  assert.equal(fmtMoney(900), '9');
  assert.equal(fmtMoney(123456), '1,234.56');
  assert.equal(fmtMoney(0), '0');
  assert.equal(esc('<img src=x onerror="a()"> & \''), '&lt;img src=x onerror=&quot;a()&quot;&gt; &amp; &#39;');
  assert.equal(daysPhrase(1), 'يوم واحد');
  assert.equal(daysPhrase(2), 'يومين');
  assert.equal(daysPhrase(5), '5 أيام');
  assert.equal(daysPhrase(19), '19 يوماً');
});

test('format: times and dates are Riyadh time', () => {
  assert.equal(timeLabel('2026-10-31T16:23:00+03:00'), '4:23 م');
  assert.equal(timeLabel('2026-10-31T02:45:00+03:00'), '2:45 ص');
  assert.equal(timeLabel('2026-10-31T00:05:00+03:00'), '12:05 ص');
  assert.equal(timeLabel('2026-10-31T12:00:00+03:00'), '12:00 م');
  assert.equal(timeLabel('2026-10-31T23:30:00Z'), '2:30 ص'); // 23:30 UTC is 02:30 next day in Riyadh
  assert.equal(dayHeading(NOW, NOW), 'اليوم');
  assert.equal(dayHeading(NOW - 24 * 3600e3, NOW), 'أمس');
  assert.equal(dayHeading(Date.parse('2026-10-25T10:00:00+03:00'), NOW), 'الأحد 25 أكتوبر');
  assert.equal(periodLabel(periodFor(NOW, 1)), 'أكتوبر 2026');
  assert.equal(periodLabel(periodFor(NOW, 27)), '27 أكتوبر إلى 26 نوفمبر');
});

test('format: "ago" wording and the datetime box', () => {
  assert.equal(agoLabel(NOW - 10e3, NOW), 'الآن');
  assert.equal(agoLabel(NOW - 60e3, NOW), 'قبل دقيقة');
  assert.equal(agoLabel(NOW - 120e3, NOW), 'قبل دقيقتين');
  assert.equal(agoLabel(NOW - 5 * 60e3, NOW), 'قبل 5 دقائق');
  assert.equal(agoLabel(NOW - 15 * 60e3, NOW), 'قبل 15 دقيقة');
  assert.equal(agoLabel(NOW - 3 * 3600e3, NOW), 'قبل 3 ساعات');
  assert.equal(agoLabel(NOW - 49 * 3600e3, NOW), 'قبل يومين');
  assert.equal(riyadhInputToIso('2026-11-01T10:30'), '2026-11-01T10:30:00+03:00');
  assert.equal(riyadhInputToIso('nonsense'), null);
  assert.equal(isoToRiyadhInput('2026-10-31T23:30:00Z'), '2026-11-01T02:30');
});

test('actions: category, confirm, ignore and details mark the transaction as edited', () => {
  const [tx] = realTxs();
  const now = '2026-10-31T17:05:00+03:00';
  assert.equal(setCategory(tx, 'shopping', now).category, 'shopping');
  assert.equal(setCategory(tx, 'shopping', now).userEdited, true);
  assert.equal(setCategory(tx, '', now).category, null);
  const review = { ...tx, status: 'review', reasons: ['wallet_only'] };
  assert.deepEqual([confirmTx(review, now).status, confirmTx(review, now).reasons], ['confirmed', []]);
  assert.equal(ignoreTx(tx, now).status, 'ignored');
  const edited = editDetails(tx, { merchant: '  Jarir Bookstore ', amountMinor: 12000, currency: 'SAR' }, now);
  assert.deepEqual([edited.merchant, edited.merchantKey, edited.amountMinor], ['Jarir Bookstore', 'JARIRBOOKSTORE', 12000]);
  assert.equal(tx.status, 'confirmed'); // the original is untouched, so undo can put it back
});

test('actions: a category chosen for a merchant is applied to the same merchant, never over a hand-picked one', () => {
  const base = { status: 'confirmed', merchantKey: 'CORNERSHOP', category: null, userEdited: false };
  const list = [
    { ...base, id: '1' },
    { ...base, id: '2', userEdited: true, category: 'health' },
    { ...base, id: '3', userEdited: true, category: null }, // confirmed by hand but never categorised: follows the rule
    { ...base, id: '4', merchantKey: 'OTHER' },
    { ...base, id: '5', status: 'ignored' },
    { ...base, id: '6' },
  ];
  const changed = categoryRuleChanges(list, 'CORNERSHOP', 'groceries', 'now', '6');
  assert.deepEqual(changed.map((t) => t.id).sort(), ['1', '3']);
  assert.ok(changed.every((t) => t.category === 'groceries'));
  assert.deepEqual(categoryRuleChanges(list, '', 'groceries', 'now'), []);
});

test('actions: a manual payment is confirmed, in SAR, and counts in the totals', () => {
  const at = '2026-10-31T12:00:00+03:00';
  const tx = manualTx({ amountMinor: 2500, merchant: 'بقالة الحي', category: 'groceries', occurredAt: at }, { now: NOW_ISO, id: 'm1' });
  assert.deepEqual([tx.id, tx.status, tx.currency, tx.kind, tx.sources[0].type], ['m1', 'confirmed', 'SAR', 'manual', 'manual']);
  const s = summarize([tx], periodFor(NOW, 1), { now: NOW });
  assert.equal(s.spentMinor, 2500);
  assert.equal(manualTx({ amountMinor: 100, merchant: '', occurredAt: at }, { now: NOW_ISO }).merchant, null);
});

test('actions: amounts typed by the user', () => {
  assert.equal(parseUserAmount('34.5'), 3450);
  assert.equal(parseUserAmount('٣٤٫٥٠'), 3450);
  assert.equal(parseUserAmount('1,234.50'), 123450);
  assert.equal(parseUserAmount('12,5'), 1250);
  assert.equal(parseUserAmount('0'), null);
  assert.equal(parseUserAmount('-5'), null);
  assert.equal(parseUserAmount('abc'), null);
  assert.equal(parseUserAmount(''), null);
});

test('model: your three real messages give the right totals, bars, categories and groups', () => {
  const txs = realTxs();
  assert.equal(txs.length, 3);
  const m = buildModel(stateOf(txs), { periodOffset: 0 }, NOW);

  assert.equal(m.summary.spentMinor, 6382 + 3450); // the 9 SAR top-up of Barq is not spending
  assert.equal(m.summary.count, 2);
  assert.equal(m.bars.length, 31);
  const today = m.bars[30];
  assert.deepEqual([today.today, today.count, today.spentMinor], [true, 2, 9832]);
  assert.equal(m.bars.filter((b) => b.future).length, 0);
  assert.deepEqual(m.cats.map((c) => [c.key, c.spentMinor]), [['food_delivery', 6382], ['restaurants', 3450]]);
  assert.equal(m.cats[0].label, 'توصيل طعام');

  assert.equal(m.groups[0].heading, 'اليوم');
  assert.equal(m.groups[0].totalMinor, 9832);
  assert.equal(m.groups[0].items[0].merchant, 'HUNGERSTATION'); // newest first
  assert.equal(m.groups.length, 2); // today, and the top-up on 5 October is outside the October-31 group
  assert.equal(m.review.count, 0);
  assert.ok(m.capture.sms > 0);
  assert.equal(m.capture.wallet, null);
});

test('model: a past period, a budget, and days left', () => {
  const txs = realTxs();
  const withBudget = stateOf(txs, { settings: { ...DEFAULT_SETTINGS, budgets: { overallMinor: 300000, byCategory: { groceries: 50000 } } } });
  const m = buildModel(withBudget, { periodOffset: 0 }, NOW);
  assert.equal(m.summary.remainingMinor, 300000 - 9832);
  assert.equal(m.summary.daysLeft, 1);
  assert.equal(m.summary.dailyAllowanceMinor, 300000 - 9832);
  assert.ok(m.cats.some((c) => c.key === 'groceries' && c.spentMinor === 0 && c.budgetMinor === 50000)); // a budgeted category shows even at zero

  const prev = buildModel(withBudget, { periodOffset: -1 }, NOW);
  assert.equal(prev.isCurrent, false);
  assert.equal(prev.summary.spentMinor, 0);
  assert.equal(prev.summary.dailyAllowanceMinor, null);
  assert.equal(buildModel(withBudget, { periodOffset: 3 }, NOW).isCurrent, true); // never a future period
});

test('model: items that need you are counted once, and filters work', () => {
  const unknown = ingestAll([sms('u', 'شراء PoS\nعبر:9683;مدى-ابل باي\nبـSAR 15.00\nلـCORNER SHOP 12\n31/10/26 10:00', '2026-10-31T10:01:00+03:00')]);
  assert.equal(unknown[0].status, 'confirmed'); // readable and complete, only the category is unknown
  const wallet = ingestAll([{ id: 'w', source: 'wallet', merchant: 'Cafe', amount: 'SAR 20.00', card: 'Mada 1234', receivedAt: '2026-10-31T09:00:00+03:00', at: '2026-10-31T09:00:00+03:00' }]);
  const reviewTx = { ...wallet[0], status: 'review', reasons: ['wallet_only'] };
  const raw = { id: 'r1', status: 'unreadable', item: { text: 'شراء ...' }, eventTime: NOW_ISO };
  const m = buildModel(stateOf([...unknown, reviewTx, ...realTxs()], { unreadable: [raw, { id: 'r2', status: 'dismissed' }] }), { periodOffset: 0 }, NOW);

  assert.deepEqual([m.review.decide.length, m.review.categorize.length, m.review.unreadable.length], [1, 1, 1]);
  assert.equal(m.review.count, 3);
  assert.equal(m.summary.byCategory.uncategorized, 1500);
  assert.ok(m.summary.spentMinor === 6382 + 3450 + 1500); // the wallet-only review item is not counted

  const only = buildModel(stateOf(unknown), { periodOffset: 0, category: 'uncategorized' }, NOW);
  assert.equal(only.listedCount, 1);
  const none = buildModel(stateOf(unknown), { periodOffset: 0, category: 'fuel' }, NOW);
  assert.equal(none.listedCount, 0);
  const ignored = buildModel(stateOf([{ ...unknown[0], status: 'ignored' }]), { periodOffset: 0, showIgnored: true }, NOW);
  assert.equal(ignored.listedCount, 1);
  assert.equal(buildModel(stateOf([{ ...unknown[0], status: 'ignored' }]), { periodOffset: 0 }, NOW).hasAny, false);
});

test('model: groups and bars on their own', () => {
  const txs = realTxs();
  assert.equal(groupByDay([], NOW).length, 0);
  const bars = dayBars(txs, periodFor(NOW, 1), NOW);
  assert.equal(bars.reduce((a, b) => a + b.spentMinor, 0), 9832);
  assert.equal(groupByDay(txs, NOW)[1].heading, 'الاثنين 5 أكتوبر');
});

test('export: CSV has a BOM, quotes properly, and cannot run as a formula', () => {
  const txs = realTxs();
  const evil = { ...txs[2], id: 'x', merchant: '=HYPERLINK("http://e","x")', sources: [{ type: 'manual', rawId: null, at: NOW_ISO }] };
  const csv = toCsv([...txs, evil]);
  assert.ok(csv.startsWith('﻿"التاريخ"'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 5);
  assert.ok(lines.some((l) => l.includes('"2026-10-31 02:45","MCDONALDS","34.50","SAR","مطاعم وكافيهات","مؤكدة","نعم","9683","رسالة"')));
  assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""http://e"",""x"")"`)));
  assert.ok(lines.some((l) => l.includes('"barq"') && l.includes('"لا"'))); // the top-up is listed but marked as not spending
  assert.equal(backupName(NOW), 'masroofi-20261031.json');
});
