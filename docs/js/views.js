import {
  esc, amountHtml, fmtMoney, percent, periodLabel, timeLabel, agoLabel, daysPhrase, opsPhrase, shortDate, weekdayName,
  dayHeading,
} from './format.js';
import { CATEGORIES } from './merchants.js';
import { categoryLabel } from './model.js';
import { riyadhParts } from './periods.js';
import {
  CLOUDFLARE_STEPS, CLOUDFLARE_NOTE, SMS_STEPS, SMS_NOTE, WALLET_STEPS, WALLET_NOTE, TEST_STEPS,
} from './guide.js';

// Every screen is a function from the model to HTML. Anything that came from outside goes through esc().

const svg = (inner) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  home: svg('<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.8V20h13V9.8"/><path d="M10 20v-5.5h4V20"/>'),
  list: svg('<path d="M4 6.5h16M4 12h16M4 17.5h10"/>'),
  check: svg('<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-5"/>'),
  sliders: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  earlier: svg('<path d="m9.5 6 6 6-6 6"/>'), // points right: older periods sit on the right of a right-to-left screen
  later: svg('<path d="m14.5 6-6 6 6 6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
};

const rich = (s) => esc(s).replace(/`([^`]+)`/g, '<code dir="ltr">$1</code>');
const steps = (list) => `<ol class="steps">${list.map((s) => `<li>${rich(s)}</li>`).join('')}</ol>`;

const REASONS = {
  wallet_only: 'ظهرت في Apple Pay ولم تصل رسالة من البنك. هل تمت العملية؟',
  foreign_currency: 'بعملة غير الريال. أدخل المبلغ بالريال لتدخل الحساب.',
  no_merchant: 'ما عرفت اسم التاجر.',
  issuer_unrecognized: 'ما عرفت من أي بنك الرسالة.',
  date_order_assumed_dmy: 'تاريخ الرسالة يحتمل قراءتين، اخترت اليوم أولاً.',
  date_far_from_received: 'تاريخ الرسالة بعيد عن وقت وصولها.',
  no_date_in_message: 'ما لقيت تاريخاً في الرسالة، فاستخدمت وقت وصولها.',
};
export const reasonText = (tx) => (tx.reasons || []).map((r) => REASONS[r]).filter(Boolean).join(' ');

const SOURCE_NAME = { sms: 'رسالة البنك', wallet: 'Apple Pay', manual: 'إدخال يدوي' };

/* ---------- Shared pieces ---------- */

export function tabsView(active, reviewCount) {
  const tabs = [
    ['home', 'الرئيسية', ICON.home],
    ['tx', 'العمليات', ICON.list],
    ['review', 'المراجعة', ICON.check],
    ['settings', 'الإعدادات', ICON.sliders],
  ];
  return tabs
    .map(([id, label, icon]) => {
      const badge = id === 'review' && reviewCount ? `<b class="badge" aria-label="${reviewCount} بانتظار المراجعة">${reviewCount}</b>` : '';
      return `<a href="#/${id}" class="tab${id === active ? ' is-on' : ''}"${id === active ? ' aria-current="page"' : ''}>${icon}<span>${label}</span>${badge}</a>`;
    })
    .join('');
}

function periodNav(m, withSync = false) {
  const sync = withSync
    ? `<button class="icon sync-btn${m.syncing ? ' is-spinning' : ''}" data-act="sync" aria-label="مزامنة الآن">${ICON.refresh}</button>`
    : '';
  return `<div class="pnav">
    <button class="icon" data-act="period" data-d="-1" aria-label="الفترة السابقة">${ICON.earlier}</button>
    <h2 class="plabel">${esc(periodLabel(m.period))}</h2>
    <button class="icon" data-act="period" data-d="1" aria-label="الفترة التالية"${m.isCurrent ? ' disabled' : ''}>${ICON.later}</button>${sync}
  </div>`;
}

function syncStatus(m) {
  const sync = m.lastSync;
  if (!m.connection) return { text: 'غير مربوط', bad: true };
  if (!sync) return { text: 'لم تتم بعد', bad: false };
  const when = agoLabel(Date.parse(sync.at), m.nowMs);
  return sync.error ? { text: `فشلت، آخر محاولة ${when}`, bad: true } : { text: when, bad: false };
}

function banners(m) {
  const out = [];
  if (!m.connection) {
    out.push(`<div class="banner warn"><p>الصندوق غير مربوط، فلن تصل العمليات تلقائياً.</p><a class="btn small" href="#/guide">ابدأ الإعداد</a></div>`);
  } else if (m.lastSync?.error) {
    out.push(`<div class="banner warn"><p>${esc(m.lastSync.error.message)}</p><button class="btn small" data-act="sync">حاول مرة ثانية</button></div>`);
  }
  return out.join('');
}

/* ---------- Home ---------- */

function dayNote(bar) {
  const p = riyadhParts(bar.start);
  const name = `${weekdayName(p.dow)} ${shortDate(bar.start)}`;
  return bar.count ? `${name}: ${fmtMoney(bar.spentMinor)} ر.س في ${opsPhrase(bar.count)}` : `${name}: لا عمليات`;
}

function dayStrip(m) {
  const max = Math.max(0, ...m.bars.map((b) => b.spentMinor));
  const top = m.bars.find((b) => b.spentMinor === max && max > 0);
  const note = top ? `أعلى يوم: ${dayNote(top)}` : 'لا مصروف مسجل في هذه الفترة.';
  const bars = m.bars
    .map((b) => {
      const h = max ? b.spentMinor / max : 0;
      const cls = ['bar', b.today ? 'is-today' : '', b.future ? 'is-future' : '', b.spentMinor ? '' : 'is-zero'].filter(Boolean).join(' ');
      return `<button class="${cls}" style="--h:${h.toFixed(3)}" data-act="bar" data-note="${esc(dayNote(b))}" aria-label="${esc(dayNote(b))}"><i></i></button>`;
    })
    .join('');
  const table = m.bars
    .filter((b) => b.count)
    .map((b) => `<tr><th scope="row">${esc(dayNote({ ...b, count: 0 }).replace(': لا عمليات', ''))}</th><td>${esc(opsPhrase(b.count))}</td><td>${amountHtml(b.spentMinor)}</td></tr>`)
    .join('');
  return `<section class="strip-wrap" aria-label="الصرف اليومي">
    <div class="strip" role="group" aria-label="عمود لكل يوم من أيام الفترة">${bars}</div>
    <p class="strip-note" data-default="${esc(note)}">${esc(note)}</p>
    ${table ? `<details class="strip-table"><summary>عرض الأيام كجدول</summary><table><tbody>${table}</tbody></table></details>` : ''}
  </section>`;
}

function categoryList(m) {
  if (!m.cats.length) return '';
  const rows = m.cats
    .map((c) => {
      const hasBudget = c.budgetMinor != null;
      const w = hasBudget ? Math.min(1, c.pct) : c.share;
      const over = hasBudget && c.pct > 1;
      const sub = hasBudget ? `${over ? 'تجاوزت' : percent(c.pct)} من ${fmtMoney(c.budgetMinor)} ر.س` : `${percent(c.share)} من الصرف`;
      return `<li><button class="row cat" data-act="filter-cat" data-key="${esc(c.key)}">
        <span class="cat-name">${esc(c.label)}</span>
        <span class="cat-amt">${amountHtml(c.spentMinor)}</span>
        <span class="cat-meter${over ? ' is-over' : ''}"><i style="--w:${w.toFixed(3)}"></i></span>
        <span class="cat-sub${over ? ' is-over' : ''}">${esc(sub)}</span>
      </button></li>`;
    })
    .join('');
  return `<section class="group"><h3>الفئات</h3><ul class="rows">${rows}</ul></section>`;
}

export function homeView(m) {
  const s = m.summary;
  const hasBudget = s.budgetMinor != null && s.budgetMinor > 0;
  const over = hasBudget && s.remainingMinor < 0;
  let hero;
  if (hasBudget) {
    const label = over ? 'تجاوزت ميزانية الفترة بمقدار' : m.isCurrent ? 'المتبقي من ميزانية الفترة' : 'المتبقي في نهاية الفترة';
    let allowance = '';
    if (m.isCurrent && s.daysLeft > 0) {
      allowance = over
        ? `<p class="hero-allow">باقي ${esc(daysPhrase(s.daysLeft))} على نهاية الفترة.</p>`
        : `<p class="hero-allow">يكفيك ${amountHtml(s.dailyAllowanceMinor)} يومياً لباقي ${esc(daysPhrase(s.daysLeft))}.</p>`;
    }
    hero = `<p class="hero-label">${label}</p>
      <p class="hero-num${over ? ' is-over' : ''}">${amountHtml(Math.abs(s.remainingMinor))}</p>
      <div class="meter${over ? ' is-over' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(s.pctUsed * 100)}" aria-label="نسبة المصروف من الميزانية"><i style="--w:${Math.min(1, s.pctUsed).toFixed(3)}"></i></div>
      <p class="hero-sub">صرفت ${amountHtml(s.spentMinor)} من ${amountHtml(s.budgetMinor)} (${percent(s.pctUsed)})</p>${allowance}`;
  } else {
    hero = `<p class="hero-label">صرفت في هذه الفترة</p>
      <p class="hero-num">${amountHtml(s.spentMinor)}</p>
      <p class="hero-sub">${esc(opsPhrase(s.count))}</p>
      <a class="link" href="#/settings">حدد ميزانية الفترة لتعرف كم باقي لك</a>`;
  }

  const reviewBanner = m.review.count
    ? `<a class="banner warn" href="#/review"><p>${m.review.count} بانتظار مراجعتك</p><span class="btn small">راجع</span></a>`
    : '';
  const empty = !m.hasAny
    ? `<p class="empty">ما وصلت عمليات بعد. تظهر هنا تلقائياً لما تصلك رسالة من البنك أو تدفع بـ Apple Pay.</p>`
    : '';
  const sync = syncStatus(m);
  const capture = `<section class="group"><h3>حالة الالتقاط</h3><ul class="rows facts">
    <li><span>المزامنة</span><span class="${sync.bad ? 'bad' : ''}">${esc(sync.text)}</span></li>
    <li><span>آخر رسالة من البنك</span><span>${m.capture.sms ? esc(agoLabel(m.capture.sms, m.nowMs)) : 'لم تصل بعد'}</span></li>
    <li><span>آخر دفعة Apple Pay</span><span>${m.capture.wallet ? esc(agoLabel(m.capture.wallet, m.nowMs)) : 'لم تصل بعد'}</span></li>
  </ul></section>`;

  return `${banners(m)}${periodNav(m, true)}<section class="hero">${hero}</section>${dayStrip(m)}${reviewBanner}${empty}${categoryList(m)}${capture}`;
}

/* ---------- Transactions ---------- */

function txRow(tx) {
  const counts = tx.countsAsSpending;
  const meta = [];
  if (counts) meta.push(`<span class="${tx.category ? '' : 'uncat'}">${esc(categoryLabel(tx.category))}</span>`);
  meta.push(`<span>${esc(timeLabel(tx.occurredAt))}</span>`);
  if (tx.status === 'pending') meta.push('<span class="tag wait">بانتظار رسالة البنك</span>');
  if (tx.status === 'review') meta.push('<span class="tag warn">يحتاج قرارك</span>');
  if (tx.status === 'ignored') meta.push('<span class="tag">متجاهلة</span>');
  if (!counts && tx.status !== 'ignored') meta.push(`<span class="tag">${tx.kind === 'wallet_topup' ? 'تعبئة محفظة' : 'لا تحسب'}</span>`);
  const dim = tx.status === 'ignored' || tx.status === 'pending' || !counts;
  return `<li><button class="row tx" data-act="open-tx" data-id="${esc(tx.id)}">
    <span class="tx-main"><span class="tx-name"><bdi>${esc(tx.merchant || 'عملية بدون اسم')}</bdi></span><span class="tx-meta">${meta.join('')}</span></span>
    <span class="tx-amt${dim ? ' is-dim' : ''}">${amountHtml(tx.amountMinor, tx.currency)}</span>
  </button></li>`;
}

export function txView(m, ui) {
  const chips = [
    `<button class="chip${!ui.category && !ui.showIgnored ? ' is-on' : ''}" data-act="filter-cat" data-key="">الكل</button>`,
    ...m.categoriesInPeriod.map(
      (k) => `<button class="chip${ui.category === k ? ' is-on' : ''}" data-act="filter-cat" data-key="${esc(k)}">${esc(categoryLabel(k))}</button>`,
    ),
    `<button class="chip${ui.showIgnored ? ' is-on' : ''}" data-act="toggle-ignored">المتجاهلة</button>`,
  ].join('');
  const groups = m.groups
    .map(
      (g) => `<section class="group"><h3 class="day"><span>${esc(g.heading)}</span>${g.totalMinor ? amountHtml(g.totalMinor) : ''}</h3>
        <ul class="rows">${g.items.map(txRow).join('')}</ul></section>`,
    )
    .join('');
  const empty = m.listedCount ? '' : `<p class="empty">${ui.category || ui.showIgnored ? 'ما فيه عمليات بهذا الفلتر في هذه الفترة.' : 'ما فيه عمليات في هذه الفترة.'}</p>`;
  return `${periodNav(m)}<div class="chips" role="group" aria-label="تصفية بالفئة">${chips}</div>${groups}${empty}
    <button class="fab" data-act="add-manual" aria-label="إضافة عملية يدوياً">${ICON.plus}<span>إضافة</span></button>`;
}

/* ---------- Review ---------- */

const categoryChips = (selected, act, extra = '') =>
  Object.entries(CATEGORIES)
    .map(([key, label]) => `<button class="chip${selected === key ? ' is-on' : ''}" data-act="${act}" data-key="${key}"${extra} aria-pressed="${selected === key}">${esc(label)}</button>`)
    .join('');

function decideCard(tx, nowMs) {
  const why = reasonText(tx) || 'تحتاج تأكيدك.';
  let actions;
  if (tx.reasons.includes('wallet_only')) {
    actions = `<button class="btn" data-act="confirm" data-id="${esc(tx.id)}">تمت العملية</button><button class="btn ghost" data-act="ignore" data-id="${esc(tx.id)}">لم تتم</button>`;
  } else if (tx.reasons.includes('foreign_currency')) {
    actions = `<button class="btn" data-act="open-tx" data-id="${esc(tx.id)}">أدخل المبلغ بالريال</button><button class="btn ghost" data-act="ignore" data-id="${esc(tx.id)}">تجاهل</button>`;
  } else {
    actions = `<button class="btn" data-act="confirm" data-id="${esc(tx.id)}">تأكيد</button><button class="btn ghost" data-act="open-tx" data-id="${esc(tx.id)}">تعديل</button><button class="btn ghost" data-act="ignore" data-id="${esc(tx.id)}">تجاهل</button>`;
  }
  return `<li class="rv"><div class="rv-head"><b><bdi>${esc(tx.merchant || 'عملية بدون اسم')}</bdi></b>${amountHtml(tx.amountMinor, tx.currency)}</div>
    <p class="rv-why">${esc(why)}</p><p class="rv-when">${esc(dayHeading(Date.parse(tx.occurredAt), nowMs))} ${esc(timeLabel(tx.occurredAt))}</p>
    <div class="rv-actions">${actions}</div></li>`;
}

function categorizeCard(tx) {
  return `<li class="rv"><div class="rv-head"><b><bdi>${esc(tx.merchant || 'عملية بدون اسم')}</bdi></b>${amountHtml(tx.amountMinor, tx.currency)}</div>
    <p class="rv-why">اختر فئة. أحفظها لهذا التاجر وأطبقها على عملياته الثانية.</p>
    <div class="chips wrap">${categoryChips(null, 'cat-pick', ` data-id="${esc(tx.id)}"`)}</div></li>`;
}

function unreadableCard(raw) {
  const text = raw.item?.text ?? [raw.item?.merchant, raw.item?.amount, raw.item?.card].filter(Boolean).join(' / ');
  return `<li class="rv"><p class="rv-why">ما فهمت هذه الرسالة، فما حسبتها.</p><pre class="raw">${esc(text)}</pre>
    <div class="rv-actions"><button class="btn" data-act="raw-add" data-id="${esc(raw.id)}">أضفها كعملية</button><button class="btn ghost" data-act="raw-dismiss" data-id="${esc(raw.id)}">تجاهل</button></div></li>`;
}

export function reviewView(m) {
  const r = m.review;
  const section = (title, hint, list, card) =>
    list.length ? `<section class="group"><h3>${title} <span class="count">${list.length}</span></h3>${hint ? `<p class="hint">${hint}</p>` : ''}<ul class="rows cards">${list.map(card).join('')}</ul></section>` : '';
  const pending = r.pending.length
    ? `<p class="hint">${r.pending.length} دفعة Apple Pay تنتظر رسالة البنك لتتأكد. ما تدخل الحساب قبلها.</p>`
    : '';
  const body =
    section('بانتظار قرارك', '', r.decide, (tx) => decideCard(tx, m.nowMs)) +
    section('تحتاج فئة', '', r.categorize, categorizeCard) +
    section('رسائل ما فهمتها', '', r.unreadable, unreadableCard);
  const empty = r.count ? '' : '<p class="empty">ما فيه شي ينتظرك.</p>';
  return `<h1 class="title">المراجعة</h1>${body}${empty}${pending}`;
}

/* ---------- Sheets ---------- */

export function sheetFrame(title, inner) {
  return `<div class="sheet-backdrop" data-act="sheet-close"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h2><bdi>${esc(title)}</bdi></h2><button class="icon" data-act="sheet-close" aria-label="إغلاق">${ICON.close}</button></div>
      <div class="sheet-body">${inner}</div></div>`;
}

export function editSheet(tx, rawText, nowMs) {
  const foreign = tx.currency !== 'SAR';
  const sources = tx.sources.map((s) => SOURCE_NAME[s.type] ?? s.type).join(' و');
  const card = tx.card?.last4 ? `بطاقة ${esc(tx.card.last4)}` : '';
  const why = reasonText(tx);
  const inner = `
    <p class="sheet-amt">${amountHtml(tx.amountMinor, tx.currency)}</p>
    <p class="muted">${esc(dayHeading(Date.parse(tx.occurredAt), nowMs))} ${esc(timeLabel(tx.occurredAt))}، ${esc(sources)}${card ? `، ${card}` : ''}</p>
    ${why ? `<p class="banner warn inline">${esc(why)}</p>` : ''}
    ${tx.status === 'pending' ? '<p class="banner wait inline">بانتظار رسالة البنك لتتأكد. لا تدخل الحساب قبلها.</p>' : ''}
    <label class="field"><span>اسم التاجر</span><input id="fMerchant" value="${esc(tx.merchant ?? '')}" autocomplete="off"></label>
    ${foreign ? `<label class="field"><span>المبلغ بالريال (الأصلي ${esc(fmtMoney(tx.amountMinor))} ${esc(tx.currency)})</span><input id="fAmount" inputmode="decimal" placeholder="مثال: 48.75" autocomplete="off"></label>` : ''}
    <h3>الفئة</h3><div class="chips wrap" id="fCats">${categoryChips(tx.category, 'sheet-cat')}</div>
    <label class="switch"><input type="checkbox" id="fCounts"${tx.countsAsSpending ? ' checked' : ''}><span>تحسب مصروفاً</span></label>
    ${rawText ? `<details class="rawbox"><summary>الرسالة الأصلية</summary><pre class="raw">${esc(rawText)}</pre></details>` : ''}
    <div class="sheet-actions">
      <button class="btn" data-act="sheet-save">حفظ</button>
      ${tx.status === 'review' || tx.status === 'pending' ? '<button class="btn ghost" data-act="sheet-confirm">حفظ وتأكيد</button>' : ''}
      ${tx.status === 'ignored' ? '<button class="btn ghost" data-act="sheet-restore">استعادة</button>' : '<button class="btn ghost danger" data-act="sheet-ignore">تجاهل</button>'}
    </div>`;
  return sheetFrame(tx.merchant || 'عملية', inner);
}

export function manualSheet({ nowInput, note = '', merchant = '' }) {
  const inner = `${note ? `<pre class="raw">${esc(note)}</pre>` : ''}
    <label class="field"><span>المبلغ (ر.س)</span><input id="fAmount" inputmode="decimal" placeholder="مثال: 35.50" autocomplete="off" autofocus></label>
    <label class="field"><span>اسم التاجر</span><input id="fMerchant" value="${esc(merchant)}" autocomplete="off"></label>
    <label class="field"><span>الوقت</span><input id="fWhen" type="datetime-local" value="${esc(nowInput)}"></label>
    <h3>الفئة</h3><div class="chips wrap" id="fCats">${categoryChips(null, 'sheet-cat')}</div>
    <p class="form-error" id="fError" role="alert" hidden></p>
    <div class="sheet-actions"><button class="btn" data-act="manual-save">إضافة</button></div>`;
  return sheetFrame('إضافة عملية', inner);
}

/* ---------- Settings ---------- */

const money = (minor) => (minor ? fmtMoney(minor) : '');

export function settingsView(m) {
  const s = m.settings;
  const conn = m.connection;
  const sync = syncStatus(m);
  const catBudgets = Object.entries(CATEGORIES)
    .map(([key, label]) => `<li><label class="field inline"><span>${esc(label)}</span><input inputmode="decimal" data-budget-cat="${key}" value="${esc(money(s.budgets.byCategory?.[key]))}" placeholder="بدون حد"></label></li>`)
    .join('');
  const days = Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}"${s.periodStartDay === i + 1 ? ' selected' : ''}>${i + 1}</option>`).join('');
  const rules = Object.entries(m.rules || {})
    .map(([key, cat]) => `<li class="rule"><span class="rule-key" dir="auto">${esc(key)}</span><span>${esc(categoryLabel(cat))}</span><button class="icon" data-act="rule-delete" data-key="${esc(key)}" aria-label="حذف القاعدة">${ICON.close}</button></li>`)
    .join('');

  return `<h1 class="title">الإعدادات</h1>
  <section class="group"><h3>الميزانية</h3><ul class="rows forms">
    <li><label class="field inline"><span>ميزانية الفترة (ر.س)</span><input id="budgetTotal" inputmode="decimal" value="${esc(money(s.budgets.overallMinor))}" placeholder="بدون ميزانية"></label></li>
    <li><label class="field inline"><span>تبدأ الفترة يوم</span><select id="startDay">${days}</select></label></li>
  </ul>
  <details class="fold"><summary>حد لكل فئة (اختياري)</summary><ul class="rows forms">${catBudgets}</ul></details></section>

  <section class="group"><h3>الصندوق</h3><ul class="rows forms">
    <li><label class="field inline stack"><span>عنوان الصندوق</span><input id="connUrl" dir="ltr" inputmode="url" autocapitalize="off" autocomplete="off" value="${esc(conn?.url ?? '')}" placeholder="https://…workers.dev"></label></li>
    <li><label class="field inline stack"><span>مفتاح السحب</span><input id="connKey" dir="ltr" type="password" autocapitalize="off" autocomplete="off" value="${esc(conn?.pullKey ?? '')}"></label></li>
    <li class="facts-line"><span>آخر مزامنة</span><span class="${sync.bad ? 'bad' : ''}">${esc(sync.text)}</span></li>
  </ul>
  <div class="btn-row"><button class="btn" data-act="conn-save">حفظ واختبار</button><button class="btn ghost" data-act="sync">زامن الآن</button><a class="btn ghost" href="#/guide">دليل الإعداد</a></div>
  <p class="form-error" id="connMsg" role="status" hidden></p></section>

  <section class="group"><h3>محافظي</h3><p class="hint">الدفع من البنك إلى محفظة تملكها تعبئة لا مصروف. افصل بين الأسماء بفاصلة.</p><ul class="rows forms">
    <li><label class="field inline"><span>أسماء المحافظ</span><input id="ownWallets" dir="auto" value="${esc((s.ownWallets || []).join('، '))}"></label></li></ul></section>

  ${rules ? `<section class="group"><h3>القواعد المحفوظة</h3><p class="hint">كل تاجر وفئته التي اخترتها. تغلب على القائمة الجاهزة.</p><ul class="rows">${rules}</ul></section>` : ''}

  <section class="group"><h3>البيانات</h3><p class="hint">كل بياناتك على هذا الجوال فقط. خذ نسخة احتياطية من وقت لوقت.</p>
  <div class="btn-row"><button class="btn ghost" data-act="export-json">نسخة احتياطية</button><button class="btn ghost" data-act="export-csv">تصدير CSV</button>
  <label class="btn ghost file">استيراد نسخة<input id="importFile" type="file" accept="application/json,.json" hidden></label></div>
  <div class="btn-row"><button class="btn ghost danger" data-act="wipe">مسح كل البيانات</button></div></section>`;
}

