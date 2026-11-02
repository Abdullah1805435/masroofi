import { riyadhParts, pad2 } from './periods.js';

// Text helpers for the screens. All dates are shown in Riyadh time and numbers with Western digits,
// the same way the bank messages write them.

const DAY_MS = 24 * 3600 * 1000;
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

// Everything that comes from outside (merchant names, message text) goes through this before it is put in HTML.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const monthName = (m) => MONTHS[m - 1];
export const weekdayName = (dow) => WEEKDAYS[dow];

// 3450 -> "34.50", 900 -> "9", 123456 -> "1,234.56"
export function fmtMoney(minor) {
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = abs % 100;
  return frac ? `${whole}.${String(frac).padStart(2, '0')}` : whole;
}

export const amountHtml = (minor, currency = 'SAR') =>
  `<span class="amt"><bdi>${esc(fmtMoney(minor))}</bdi> <span class="cur">${currency === 'SAR' ? 'ر.س' : esc(currency)}</span></span>`;

export const percent = (ratio) => `${Math.round(ratio * 100)}%`;

export function periodLabel(p) {
  if (p.startDay === 1) return `${monthName(p.m)} ${p.y}`;
  const a = riyadhParts(p.start);
  const b = riyadhParts(p.end - 1);
  return `${a.d} ${monthName(a.m)} إلى ${b.d} ${monthName(b.m)}`;
}

const dayKey = (ms) => {
  const p = riyadhParts(ms);
  return p.y * 10000 + p.m * 100 + p.d;
};
export const dayKeyOf = dayKey;

export function dayHeading(ms, nowMs) {
  if (dayKey(ms) === dayKey(nowMs)) return 'اليوم';
  if (dayKey(ms) === dayKey(nowMs - DAY_MS)) return 'أمس';
  const p = riyadhParts(ms);
  return `${WEEKDAYS[p.dow]} ${p.d} ${monthName(p.m)}`;
}

export const shortDate = (ms) => {
  const p = riyadhParts(ms);
  return `${p.d} ${monthName(p.m)}`;
};

export function timeLabel(input) {
  const p = riyadhParts(input);
  return `${p.hh % 12 || 12}:${pad2(p.mm)} ${p.hh < 12 ? 'ص' : 'م'}`;
}

// Arabic number agreement: 1 / 2 / 3-10 / 11+
const unit = (n, [one, two, few, many]) => (n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`);

export const daysPhrase = (n) => unit(n, ['يوم واحد', 'يومين', 'أيام', 'يوماً']);
export const opsPhrase = (n) => (n === 0 ? 'لا عمليات' : unit(n, ['عملية واحدة', 'عمليتان', 'عمليات', 'عملية']));

export function agoLabel(thenMs, nowMs) {
  const s = Math.max(0, (nowMs - thenMs) / 1000);
  if (s < 45) return 'الآن';
  const min = Math.floor(s / 60);
  if (min < 60) return `قبل ${unit(Math.max(1, min), ['دقيقة', 'دقيقتين', 'دقائق', 'دقيقة'])}`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `قبل ${unit(hours, ['ساعة', 'ساعتين', 'ساعات', 'ساعة'])}`;
  const days = Math.floor(hours / 24);
  return `قبل ${unit(days, ['يوم', 'يومين', 'أيام', 'يوماً'])}`;
}

// "2026-11-01T10:30" typed in a datetime-local box is Riyadh time, whatever the phone's clock says.
export function riyadhInputToIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return null;
  const iso = `${value}:00+03:00`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

export function isoToRiyadhInput(input) {
  const p = riyadhParts(input);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.hh)}:${pad2(p.mm)}`;
}
