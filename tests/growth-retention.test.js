import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createLocalStore } from '../lib/growth/store.js';
import { createGrowthAPI } from '../lib/growth/api.js';
import { finalizeOriginalRetention } from '../lib/growth/retention.js';
import { createGrowthWorkspace } from '../public/growth-domain.js';

const PASSWORD = 'retention-private-password';
const hash = value => createHash('sha256').update(value).digest('hex');
const evidenceKey = (setup, clip) => `evidence-media/${setup.userId}/${setup.videoId}/${clip.id}`;
const quotaKey = setup => `quotas/storage/${setup.userId}`;
// The encoder is deliberately replaced in these lifecycle tests. Real FFmpeg
// decoding is covered by growth-worker.test.js; the retention boundary only
// needs a small MP4-shaped result with a distinct checksum for each clip.
function mp4(clip) {
  const bytes = Buffer.alloc(64, Math.floor(clip.start) % 251);
  bytes.writeUInt32BE(24, 0); bytes.write('ftypisom', 4, 'ascii');
  return bytes;
}
function request(route, { method = 'GET', cookie, body, headers = {} } = {}) {
  return new Request(`https://soccer.example/api/v2${route}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(!['GET', 'HEAD'].includes(method) ? { Origin: 'https://soccer.example' } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function seedOwner(store) {
  const id = randomUUID(); const token = randomBytes(32).toString('base64url'); const salt = randomBytes(16).toString('hex');
  const user = { id, email: `${id}@example.com`, guardianName: '보호자', guardianConsent: true, adult: true, deleting: false, createdAt: new Date().toISOString(), password: { salt, hash: scryptSync(PASSWORD, salt, 64).toString('hex') } };
  await store.set(`users/${id}`, user);
  await store.set(`sessions/${hash(token)}`, { userId: id, expiresAt: Date.now() + 60_000 });
  return { user, cookie: `nx_session=${token}` };
}
async function fixture(t, clipCount = 2) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'next-xi-retention-'));
  const store = await createLocalStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const owner = await seedOwner(store); const other = await seedOwner(store);
  const userId = owner.user.id; const videoId = randomUUID(); const jobId = randomUUID();
  const token = randomBytes(32).toString('base64url'); const stamp = new Date().toISOString();
  const original = Buffer.from(Array.from({ length: 1025 }, (_, index) => index % 251)); const chunkSize = 256; const chunks = [];
  for (let offset = 0; offset < original.length; offset += chunkSize) {
    const bytes = original.subarray(offset, offset + chunkSize); const index = offset / chunkSize;
    const key = `media/${userId}/${videoId}/${index}/${hash(bytes)}`;
    chunks.push({ index, key, hash: hash(bytes), size: bytes.length }); await store.putBinary(key, bytes);
  }
  const target = { kit: 'navy', number: 11, age: 11 };
  const context = { position: 'MF', opponentLevel: 'similar', minutesPlayed: 30, filming: 'clear', matchDate: stamp.slice(0, 10) };
  const video = { id: videoId, userId, kind: 'server', title: '근거 보관 테스트', fileName: 'private-original.mp4', size: original.length, mime: 'video/mp4', addedAt: stamp, duration: 180, target, context, status: 'ready', sourceStatus: 'stored', activeJobId: jobId, chunkSize, chunks };
  const clips = Array.from({ length: clipCount }, (_, index) => ({ id: randomUUID(), jobId, videoId, createdAt: stamp, start: index * 15, end: index * 15 + 12, model: 'mock-retention', result: { identified: true, summary: '저장된 관찰', observations: [{ skill: 'pass', time: index * 15 + 2, note: '패스 선택 근거', type: 'note', confidence: 'medium' }], limitations: ['테스트 결과'], nextAction: '코치와 확인' } }));
  const workspace = createGrowthWorkspace(); workspace.videos = [{ ...video }]; workspace.analyses = structuredClone(clips); workspace.consents.guardian = true; workspace.consents.analysis = true;
  const job = { id: jobId, userId, videoId, target, context, status: 'completed', stage: 'completed', tokenHash: hash(token), cancelRequested: false, createdAt: stamp, updatedAt: stamp, completedAt: stamp, progress: { status: 'completed', duration: video.duration, selectedCount: clips.length, completedCount: clips.length, segments: clips.map(({ start, end }) => ({ start, end })) }, clips, result: { analysisIds: clips.map(clip => clip.id), identified: true, summary: '완료된 결과' } };
  await store.set(`videos/${videoId}`, video); await store.set(`jobs/${jobId}`, job); await store.set(`workspaces/${userId}`, workspace);
  await store.set(`quotas/storage/${userId}`, { entries: [{ videoId, size: original.length, status: 'ready' }] });
  const api = createGrowthAPI({ store });
  return { store, api, dir, userId, videoId, jobId, job, video, clips, original, chunks, token, cookie: owner.cookie, otherCookie: other.cookie, otherUserId: other.user.id };
}
async function finalize(setup, createEvidence = async ({ clip }) => mp4(clip), extra = {}) {
  return finalizeOriginalRetention({ store: setup.store, job: setup.job, createEvidence, ...extra });
}
async function retained(setup) {
  const video = await setup.store.get(`videos/${setup.videoId}`);
  assert.notEqual(video?.sourceStatus, 'deleted_after_analysis'); assert.equal(video?.sourceDeletedAt ?? null, null);
  assert.equal((await setup.store.get(quotaKey(setup))).entries[0].size, setup.original.length);
  for (const chunk of setup.chunks) assert.ok(await setup.store.getBinary(chunk.key), 'The original is retained while evidence is incomplete');
}

test('all seven completed clips are read back before any source deletion and retry is idempotent', async t => {
  const setup = await fixture(t, 7); const { store } = setup; const encoded = []; const verified = new Set();
  const read = store.getBinary.bind(store); const remove = store.delete.bind(store);
  store.getBinary = async key => { const bytes = await read(key); if (key.startsWith('evidence-media/') && bytes) verified.add(key); return bytes; };
  store.delete = async key => {
    if (key.startsWith(`media/${setup.userId}/${setup.videoId}/`)) {
      assert.equal(verified.size, 7, 'Every persisted evidence MP4 must be read back before the first source chunk is removed');
      assert.equal((await store.get(quotaKey(setup))).entries[0].size, setup.original.length, 'Quota remains reserved until every source chunk is gone');
    }
    return remove(key);
  };
  await finalize(setup, async ({ clip, video, job }) => {
    assert.equal(video.id, setup.videoId); assert.equal(job.id, setup.jobId);
    for (const chunk of setup.chunks) assert.ok(await read(chunk.key));
    encoded.push(clip.id); return mp4(clip);
  });
  assert.deepEqual(encoded, setup.clips.map(clip => clip.id));
  assert.deepEqual(await store.list(`media/${setup.userId}/${setup.videoId}/`), []);
  const video = await store.get(`videos/${setup.videoId}`);
  assert.equal(video.sourceStatus, 'deleted_after_analysis'); assert.ok(Number.isFinite(Date.parse(video.sourceDeletedAt)));
  const workspace = await store.get(`workspaces/${setup.userId}`);
  assert.equal(workspace.videos[0].sourceStatus, 'deleted_after_analysis');
  assert.equal(workspace.analyses.length, 7);
  for (const clip of setup.clips) {
    const bytes = mp4(clip); const metadata = await store.get(`evidence/${clip.id}`);
    for (const [key, value] of Object.entries({ id: clip.id, userId: setup.userId, videoId: setup.videoId, jobId: setup.jobId, analysisId: clip.id, start: clip.start, end: clip.end, mime: 'video/mp4', size: bytes.length, sha256: hash(bytes), key: evidenceKey(setup, clip) })) assert.equal(metadata[key], value, `Evidence metadata: ${key}`);
    assert.deepEqual(Buffer.from(await read(metadata.key)), bytes);
    assert.deepEqual(workspace.analyses.find(analysis => analysis.id === clip.id).evidence, { id: clip.id, start: clip.start, end: clip.end, mime: 'video/mp4', size: bytes.length });
  }
  const storageEntry = (await store.get(quotaKey(setup))).entries[0];
  assert.equal(storageEntry.size, setup.clips.reduce((size, clip) => size + mp4(clip).length, 0)); assert.equal(storageEntry.status, 'evidence_only');
  await finalize(setup, async () => assert.fail('Verified evidence must not be encoded again'));
  assert.equal((await store.list('evidence/')).length, 7);
});

test('an interrupted encode retains the original and retry reuses each verified clip', async t => {
  const setup = await fixture(t, 4); const calls = [];
  await assert.rejects(finalize(setup, async ({ clip }) => { calls.push(clip.id); if (calls.length === 2) throw new Error('Temporary encoder failure'); return mp4(clip); }));
  await retained(setup);
  assert.deepEqual(Buffer.from(await setup.store.getBinary(evidenceKey(setup, setup.clips[0]))), mp4(setup.clips[0]));
  assert.equal((await setup.store.get(`evidence/${setup.clips[0].id}`)).sha256, hash(mp4(setup.clips[0])));
  const retryCalls = [];
  await finalize(setup, async ({ clip }) => { retryCalls.push(clip.id); return mp4(clip); });
  assert.deepEqual(retryCalls, setup.clips.slice(1).map(clip => clip.id));
  assert.equal((await setup.store.get(`videos/${setup.videoId}`)).sourceStatus, 'deleted_after_analysis');
});

test('evidence readback corruption prevents original deletion or a quota reduction', async t => {
  const setup = await fixture(t); const read = setup.store.getBinary.bind(setup.store);
  setup.store.getBinary = async key => { const bytes = await read(key); if (key.startsWith('evidence-media/') && bytes) { const corrupted = bytes.slice(); corrupted[corrupted.length - 1] ^= 1; return corrupted; } return bytes; };
  await assert.rejects(finalize(setup));
  await retained(setup);
});

test('a source deletion failure keeps quota reserved and retries deletion without encoding again', async t => {
  const setup = await fixture(t); const remove = setup.store.delete.bind(setup.store); let failed = false;
  setup.store.delete = async key => { if (key === setup.chunks[1].key && !failed) { failed = true; throw new Error('Temporary original deletion failure'); } return remove(key); };
  await assert.rejects(finalize(setup));
  assert.equal((await setup.store.get(quotaKey(setup))).entries[0].size, setup.original.length);
  assert.notEqual((await setup.store.get(`videos/${setup.videoId}`)).sourceStatus, 'deleted_after_analysis');
  assert.ok(await setup.store.getBinary(setup.chunks[1].key));
  assert.equal((await setup.store.list('evidence/')).length, setup.clips.length);
  await finalize(setup, async () => assert.fail('Completed evidence survives an original cleanup failure'));
  assert.deepEqual(await setup.store.list(`media/${setup.userId}/${setup.videoId}/`), []);
  assert.equal((await setup.store.get(quotaKey(setup))).entries[0].size, setup.clips.length * 64);
});

test('failed, blocked, cancelled, running, incomplete and not-found jobs keep their original', async t => {
  for (const change of [{ status: 'failed', stage: 'failed' }, { status: 'blocked', stage: 'quota' }, { status: 'cancelled', cancelRequested: true }, { status: 'completed', cancelRequested: true }, { status: 'running', stage: 'analyzing' }, { progress: { status: 'completed', selectedCount: 3, completedCount: 2 } }, { status: 'completed', stage: 'not_found', clips: [], progress: { status: 'not_found', selectedCount: 0, completedCount: 0 }, result: { analysisIds: [], identified: false } }]) {
    const setup = await fixture(t); setup.job = { ...setup.job, ...change }; await setup.store.set(`jobs/${setup.jobId}`, setup.job);
    await finalize(setup, async () => assert.fail('Only a complete successful result can authorize evidence encoding'));
    await retained(setup); assert.deepEqual(await setup.store.list('evidence/'), []);
  }
});

test('missing persisted results, unsafe clips, deleting accounts and cancelled signals cannot remove originals', async t => {
  for (const scenario of ['missing-analysis', 'too-long', 'deleting-account', 'cancelled']) {
    const setup = await fixture(t); const extra = {};
    if (scenario === 'missing-analysis') await setup.store.update(`workspaces/${setup.userId}`, workspace => ({ ...workspace, analyses: workspace.analyses.slice(1) }));
    if (scenario === 'too-long') { setup.job.clips[0].end = setup.job.clips[0].start + 12.1; await setup.store.set(`jobs/${setup.jobId}`, setup.job); }
    if (scenario === 'deleting-account') await setup.store.update(`users/${setup.userId}`, user => ({ ...user, deleting: true }));
    if (scenario === 'cancelled') extra.signal = AbortSignal.abort();
    let encodes = 0;
    await finalize(setup, async ({ clip }) => { encodes += 1; return mp4(clip); }, extra).catch(() => {});
    assert.equal(encodes, 0, 'The safety precondition must be checked before encoding');
    await retained(setup); assert.deepEqual(await setup.store.list('evidence/'), []);
  }
});

test('oversized or non-MP4 evidence is rejected before source deletion', async t => {
  for (const output of [Buffer.from('not a playable evidence video'), Buffer.alloc(8 * 1024 ** 2 + 1)]) {
    const setup = await fixture(t, 1);
    await assert.rejects(finalize(setup, async () => output));
    await retained(setup);
  }
});

test('private evidence supports owner sessions, job bearer access, ranges and HEAD after the source is deleted', async t => {
  const setup = await fixture(t, 1); await finalize(setup);
  const clip = setup.clips[0]; const bytes = mp4(clip); const route = `/evidence/${clip.id}`;
  for (const options of [{}, { cookie: setup.otherCookie }, { headers: { Authorization: `Bearer ${setup.token}` } }, { headers: { Authorization: `Bearer ${'wrong-token-'.repeat(3)}` } }]) assert.equal((await setup.api(request(route, options))).status, 404);
  const full = await setup.api(request(route, { cookie: setup.cookie }));
  assert.equal(full.status, 200); assert.match(full.headers.get('cache-control'), /private/); assert.equal(full.headers.get('content-type'), 'video/mp4'); assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const partial = await setup.api(request(`${route}?jobId=${setup.jobId}`, { headers: { Authorization: `Bearer ${setup.token}`, Range: 'bytes=4-15' } }));
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), `bytes 4-15/${bytes.length}`); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(4, 16));
  const suffix = await setup.api(request(route, { cookie: setup.cookie, headers: { Range: 'bytes=-5' } })); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-5));
  const head = await setup.api(request(route, { method: 'HEAD', cookie: setup.cookie })); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const invalid = await setup.api(request(route, { cookie: setup.cookie, headers: { Range: 'bytes=999-' } })); assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.length}`);
  const wrongJobId = randomUUID(); await setup.store.set(`jobs/${wrongJobId}`, { ...setup.job, id: wrongJobId, userId: setup.otherUserId });
  assert.equal((await setup.api(request(`${route}?jobId=${wrongJobId}`, { headers: { Authorization: `Bearer ${setup.token}` } }))).status, 404);
  await setup.store.update(`jobs/${wrongJobId}`, job => ({ ...job, userId: setup.userId }));
  assert.equal((await setup.api(request(`${route}?jobId=${wrongJobId}`, { headers: { Authorization: `Bearer ${setup.token}` } }))).status, 404, 'A different job for the same owner and video cannot use this evidence bearer');
  assert.equal((await setup.api(request(`/media/${setup.videoId}`, { cookie: setup.cookie }))).status, 404);
  assert.equal((await setup.api(request(`/media/${setup.videoId}?jobId=${setup.jobId}`, { headers: { Authorization: `Bearer ${setup.token}` } }))).status, 404);
  await setup.store.update(`jobs/${setup.jobId}`, job => ({ ...job, cancelRequested: true }));
  assert.equal((await setup.api(request(`${route}?jobId=${setup.jobId}`, { headers: { Authorization: `Bearer ${setup.token}` } }))).status, 404);
  assert.equal((await setup.api(request(route, { cookie: setup.cookie }))).status, 200, 'The owner keeps access to saved evidence after job cancellation');
  await setup.store.update(`users/${setup.userId}`, user => ({ ...user, deleting: true }));
  assert.equal((await setup.api(request(route, { cookie: setup.cookie }))).status, 404);
});