/* ---------- Setup guide ---------- */

export function guideView(g) {
  const hasUrl = !!g.url;
  return `<a class="link back" href="#/settings">رجوع للإعدادات</a><h1 class="title">دليل الإعداد</h1>
  <p class="lead">مرة وحدة وتخلص: صندوق مجاني على Cloudflare، ثم اختصارين على جوالك. بعدها العمليات تصل وحدها.</p>

  <section class="group"><h3>1. المفاتيح</h3>
    <p class="hint">مفتاحان مختلفان. مفتاح الإرسال يوضع في الاختصارات ويقدر يضيف فقط. مفتاح السحب يوضع في التطبيق ويقرأ ويحذف. حافظ عليهما.</p>
    <ul class="rows keys">
      <li><span>مفتاح الإرسال <code dir="ltr">INGEST_KEY</code></span><code class="keyval" dir="ltr">${esc(g.keys.ingest)}</code><button class="btn small ghost" data-act="copy" data-text="${esc(g.keys.ingest)}">نسخ</button></li>
      <li><span>مفتاح السحب <code dir="ltr">PULL_KEY</code></span><code class="keyval" dir="ltr">${esc(g.keys.pull)}</code><button class="btn small ghost" data-act="copy" data-text="${esc(g.keys.pull)}">نسخ</button></li>
    </ul>
    <div class="btn-row"><button class="btn small ghost danger" data-act="keys-new">أنشئ مفاتيح جديدة</button></div>
  </section>

  <section class="group"><h3>2. الصندوق في Cloudflare</h3>
    <div class="btn-row"><button class="btn" data-act="copy-worker"${g.workerReady ? '' : ' disabled'}>${g.workerReady ? 'انسخ كود الصندوق' : 'يحمّل الكود…'}</button></div>
    ${steps(CLOUDFLARE_STEPS)}<p class="hint">${esc(CLOUDFLARE_NOTE)}</p>
    <ul class="rows forms"><li><label class="field inline stack"><span>عنوان الصندوق</span><input id="guideUrl" dir="ltr" inputmode="url" autocapitalize="off" autocomplete="off" value="${esc(g.url)}" placeholder="https://…workers.dev"></label></li></ul>
    <div class="btn-row"><button class="btn" data-act="guide-connect">اربط التطبيق</button></div>
    <p class="form-error" id="connMsg" role="status" hidden></p>
  </section>

  <section class="group"><h3>3. اختصار الرسائل</h3>
    ${hasUrl ? `<ul class="rows keys"><li><span>رابط الإرسال</span><code class="keyval" dir="ltr">${esc(g.url)}/i</code><button class="btn small ghost" data-act="copy" data-text="${esc(g.url)}/i">نسخ</button></li></ul>` : '<p class="hint">اربط عنوان الصندوق أولاً ليظهر رابط الإرسال هنا.</p>'}
    ${steps(SMS_STEPS)}<p class="hint">${rich(SMS_NOTE)}</p>
    <p class="hint">ملاحظة: كل رسالة فيها كلمة «شراء» ترسل للصندوق، حتى من غير البنوك. اللي ما يفهمها التطبيق يعرضها لك في المراجعة وما يحسبها.</p>
  </section>

  <section class="group"><h3>4. اختصار Apple Pay (الطبقة الثانية)</h3>
    ${steps(WALLET_STEPS)}<p class="hint">${esc(WALLET_NOTE)}</p>
  </section>

  <section class="group"><h3>5. جرّب</h3>${steps(TEST_STEPS)}
    <div class="btn-row"><button class="btn" data-act="send-test"${hasUrl ? '' : ' disabled'}>أرسل اختباراً</button></div>
    <p class="form-error" id="testMsg" role="status" hidden></p>
  </section>`;
}
