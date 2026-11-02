import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSms } from '../docs/js/parser.js';
import { normalizeSms } from '../docs/js/normalize.js';
import { categorize, isOwnWallet } from '../docs/js/merchants.js';
import { BARQ, RAJHI, AHLI, stripHeader } from './fixtures.js';

test('normalize: strips invisible marks and converts Arabic digits', () => {
  assert.equal(normalizeSms('؜31/10/26 ٠٢:٤٥'), '31/10/26 02:45');
  assert.equal(normalizeSms('بـ٣٤٫٥٠ SAR'), 'بـ34.50 SAR');
});

test('Barq: online purchase at HungerStation', () => {
  const r = parseSms(BARQ);
  assert.equal(r.ok, true);
  assert.equal(r.issuer, 'barq');
  assert.equal(r.kind, 'purchase');
  assert.equal(r.countsAsSpending, true);
  assert.equal(r.channel, 'online');
  assert.equal(r.amount, 63.82);
  assert.equal(r.amountMinor, 6382);
  assert.equal(r.currency, 'SAR');
  assert.equal(r.merchant, 'HUNGERSTATION');
  assert.equal(r.category, 'food_delivery');
  assert.deepEqual(r.card, { scheme: 'visa', last4: null, applePay: false });
  assert.equal(r.balanceAfter, 2.85);
  assert.equal(r.occurredAt, '2026-10-31T16:23:00+03:00');
  assert.deepEqual(r.flags, []);
  assert.equal(r.needsReview, false);
});

test('Al Rajhi: point-of-sale purchase via Apple Pay (message has an invisible mark before the date)', () => {
  const r = parseSms(RAJHI);
  assert.equal(r.ok, true);
  assert.equal(r.issuer, 'alrajhi');
  assert.equal(r.kind, 'purchase');
  assert.equal(r.channel, 'pos');
  assert.equal(r.amount, 34.5);
  assert.equal(r.amountMinor, 3450);
  assert.equal(r.merchant, 'MCDONALDS');
  assert.equal(r.category, 'restaurants');
  assert.deepEqual(r.card, { scheme: 'mada', last4: '9683', applePay: true });
  assert.equal(r.balanceAfter, null);
  assert.equal(r.occurredAt, '2026-10-31T02:45:00+03:00');
  assert.deepEqual(r.flags, []);
});

test('Al Ahli: purchase from "barq" is treated as a wallet top-up, not spending', () => {
  const r = parseSms(AHLI);
  assert.equal(r.ok, true);
  assert.equal(r.issuer, 'ahli');
  assert.equal(r.kind, 'wallet_topup');
  assert.equal(r.countsAsSpending, false);
  assert.equal(r.channel, 'online');
  assert.equal(r.amount, 9);
  assert.equal(r.amountMinor, 900);
  assert.equal(r.merchant, 'barq');
  assert.equal(r.category, null);
  assert.deepEqual(r.card, { scheme: 'mada', last4: '4712', applePay: true });
  assert.equal(r.accountRef, '7001');
  assert.ok(r.flags.includes('wallet_topup_inferred'));
  // Still flagged, but only because the message date is ambiguous without a received time.
  assert.equal(r.needsReview, true);
  const resolved = parseSms(AHLI, { receivedAt: '2026-10-05T16:08:00+03:00' });
  assert.equal(resolved.needsReview, false);
});

test('only wallets the user owns are top-ups (Barq by default, others from settings)', () => {
  const msg = 'شراء انترنت\nبـ20 SAR\nمن STCPAY\nفي 31/10/26 10:00';
  assert.equal(parseSms(msg).kind, 'purchase');
  assert.equal(parseSms(msg, { ownWallets: ['barq', 'stc pay'] }).kind, 'wallet_topup');
});

test('Al Ahli: ambiguous 10/05/26 is flagged without a received time', () => {
  const r = parseSms(AHLI);
  assert.equal(r.occurredAt, '2026-05-10T16:07:00+03:00');
  assert.ok(r.flags.includes('date_order_assumed_dmy'));
});

test('Al Ahli: the received time resolves 10/05/26 either way', () => {
  const october = parseSms(AHLI, { receivedAt: '2026-10-05T16:08:00+03:00' });
  assert.equal(october.occurredAt, '2026-10-05T16:07:00+03:00');
  assert.ok(!october.flags.includes('date_order_assumed_dmy'));

  const may = parseSms(AHLI, { receivedAt: '2026-05-10T16:08:00+03:00' });
  assert.equal(may.occurredAt, '2026-05-10T16:07:00+03:00');
  assert.ok(!may.flags.includes('date_order_assumed_dmy'));
});

test('issuer is inferred from the body when no header line is present', () => {
  assert.equal(parseSms(stripHeader(BARQ)).issuer, 'barq');
  assert.equal(parseSms(stripHeader(RAJHI)).issuer, 'alrajhi');
  assert.equal(parseSms(stripHeader(AHLI)).issuer, 'ahli');
  assert.equal(parseSms(stripHeader(RAJHI)).amount, 34.5);
});

test('a sender name passed separately identifies the issuer', () => {
  const r = parseSms(stripHeader(RAJHI), { sender: 'AlRajhiBank' });
  assert.equal(r.issuer, 'alrajhi');
});

test('messages that are not purchases are rejected instead of guessed', () => {
  assert.equal(parseSms('رمز التحقق 123456 لعملية بمبلغ 50 SAR').ok, false);
  assert.equal(parseSms('استرجاع\nبـSAR 20.00\nلـNOON').reason, 'unsupported_kind');
  assert.equal(parseSms('').ok, false);
});

test('a purchase with no amount is rejected', () => {
  const r = parseSms('شراء انترنت\nمن NOON\nفي 31/10/26 10:00');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_amount');
});

test('foreign currency is kept as-is and flagged for review', () => {
  const r = parseSms('شراء انترنت\nبـUSD 12.99\nلـNETFLIX.COM\n31/10/26 10:00');
  assert.equal(r.ok, true);
  assert.equal(r.currency, 'USD');
  assert.ok(r.flags.includes('foreign_currency'));
  assert.equal(r.needsReview, true);
});

test('unknown merchants get no category and are marked as needing one', () => {
  const r = parseSms('شراء PoS\nبـSAR 15.00\nلـCORNER SHOP 12\n31/10/26 10:00');
  assert.equal(r.ok, true);
  assert.equal(r.category, null);
  assert.ok(r.flags.includes('needs_category'));
});

test('merchant rules', () => {
  assert.equal(categorize('UBER EATS'), 'food_delivery');
  assert.equal(categorize('UBER *TRIP'), 'transport');
  assert.equal(categorize('Starbucks Olaya'), 'restaurants');
  assert.equal(categorize('SOME RANDOM SHOP'), null);
  assert.equal(isOwnWallet('barq'), true);
  assert.equal(isOwnWallet('STC PAY'), false);
  assert.equal(isOwnWallet('STC PAY', ['stc pay']), true);
  assert.equal(isOwnWallet('HUNGERSTATION'), false);
});