test('owner video deletion purges evidence and a stale retention attempt cannot resurrect it', async t => {
  const setup = await fixture(t); await finalize(setup);
  const route = `/videos/${setup.videoId}`;
  assert.equal((await setup.api(request(route, { method: 'DELETE', cookie: setup.otherCookie }))).status, 404);
  assert.equal((await setup.api(request(route, { method: 'DELETE', cookie: setup.cookie }))).status, 200);
  let encodes = 0;
  await finalize(setup, async ({ clip }) => { encodes += 1; return mp4(clip); }).catch(() => {});
  assert.equal(encodes, 0, 'Deleted videos must not be encoded');
  assert.equal(await setup.store.get(`videos/${setup.videoId}`), null); assert.equal(await setup.store.get(`jobs/${setup.jobId}`), null);
  assert.deepEqual(await setup.store.list('evidence/'), []); assert.deepEqual(await setup.store.list(`evidence-media/${setup.userId}/`), []);
  assert.deepEqual(await setup.store.list(`evidence-owners/${setup.userId}/`), []);
  assert.deepEqual((await setup.store.get(`workspaces/${setup.userId}`)).analyses, []);
  assert.equal((await setup.api(request(`/evidence/${setup.clips[0].id}`, { cookie: setup.cookie }))).status, 404);
});

