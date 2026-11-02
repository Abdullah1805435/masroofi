// Minimal in-memory stand-in for a Cloudflare KV namespace (put/get/delete/list with prefix, limit, cursor).
export class MockKV {
  constructor() {
    this.map = new Map();
    this.puts = [];
  }
  async put(key, value, options = {}) {
    this.map.set(key, value);
    this.puts.push({ key, options });
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const all = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = all.slice(start, start + limit);
    const complete = start + limit >= all.length;
    return { keys: slice.map((name) => ({ name })), list_complete: complete, cursor: complete ? undefined : String(start + limit) };
  }
}
