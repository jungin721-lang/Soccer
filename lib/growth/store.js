import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const copy = value => value == null ? null : structuredClone(value);
function encode(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Store values must be JSON serializable.');
  return text;
}

/** Durable local development store. Synchronous transactions keep updater CAS atomic. */
export async function createLocalStore(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path.join(dataDir, 'growth.sqlite'));
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, kind TEXT NOT NULL, value BLOB NOT NULL)');
  const read = database.prepare('SELECT kind, value FROM entries WHERE key = ?');
  const set = database.prepare('INSERT INTO entries(key, kind, value) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,value=excluded.value');
  const create = database.prepare('INSERT OR IGNORE INTO entries(key, kind, value) VALUES(?, ?, ?)');
  return {
    async get(key) { const row = read.get(key); return row?.kind === 'json' ? JSON.parse(row.value) : null; },
    async set(key, value) { set.run(key, 'json', encode(value)); },
    async create(key, value) { return create.run(key, 'json', encode(value)).changes === 1; },
    async update(key, updater) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const row = read.get(key);
        const previous = row?.kind === 'json' ? JSON.parse(row.value) : null;
        const next = updater(copy(previous));
        if (next?.then) throw new TypeError('Store updater must be synchronous.');
        set.run(key, 'json', encode(next));
        database.exec('COMMIT');
        return copy(next);
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    async delete(key) { database.prepare('DELETE FROM entries WHERE key = ?').run(key); },
    async list(prefix = '') { return database.prepare('SELECT key FROM entries WHERE substr(key, 1, length(?)) = ? ORDER BY key').all(prefix, prefix).map(row => row.key); },
    async putBinary(key, bytes) { set.run(key, 'binary', Buffer.from(bytes)); },
    async getBinary(key) { const row = read.get(key); return row?.kind === 'binary' ? new Uint8Array(row.value) : null; },
    close() { database.close(); },
  };
}

/** Netlify SDK 11.1.4: strong reads + onlyIfNew / onlyIfMatch conditional writes. */
export async function createNetlifyStore({ blobs } = {}) {
  const sdk = blobs || (await import('@netlify/blobs')).getStore({ name: 'next-xi-growth-v2', consistency: 'strong' });
  return {
    async get(key) { return copy(await sdk.get(key, { type: 'json', consistency: 'strong' })); },
    async set(key, value) { await sdk.setJSON(key, value); },
    async create(key, value) { return (await sdk.setJSON(key, value, { onlyIfNew: true })).modified; },
    async update(key, updater) {
      for (let attempt = 0; attempt < 32; attempt++) {
        const previous = await sdk.getWithMetadata(key, { type: 'json', consistency: 'strong' });
        const next = updater(copy(previous?.data));
        if (next?.then) throw new TypeError('Store updater must be synchronous.');
        encode(next);
        const condition = previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true };
        if (previous && !previous.etag) throw new Error('Strong storage read did not return a concurrency token.');
        const result = await sdk.setJSON(key, next, condition);
        if (result.modified) return copy(next);
      }
      throw Object.assign(new Error('동시에 변경된 기록을 저장하지 못했습니다. 다시 시도해 주세요.'), { status: 503, code: 'storage_busy' });
    },
    async delete(key) { await sdk.delete(key); },
    async list(prefix = '') {
      const keys = [];
      for await (const page of sdk.list({ prefix, paginate: true })) keys.push(...page.blobs.map(blob => blob.key));
      return keys.sort();
    },
    async putBinary(key, bytes) { const value = new Uint8Array(bytes); await sdk.set(key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)); },
    async getBinary(key) { const value = await sdk.get(key, { type: 'arrayBuffer', consistency: 'strong' }); return value == null ? null : new Uint8Array(value); },
  };
}