test('password-confirmed account deletion removes private evidence and preserves other owners', async t => {
  const setup = await fixture(t); await finalize(setup);
  const foreignId = randomUUID(); const foreignKey = `evidence-media/${setup.otherUserId}/${randomUUID()}/${foreignId}`;
  await setup.store.set(`evidence/${foreignId}`, { id: foreignId, userId: setup.otherUserId, key: foreignKey }); await setup.store.putBinary(foreignKey, Buffer.from('other owner evidence'));
  assert.equal((await setup.api(request('/auth/account', { method: 'DELETE', cookie: setup.cookie, body: { password: PASSWORD } }))).status, 200);
  let encodes = 0;
  await finalize(setup, async ({ clip }) => { encodes += 1; return mp4(clip); }).catch(() => {});
  assert.equal(encodes, 0, 'Deleted account evidence must not be recreated');
  assert.equal(await setup.store.get(`users/${setup.userId}`), null); assert.equal(await setup.store.get(`workspaces/${setup.userId}`), null);
  for (const clip of setup.clips) assert.equal(await setup.store.get(`evidence/${clip.id}`), null);
  assert.deepEqual(await setup.store.list(`evidence-media/${setup.userId}/`), []);
  assert.deepEqual(await setup.store.list(`evidence-owners/${setup.userId}/`), []);
  assert.ok(await setup.store.get(`users/${setup.otherUserId}`)); assert.ok(await setup.store.getBinary(foreignKey)); assert.ok(await setup.store.get(`evidence/${foreignId}`));
});

