import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLocalStore, createNetlifyStore } from '../lib/growth/store.js';
import { createGrowthAPI } from '../lib/growth/api.js';
import { seedState } from '../public/domain.js';
import { blockProviderQuota } from '../lib/growth/provider.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const PASSWORD = 'long-private-password-123';
const CHUNK = 2 * 1024 ** 2;
function req(route, { method = 'GET', body, cookie, headers = {} } = {}) {
  const json = body !== undefined && !Buffer.isBuffer(body) && !(body instanceof Uint8Array);
  return new Request(`https://soccer.example/api/v2${route}`, { method, headers: { ...(method !== 'GET' && method !== 'HEAD' ? { Origin: 'https://soccer.example' } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: json ? JSON.stringify(body) : body }) });
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'next-xi-growth-test-'));
  const store = await createLocalStore(dir); const dispatched = [];
  const api = createGrowthAPI({ store, availability: async () => ({ available: true, reason: 'ready' }), dispatchJob: async (id, token) => { dispatched.push({ id, token }); }, ...options });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, api, dispatched };
}
async function register(api, email = 'parent@example.com') {
  const response = await api(req('/auth/register', { method: 'POST', body: { email, password: PASSWORD, guardianName: '보호자', guardianConsent: true, adult: true } }));
  assert.equal(response.status, 201, await response.clone().text());
  return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user, headers: response.headers };
}
async function upload(api, cookie, bytes = Buffer.from('private-original-video-bytes')) {
  const start = await api(req('/uploads', { method: 'POST', cookie, body: { rightsConsent: true, fileName: 'match.mp4', title: '우리 선수 경기', size: bytes.length, mime: 'video/mp4', target: { kit: 'navy', number: 11, age: 11 }, context: { matchDate: '2026-10-16', position: 'MF', filming: 'clear' } } }));
  assert.equal(start.status, 201, await start.clone().text());
  let value = (await start.json()).upload;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const response = await api(req(`/uploads/${value.id}`, { method: 'PUT', cookie, headers: { 'Upload-Offset': String(offset) }, body: bytes.subarray(offset, offset + CHUNK) }));
    assert.equal(response.status, 200, await response.clone().text()); value = (await response.json()).upload;
  }
  const completed = await api(req(`/uploads/${value.id}/complete`, { method: 'POST', cookie }));
  assert.equal(completed.status, 200, await completed.clone().text());
  return { ...(await completed.json()), upload: value };
}

test('local SQLite persists JSON/binaries across restart and concurrent updates do not lose writes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nx-growth-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let store = await createLocalStore(dir);
  assert.equal(await store.create('counter', { value: 0 }), true); assert.equal(await store.create('counter', { value: 99 }), false);
  await Promise.all(Array.from({ length: 50 }, () => store.update('counter', value => ({ value: value.value + 1 }))));
  await store.putBinary('binary/example', Buffer.from([0, 255, 17])); store.close(); store = await createLocalStore(dir);
  assert.deepEqual(await store.get('counter'), { value: 50 }); assert.deepEqual(await store.getBinary('binary/example'), new Uint8Array([0, 255, 17]));
  assert.deepEqual(await store.list('binary/'), ['binary/example']); await store.delete('counter'); assert.equal(await store.get('counter'), null); store.close();
});

test('Netlify adapter uses strong reads and official conditional writes, retries CAS and paginates keys', async () => {
  const records = new Map(); let version = 0; let conflicts = 0;
  const sdk = {
    async get(key, options) { assert.equal(options.consistency, 'strong'); const row = records.get(key); return row ? structuredClone(row.value) : null; },
    async getWithMetadata(key, options) { assert.equal(options.consistency, 'strong'); const row = records.get(key); return row ? { data: structuredClone(row.value), etag: row.etag } : null; },
    async setJSON(key, value, options = {}) { const old = records.get(key); if ((options.onlyIfNew && old) || (options.onlyIfMatch && old?.etag !== options.onlyIfMatch)) { conflicts++; return { modified: false }; } const etag = String(++version); records.set(key, { value: structuredClone(value), etag }); return { modified: true, etag }; },
    async set(key, value) { records.set(key, { value: value.slice(0), etag: String(++version) }); return { modified: true }; },
    async delete(key) { records.delete(key); },
    async *list({ prefix, paginate }) { assert.equal(paginate, true); const keys = [...records.keys()].filter(key => key.startsWith(prefix)); for (let index = 0; index < keys.length; index += 2) yield { blobs: keys.slice(index, index + 2).map(key => ({ key })) }; },
  };
  const store = await createNetlifyStore({ blobs: sdk });
  assert.equal(await store.create('counter', { value: 0 }), true); assert.equal(await store.create('counter', { value: 4 }), false);
  await Promise.all(Array.from({ length: 20 }, () => store.update('counter', value => ({ value: value.value + 1 }))));
  assert.equal((await store.get('counter')).value, 20); assert.ok(conflicts > 1);
  for (let n = 0; n < 5; n++) await store.set(`owner/${n}`, { n });
  assert.equal((await store.list('owner/')).length, 5); await store.putBinary('bytes', new Uint8Array([7, 9])); assert.deepEqual(await store.getBinary('bytes'), new Uint8Array([7, 9]));
});

test('guardian registration stores salted passwords and opaque HttpOnly sessions; login and logout work', async t => {
  const { api, store } = await fixture(t); const account = await register(api);
  assert.match(account.headers.get('set-cookie'), /HttpOnly/); assert.match(account.headers.get('set-cookie'), /SameSite=Lax/); assert.match(account.headers.get('set-cookie'), /Secure/);
  assert.equal(Object.hasOwn(account.user, 'password'), false);
  const persisted = await store.get(`users/${account.user.id}`); assert.notEqual(persisted.password.hash, PASSWORD); assert.equal(persisted.password.salt.length, 32);
  const sessionKeys = await store.list('sessions/'); assert.equal(sessionKeys.length, 1); assert.equal(sessionKeys[0].includes(account.cookie.split('=')[1]), false);
  assert.equal((await (await api(req('/auth/me', { cookie: account.cookie }))).json()).user.id, account.user.id);
  const workspace = await (await api(req('/workspace', { cookie: account.cookie }))).json(); assert.equal(workspace.consents.guardian, true); assert.equal(workspace.videos.length, 0);
  assert.equal((await api(req('/auth/login', { method: 'POST', body: { email: 'parent@example.com', password: 'incorrect-password' } }))).status, 401);
  const login = await api(req('/auth/login', { method: 'POST', body: { email: 'PARENT@example.com', password: PASSWORD } })); assert.equal(login.status, 200);
  assert.equal((await api(req('/auth/logout', { method: 'POST', cookie: account.cookie }))).status, 200);
  assert.equal((await (await api(req('/auth/me', { cookie: account.cookie }))).json()).user, null);
  assert.equal((await api(req('/workspace', { cookie: account.cookie }))).status, 401);
});

test('registration requires adult guardian consent, password length and unique email; foreign writes cannot mutate state', async t => {
  const { api } = await fixture(t);
  const valid = { email: 'test@example.com', password: PASSWORD, guardianName: '보호자', guardianConsent: true, adult: true };
  for (const change of [{ guardianConsent: false }, { adult: false }, { guardianName: '' }, { password: 'short' }, { email: 'invalid' }]) assert.equal((await api(req('/auth/register', { method: 'POST', body: { ...valid, ...change } }))).status, 400);
  const account = await register(api);
  assert.equal((await api(req('/auth/register', { method: 'POST', body: { ...valid, email: account.user.email } }))).status, 409);
  const workspace = await (await api(req('/workspace', { cookie: account.cookie }))).json();
  const foreign = await api(req('/workspace', { method: 'PUT', body: { ...workspace, profile: { ...workspace.profile, name: 'changed' } }, cookie: account.cookie, headers: { Origin: 'https://other.example' } })); assert.equal(foreign.status, 403);
  assert.equal((await (await api(req('/workspace', { cookie: account.cookie }))).json()).profile.name, '');
});

