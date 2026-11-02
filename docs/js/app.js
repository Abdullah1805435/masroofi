import {
  loadState, createRepo, putTxs, putRule, deleteRule, getKv, setKv, getRaw, putRaw, pruneRaw, exportAll, importAll, wipeAll,
} from './store.js';
import { syncNow, testConnection } from './sync.js';
import { buildModel } from './model.js';
import * as V from './views.js';
import * as A from './actions.js';
import { toCsv, backupName } from './export.js';
import { generateKey, normalizeWorkerUrl, TEST_MESSAGE } from './guide.js';
import { riyadhInputToIso, isoToRiyadhInput } from './format.js';
import { DEFAULT_OWN_WALLETS } from './merchants.js';

const $ = (sel) => document.querySelector(sel);
const main = $('#main');
const tabsEl = $('#tabs');
const sheetEl = $('#sheet');
const toastEl = $('#toast');

const SYNC_EVERY_MS = 45_000;
const ROUTES = new Set(['home', 'tx', 'review', 'settings', 'guide']);

let state = null;
const ui = { periodOffset: 0, category: '', showIgnored: false, syncing: false };
const guide = { keys: null, workerCode: '', loading: false };
let sheet = null; // { kind: 'edit'|'manual', id?, category, rawId? }
let lastTab = null;
let renderLater = false;
let lastSyncStart = 0;

const nowMs = () => Date.now();
const nowIso = () => new Date().toISOString();
const route = () => {
  const r = location.hash.replace(/^#\/?/, '') || 'home';
  return ROUTES.has(r) ? r : 'home';
};

/* ---------- Drawing ---------- */

const typing = () => {
  const el = document.activeElement;
  return !!el && main.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};

function render() {
  if (!state) return;
  if (typing()) {
    renderLater = true; // do not rebuild the screen under the user's finger while they type
    return;
  }
  renderLater = false;
  const tab = route();
  const m = { ...buildModel(state, ui, nowMs()), syncing: ui.syncing };
  const y = window.scrollY;
  const html = {
    tx: () => V.txView(m, ui),
    review: () => V.reviewView(m),
    settings: () => V.settingsView(m),
    guide: () => V.guideView({ keys: guide.keys, url: state.connection?.url ?? '', workerReady: !!guide.workerCode }),
    home: () => V.homeView(m),
  }[tab]();
  main.innerHTML = html;
  tabsEl.innerHTML = V.tabsView(tab === 'guide' ? 'settings' : tab, m.review.count);
  for (const [id, n] of Object.entries(notes)) showNote(id, n);
  window.scrollTo(0, lastTab === tab ? y : 0);
  lastTab = tab;
}

document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (renderLater && !typing()) render();
  }, 60);
});

let toastTimer = null;
function toast(message, undo = null) {
  clearTimeout(toastTimer);
  toastEl.textContent = '';
  const span = document.createElement('span');
  span.textContent = message;
  toastEl.append(span);
  if (undo) {
    const b = document.createElement('button');
    b.textContent = 'تراجع';
    b.addEventListener('click', async () => {
      toastEl.hidden = true;
      await undo();
    });
    toastEl.append(b);
  }
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), undo ? 7000 : 3500);
}

// Status lines under a button ("connected", "test passed"). They are kept, because the screen is
// redrawn after every sync and would otherwise wipe the message a second after it appears.
let notes = {};

function showNote(id, { text, isError }) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('is-ok', !isError);
}

function note(id, text, isError = false) {
  notes[id] = { text, isError };
  showNote(id, notes[id]);
}

/* ---------- Saving ---------- */

async function saveTxs(list) {
  await putTxs(list);
  for (const t of list) state.txs.set(t.id, t);
}

// Saves a change and offers to put the old version back.
async function change(next, message) {
  const prev = state.txs.get(next.id);
  await saveTxs([next]);
  render();
  toast(message, async () => {
    await saveTxs([prev]);
    render();
  });
}