test('video or account deletion during encoding cannot recreate an orphan binary or result', async t => {
  for (const scope of ['video', 'account']) {
    const setup = await fixture(t, 1);
    await finalize(setup, async ({ clip }) => {
      const route = scope === 'video' ? `/videos/${setup.videoId}` : '/auth/account';
      const response = await setup.api(request(route, { method: 'DELETE', cookie: setup.cookie, ...(scope === 'account' ? { body: { password: PASSWORD } } : {}) })); assert.equal(response.status, 200);
      return mp4(clip);
    }).catch(() => {});
    assert.equal(await setup.store.get(`videos/${setup.videoId}`), null); assert.equal(await setup.store.get(`jobs/${setup.jobId}`), null);
    assert.deepEqual(await setup.store.list('evidence/'), []); assert.deepEqual(await setup.store.list(`evidence-media/${setup.userId}/`), []);
    assert.deepEqual(await setup.store.list(`evidence-owners/${setup.userId}/`), []);
    const workspace = await setup.store.get(`workspaces/${setup.userId}`);
    if (scope === 'account') assert.equal(workspace, null);
    else { assert.deepEqual(workspace.videos, []); assert.deepEqual(workspace.analyses, []); }
  }
});

test('ten evidence-only reports release original slots and source bytes while the 100-report metadata limit remains', async t => {
  const setup = await fixture(t, 1); await finalize(setup);
  const api = createGrowthAPI({ store: setup.store, availability: async () => ({ available: true, provider: 'cloudflare', freeOnly: true, model: 'mock-model' }) });
  const sourceUnavailable = await api(request('/jobs', { method: 'POST', cookie: setup.cookie, body: { videoId: setup.videoId, analysisConsent: true, provider: 'cloudflare' } }));
  assert.equal(sourceUnavailable.status, 409); assert.equal((await sourceUnavailable.json()).code, 'source_unavailable');
  const released = { ...(await setup.store.get(`videos/${setup.videoId}`)), size: 2 * 1024 ** 3 };
  const videos = [{ ...released }]; await setup.store.set(`videos/${released.id}`, released);
  for (let index = 1; index < 10; index += 1) {
    const video = { ...released, id: randomUUID(), activeJobId: null }; videos.push(video); await setup.store.set(`videos/${video.id}`, video);
  }
  await setup.store.update(`workspaces/${setup.userId}`, workspace => ({ ...workspace, videos }));
  // Force the API to rebuild quota from retained video metadata. The ten 2 GiB
  // declarations describe deleted sources; only ten small MP4s occupy storage.
  await setup.store.delete(quotaKey(setup));
  const body = { rightsConsent: true, fileName: 'next-original.mp4', title: '새 원본', size: 3, mime: 'video/mp4', target: setup.video.target, context: setup.video.context };
  const started = await api(request('/uploads', { method: 'POST', cookie: setup.cookie, body }));
  assert.equal(started.status, 201, await started.clone().text());
  const upload = (await started.json()).upload;
  const quota = await setup.store.get(quotaKey(setup));
  assert.equal(quota.entries.filter(entry => entry.status === 'evidence_only').length, 10);
  assert.equal(quota.entries.reduce((total, entry) => total + entry.size, 0), 10 * mp4(setup.clips[0]).length + 3);
  assert.equal((await api(request(`/uploads/${upload.id}`, { method: 'DELETE', cookie: setup.cookie }))).status, 200);
  for (let index = 10; index < 100; index += 1) {
    const video = { ...released, id: randomUUID(), activeJobId: null }; videos.push(video); await setup.store.set(`videos/${video.id}`, video);
  }
  await setup.store.update(`workspaces/${setup.userId}`, workspace => ({ ...workspace, videos })); await setup.store.delete(quotaKey(setup));
  const limited = await api(request('/uploads', { method: 'POST', cookie: setup.cookie, body }));
  assert.equal(limited.status, 409); assert.equal((await limited.json()).code, 'upload_limit');
  assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).videos.length, 100);
});