test('workspace CAS prevents lost updates and clients cannot forge private server records or guardian consent', async t => {
  const { api } = await fixture(t); const account = await register(api);
  const workspace = await (await api(req('/workspace', { cookie: account.cookie }))).json();
  const results = await Promise.all(['선수 A', '선수 B'].map(name => api(req('/workspace', { method: 'PUT', cookie: account.cookie, body: { ...workspace, profile: { ...workspace.profile, name }, videos: [{ id: 'forged' }], analyses: [{ summary: 'invented' }], jobs: [{ status: 'completed' }], consents: { guardian: false, analysis: true, training: true } } }))));
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const saved = await (await api(req('/workspace', { cookie: account.cookie }))).json(); assert.equal(saved.revision, 1); assert.deepEqual(saved.videos, []); assert.deepEqual(saved.analyses, []); assert.equal(saved.consents.guardian, true); assert.equal(saved.consents.analysis, false); assert.equal(saved.consents.training, false);
  const sensitive = await api(req('/workspace', { method: 'PUT', cookie: account.cookie, body: { ...saved, profile: { ...saved.profile, allergies: ['땅콩'] } } })); assert.equal(sensitive.status, 400); assert.equal((await sensitive.json()).code, 'sensitive_consent_required');
  const consented = await api(req('/workspace', { method: 'PUT', cookie: account.cookie, body: { ...saved, profile: { ...saved.profile, allergies: ['땅콩'], sensitiveConsent: true } } })); assert.equal(consented.status, 200);
});

