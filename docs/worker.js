// Masroofi inbox — a tiny Cloudflare Worker that holds bank-SMS / Apple Pay events until the phone
// app pulls them. The phone is the permanent store; this only keeps items in transit.
//
// Setup (Cloudflare dashboard):
//   1. Storage & Databases > KV > create a namespace, then bind it to this Worker as  INBOX
//   2. Add two secrets (any random 32+ characters, different from each other):
//        INGEST_KEY  used by the iPhone Shortcuts to add items   (can only add)
//        PULL_KEY    used by the app to read and delete items
//   3. Optional variable ALLOW_ORIGIN, e.g. https://abdullah1805435.github.io  (defaults to *)
//
// Endpoints
//   GET  /        health check, no auth
//   POST /i       add an item          Authorization: Bearer <INGEST_KEY>
//   GET  /p       list up to 100 items Authorization: Bearer <PULL_KEY>
//   POST /a       delete items by id   Authorization: Bearer <PULL_KEY>   body {"ids":[...]}

const MAX_BODY = 4096; // bytes of request body we are willing to read
const MAX_TEXT = 2000; // characters of SMS text
const MAX_PULL = 100;
const TTL_SECONDS = 14 * 24 * 3600; // unpulled items expire on their own
const MIN_KEY_LENGTH = 16;
const ID_RE = /^m:\d{13}:[0-9a-f]{12}$/;

const enc = new TextEncoder();

function cors(env) {
  return {
    'access-control-allow-origin': (env && env.ALLOW_ORIGIN) || '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
  };
}

function reply(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(env) },
  });
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

// Compares hashes of both values so the comparison time does not depend on how much matched.
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function authorize(request, env, keyName) {
  const expected = env[keyName];
  if (typeof expected !== 'string' || expected.length < MIN_KEY_LENGTH) {
    return reply({ error: 'not_configured', detail: `${keyName} must be set to ${MIN_KEY_LENGTH}+ characters` }, 500, env);
  }
  const header = request.headers.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return (await safeEqual(given, expected)) ? null : reply({ error: 'unauthorized' }, 401, env);
}

async function readBody(request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY) return { error: 'too_large', status: 413 };
  return { raw };
}

const optString = (v, max) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);

function validTime(v) {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// Turns the request body into a stored item, or says why it was refused.
function buildItem(raw, contentType, nowIso) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    // A Shortcut that posts the bare message text is still accepted as an SMS.
    if (/text\/plain/i.test(contentType) && raw.trim()) body = { source: 'sms', text: raw };
    else return { error: 'invalid_json', status: 400 };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_json', status: 400 };

  const source = body.source ?? 'sms';
  if (source !== 'sms' && source !== 'wallet') return { error: 'unknown_source', status: 400 };

  const item = { source, at: nowIso };
  const receivedAt = validTime(body.receivedAt);
  if (receivedAt) item.receivedAt = receivedAt;

  if (source === 'sms') {
    if (typeof body.text !== 'string' || !body.text.trim()) return { error: 'text_required', status: 400 };
    if (body.text.length > MAX_TEXT) return { error: 'text_too_long', status: 413 };
    item.text = body.text;
    const sender = optString(body.sender, 100);
    if (sender) item.sender = sender;
  } else {
    const amount = body.amount;
    const amountOk = (typeof amount === 'number' && Number.isFinite(amount)) || (typeof amount === 'string' && amount.trim());
    if (!amountOk) return { error: 'amount_required', status: 400 };
    item.amount = typeof amount === 'string' ? amount.slice(0, 100) : amount;
    for (const [field, max] of [['merchant', 200], ['card', 100], ['currency', 20]]) {
      const v = optString(body[field], max);
      if (v) item[field] = v;
    }
    if (typeof body.text === 'string' && body.text.length <= MAX_TEXT && body.text.trim()) item.text = body.text;
  }
  return { item };
}

async function handleIngest(request, env) {
  const denied = await authorize(request, env, 'INGEST_KEY');
  if (denied) return denied;
  const body = await readBody(request);
  if (body.error) return reply({ error: body.error }, body.status, env);

  const now = Date.now();
  const built = buildItem(body.raw, request.headers.get('content-type') || '', new Date(now).toISOString());
  if (built.error) return reply({ error: built.error }, built.status, env);

  const { item } = built;
  const digest = await sha256(JSON.stringify([item.source, item.text, item.sender, item.merchant, item.amount, item.card, item.currency, item.receivedAt]));
  const hash = [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const id = `m:${String(now).padStart(13, '0')}:${hash}`;

  await env.INBOX.put(id, JSON.stringify(item), { expirationTtl: TTL_SECONDS });
  return reply({ ok: true, id }, 201, env);
}

async function handlePull(request, env) {
  const denied = await authorize(request, env, 'PULL_KEY');
  if (denied) return denied;

  const page = await env.INBOX.list({ prefix: 'm:', limit: MAX_PULL });
  const items = (
    await Promise.all(
      page.keys.map(async ({ name }) => {
        const value = await env.INBOX.get(name);
        if (!value) return null; // already deleted
        try {
          return { id: name, ...JSON.parse(value) };
        } catch {
          return null;
        }
      }),
    )
  ).filter(Boolean);
  return reply({ items, more: !page.list_complete }, 200, env);
}

async function handleAck(request, env) {
  const denied = await authorize(request, env, 'PULL_KEY');
  if (denied) return denied;
  const body = await readBody(request);
  if (body.error) return reply({ error: body.error }, body.status, env);

  let ids;
  try {
    ids = JSON.parse(body.raw).ids;
  } catch {
    return reply({ error: 'invalid_json' }, 400, env);
  }
  if (!Array.isArray(ids) || ids.length > MAX_PULL || !ids.every((id) => typeof id === 'string' && ID_RE.test(id))) {
    return reply({ error: 'invalid_ids' }, 400, env);
  }
  await Promise.all(ids.map((id) => env.INBOX.delete(id)));
  return reply({ deleted: ids.length }, 200, env);
}

async function handle(request, env) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  if (request.method === 'GET' && path === '/') {
    return new Response('masroofi inbox', { status: 200, headers: { 'content-type': 'text/plain', ...cors(env) } });
  }
  if (request.method === 'POST' && path === '/i') return handleIngest(request, env);
  if (request.method === 'GET' && path === '/p') return handlePull(request, env);
  if (request.method === 'POST' && path === '/a') return handleAck(request, env);
  return reply({ error: 'not_found' }, 404, env);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      return reply({ error: 'server_error' }, 500, env);
    }
  },
};