test('evidence bytes remain charged against the 6 GiB account limit after original release', async t => {
  const setup = await fixture(t, 1); await finalize(setup);
  const maximum = 6 * 1024 ** 3; const retainedBytes = maximum - 3;
  await setup.store.update(`videos/${setup.videoId}`, video => ({ ...video, evidenceBytes: retainedBytes }));
  await setup.store.set(quotaKey(setup), { entries: [{ videoId: setup.videoId, size: retainedBytes, status: 'evidence_only' }] });
  const body = { rightsConsent: true, fileName: 'remaining-space.mp4', size: 4, mime: 'video/mp4', target: setup.video.target, context: setup.video.context };
  const tooLarge = await setup.api(request('/uploads', { method: 'POST', cookie: setup.cookie, body }));
  assert.equal(tooLarge.status, 409); assert.equal((await tooLarge.json()).code, 'account_storage_limit');
  assert.deepEqual((await setup.store.get(quotaKey(setup))).entries, [{ videoId: setup.videoId, size: retainedBytes, status: 'evidence_only' }]);
  assert.deepEqual(await setup.store.list('uploads/'), []);
  const exact = await setup.api(request('/uploads', { method: 'POST', cookie: setup.cookie, body: { ...body, size: 3 } }));
  assert.equal(exact.status, 201, await exact.clone().text());
  assert.equal((await setup.store.get(quotaKey(setup))).entries.reduce((total, entry) => total + entry.size, 0), maximum);
});