// Picks a category: remembered for this merchant, and applied to its other transactions.
async function chooseCategory(tx, category, { silent = false } = {}) {
  const now = nowIso();
  const next = A.setCategory(tx, category, now);
  const others = category ? A.categoryRuleChanges([...state.txs.values()], tx.merchantKey, category, now, tx.id) : [];
  const key = tx.merchantKey;
  const hadRule = key ? state.rules[key] : undefined;
  const before = [tx, ...others.map((o) => state.txs.get(o.id))];
  if (category && key) {
    await putRule(key, category);
    state.rules[key] = category;
  }
  await saveTxs([next, ...others]);
  render();
  if (silent) return;
  toast(others.length ? `حفظت الفئة، وطبقتها على ${others.length} عملية ثانية` : 'حفظت الفئة', async () => {
    await saveTxs(before);
    if (key) {
      if (hadRule) {
        await putRule(key, hadRule);
        state.rules[key] = hadRule;
      } else {
        await deleteRule(key);
        delete state.rules[key];
      }
    }
    render();
  });
}

async function saveSettings(patch) {
  const s = state.settings;
  state.settings = { ...s, ...patch, budgets: { ...s.budgets, ...(patch.budgets || {}) } };
  await setKv('settings', state.settings);
}

/* ---------- Sync ---------- */

async function runSync() {
  if (ui.syncing || !state) return null;
  const repo = createRepo(state);
  if (!state.connection) {
    await repo.sweep(nowIso());
    render();
    return null;
  }
  ui.syncing = true;
  lastSyncStart = nowMs();
  render();
  const result = await syncNow({ conn: state.connection, repo });
  state.lastSync = { at: nowIso(), error: result.error, pulled: result.pulled, added: result.added, merged: result.merged };
  await setKv('lastSync', state.lastSync);
  ui.syncing = false;
  render();
  return result;
}

async function saveConnection(url, pullKey, msgId) {
  const clean = normalizeWorkerUrl(url);
  if (!clean) {
    note(msgId, 'العنوان غير صحيح. يجب أن يبدأ بـ https وينتهي بـ workers.dev أو دومينك.', true);
    return false;
  }
  if (String(pullKey).trim().length < 16) {
    note(msgId, 'مفتاح السحب قصير. يجب أن يكون 16 حرفاً على الأقل.', true);
    return false;
  }
  state.connection = { url: clean, pullKey: String(pullKey).trim() };
  await setKv('connection', state.connection);
  note(msgId, 'أختبر الاتصال…', false);
  try {
    const waiting = await testConnection(state.connection);
    note(msgId, waiting ? `تم الاتصال. ينتظر ${waiting} عنصر وسأسحبه الآن.` : 'تم الاتصال. الصندوق فاضي وجاهز.', false);
    runSync();
    return true;
  } catch (err) {
    note(msgId, err.message || 'تعذّر الاتصال.', true);
    return false;
  }
}