test('private original upload resumes, verifies retries and serves exact ranges across chunk boundaries', async t => {
  const { api, store } = await fixture(t); const account = await register(api); const other = await register(api, 'other@example.com');
  const bytes = Buffer.alloc(CHUNK + 41); for (let n = 0; n < bytes.length; n++) bytes[n] = n % 251;
  const uploaded = await upload(api, account.cookie, bytes);
  const metadata = (await (await api(req(`/uploads/${uploaded.upload.id}`, { cookie: account.cookie }))).json()).upload;
  assert.equal(metadata.offset, bytes.length); assert.equal(metadata.status, 'completed'); assert.equal(Object.hasOwn(metadata, 'chunks'), false);
  assert.equal((await api(req(`/uploads/${metadata.id}`, { cookie: other.cookie }))).status, 404);
  assert.equal((await api(req(`/media/${uploaded.video.id}`))).status, 404); assert.equal((await api(req(`/media/${uploaded.video.id}`, { cookie: other.cookie }))).status, 404);
  const range = await api(req(`/media/${uploaded.video.id}`, { cookie: account.cookie, headers: { Range: `bytes=${CHUNK - 7}-${CHUNK + 11}` } })); assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes ${CHUNK - 7}-${CHUNK + 11}/${bytes.length}`); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(CHUNK - 7, CHUNK + 12));
  const suffix = await api(req(`/media/${uploaded.video.id}`, { cookie: account.cookie, headers: { Range: 'bytes=-9' } })); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-9));
  const head = await api(req(`/media/${uploaded.video.id}`, { method: 'HEAD', cookie: account.cookie })); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await api(req(`/media/${uploaded.video.id}`, { cookie: account.cookie, headers: { Range: 'bytes=1-2,4-5' } }))).status, 416);
  assert.equal((await api(req(`/media/${uploaded.video.id}`, { cookie: account.cookie, headers: { Range: `bytes=${bytes.length}-` } }))).status, 416);
  const raw = await store.get(`videos/${uploaded.video.id}`); assert.ok(raw.chunks.every(chunk => chunk.key.startsWith(`media/${account.user.id}/${uploaded.video.id}/`)));
});

test('resumable uploads enforce contiguous sizes and idempotent chunks without corrupting stored originals', async t => {
  const { api } = await fixture(t); const account = await register(api);
  const initial = await api(req('/uploads', { method: 'POST', cookie: account.cookie, body: { rightsConsent: true, fileName: 'raw.mov', size: CHUNK + 3, mime: 'video/quicktime', title: '원본', target: { kit: 'red', number: 7, age: 12 } } })); const upload = (await initial.json()).upload;
  assert.equal((await api(req(`/uploads/${upload.id}/complete`, { method: 'POST', cookie: account.cookie }))).status, 409);
  assert.equal((await api(req(`/uploads/${upload.id}`, { method: 'PUT', cookie: account.cookie, headers: { 'Upload-Offset': String(CHUNK) }, body: Buffer.from([1, 2, 3]) }))).status, 409);
  assert.equal((await api(req(`/uploads/${upload.id}`, { method: 'PUT', cookie: account.cookie, headers: { 'Upload-Offset': '0' }, body: Buffer.from([1]) }))).status, 400);
  const chunk = Buffer.alloc(CHUNK, 19);
  for (let repeat = 0; repeat < 2; repeat++) assert.equal((await api(req(`/uploads/${upload.id}`, { method: 'PUT', cookie: account.cookie, headers: { 'Upload-Offset': '0' }, body: chunk }))).status, 200);
  assert.equal((await api(req(`/uploads/${upload.id}`, { method: 'PUT', cookie: account.cookie, headers: { 'Upload-Offset': '0' }, body: Buffer.alloc(CHUNK, 20) }))).status, 409);
  const resumed = await (await api(req(`/uploads/${upload.id}`, { cookie: account.cookie }))).json(); assert.equal(resumed.upload.offset, CHUNK);
  assert.equal((await api(req(`/uploads/${upload.id}`, { method: 'DELETE', cookie: account.cookie }))).status, 200);
  assert.equal((await api(req(`/uploads/${upload.id}`, { cookie: account.cookie }))).status, 404);
});

test('durable jobs keep credentials private, authorize worker media only for the job and preserve retry checkpoints', async t => {
  const { api, store, dispatched } = await fixture(t); const account = await register(api); const other = await register(api, 'coach@example.com'); const uploaded = await upload(api, account.cookie);
  assert.equal((await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: uploaded.video.id } }))).status, 400);
  const queued = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: uploaded.video.id, analysisConsent: true } })); assert.equal(queued.status, 202); const job = (await queued.json()).job; assert.equal(job.status, 'queued'); assert.equal(dispatched.length, 1);
  assert.equal(Object.hasOwn(job, 'tokenHash'), false); assert.equal(Object.hasOwn(job, 'clips'), false);
  const internal = await store.get(`jobs/${job.id}`); assert.equal(internal.tokenHash, hash(dispatched[0].token)); assert.equal(Object.hasOwn(internal, 'token'), false); assert.ok(Number.isFinite(Date.parse(internal.analysisConsentAt))); assert.equal(internal.analysisConsentVersion, '2026-10-growth-v2');
  assert.equal((await api(req(`/jobs/${job.id}`, { cookie: other.cookie }))).status, 404); assert.equal((await api(req('/jobs', { cookie: other.cookie }))).status, 200);
  const bearer = { Authorization: `Bearer ${dispatched[0].token}`, Range: 'bytes=0-6' };
  const media = await api(req(`/media/${uploaded.video.id}?jobId=${job.id}`, { headers: bearer })); assert.equal(media.status, 206); assert.equal((await media.arrayBuffer()).byteLength, 7);
  const duplicate = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: uploaded.video.id, analysisConsent: true } })); assert.equal((await duplicate.json()).job.id, job.id); assert.equal(dispatched.length, 1);
  assert.equal((await api(req(`/jobs/${job.id}/cancel`, { method: 'POST', cookie: account.cookie }))).status, 200); assert.equal((await api(req(`/media/${uploaded.video.id}?jobId=${job.id}`, { headers: bearer }))).status, 404);
  await store.update(`jobs/${job.id}`, current => ({ ...current, progress: { sampledCount: 24, detectedCount: 1 }, clips: [{ id: 'checkpoint' }], result: { summary: 'already saved' } }));
  const retry = await api(req(`/jobs/${job.id}/retry`, { method: 'POST', cookie: account.cookie })); assert.equal(retry.status, 202); const restored = await store.get(`jobs/${job.id}`); assert.equal(restored.progress.sampledCount, 24); assert.equal(restored.clips[0].id, 'checkpoint'); assert.equal(restored.result.summary, 'already saved'); assert.equal(restored.leaseOwner, null); assert.equal(restored.attempt, 2); assert.equal(dispatched.length, 2); assert.notEqual(dispatched[1].token, dispatched[0].token); assert.equal(restored.analysisConsentAt, internal.analysisConsentAt);
});

test('analysis configuration failures are visible before a job is queued or dispatched', async t => {
  const { api, store } = await fixture(t, { availability: async () => ({ available: false, reason: 'invalid_key_format' }) }); const account = await register(api); const uploaded = await upload(api, account.cookie);
  const response = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: uploaded.video.id, analysisConsent: true } })); assert.equal(response.status, 503); assert.equal((await response.json()).code, 'analysis_key_format_invalid'); assert.deepEqual(await store.list('jobs/'), []);
});

test('video deletion removes owned chunks and jobs while another user remains isolated', async t => {
  const { api, store } = await fixture(t); const first = await register(api); const second = await register(api, 'second@example.com'); const video1 = await upload(api, first.cookie); const video2 = await upload(api, second.cookie);
  const queued = await api(req('/jobs', { method: 'POST', cookie: first.cookie, body: { videoId: video1.video.id, analysisConsent: true } })); const job = (await queued.json()).job;
  assert.equal((await api(req(`/videos/${video1.video.id}`, { method: 'DELETE', cookie: second.cookie }))).status, 404);
  assert.equal((await api(req(`/videos/${video1.video.id}`, { method: 'DELETE', cookie: first.cookie }))).status, 200);
  assert.equal(await store.get(`videos/${video1.video.id}`), null); assert.equal(await store.get(`jobs/${job.id}`), null); assert.deepEqual(await store.list(`media/${first.user.id}/${video1.video.id}/`), []);
  const other = await api(req(`/media/${video2.video.id}`, { cookie: second.cookie })); assert.equal(other.status, 200); assert.ok((await other.arrayBuffer()).byteLength);
});

test('password-confirmed account deletion erases user-owned originals, sessions and workspace without affecting others', async t => {
  const { api, store } = await fixture(t); const first = await register(api); const second = await register(api, 'keep@example.com'); await upload(api, first.cookie); await upload(api, second.cookie);
  assert.equal((await api(req('/auth/account', { method: 'DELETE', cookie: first.cookie, body: { password: 'wrong' } }))).status, 401);
  assert.equal((await api(req('/auth/account', { method: 'DELETE', cookie: first.cookie, body: { password: PASSWORD } }))).status, 200);
  assert.equal(await store.get(`users/${first.user.id}`), null); assert.equal(await store.get(`workspaces/${first.user.id}`), null); assert.deepEqual(await store.list(`media/${first.user.id}/`), []);
  assert.equal((await (await api(req('/auth/me', { cookie: first.cookie }))).json()).user, null); assert.equal((await (await api(req('/auth/me', { cookie: second.cookie }))).json()).user.id, second.user.id);
});

test('simultaneous different chunks at the same offset cannot overwrite the winning original', async t => {
  const { api } = await fixture(t); const account = await register(api);
  const response = await api(req('/uploads', { method: 'POST', cookie: account.cookie, body: { rightsConsent: true, fileName: 'concurrent.mp4', size: 4, mime: 'video/mp4', target: { kit: 'navy', number: 11, age: 11 } } })); const initial = (await response.json()).upload;
  const parts = [Buffer.from([1, 2, 3, 4]), Buffer.from([9, 8, 7, 6])];
  const results = await Promise.all(parts.map(body => api(req(`/uploads/${initial.id}`, { method: 'PUT', cookie: account.cookie, headers: { 'Upload-Offset': '0' }, body }))));
  assert.deepEqual(results.map(value => value.status).sort(), [200, 409]);
  const winner = results.findIndex(value => value.status === 200);
  const complete = await api(req(`/uploads/${initial.id}/complete`, { method: 'POST', cookie: account.cookie })); const video = (await complete.json()).video;
  assert.deepEqual(Buffer.from(await (await api(req(`/media/${video.id}`, { cookie: account.cookie }))).arrayBuffer()), parts[winner]);
});

test('concurrent requests for one video enqueue at most one paid job', async t => {
  const { api, store, dispatched } = await fixture(t); const account = await register(api); const uploaded = await upload(api, account.cookie);
  const responses = await Promise.all(Array.from({ length: 4 }, () => api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: uploaded.video.id, analysisConsent: true } }))));
  assert.ok(responses.some(response => response.status === 202)); assert.equal(dispatched.length, 1); assert.equal((await store.list('jobs/')).length, 1);
});

test('active and per-account daily job limits are bounded atomically and completed jobs release active capacity', async t => {
  const { api, store, dispatched } = await fixture(t); const account = await register(api);
  const videos = []; for (let n = 0; n < 4; n++) videos.push((await upload(api, account.cookie)).video);
  const responses = await Promise.all(videos.slice(0, 3).map(video => api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: video.id, analysisConsent: true } }))));
  assert.equal(responses.filter(response => response.status === 202).length, 2); assert.equal(responses.filter(response => response.status === 429).length, 1); assert.equal(dispatched.length, 2);
  for (const key of await store.list('jobs/')) await store.update(key, job => ({ ...job, status: 'completed' }));
  const third = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: videos[3].id, analysisConsent: true } })); assert.equal(third.status, 202);
  for (const key of await store.list('jobs/')) await store.update(key, job => ({ ...job, status: 'completed' }));
  const fourth = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: videos[0].id, analysisConsent: true } })); assert.equal(fourth.status, 429); assert.equal((await fourth.json()).code, 'user_daily_job_limit');
});

test('global daily budget is shared across accounts and remains consumed after account deletion', async t => {
  const { api, store } = await fixture(t, { env: { SOCCER_MAX_DAILY_JOBS: '1' } }); const first = await register(api); const second = await register(api, 'budget@example.com'); const one = await upload(api, first.cookie); const two = await upload(api, second.cookie);
  const initial = await api(req('/jobs', { method: 'POST', cookie: first.cookie, body: { videoId: one.video.id, analysisConsent: true } })); assert.equal(initial.status, 202);
  const budgetKey = (await store.list('budgets/global/'))[0]; assert.equal((await store.get(budgetKey)).entries.length, 1);
  const deleted = await api(req('/auth/account', { method: 'DELETE', cookie: first.cookie, body: { password: PASSWORD } })); assert.equal(deleted.status, 200); assert.equal((await store.get(budgetKey)).entries.length, 1);
  const limited = await api(req('/jobs', { method: 'POST', cookie: second.cookie, body: { videoId: two.video.id, analysisConsent: true } })); assert.equal(limited.status, 429); assert.equal((await limited.json()).code, 'global_daily_job_limit');
});

test('retry is limited to three dispatched attempts per job per KST day while retaining checkpoint results', async t => {
  const { api, store, dispatched } = await fixture(t); const account = await register(api); const uploaded = await upload(api, account.cookie);
  const queued = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: uploaded.video.id, analysisConsent: true } })); const job = (await queued.json()).job;
  for (let attempt = 2; attempt <= 3; attempt++) { await store.update(`jobs/${job.id}`, current => ({ ...current, status: 'failed', progress: { sampledCount: 12 }, clips: [{ id: 'retained' }] })); const retried = await api(req(`/jobs/${job.id}/retry`, { method: 'POST', cookie: account.cookie })); assert.equal(retried.status, 202); }
  await store.update(`jobs/${job.id}`, current => ({ ...current, status: 'failed' }));
  const fourth = await api(req(`/jobs/${job.id}/retry`, { method: 'POST', cookie: account.cookie })); assert.equal(fourth.status, 429); assert.equal((await fourth.json()).code, 'job_attempt_limit'); assert.equal(dispatched.length, 3); assert.equal((await store.get(`jobs/${job.id}`)).clips[0].id, 'retained');
});

test('an unstarted dispatch failure invalidates its token and refunds budgets without opening a billing bypass', async t => {
  let firstToken; let calls = 0;
  const { api, store } = await fixture(t, { env: { SOCCER_MAX_DAILY_JOBS: '1' }, dispatchJob: async (_id, token) => { calls++; if (calls === 1) { firstToken = token; throw new Error('dispatch unreachable'); } } });
  const account = await register(api); const uploaded = await upload(api, account.cookie);
  const failed = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: uploaded.video.id, analysisConsent: true } })); assert.equal(failed.status, 503);
  const job = await store.get((await store.list('jobs/'))[0]); assert.notEqual(job.tokenHash, hash(firstToken)); assert.equal(job.status, 'failed');
  for (const key of await store.list('budgets/global/')) assert.equal((await store.get(key)).entries.length, 0);
  const retry = await api(req(`/jobs/${job.id}/retry`, { method: 'POST', cookie: account.cookie })); assert.equal(retry.status, 202); assert.equal(calls, 2);
});

test('health check-ins require separate sensitive consent and withdrawal cannot retain health records', async t => {
  const { api } = await fixture(t); const account = await register(api);
  const current = await (await api(req('/workspace', { cookie: account.cookie }))).json();
  const checkins = [{ date: '2026-10-16', sleepQuality: 'good', fatigue: 'fresh', mood: 'good', pain: false, notes: '' }];
  const unconsented = await api(req('/workspace', { method: 'PUT', cookie: account.cookie, body: { ...current, checkins } })); assert.equal(unconsented.status, 400); assert.equal((await unconsented.json()).code, 'sensitive_consent_required');
  const consented = await api(req('/workspace', { method: 'PUT', cookie: account.cookie, body: { ...current, checkins, profile: { ...current.profile, sensitiveConsent: true } } })); assert.equal(consented.status, 200); const saved = await consented.json();
  const retained = await api(req('/workspace', { method: 'PUT', cookie: account.cookie, body: { ...saved, profile: { ...saved.profile, sensitiveConsent: false } } })); assert.equal(retained.status, 400);
  const cleared = await api(req('/workspace', { method: 'PUT', cookie: account.cookie, body: { ...saved, checkins: [], profile: { ...saved.profile, sensitiveConsent: false } } })); assert.equal(cleared.status, 200); assert.deepEqual((await cleared.json()).checkins, []);
});

test('withdrawing analysis consent cancels active jobs and prevents checkpoint retry until new consent', async t => {
  const { api, store, dispatched } = await fixture(t); const account = await register(api); const uploaded = await upload(api, account.cookie);
  const queued = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: uploaded.video.id, analysisConsent: true } })); const job = (await queued.json()).job;
  const current = await (await api(req('/workspace', { cookie: account.cookie }))).json(); assert.equal(current.consents.analysis, true);
  const withdrawn = await api(req('/workspace', { method: 'PUT', cookie: account.cookie, body: { ...current, consents: { ...current.consents, analysis: false } } })); assert.equal(withdrawn.status, 200); assert.equal((await withdrawn.json()).consents.analysis, false);
  const cancelled = await store.get(`jobs/${job.id}`); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.cancelRequested, true);
  const retry = await api(req(`/jobs/${job.id}/retry`, { method: 'POST', cookie: account.cookie })); assert.equal(retry.status, 400); assert.equal((await retry.json()).code, 'analysis_consent_required'); assert.equal(dispatched.length, 1);
});

test('large private videos bound open-ended range responses and require ranges instead of truncating full downloads', async t => {
  const { api } = await fixture(t); const account = await register(api);
  const bytes = Buffer.alloc(5 * 1024 ** 2 + 23); for (let n = 0; n < bytes.length; n++) bytes[n] = n % 241;
  const saved = await upload(api, account.cookie, bytes);
  const entire = await api(req(`/media/${saved.video.id}`, { cookie: account.cookie })); assert.equal(entire.status, 413); assert.equal((await entire.json()).code, 'range_required'); assert.equal(entire.headers.get('accept-ranges'), 'bytes');
  const head = await api(req(`/media/${saved.video.id}`, { method: 'HEAD', cookie: account.cookie })); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length));
  const first = await api(req(`/media/${saved.video.id}`, { cookie: account.cookie, headers: { Range: 'bytes=0-' } })); assert.equal(first.status, 206); assert.equal(first.headers.get('content-range'), `bytes 0-${4 * 1024 ** 2 - 1}/${bytes.length}`); assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes.subarray(0, 4 * 1024 ** 2));
  const next = await api(req(`/media/${saved.video.id}`, { cookie: account.cookie, headers: { Range: `bytes=${4 * 1024 ** 2}-` } })); assert.equal(next.status, 206); assert.equal(next.headers.get('content-range'), `bytes ${4 * 1024 ** 2}-${bytes.length - 1}/${bytes.length}`); assert.deepEqual(Buffer.from(await next.arrayBuffer()), bytes.subarray(4 * 1024 ** 2));
});

test('pilot upload reservations atomically allow three pending originals and release capacity on deletion', async t => {
  const { api, store } = await fixture(t); const account = await register(api);
  const body = { rightsConsent: true, fileName: 'large.mp4', size: 2 * 1024 ** 3, mime: 'video/mp4', target: { kit: 'navy', number: 11, age: 11 } };
  const results = await Promise.all(Array.from({ length: 5 }, () => api(req('/uploads', { method: 'POST', cookie: account.cookie, body }))));
  assert.equal(results.filter(result => result.status === 201).length, 3); assert.equal(results.filter(result => result.status === 409).length, 2); assert.equal((await store.list('uploads/')).length, 3);
  assert.equal((await (await api(req('/uploads', { cookie: account.cookie }))).json()).uploads.length, 3);
  const one = (await results.find(result => result.status === 201).json()).upload;
  assert.equal((await api(req(`/uploads/${one.id}`, { method: 'DELETE', cookie: account.cookie }))).status, 200);
  assert.equal((await api(req('/uploads', { method: 'POST', cookie: account.cookie, body }))).status, 201);
});

test('the six-gigabyte declared account quota includes already-ready originals when initializing reservations', async t => {
  const { api, store } = await fixture(t); const account = await register(api);
  // Seed pre-existing large originals' server metadata; this quota test need not allocate 6GB.
  for (let index = 0; index < 3; index++) { const id = randomUUID(); await store.set(`videos/${id}`, { id, userId: account.user.id, size: 2 * 1024 ** 3, status: 'ready' }); }
  const response = await api(req('/uploads', { method: 'POST', cookie: account.cookie, body: { rightsConsent: true, fileName: 'one-byte.mp4', size: 1, mime: 'video/mp4', target: { kit: 'red', number: 7, age: 12 } } })); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'account_storage_limit'); assert.deepEqual(await store.list('uploads/'), []);
});

test('ten completed pilot videos exhaust per-account reservations until an owned video is deleted', async t => {
  const { api } = await fixture(t); const account = await register(api); let first;
  for (let index = 0; index < 10; index++) { const saved = await upload(api, account.cookie, Buffer.from([index])); if (!first) first = saved.video; }
  const body = { rightsConsent: true, fileName: 'extra.mp4', size: 1, mime: 'video/mp4', target: { kit: 'navy', number: 11, age: 11 } };
  const limited = await api(req('/uploads', { method: 'POST', cookie: account.cookie, body })); assert.equal(limited.status, 409); assert.equal((await limited.json()).code, 'upload_limit');
  assert.equal((await api(req(`/videos/${first.id}`, { method: 'DELETE', cookie: account.cookie }))).status, 200);
  assert.equal((await api(req('/uploads', { method: 'POST', cookie: account.cookie, body }))).status, 201);
});

test('original upload requires explicit rights consent and keeps its timestamp/version private after completion', async t => {
  const { api, store } = await fixture(t); const account = await register(api);
  const body = { fileName: 'rights.mp4', size: 1, mime: 'video/mp4', target: { kit: 'navy', number: 11, age: 11 } };
  for (const consent of [undefined, false, 'true']) {
    const response = await api(req('/uploads', { method: 'POST', cookie: account.cookie, body: { ...body, rightsConsent: consent } })); assert.equal(response.status, 400); assert.equal((await response.json()).code, 'video_rights_consent_required');
  }
  assert.deepEqual(await store.list('uploads/'), []);
  const response = await api(req('/uploads', { method: 'POST', cookie: account.cookie, body: { ...body, rightsConsent: true } })); assert.equal(response.status, 201); const upload = (await response.json()).upload;
  assert.equal(Object.hasOwn(upload, 'rightsConsentAt'), false); assert.equal(Object.hasOwn(upload, 'rightsConsentVersion'), false);
  const saved = await store.get(`uploads/${upload.id}`); assert.ok(Number.isFinite(Date.parse(saved.rightsConsentAt))); assert.equal(saved.rightsConsentVersion, '2026-10-growth-v2-video-rights');
  assert.equal((await api(req(`/uploads/${upload.id}`, { method: 'PUT', cookie: account.cookie, headers: { 'Upload-Offset': '0' }, body: Buffer.from([1]) }))).status, 200);
  const completed = await api(req(`/uploads/${upload.id}/complete`, { method: 'POST', cookie: account.cookie })); assert.equal(completed.status, 200); const publicData = await completed.json();
  assert.equal(Object.hasOwn(publicData.video, 'rightsConsentAt'), false); assert.equal(Object.hasOwn(publicData.video, 'rightsConsentVersion'), false); assert.equal(JSON.stringify(publicData.workspace).includes('rightsConsent'), false);
  const privateVideo = await store.get(`videos/${upload.videoId}`); assert.equal(privateVideo.rightsConsentAt, saved.rightsConsentAt); assert.equal(privateVideo.rightsConsentVersion, saved.rightsConsentVersion);
});

function legacyArchive() {
  const archive = seedState(); const id = `local-${randomUUID()}`; const stamp = '2026-10-16T00:00:00.000Z';
  archive.player.name = '이전 선수';
  archive.videos.push({ id, kind: 'file', title: '이전 경기 원본', fileName: 'old.mp4', size: 17, mime: 'video/mp4', duration: 20, lastModified: 0, start: 0, source: '원본 파일', addedAt: stamp });
  archive.observations.push({ id: 'legacy-observation', videoId: id, skill: 'touch', time: 4, rating: 3, note: '이전 브라우저의 직접 관찰 기록', type: 'note', createdAt: stamp });
  archive.completed = ['habit-0'];
  archive.snapshots = [{ id: 'legacy-snapshot', createdAt: stamp, observationCount: 1, scores: [3, null, null, null, null, null, null, null] }];
  archive.analyses.push({ id: 'legacy-analysis', videoId: id, createdAt: stamp, start: 0, end: 12, model: 'previous-model', result: { identified: true, summary: '이전 브라우저의 AI 관찰', observations: [{ skill: 'move', time: 5, note: '패스 지원 위치에서 보인 장면', type: 'note', confidence: 'medium' }], limitations: ['이전 기록이며 서버에서 검증하지 않았습니다.'], nextAction: '다음 경기의 실제 장면을 다시 확인합니다.' } });
  return archive;
}

test('legacy import requires consent and valid old data without changing the trusted growth workspace', async t => {
  const { api, store } = await fixture(t); const account = await register(api); const archive = legacyArchive();
  assert.equal((await api(req('/imports'))).status, 401);
  for (const importConsent of [undefined, false, 'true']) { const response = await api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive, importConsent } })); assert.equal(response.status, 400); assert.equal((await response.json()).code, 'import_consent_required'); }
  const invalid = structuredClone(archive); invalid.player.number = 7;
  const rejected = await api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive: invalid, importConsent: true } })); assert.equal(rejected.status, 400); assert.equal((await rejected.json()).code, 'invalid_legacy_archive');
  assert.deepEqual(await store.list('imports/'), []);
  const current = await (await api(req('/workspace', { cookie: account.cookie }))).json(); assert.deepEqual(current.analyses, []); assert.deepEqual(current.observations, []); assert.equal(current.profile.name, '');
});

test('legacy archive strips unknown secret fields, preserves separate records and marks every response unverified', async t => {
  const { api, store } = await fixture(t); const account = await register(api); const archive = legacyArchive();
  archive.apiKey = 'TOP_SECRET_DO_NOT_STORE'; archive.accessCode = 'TOP_SECRET_DO_NOT_STORE'; archive.player.apiKey = 'TOP_SECRET_DO_NOT_STORE'; archive.player.password = 'TOP_SECRET_DO_NOT_STORE'; archive.videos[1].blob = 'TOP_SECRET_DO_NOT_STORE'; archive.observations[0].rawFrames = 'TOP_SECRET_DO_NOT_STORE';
  const response = await api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive, importConsent: true, source: 'server_verified', title: '이전 기록 보관' } })); assert.equal(response.status, 201); const metadata = (await response.json()).import;
  assert.equal(metadata.source, 'legacy_browser_unverified'); assert.match(metadata.label, /서버 검증 안 됨/); assert.equal(metadata.counts.observations, 1); assert.equal(metadata.counts.analyses, 1); assert.equal(metadata.counts.snapshots, 1); assert.equal(metadata.counts.completed, 1); assert.equal(metadata.mappedVideos, 0); assert.equal(Object.hasOwn(metadata, 'archive'), false); assert.equal(Object.hasOwn(metadata, 'contentHash'), false);
  const detail = (await (await api(req(`/imports/${metadata.id}`, { cookie: account.cookie }))).json()).import;
  assert.equal(detail.archive.observations[0].rating, 3); assert.equal(detail.archive.analyses[0].model, 'previous-model'); assert.equal(detail.source, 'legacy_browser_unverified'); assert.equal(JSON.stringify(detail).includes('TOP_SECRET_DO_NOT_STORE'), false);
  const privateRecord = await store.get(`imports/${metadata.id}`); assert.ok(Number.isFinite(Date.parse(privateRecord.importConsentAt))); assert.equal(privateRecord.importConsentVersion, '2026-10-growth-v2-legacy-archive'); assert.equal(JSON.stringify(privateRecord).includes('TOP_SECRET_DO_NOT_STORE'), false);
  const workspace = await (await api(req('/workspace', { cookie: account.cookie }))).json(); assert.deepEqual(workspace.videos, []); assert.deepEqual(workspace.observations, []); assert.deepEqual(workspace.analyses, []);
});

test('legacy archives remain owner-private and mapping requires registered old and owned completed new video IDs', async t => {
  const { api } = await fixture(t); const first = await register(api); const other = await register(api, 'archive-other@example.com'); const mine = await upload(api, first.cookie); const theirs = await upload(api, other.cookie); const archive = legacyArchive(); const oldId = archive.videos[1].id;
  for (const map of [[{ oldId, newId: theirs.video.id }], [{ oldId, newId: randomUUID() }], [{ oldId: 'unknown-old-video', newId: mine.video.id }], [{ oldId, newId: mine.video.id }, { oldId, newId: mine.video.id }]]) { const response = await api(req('/imports', { method: 'POST', cookie: first.cookie, body: { archive, videoMap: map, importConsent: true } })); assert.ok([400, 404].includes(response.status)); }
  const response = await api(req('/imports', { method: 'POST', cookie: first.cookie, body: { archive, videoMap: [{ oldId, newId: mine.video.id }], importConsent: true } })); assert.equal(response.status, 201); const saved = (await response.json()).import; assert.equal(saved.mappedVideos, 1);
  const detail = (await (await api(req(`/imports/${saved.id}`, { cookie: first.cookie }))).json()).import; assert.deepEqual(detail.idMap, [{ oldId, newId: mine.video.id }]);
  assert.deepEqual((await (await api(req('/imports', { cookie: other.cookie }))).json()).imports, []); assert.equal((await api(req(`/imports/${saved.id}`, { cookie: other.cookie }))).status, 404); assert.equal((await api(req(`/imports/${saved.id}`, { method: 'DELETE', cookie: other.cookie }))).status, 404);
});

test('legacy import is idempotent under concurrent duplicate requests and sanitizes before hashing', async t => {
  const { api, store } = await fixture(t); const account = await register(api); const archive = legacyArchive();
  const results = await Promise.all(Array.from({ length: 4 }, () => api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive, idMap: [], importConsent: true } }))));
  assert.equal(results.filter(response => response.status === 201).length, 1); assert.equal(results.filter(response => response.status === 200).length, 3);
  const ids = await Promise.all(results.map(async response => (await response.json()).import.id)); assert.equal(new Set(ids).size, 1); assert.equal((await store.list('imports/')).length, 1);
  const extra = structuredClone(archive); extra.apiKey = 'stripped'; extra.player.sessionToken = 'stripped';
  const repeated = await api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive: extra, importConsent: true, title: '다른 제목은 중복을 만들지 않음' } })); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).import.id, ids[0]);
});

test('legacy import archive limit is atomic, duplicates remain readable and deleting releases its slot', async t => {
  const { api, store } = await fixture(t); const account = await register(api); const archives = Array.from({ length: 12 }, (_, index) => { const archive = legacyArchive(); archive.player.name = `이전 선수 ${index}`; return archive; });
  const results = await Promise.all(archives.map(archive => api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive, importConsent: true } })))); assert.equal(results.filter(response => response.status === 201).length, 10); assert.equal(results.filter(response => response.status === 409).length, 2); assert.equal((await store.list('imports/')).length, 10);
  const firstIndex = results.findIndex(response => response.status === 201); const first = (await results[firstIndex].json()).import;
  const duplicate = await api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive: archives[firstIndex], importConsent: true } })); assert.equal(duplicate.status, 200);
  assert.equal((await api(req(`/imports/${first.id}`, { method: 'DELETE', cookie: account.cookie }))).status, 200); assert.equal((await api(req(`/imports/${first.id}`, { cookie: account.cookie }))).status, 404);
  const replacement = await api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive: archives[11], importConsent: true } })); assert.equal(replacement.status, 201); assert.equal((await store.list('imports/')).length, 10);
});

test('deleting a mapped original deletes its entire linked legacy archive and account deletion erases unmapped archives', async t => {
  const { api, store } = await fixture(t); const account = await register(api); const video = (await upload(api, account.cookie)).video; const archive = legacyArchive();
  const linked = await api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive, videoMap: [{ oldId: archive.videos[1].id, newId: video.id }], importConsent: true } })); const linkedId = (await linked.json()).import.id;
  const separate = legacyArchive(); separate.player.name = '연결하지 않은 기록'; const unlinked = await api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive: separate, importConsent: true } })); const unlinkedId = (await unlinked.json()).import.id;
  assert.equal((await api(req(`/videos/${video.id}`, { method: 'DELETE', cookie: account.cookie }))).status, 200); assert.equal(await store.get(`imports/${linkedId}`), null); assert.ok(await store.get(`imports/${unlinkedId}`));
  assert.equal((await api(req('/auth/account', { method: 'DELETE', cookie: account.cookie, body: { password: PASSWORD } }))).status, 200); assert.deepEqual(await store.list('imports/'), []); assert.equal(await store.get(`import-quotas/${account.user.id}`), null);
});

test('oversized legacy import bodies are rejected before storage even if their extra fields would be stripped', async t => {
  const { api, store } = await fixture(t); const account = await register(api); const archive = legacyArchive(); archive.unknown = 'x'.repeat(2_000_001);
  const response = await api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive, importConsent: true } })); assert.equal(response.status, 413); assert.deepEqual(await store.list('imports/'), []);
});

test('backup-first legacy migration progressively merges video mappings into one immutable archive and rejects duplicate final targets', async t => {
  const { api, store } = await fixture(t); const account = await register(api); const archive = legacyArchive();
  archive.videos.push({ ...archive.videos[1], id: `local-${randomUUID()}`, title: '두 번째 이전 원본' });
  const oldFirst = archive.videos[1].id; const oldSecond = archive.videos[2].id;
  const first = (await upload(api, account.cookie)).video; const second = (await upload(api, account.cookie)).video; const replacement = (await upload(api, account.cookie)).video;
  const post = videoMap => api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive, videoMap, importConsent: true } }));
  const backup = await post([]); assert.equal(backup.status, 201); const initial = (await backup.json()).import; assert.equal(initial.mappedVideos, 0);
  const one = await post([{ oldId: oldFirst, newId: first.id }]); assert.equal(one.status, 200); const firstMapping = (await one.json()).import; assert.equal(firstMapping.id, initial.id); assert.equal(firstMapping.mappedVideos, 1);
  const two = await post([{ oldId: oldSecond, newId: second.id }]); assert.equal(two.status, 200); const secondMapping = (await two.json()).import; assert.equal(secondMapping.id, initial.id); assert.equal(secondMapping.mappedVideos, 2);
  const privateBefore = await store.get(`imports/${initial.id}`);
  const remapped = await post([{ oldId: oldFirst, newId: replacement.id }]); assert.equal(remapped.status, 200); assert.equal((await remapped.json()).import.id, initial.id);
  const privateAfter = await store.get(`imports/${initial.id}`); assert.equal(privateAfter.idMap.find(mapping => mapping.oldId === oldFirst).newId, replacement.id); assert.deepEqual(privateAfter.archive, privateBefore.archive); assert.equal(privateAfter.importConsentAt, privateBefore.importConsentAt); assert.equal(privateAfter.source, 'legacy_browser_unverified');
  const duplicateTarget = await post([{ oldId: oldSecond, newId: replacement.id }]); assert.equal(duplicateTarget.status, 400); assert.equal((await duplicateTarget.json()).code, 'invalid_import_mapping');
  const detail = (await (await api(req(`/imports/${initial.id}`, { cookie: account.cookie }))).json()).import; assert.equal(detail.idMap.length, 2); assert.equal(detail.idMap.find(mapping => mapping.oldId === oldSecond).newId, second.id); assert.equal((await store.list('imports/')).length, 1);
});

test('concurrent partial legacy mapping checkpoints merge without dropping a previously saved mapping', async t => {
  const { api } = await fixture(t); const account = await register(api); const archive = legacyArchive(); archive.videos.push({ ...archive.videos[1], id: `local-${randomUUID()}` });
  const first = (await upload(api, account.cookie)).video; const second = (await upload(api, account.cookie)).video;
  const initial = await api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive, importConsent: true } })); const id = (await initial.json()).import.id;
  const responses = await Promise.all([[archive.videos[1].id, first.id], [archive.videos[2].id, second.id]].map(([oldId, newId]) => api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive, idMap: [{ oldId, newId }], importConsent: true } }))));
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  const stored = (await (await api(req(`/imports/${id}`, { cookie: account.cookie }))).json()).import; assert.equal(stored.idMap.length, 2); assert.equal(new Set(stored.idMap.map(mapping => mapping.newId)).size, 2);
});

test('provider quota readiness stays distinct from configuration and never exposes private probe credentials', async t => {
  const { api, store } = await fixture(t);
  const unknown = await (await api(req('/status'))).json(); assert.equal(unknown.available, true); assert.equal(unknown.configured, true); assert.equal(unknown.liveVerified, false);
  const blocked = await blockProviderQuota(store);
  await store.update('providers/openai', current => ({ ...current, probeLease: { owner: 'private-probe-job', token: 'PRIVATE_PROBE_TOKEN', until: new Date(Date.now() + 120000).toISOString() } }));
  const response = await api(req('/status')); assert.equal(response.status, 200); const status = await response.json(); assert.equal(status.available, false); assert.equal(status.reason, 'provider_quota'); assert.equal(status.configured, true); assert.equal(status.liveVerified, false); assert.equal(status.retryAt, blocked.retryAt); assert.equal(status.checkedAt, blocked.checkedAt);
  const text = JSON.stringify(status); assert.equal(text.includes('PRIVATE_PROBE_TOKEN'), false); assert.equal(text.includes('private-probe-job'), false); assert.equal(Object.hasOwn(status, 'probeLease'), false); assert.equal(Object.hasOwn(status, 'version'), false);
});

test('quota-blocked provider admits and deduplicates consented durable jobs without dispatch or fabricated analysis', async t => {
  const { api, store, dispatched } = await fixture(t); const account = await register(api); const video = (await upload(api, account.cookie)).video; const provider = await blockProviderQuota(store);
  const response = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: video.id, analysisConsent: true } })); assert.equal(response.status, 202); const job = (await response.json()).job; assert.equal(job.status, 'blocked'); assert.equal(job.stage, 'quota'); assert.equal(job.retryAt, provider.retryAt); assert.equal(job.error.code, 'analysis_quota_exceeded'); assert.equal(dispatched.length, 0); assert.equal(Object.hasOwn(job, 'tokenHash'), false); assert.equal(Object.hasOwn(job, 'probeToken'), false);
  const duplicate = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: video.id, analysisConsent: true } })); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).job.id, job.id); assert.equal((await store.list('jobs/')).length, 1); assert.equal(dispatched.length, 0);
  const jobs = (await (await api(req('/jobs', { cookie: account.cookie }))).json()).jobs; assert.equal(jobs[0].retryAt, provider.retryAt);
  const workspace = await (await api(req('/workspace', { cookie: account.cookie }))).json(); assert.equal(workspace.consents.analysis, true); assert.deepEqual(workspace.analyses, []);
});

test('manual retry cannot bypass quota cooldown or treat elapsed time as provider recovery', async t => {
  const { api, store, dispatched } = await fixture(t); const account = await register(api); const video = (await upload(api, account.cookie)).video; await blockProviderQuota(store);
  const response = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: video.id, analysisConsent: true } })); const job = (await response.json()).job;
  for (const expired of [false, true]) {
    if (expired) await store.update('providers/openai', current => ({ ...current, retryAt: new Date(Date.now() - 1000).toISOString() }));
    const retry = await api(req(`/jobs/${job.id}/retry`, { method: 'POST', cookie: account.cookie })); assert.equal(retry.status, 409); assert.equal((await retry.json()).code, 'automatic_retry_pending'); assert.equal(dispatched.length, 0); assert.equal((await store.get(`jobs/${job.id}`)).attempt, 1);
  }
  // Mock an actual successful provider probe's persisted state; time alone above did not clear it.
  await store.set('providers/openai', { status: 'ready', retryAt: null, checkedAt: new Date().toISOString(), probeLease: null, version: 1 });
  const ready = await (await api(req('/status'))).json(); assert.equal(ready.available, true); assert.equal(ready.liveVerified, true);
  const retried = await api(req(`/jobs/${job.id}/retry`, { method: 'POST', cookie: account.cookie })); assert.equal(retried.status, 202); const resumed = (await retried.json()).job; assert.equal(resumed.id, job.id); assert.equal(resumed.status, 'queued'); assert.equal(resumed.retryAt, null); assert.equal(dispatched.length, 1);
});

test('blocked jobs consume active capacity and cancellation or consent withdrawal stops their scheduled retry', async t => {
  const { api, store, dispatched } = await fixture(t); const account = await register(api); await blockProviderQuota(store); const videos = []; for (let index = 0; index < 3; index++) videos.push((await upload(api, account.cookie)).video);
  const queued = []; for (const video of videos.slice(0, 2)) queued.push((await (await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: video.id, analysisConsent: true } }))).json()).job);
  const limited = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: videos[2].id, analysisConsent: true } })); assert.equal(limited.status, 429); assert.equal((await limited.json()).code, 'active_job_limit');
  const cancel = await api(req(`/jobs/${queued[0].id}/cancel`, { method: 'POST', cookie: account.cookie })); assert.equal(cancel.status, 200); const cancelled = (await cancel.json()).job; assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.retryAt, null);
  const third = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: videos[2].id, analysisConsent: true } })); assert.equal(third.status, 202); assert.equal((await third.json()).job.status, 'blocked');
  const workspace = await (await api(req('/workspace', { cookie: account.cookie }))).json(); const withdraw = await api(req('/workspace', { method: 'PUT', cookie: account.cookie, body: { ...workspace, consents: { ...workspace.consents, analysis: false } } })); assert.equal(withdraw.status, 200);
  for (const key of await store.list('jobs/')) { const job = await store.get(key); assert.equal(job.status, 'cancelled'); assert.equal(job.cancelRequested, true); assert.equal(job.retryAt, null); }
  assert.equal(dispatched.length, 0);
});

test('missing server credentials never turn into a quota waiting job and account deletion preserves shared provider protection', async t => {
  const first = await fixture(t, { availability: async () => ({ available: false, reason: 'missing_credentials' }) }); const account = await register(first.api); const video = (await upload(first.api, account.cookie)).video; await blockProviderQuota(first.store);
  const status = await (await first.api(req('/status'))).json(); assert.equal(status.available, false); assert.equal(status.reason, 'missing_credentials');
  const rejected = await first.api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: video.id, analysisConsent: true } })); assert.equal(rejected.status, 503); assert.equal((await rejected.json()).code, 'analysis_unavailable'); assert.deepEqual(await first.store.list('jobs/'), []);
  const second = await fixture(t); const secondAccount = await register(second.api); const secondVideo = (await upload(second.api, secondAccount.cookie)).video; const provider = await blockProviderQuota(second.store);
  const waiting = await second.api(req('/jobs', { method: 'POST', cookie: secondAccount.cookie, body: { videoId: secondVideo.id, analysisConsent: true } })); assert.equal(waiting.status, 202); const id = (await waiting.json()).job.id;
  const deletion = await second.api(req('/auth/account', { method: 'DELETE', cookie: secondAccount.cookie, body: { password: PASSWORD } })); assert.equal(deletion.status, 200); assert.equal(await second.store.get(`jobs/${id}`), null); assert.equal((await second.store.get('providers/openai')).retryAt, provider.retryAt);
});

test('concurrent retries of an older failed job cannot repeatedly replace a quota-blocked checkpoint or consume extra attempts', async t => {
  const { api, store, dispatched } = await fixture(t); const account = await register(api); const video = (await upload(api, account.cookie)).video;
  const queued = await api(req('/jobs', { method: 'POST', cookie: account.cookie, body: { videoId: video.id, analysisConsent: true } })); const id = (await queued.json()).job.id;
  await store.update(`jobs/${id}`, current => ({ ...current, status: 'failed', error: { code: 'analysis_quota_exceeded', message: '이전 공급자 한도 오류' } })); await blockProviderQuota(store);
  const retries = await Promise.all(Array.from({ length: 2 }, () => api(req(`/jobs/${id}/retry`, { method: 'POST', cookie: account.cookie })))); assert.deepEqual(retries.map(response => response.status).sort(), [202, 409]);
  const record = await store.get(`jobs/${id}`); assert.equal(record.status, 'blocked'); assert.equal(record.attempt, 2); assert.equal(dispatched.length, 1);
  const budgetKey = (await store.list(`budgets/attempt/${id}/`))[0]; assert.equal((await store.get(budgetKey)).entries.length, 2);
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('deleting an archive invalidates an in-flight duplicate generation and leaves no hidden personal record after account deletion', async t => {
  const { api, store } = await fixture(t); const account = await register(api); const archive = legacyArchive(); const body = { archive, importConsent: true };
  const original = await api(req('/imports', { method: 'POST', cookie: account.cookie, body })); const id = (await original.json()).import.id;
  const paused = deferred(), resume = deferred(); let intercept = true;
  const delayedAPI = createGrowthAPI({ store: { ...store, async create(key, value) { if (intercept && key.startsWith('imports/')) { intercept = false; paused.resolve(); await resume.promise; } return store.create(key, value); } } });
  const duplicate = delayedAPI(req('/imports', { method: 'POST', cookie: account.cookie, body })); await paused.promise;
  assert.equal((await api(req(`/imports/${id}`, { method: 'DELETE', cookie: account.cookie }))).status, 200); resume.resolve();
  const result = await duplicate; assert.equal(result.status, 409); assert.equal((await result.json()).code, 'import_changed');
  assert.deepEqual((await (await api(req('/imports', { cookie: account.cookie }))).json()).imports, []); assert.deepEqual(await store.list('imports/'), []); assert.deepEqual(await store.list(`import-owners/${account.user.id}/`), []);
  assert.equal((await api(req('/auth/account', { method: 'DELETE', cookie: account.cookie, body: { password: PASSWORD } }))).status, 200); assert.deepEqual(await store.list('imports/'), []); assert.equal(await store.get(`import-quotas/${account.user.id}`), null);
});

test('account deletion wins over an in-flight archive replay without recreating its quota or owner index', async t => {
  const { api, store } = await fixture(t); const account = await register(api); const body = { archive: legacyArchive(), importConsent: true };
  assert.equal((await api(req('/imports', { method: 'POST', cookie: account.cookie, body }))).status, 201);
  const paused = deferred(), resume = deferred(); let intercept = true;
  const delayedAPI = createGrowthAPI({ store: { ...store, async create(key, value) { if (intercept && key.startsWith('imports/')) { intercept = false; paused.resolve(); await resume.promise; } return store.create(key, value); } } });
  const duplicate = delayedAPI(req('/imports', { method: 'POST', cookie: account.cookie, body })); await paused.promise;
  assert.equal((await api(req('/auth/account', { method: 'DELETE', cookie: account.cookie, body: { password: PASSWORD } }))).status, 200); resume.resolve(); const result = await duplicate; assert.ok([409, 410].includes(result.status));
  assert.deepEqual(await store.list('imports/'), []); assert.deepEqual(await store.list(`import-owners/${account.user.id}/`), []); assert.equal(await store.get(`import-quotas/${account.user.id}`), null);
});

test('a conflicting initial mapping request cannot erase a concurrently saved valid archive checkpoint', async t => {
  const { api, store } = await fixture(t); const account = await register(api); const archive = legacyArchive(); archive.videos.push({ ...archive.videos[1], id: `local-${randomUUID()}` });
  const first = (await upload(api, account.cookie)).video, second = (await upload(api, account.cookie)).video;
  const paused = deferred(), resume = deferred(); let intercept = true;
  const delayedAPI = createGrowthAPI({ store: { ...store, async update(key, updater) { if (intercept && key.startsWith('imports/')) { intercept = false; paused.resolve(); await resume.promise; } return store.update(key, updater); } } });
  const initial = delayedAPI(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive, videoMap: [{ oldId: archive.videos[1].id, newId: first.id }], importConsent: true } })); await paused.promise;
  const validMap = [{ oldId: archive.videos[1].id, newId: second.id }, { oldId: archive.videos[2].id, newId: first.id }];
  const other = await api(req('/imports', { method: 'POST', cookie: account.cookie, body: { archive, videoMap: validMap, importConsent: true } })); assert.equal(other.status, 200); const id = (await other.json()).import.id;
  resume.resolve(); const rejected = await initial; assert.equal(rejected.status, 400); assert.equal((await rejected.json()).code, 'invalid_import_mapping');
  const saved = (await (await api(req(`/imports/${id}`, { cookie: account.cookie }))).json()).import; assert.deepEqual(saved.idMap, validMap.sort((a, b) => a.oldId.localeCompare(b.oldId))); assert.equal((await store.list('imports/')).length, 1);
});

test('account cleanup uses owner-prefixed import safety indexes without reading another family archive body', async t => {
  const { api, store } = await fixture(t); const first = await register(api); const other = await register(api, 'archive-safe-other@example.com');
  const created = await api(req('/imports', { method: 'POST', cookie: first.cookie, body: { archive: legacyArchive(), importConsent: true } })); const id = (await created.json()).import.id;
  const theirs = await api(req('/imports', { method: 'POST', cookie: other.cookie, body: { archive: legacyArchive(), importConsent: true } })); const otherId = (await theirs.json()).import.id;
  await store.delete(`import-quotas/${first.user.id}`); // Simulate a pre-existing unlisted record.
  const watched = createGrowthAPI({ store: { ...store, async get(key) { assert.notEqual(key, `imports/${otherId}`, 'deleting one account must not read another archive body'); return store.get(key); } } });
  const deletion = await watched(req('/auth/account', { method: 'DELETE', cookie: first.cookie, body: { password: PASSWORD } })); assert.equal(deletion.status, 200); assert.equal(await store.get(`imports/${id}`), null); assert.ok(await store.get(`imports/${otherId}`)); assert.deepEqual(await store.list(`import-owners/${first.user.id}/`), []);
});