test('Cloudflare availability and queued jobs use only Cloudflare status and preserve legacy retry checkpoints', async t => {
  const setup = await fixture(t); const dispatched = []; const providerReads = [];
  const get = setup.store.get.bind(setup.store);
  setup.store.get = async key => { if (key.startsWith('providers/')) providerReads.push(key); return get(key); };
  const availability = async () => ({ available: true, reason: 'ready', provider: 'cloudflare', freeOnly: true, model: 'mock-model' });
  const api = createGrowthAPI({ store: setup.store, availability, dispatchJob: async (...args) => dispatched.push(args) });
  const checkedAt = new Date().toISOString(); const retryAt = new Date(Date.now() + 60_000).toISOString();
  await setup.store.set('providers/openai', { status: 'quota_exceeded', checkedAt, retryAt, version: 1 });
  await setup.store.set('providers/cloudflare', { status: 'ready', checkedAt, retryAt: null, version: 2 });
  const ready = await (await api(request('/status'))).json();
  assert.equal(ready.available, true); assert.equal(ready.liveVerified, true); assert.equal(ready.provider, 'cloudflare'); assert.equal(ready.freeOnly, true); assert.equal(ready.model, 'mock-model'); assert.equal(ready.checkedAt, checkedAt);
  assert.deepEqual(providerReads, ['providers/cloudflare']);
  await setup.store.set('providers/openai', { status: 'ready', checkedAt, retryAt: null, version: 2 });
  await setup.store.set('providers/cloudflare', { status: 'quota_exceeded', checkedAt, retryAt, version: 3 });
  const blocked = await (await api(request('/status'))).json();
  assert.equal(blocked.available, false); assert.equal(blocked.reason, 'provider_quota'); assert.equal(blocked.provider, 'cloudflare'); assert.equal(blocked.freeOnly, true); assert.equal(blocked.model, 'mock-model'); assert.equal(blocked.retryAt, retryAt);
  await setup.store.set('providers/cloudflare', { status: 'ready', checkedAt, retryAt: null, version: 3 });
  const queued = await api(request('/jobs', { method: 'POST', cookie: setup.cookie, body: { videoId: setup.videoId, analysisConsent: true, provider: 'cloudflare' } }));
  assert.equal(queued.status, 202, await queued.clone().text());
  const job = (await queued.json()).job;
  assert.equal(job.status, 'queued'); assert.equal(job.provider, 'cloudflare'); assert.equal(dispatched.length, 1);
  const persisted = await setup.store.get(`jobs/${job.id}`);
  assert.equal(persisted.provider, 'cloudflare'); assert.equal(persisted.analysisConsentVersion, '2026-10-cloudflare-v24'); assert.ok(Number.isFinite(Date.parse(persisted.analysisConsentAt)));
  await setup.store.update(`jobs/${setup.jobId}`, legacy => ({ ...legacy, status: 'failed', stage: 'failed' }));
  const legacy = await setup.store.get(`jobs/${setup.jobId}`);
  const retry = await api(request(`/jobs/${setup.jobId}/retry`, { method: 'POST', cookie: setup.cookie, body: { analysisConsent: true, provider: 'cloudflare' } }));
  assert.equal(retry.status, 409); assert.equal((await retry.json()).code, 'provider_changed');
  assert.deepEqual(await setup.store.get(`jobs/${setup.jobId}`), legacy, 'A provider switch must not mutate or discard legacy paid clip checkpoints');
  assert.equal(dispatched.length, 1); assert.ok(providerReads.every(key => key === 'providers/cloudflare'));
});