async function sendTest() {
  const url = state.connection?.url;
  if (!url || !guide.keys) return;
  note('#testMsg', 'أرسل الاختبار…', false);
  let res;
  try {
    res = await fetch(`${url}/i`, {
      method: 'POST',
      headers: { authorization: `Bearer ${guide.keys.ingest}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'sms', text: TEST_MESSAGE }),
    });
  } catch {
    note('#testMsg', 'تعذّر الوصول للصندوق. تأكد من العنوان ومن الإنترنت.', true);
    return;
  }
  if (res.status === 401) return note('#testMsg', 'مفتاح الإرسال لا يطابق `INGEST_KEY` في Cloudflare.', true);
  if (res.status === 500) return note('#testMsg', 'مفاتيح الصندوق غير مضبوطة في Cloudflare (`INGEST_KEY` و`PULL_KEY`).', true);
  if (!res.ok) return note('#testMsg', `رفض الصندوق الرسالة (${res.status}).`, true);

  // The inbox list can lag by a few seconds, so look for it a few times.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const result = await runSync();
    if (result?.error) return note('#testMsg', `وصل الاختبار لكن السحب فشل: ${result.error.message}`, true);
    if (result && result.ignored > 0) return note('#testMsg', 'نجح الاختبار: وصلت الرسالة وانسحبت وانحذفت من الصندوق.', false);
    note('#testMsg', `أنتظر وصولها… (${i + 1}/6)`, false);
  }
  note('#testMsg', 'أُرسل الاختبار لكنه ما ظهر بعد. قد يتأخر حتى دقيقة، اضغط «زامن الآن» وجرّب مرة ثانية.', true);
}

/* ---------- Sheets ---------- */

function mountSheet(html) {
  sheetEl.innerHTML = html;
  sheetEl.hidden = false;
  document.body.classList.add('sheet-open');
  (sheetEl.querySelector('[autofocus]') || sheetEl.querySelector('.sheet'))?.focus?.();
}

function closeSheet() {
  sheetEl.hidden = true;
  sheetEl.innerHTML = '';
  document.body.classList.remove('sheet-open');
  sheet = null;
  if (renderLater) render();
}

async function openEdit(id) {
  const tx = state.txs.get(id);
  if (!tx) return;
  const source = tx.sources.find((s) => s.type === 'sms' && s.rawId) || tx.sources.find((s) => s.rawId);
  const raw = source ? await getRaw(source.rawId) : null;
  sheet = { kind: 'edit', id, category: tx.category };
  mountSheet(V.editSheet(tx, raw?.item?.text ?? '', nowMs()));
}

function openManual({ note: noteText = '', rawId = null, at = null } = {}) {
  sheet = { kind: 'manual', category: null, rawId };
  mountSheet(V.manualSheet({ nowInput: isoToRiyadhInput(at ?? nowMs()), note: noteText }));
  $('#fAmount')?.focus();
}

function markChipSelected(category) {
  document.querySelectorAll('#fCats .chip').forEach((chip) => {
    const on = chip.dataset.key === category;
    chip.classList.toggle('is-on', on);
    chip.setAttribute('aria-pressed', String(on));
  });
}

async function saveEdit({ confirm: andConfirm = false } = {}) {
  const tx = state.txs.get(sheet.id);
  if (!tx) return closeSheet();
  const now = nowIso();
  const patch = { merchant: $('#fMerchant').value };
  const foreign = tx.currency !== 'SAR';
  let converted = false;
  if (foreign) {
    const sar = A.parseUserAmount($('#fAmount')?.value);
    if (sar) {
      patch.amountMinor = sar;
      patch.currency = 'SAR';
      converted = true;
    } else if (andConfirm) {
      return toast('أدخل المبلغ بالريال أولاً');
    }
  }
  let next = A.editDetails(tx, patch, now);
  if (converted) next = { ...next, original: { amountMinor: tx.amountMinor, currency: tx.currency }, reasons: next.reasons.filter((r) => r !== 'foreign_currency') };
  next = A.setCategory(next, sheet.category, now);
  next = A.setCounts(next, $('#fCounts').checked, now);
  if (andConfirm || (converted && !next.reasons.length && next.status === 'review')) next = A.confirmTx(next, now);

  const changedCategory = sheet.category && sheet.category !== tx.category && next.merchantKey;
  const others = changedCategory ? A.categoryRuleChanges([...state.txs.values()], next.merchantKey, sheet.category, now, tx.id) : [];
  if (changedCategory) {
    await putRule(next.merchantKey, sheet.category);
    state.rules[next.merchantKey] = sheet.category;
  }
  await saveTxs([next, ...others]);
  closeSheet();
  render();
  toast('تم الحفظ');
}

async function saveManual() {
  const amountMinor = A.parseUserAmount($('#fAmount').value);
  const occurredAt = riyadhInputToIso($('#fWhen').value);
  const err = $('#fError');
  const fail = (text) => {
    err.textContent = text;
    err.hidden = false;
  };
  if (!amountMinor) return fail('اكتب مبلغاً صحيحاً أكبر من صفر.');
  if (!occurredAt) return fail('اختر وقتاً صحيحاً.');
  const tx = A.manualTx({ amountMinor, merchant: $('#fMerchant').value, category: sheet.category, occurredAt }, { now: nowIso() });
  await saveTxs([tx]);
  if (sheet.rawId) await dismissRaw(sheet.rawId, tx.id);
  closeSheet();
  render();
  toast('أضفت العملية');
}

async function dismissRaw(id, txId = null) {
  const raw = state.unreadable.find((r) => r.id === id) || (await getRaw(id));
  if (!raw) return;
  await putRaw({ ...raw, status: 'dismissed', txId });
  state.unreadable = state.unreadable.filter((r) => r.id !== id);
}

/* ---------- Files and clipboard ---------- */

async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('تم النسخ');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    toast(ok ? 'تم النسخ' : 'ما قدرت أنسخ تلقائياً. اضغط مطولاً على النص وانسخه.');
  }
}

async function ensureGuide() {
  if (!guide.keys) {
    guide.keys = (await getKv('guideKeys', null)) || { ingest: generateKey(), pull: generateKey() };
    await setKv('guideKeys', guide.keys);
  }
  if (!guide.workerCode && !guide.loading) {
    guide.loading = true;
    fetch('./worker.js')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('worker.js'))))
      .then((code) => {
        guide.workerCode = code;
        if (route() === 'guide') render();
      })
      .catch(() => {})
      .finally(() => (guide.loading = false));
  }
}

/* ---------- Taps ---------- */

const ACTIONS = {
  period: (el) => {
    ui.periodOffset = Math.min(0, ui.periodOffset + Number(el.dataset.d));
    render();
  },
  sync: () => runSync(),
  bar: (el) => {
    document.querySelectorAll('.bar.is-picked').forEach((b) => b.classList.remove('is-picked'));
    el.classList.add('is-picked');
    const noteEl = $('.strip-note');
    if (noteEl) noteEl.textContent = el.dataset.note;
  },
  'filter-cat': (el) => {
    ui.category = el.dataset.key || '';
    ui.showIgnored = false;
    if (route() !== 'tx') location.hash = '#/tx';
    else render();
  },
  'toggle-ignored': () => {
    ui.showIgnored = !ui.showIgnored;
    ui.category = '';
    render();
  },
  'open-tx': (el) => openEdit(el.dataset.id),
  'add-manual': () => openManual(),
  confirm: (el) => {
    const tx = state.txs.get(el.dataset.id);
    if (tx) change(A.confirmTx(tx, nowIso()), 'أكدت العملية');
  },
  ignore: (el) => {
    const tx = state.txs.get(el.dataset.id);
    if (tx) change(A.ignoreTx(tx, nowIso()), 'تجاهلت العملية');
  },
  'cat-pick': (el) => {
    const tx = state.txs.get(el.dataset.id);
    if (tx) chooseCategory(tx, el.dataset.key);
  },
  'raw-add': async (el) => {
    const raw = state.unreadable.find((r) => r.id === el.dataset.id);
    if (raw) openManual({ note: raw.item?.text ?? '', rawId: raw.id, at: Date.parse(raw.eventTime) });
  },
  'raw-dismiss': async (el) => {
    await dismissRaw(el.dataset.id);
    render();
    toast('تجاهلت الرسالة');
  },
  'sheet-close': closeSheet,
  'sheet-cat': (el) => {
    sheet.category = sheet.category === el.dataset.key ? null : el.dataset.key;
    markChipSelected(sheet.category);
  },
  'sheet-save': () => saveEdit(),
  'sheet-confirm': () => saveEdit({ confirm: true }),
  'sheet-ignore': async () => {
    const tx = state.txs.get(sheet.id);
    closeSheet();
    if (tx) await change(A.ignoreTx(tx, nowIso()), 'تجاهلت العملية');
  },
  'sheet-restore': async () => {
    const tx = state.txs.get(sheet.id);
    closeSheet();
    if (tx) await change(A.confirmTx(tx, nowIso()), 'استعدت العملية');
  },
  'manual-save': saveManual,
  'rule-delete': async (el) => {
    await deleteRule(el.dataset.key);
    delete state.rules[el.dataset.key];
    render();
  },
  'conn-save': () => saveConnection($('#connUrl').value, $('#connKey').value, '#connMsg'),
  'guide-connect': () => saveConnection($('#guideUrl').value, guide.keys.pull, '#connMsg'),
  'send-test': sendTest,
  'keys-new': async () => {
    if (!confirm('المفاتيح القديمة تتوقف عن العمل. ستحدّثها في Cloudflare وفي الاختصارات. متابعة؟')) return;
    guide.keys = { ingest: generateKey(), pull: generateKey() };
    await setKv('guideKeys', guide.keys);
    render();
  },
  copy: (el) => copyText(el.dataset.text),
  'copy-worker': () => copyText(guide.workerCode),
  'export-json': async () => shareOrDownload(new Blob([JSON.stringify(await exportAll())], { type: 'application/json' }), backupName(nowMs(), 'json')),
  'export-csv': () => shareOrDownload(new Blob([toCsv([...state.txs.values()])], { type: 'text/csv;charset=utf-8' }), backupName(nowMs(), 'csv')),
  wipe: async () => {
    if (!confirm('سيمسح كل العمليات والقواعد من هذا الجوال، ولا يمكن التراجع. متابعة؟')) return;
    await wipeAll({ keepConnection: true });
    state = await loadState();
    render();
    toast('مسحت البيانات');
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = ACTIONS[el.dataset.act];
  if (act) {
    e.preventDefault?.();
    Promise.resolve(act(el)).catch((err) => toast(`صار خطأ: ${err?.message || err}`));
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheet) closeSheet();
});

// Settings save as soon as a box loses focus.
document.addEventListener('change', async (e) => {
  const el = e.target;
  try {
    if (el.id === 'budgetTotal') {
      const v = el.value.trim();
      const minor = v ? A.parseUserAmount(v) : null;
      if (v && !minor) toast('مبلغ غير صحيح');
      else await saveSettings({ budgets: { overallMinor: minor } });
      render();
    } else if (el.id === 'startDay') {
      await saveSettings({ periodStartDay: Number(el.value) });
      ui.periodOffset = 0;
    } else if (el.dataset.budgetCat) {
      const v = el.value.trim();
      const minor = v ? A.parseUserAmount(v) : null;
      const byCategory = { ...state.settings.budgets.byCategory };
      if (v && !minor) toast('مبلغ غير صحيح');
      else if (minor) byCategory[el.dataset.budgetCat] = minor;
      else delete byCategory[el.dataset.budgetCat];
      await saveSettings({ budgets: { byCategory } });
      render();
    } else if (el.id === 'ownWallets') {
      const list = el.value.split(/[،,]/).map((s) => s.trim()).filter(Boolean);
      await saveSettings({ ownWallets: list.length ? list : [...DEFAULT_OWN_WALLETS] });
      render();
    } else if (el.id === 'importFile' && el.files?.[0]) {
      const text = await el.files[0].text();
      if (!confirm('سيستبدل هذا كل بيانات الجوال الحالية بمحتوى الملف. متابعة؟')) return;
      const r = await importAll(JSON.parse(text));
      state = await loadState();
      render();
      toast(`استوردت ${r.txs} عملية${r.skipped ? ` وتخطيت ${r.skipped}` : ''}`);
    }
  } catch (err) {
    toast(`صار خطأ: ${err?.message || err}`);
  }
});

/* ---------- Start ---------- */

async function onRoute() {
  notes = {}; // messages belong to the screen they were shown on
  if (route() === 'guide') await ensureGuide();
  render();
}

async function init() {
  try {
    state = await loadState();
  } catch {
    main.innerHTML = '<p class="empty">ما قدرت أفتح مخزن البيانات على هذا الجهاز. جرّب إغلاق التطبيق وفتحه من جديد.</p>';
    return;
  }
  pruneRaw().catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
  window.addEventListener('hashchange', onRoute);
  await onRoute();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && nowMs() - lastSyncStart > 15_000) runSync();
  });
  window.addEventListener('online', () => runSync());
  setInterval(() => {
    if (!document.hidden) runSync();
  }, SYNC_EVERY_MS);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  runSync();
}

init();
