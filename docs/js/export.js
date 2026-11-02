import { riyadhParts, pad2 } from './periods.js';
import { categoryLabel } from './model.js';

// CSV for spreadsheets. The BOM makes Excel read the Arabic text as UTF-8.

const STATUS = { confirmed: 'مؤكدة', pending: 'معلّقة', review: 'للمراجعة', ignored: 'متجاهلة' };

// A cell that starts with = + - @ would be run as a formula by Excel, so it gets a leading quote.
const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function toCsv(txs) {
  const head = ['التاريخ', 'التاجر', 'المبلغ', 'العملة', 'الفئة', 'الحالة', 'تحسب مصروفاً', 'البطاقة', 'المصدر'];
  const rows = [...txs]
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
    .map((t) => {
      const p = riyadhParts(t.occurredAt);
      const sources = t.sources.map((s) => ({ sms: 'رسالة', wallet: 'Apple Pay', manual: 'يدوي' })[s.type] ?? s.type).join(' + ');
      return [
        `${p.y}-${pad2(p.m)}-${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mm)}`,
        t.merchant ?? '',
        (t.amountMinor / 100).toFixed(2),
        t.currency,
        t.countsAsSpending ? categoryLabel(t.category) : '',
        STATUS[t.status] ?? t.status,
        t.countsAsSpending ? 'نعم' : 'لا',
        t.card?.last4 ?? '',
        sources,
      ];
    });
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function backupName(nowMs = Date.now(), ext = 'json') {
  const p = riyadhParts(nowMs);
  return `masroofi-${p.y}${pad2(p.m)}${pad2(p.d)}.${ext}`;
}