test('a completed Cloudflare worker can read its source only while a live evidence-preparation lease permits it', async t => {
  const setup = await fixture(t, 1);
  setup.job = { ...setup.job, provider: 'cloudflare', analysisConsentVersion: '2026-10-cloudflare-v24' };
  const preparing = { ...setup.job, retention: { status: 'preparing', leaseOwner: randomUUID(), leaseUntil: new Date(Date.now() + 60_000).toISOString() } };
  const route = `/media/${setup.videoId}?jobId=${setup.jobId}`;
  const headers = { Authorization: `Bearer ${setup.token}`, Range: 'bytes=250-268' };
  for (const change of [
    { provider: undefined }, { provider: 'openai' },
    { analysisConsentVersion: undefined }, { analysisConsentVersion: '2026-10-growth-v2' },
    { result: { ...preparing.result, identified: false } },
    { retention: undefined }, { retention: { ...preparing.retention, status: 'pending' } },
    { retention: { ...preparing.retention, status: 'completed' } },
    { retention: { ...preparing.retention, leaseUntil: new Date(Date.now() - 1_000).toISOString() } },
    { retention: { ...preparing.retention, leaseUntil: undefined } },
    { cancelRequested: true }, { status: 'failed' },
  ]) {
    await setup.store.set(`jobs/${setup.jobId}`, { ...preparing, ...change });
    assert.equal((await setup.api(request(route, { headers }))).status, 404, `Completed source access must reject ${JSON.stringify(change)}`);
  }
  await setup.store.set(`jobs/${setup.jobId}`, preparing);
  assert.equal((await setup.api(request(route, { headers: { ...headers, Authorization: `Bearer ${'wrong-token-'.repeat(3)}` } }))).status, 404);
  assert.equal((await setup.api(request(`/media/${setup.videoId}`, { headers }))).status, 404);
  const allowed = await setup.api(request(route, { headers }));
  assert.equal(allowed.status, 206); assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), setup.original.subarray(250, 269));
  // The retention finalizer itself claims the lease before calling the encoder.
  // Exercise the actual API inside that callback, as the worker's FFmpeg does.
  await setup.store.set(`jobs/${setup.jobId}`, setup.job);
  let encodes = 0;
  await finalize(setup, async ({ clip }) => {
    encodes += 1;
    const job = await setup.store.get(`jobs/${setup.jobId}`);
    assert.equal(job.retention.status, 'preparing'); assert.ok(Date.parse(job.retention.leaseUntil) > Date.now());
    const response = await setup.api(request(route, { headers }));
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes 250-268/${setup.original.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), setup.original.subarray(250, 269));
    return mp4(clip);
  });
  assert.equal(encodes, 1);
  assert.equal((await setup.api(request(route, { headers }))).status, 404, 'Completed evidence retention revokes source access after purge');
  assert.equal((await setup.store.get(`videos/${setup.videoId}`)).sourceStatus, 'deleted_after_analysis');
});

test('cached paid-provider consent cannot send child frames to Cloudflare or retry a free job', async t => {
  const setup = await fixture(t); const dispatched = [];
  const api = createGrowthAPI({ store: setup.store, availability: async () => ({ available: true, provider: 'cloudflare', freeOnly: true }), dispatchJob: async (...args) => dispatched.push(args) });
  const before = await setup.store.get(`jobs/${setup.jobId}`);
  const stale = await api(request('/jobs', { method: 'POST', cookie: setup.cookie, body: { videoId: setup.videoId, analysisConsent: true } }));
  assert.equal(stale.status, 400); assert.equal((await stale.json()).code, 'provider_consent_required');
  const retry = await api(request(`/jobs/${setup.jobId}/retry`, { method: 'POST', cookie: setup.cookie, body: { analysisConsent: true } }));
  assert.equal(retry.status, 400); assert.equal((await retry.json()).code, 'provider_consent_required');
  assert.deepEqual(await setup.store.get(`jobs/${setup.jobId}`), before); assert.equal(dispatched.length, 0);
});

test('fresh free consent replaces blocked legacy work without discarding its saved evidence', async t => {
  const setup = await fixture(t); const dispatched = [];
  const api = createGrowthAPI({ store: setup.store, availability: async () => ({ available: true, provider: 'cloudflare', freeOnly: true }), dispatchJob: async (...args) => dispatched.push(args) });
  await setup.store.update(`jobs/${setup.jobId}`, current => ({ ...current, status: 'blocked', stage: 'quota' }));
  const old = await setup.store.get(`jobs/${setup.jobId}`);
  const queued = await api(request('/jobs', { method: 'POST', cookie: setup.cookie, body: { videoId: setup.videoId, analysisConsent: true, provider: 'cloudflare' } }));
  assert.equal(queued.status, 202, await queued.clone().text());
  const fresh = (await queued.json()).job; assert.notEqual(fresh.id, old.id); assert.equal(fresh.provider, 'cloudflare'); assert.equal(dispatched.length, 1);
  const preserved = await setup.store.get(`jobs/${setup.jobId}`);
  assert.equal(preserved.status, 'cancelled'); assert.equal(preserved.cancelRequested, true); assert.notEqual(preserved.tokenHash, old.tokenHash);
  assert.deepEqual(preserved.clips, old.clips); assert.deepEqual(preserved.result, old.result);
});
