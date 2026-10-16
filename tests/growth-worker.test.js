import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createLocalStore } from '../lib/growth/store.js';
import { runGrowthJob, recoverGrowthJobs } from '../lib/growth/worker.js';
import { createGrowthWorkspace, validateGrowthWorkspace } from '../public/growth-domain.js';
import { readProviderStatus, blockProviderQuota } from '../lib/growth/provider.js';

const token = 'private-worker-token-only-for-tests';
const digest = value => createHash('sha256').update(value).digest('hex');
const target = { kit: 'red', number: 7, age: 9 };
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

async function fixture(t, seconds = 30) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'next-xi-worker-'));
  const store = await createLocalStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const file = path.join(directory, 'original.mp4');
  const generated = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=5', '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
  assert.equal(generated.status, 0, 'Generate a real, locally decodable MP4');
  const userId = randomUUID(); const videoId = randomUUID(); const jobId = randomUUID();
  const stamp = new Date().toISOString();
  const video = { id: videoId, userId, kind: 'server', title: '실제 원본 테스트', fileName: 'original.mp4', size: 12345, mime: 'video/mp4', addedAt: stamp, duration: 999, target, context: {} };
  const workspace = createGrowthWorkspace(); workspace.videos.push({ ...video, duration: null }); workspace.consents.analysis = true;
  await store.set(`users/${userId}`, { id: userId, deleting: false });
  await store.set(`workspaces/${userId}`, workspace);
  await store.set(`videos/${videoId}`, video);
  await store.set(`jobs/${jobId}`, { id: jobId, userId, videoId, target, context: {}, status: 'queued', stage: 'queued', createdAt: stamp, updatedAt: stamp, tokenHash: digest(token), cancelRequested: false, progress: {}, clips: [], result: null });
  return { store, file, userId, videoId, jobId };
}

function fakeAnalysis(calls, { failClip = 0, onClip, expectedToken = token } = {}) {
  let clips = 0;
  return async (request, options) => {
    const input = await request.json();
    calls.push(input);
    assert.deepEqual(input.target, target);
    assert.equal(input.accessCode, expectedToken);
    assert.equal(options.env.SOCCER_ANALYSIS_ACCESS_CODE, expectedToken);
    assert.ok(Buffer.byteLength(JSON.stringify(input)) < 3_000_000);
    assert.ok(input.frames.every(frame => frame.image.startsWith('data:image/jpeg;base64,') && frame.image.length <= 250_000));
    if (input.mode === 'discover') return response({ mode: 'discover', detections: [input.frames[0], input.frames.at(-1)].map(frame => ({ time: frame.time, confidence: 'high', reason: '모의 응답: 지정 색과 번호 확인' })), summary: '테스트용 탐색', limitations: ['모델 응답은 모의 처리'], model: 'mock-only' });
    clips += 1;
    if (onClip) await onClip(input, clips);
    if (clips === failClip) return new Response(JSON.stringify({ code: 'analysis_provider_failed', error: 'must not forward arbitrary details or secret' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    return response({ model: 'mock-only', result: { identified: true, summary: '실제 JPEG를 사용한 모의 관찰', observations: [{ skill: 'move', time: Math.ceil(input.start), note: '테스트용 위치 관찰', type: 'note', confidence: 'medium' }], limitations: ['테스트용 AI 응답이며 실제 선수 평가가 아닙니다.'], nextAction: '코치와 장면 확인' } });
  };
}

test('server decodes the real original, checkpoints paid results and resumes without a browser or duplicate calls', async t => {
  const setup = await fixture(t);
  const calls = [];
  const first = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, analysisHandler: fakeAnalysis(calls, { failClip: 2 }), env: {} });
  assert.equal(first.status, 'failed');
  assert.equal(first.clips.length, 1, JSON.stringify(first.error));
  assert.equal(first.progress.completedCount, 1);
  assert.equal(first.progress.duration, 30, 'Duration is probed from bytes, ignoring claimed 999 seconds');
  let workspace = await setup.store.get(`workspaces/${setup.userId}`);
  assert.equal(workspace.analyses.length, 1);
  assert.equal(workspace.videos[0].duration, 30);
  assert.equal(JSON.stringify(workspace).includes(token), false);
  assert.equal(JSON.stringify(workspace).includes('data:image'), false);
  assert.equal(JSON.stringify(first.error).includes('secret'), false);
  const completed = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, analysisHandler: fakeAnalysis(calls), env: {} });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.stage, 'completed');
  assert.equal(completed.progress.completedCount, 2);
  assert.equal(completed.leaseOwner, null);
  assert.equal(completed.leaseUntil, null);
  assert.equal(calls.filter(call => call.mode === 'discover').length, 1);
  assert.equal(calls.filter(call => !call.mode).length, 3, 'Only the failed second clip is requested again explicitly');
  workspace = await setup.store.get(`workspaces/${setup.userId}`);
  assert.equal(workspace.analyses.length, 2);
  assert.equal(new Set(workspace.analyses.map(item => item.id)).size, 2);
  assert.equal(workspace.observations.length, 0, 'Qualitative AI cannot create human ratings');
  assert.equal(completed.result.coverage.analyzedSeconds, 24);
  assert.equal(completed.result.coverage.mode, 'sampled');
  assert.deepEqual(validateGrowthWorkspace(workspace).analyses, workspace.analyses);
});

test('persisted cancellation stops future paid requests while retaining the completed clip', async t => {
  const setup = await fixture(t);
  const calls = [];
  const stopped = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, env: {}, analysisHandler: fakeAnalysis(calls, { onClip: async (_input, count) => {
    // Cancellation arrives while a paid result is returning. Keep that result
    // durably, then stop before asking the provider to process another clip.
    if (count === 1) await setup.store.update(`jobs/${setup.jobId}`, current => ({ ...current, cancelRequested: true, status: 'cancelled' }));
  } }) });
  assert.equal(stopped.status, 'cancelled', JSON.stringify(stopped.error));
  assert.equal(stopped.clips.length, 1);
  assert.equal(calls.filter(call => !call.mode).length, 1);
  assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length, 1);
});

test('job credentials and real AI configuration fail clearly before media processing', async t => {
  const setup = await fixture(t, 1);
  await assert.rejects(runGrowthJob({ ...setup, token: 'wrong-private-token', localMediaInput: '/unreadable.mp4', env: {} }), { code: 'unauthorized_job' });
  const failed = await runGrowthJob({ ...setup, token, localMediaInput: '/unreadable.mp4', env: {} });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'analysis_unavailable');
  assert.match(failed.error.message, /API 키/);
  assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length, 0);
});

test('budget checkpoints queue a continuation and recovery rotates tokens only for eligible jobs', async t => {
  const setup = await fixture(t, 30);
  const continuations = [];
  const queued = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, budgetMs: 100, dispatchContinuation: async (...args) => { continuations.push(args); }, analysisHandler: fakeAnalysis([]), env: {} });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.leaseOwner, null);
  assert.deepEqual(continuations, [[setup.jobId, token]]);
  const now = Date.now() + 120_000;
  const dispatched = [];
  const recovered = await recoverGrowthJobs({ store: setup.store, now, dispatchJob: async (...args) => { dispatched.push(args); } });
  assert.equal(recovered.dispatched, 1);
  assert.equal(dispatched[0][0], setup.jobId);
  assert.notEqual(dispatched[0][1], token);
  const persisted = await setup.store.get(`jobs/${setup.jobId}`);
  assert.equal(persisted.tokenHash, digest(dispatched[0][1]));
  assert.equal(JSON.stringify(persisted).includes(dispatched[0][1]), false);
  assert.equal((await recoverGrowthJobs({ store: setup.store, now, dispatchJob: async () => assert.fail('Dispatch lease prevents another rotation') })).dispatched, 0);
});

test('a workspace write failure is repaired from the durable clip without repeating the paid call', async t => {
  const setup = await fixture(t, 2);
  const originalUpdate = setup.store.update;
  let failOnce = true;
  setup.store.update = async (key, updater) => {
    if (key === `workspaces/${setup.userId}` && failOnce && (await setup.store.get(`jobs/${setup.jobId}`)).clips.length) {
      failOnce = false;
      throw new Error('Temporary storage connection failure');
    }
    return originalUpdate(key, updater);
  };
  const calls = [];
  const failed = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, analysisHandler: fakeAnalysis(calls), env: {} });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.clips.length, 1);
  assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length, 0);
  const restored = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, analysisHandler: fakeAnalysis(calls), env: {} });
  assert.equal(restored.status, 'completed');
  assert.equal(calls.filter(call => call.mode === 'discover').length, 1);
  assert.equal(calls.filter(call => !call.mode).length, 1);
  assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length, 1);
});

test('a second invocation cannot take an active lease or turn AI observations into player ratings', async t => {
  const setup = await fixture(t, 2);
  await setup.store.update(`jobs/${setup.jobId}`, job => ({ ...job, status: 'running', leaseOwner: 'another-invocation', leaseUntil: new Date(Date.now() + 60_000).toISOString() }));
  const held = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, analysisHandler: async () => assert.fail('Active lease cannot make another paid call') });
  assert.equal(held.leaseOwner, 'another-invocation');
  await setup.store.update(`jobs/${setup.jobId}`, job => ({ ...job, leaseOwner: null, leaseUntil: null }));
  const originalHandler = fakeAnalysis([]);
  const failed = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, analysisHandler: async (request, options) => {
    const result = await originalHandler(request, options);
    const payload = await result.json();
    if (payload.result) payload.result.observations[0].rating = 5;
    return response(payload);
  }, env: {} });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'analysis_invalid_result');
  assert.equal(failed.clips.length, 0);
  assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length, 0);
});

test('an uploaded playlist disguised as MP4 cannot make the decoder fetch its referenced URL', async t => {
  const setup = await fixture(t, 2);
  let referencedRequests = 0;
  let authorizedReads = 0;
  let origin;
  const server = http.createServer((request, result) => {
    if (request.url === '/should-never-fetch') {
      referencedRequests += 1;
      result.writeHead(200, { 'Content-Type': 'video/mp2t' });
      result.end('not a real segment');
      return;
    }
    if (request.url !== '/original.mp4' || request.headers.authorization !== `Bearer ${token}`) { result.writeHead(404); result.end(); return; }
    authorizedReads += 1;
    const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\n${origin}/should-never-fetch\n#EXT-X-ENDLIST\n`;
    result.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': Buffer.byteLength(playlist) });
    result.end(playlist);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const failed = await runGrowthJob({ ...setup, token, mediaURL: `${origin}/original.mp4`, env: {}, analysisHandler: async () => assert.fail('A disguised playlist must fail before a paid request') });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'media_unreadable');
  assert.ok(authorizedReads >= 1);
  assert.equal(referencedRequests, 0, 'Untrusted media must never choose another server request');
  assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length, 0);
});

test('the container allowlist still accepts a real WebM original', async t => {
  const setup = await fixture(t, 2);
  const webm = path.join(path.dirname(setup.file), 'original.webm');
  const generated = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', setup.file, '-c:v', 'libvpx-vp9', '-an', webm]);
  assert.equal(generated.status, 0, 'Generate a real WebM to exercise its Matroska demuxer');
  const result = await runGrowthJob({ ...setup, token, localMediaInput: webm, env: {}, analysisHandler: fakeAnalysis([]) });
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.progress.duration, 2);
  assert.equal(result.clips.length, 1);
});

test('an uploaded metadata comment cannot impersonate the actual media duration', async t => {
  const setup = await fixture(t, 6);
  const tagged = path.join(path.dirname(setup.file), 'tagged-original.mp4');
  const generated = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', setup.file, '-c', 'copy', '-metadata', 'comment=Duration: 00:00:01.00, start: 0.000000, bitrate: 123 kb/s', tagged]);
  assert.equal(generated.status, 0);
  const calls = [];
  const result = await runGrowthJob({ ...setup, token, localMediaInput: tagged, env: {}, analysisHandler: fakeAnalysis(calls) });
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.progress.duration, 6, 'Probe the real format summary, ignoring a forged one-second comment');
  assert.equal(result.progress.sampleCount, 3);
  assert.equal(result.result.coverage.duration, 6);
  assert.equal(result.clips[0].end, 6);
  assert.equal(calls[0].end, 6);
});

test('real quota responses block durably, hold the timer, probe one job and resume paid checkpoints once', async t => {
  const setup = await fixture(t, 30);
  const calls = [];
  const normal = fakeAnalysis(calls);
  let observations = 0;
  const blocked = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, env: {}, analysisHandler: async (request, options) => {
    const body = await request.clone().json();
    if (!body.mode && ++observations === 2) {
      calls.push(body);
      return new Response(JSON.stringify({ code: 'analysis_quota_exceeded', error: 'ignored raw provider body' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }
    return normal(request, options);
  } });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stage, 'quota');
  assert.equal(blocked.clips.length, 1);
  assert.equal(blocked.progress.completedCount, 1);
  const provider = await readProviderStatus(setup.store);
  assert.equal(provider.status, 'quota_exceeded');
  assert.equal(blocked.retryAt, provider.retryAt);
  const previousCalls = calls.length;
  const held = await runGrowthJob({ ...setup, token, localMediaInput: '/must-not-decode-before-cooldown.mp4', env: {}, analysisHandler: normal });
  assert.equal(held.status, 'blocked');
  assert.equal(calls.length, previousCalls);
  assert.deepEqual(await readProviderStatus(setup.store), provider, 'A locally blocked attempt cannot reset the 30-minute clock');
  assert.equal((await recoverGrowthJobs({ store: setup.store, dispatchJob: async () => assert.fail('No cooldown probe yet') })).dispatched, 0);
  // A second already-admitted video waits behind the single provider probe.
  const secondId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const secondVideo = randomUUID();
  const original = await setup.store.get(`videos/${setup.videoId}`);
  await setup.store.set(`videos/${secondVideo}`, { ...original, id: secondVideo });
  await setup.store.update(`workspaces/${setup.userId}`, current => ({ ...current, videos: [...current.videos, { ...current.videos[0], id: secondVideo }] }));
  await setup.store.set(`jobs/${secondId}`, { ...blocked, id: secondId, videoId: secondVideo, progress: {}, clips: [], result: null });
  await setup.store.update('providers/openai', current => ({ ...current, retryAt: new Date(Date.now() - 1).toISOString() }));
  // Start this scenario at the partially completed job; separate tests verify
  // round-robin cursor fairness when later jobs are present.
  await setup.store.update('recovery/growth-jobs', current => ({ ...current, cursor: null }));
  const dispatched = [];
  assert.equal((await recoverGrowthJobs({ store: setup.store, dispatchJob: async (id, raw) => { dispatched.push({ id, token: raw }); } })).dispatched, 1);
  assert.equal(dispatched[0].id, setup.jobId);
  assert.equal((await recoverGrowthJobs({ store: setup.store, dispatchJob: async () => assert.fail('One outstanding probe only') })).dispatched, 0);
  const restored = await runGrowthJob({ ...setup, token: dispatched[0].token, localMediaInput: setup.file, env: {}, analysisHandler: fakeAnalysis(calls, { expectedToken: dispatched[0].token }) });
  assert.equal(restored.status, 'completed', JSON.stringify(restored.error));
  assert.equal(restored.clips.length, 2);
  assert.equal(restored.clips[0].id, blocked.clips[0].id);
  assert.equal(calls.filter(item => item.mode === 'discover').length, 1, 'Paid discovery is not repeated');
  assert.equal(calls.filter(item => !item.mode).length, 3, 'Only the unsuccessful second clip is requested once after recovery');
  assert.equal((await readProviderStatus(setup.store)).status, 'ready');
  const unblocked = [];
  assert.equal((await recoverGrowthJobs({ store: setup.store, dispatchJob: async (...args) => { unblocked.push(args); } })).dispatched, 1);
  assert.equal(unblocked[0][0], secondId);
});

test('legacy quota failures migrate once while revoked consent and other provider failures cannot restart', async t => {
  const setup = await fixture(t, 2);
  const observed = Date.now() - 5 * 60_000;
  await setup.store.update(`jobs/${setup.jobId}`, current => ({ ...current, status: 'failed', error: { code: 'analysis_quota_exceeded', message: 'Actual previous quota evidence' }, updatedAt: new Date(observed).toISOString() }));
  const olderId = '00000000-0000-0000-0000-000000000000';
  const older = await setup.store.get(`jobs/${setup.jobId}`);
  await setup.store.set(`jobs/${olderId}`, { ...older, id: olderId, updatedAt: new Date(observed - 10 * 60_000).toISOString() });
  const dispatched = [];
  assert.equal((await recoverGrowthJobs({ store: setup.store, dispatchJob: async (...args) => { dispatched.push(args); } })).dispatched, 0);
  const migrated = await setup.store.get(`jobs/${setup.jobId}`);
  assert.equal(migrated.status, 'blocked');
  assert.equal(Date.parse(migrated.retryAt), observed + 30 * 60_000);
  const before = await readProviderStatus(setup.store);
  await recoverGrowthJobs({ store: setup.store, now: Date.now() + 60_000, dispatchJob: async () => assert.fail('Migration cannot renew or bypass cooldown') });
  assert.deepEqual(await readProviderStatus(setup.store), before);
  await setup.store.update(`workspaces/${setup.userId}`, current => ({ ...current, consents: { ...current.consents, analysis: false } }));
  await recoverGrowthJobs({ store: setup.store, now: Date.now() + 31 * 60_000, dispatchJob: async () => assert.fail('Consent withdrawal stops a blocked job') });
  assert.equal((await setup.store.get(`jobs/${setup.jobId}`)).status, 'cancelled');
  assert.equal(dispatched.length, 0);
  const other = await fixture(t, 2);
  await other.store.update(`jobs/${other.jobId}`, current => ({ ...current, status: 'failed', error: { code: 'analysis_credentials_rejected', message: 'Authentication failure must remain explicit' } }));
  await recoverGrowthJobs({ store: other.store, dispatchJob: async () => assert.fail('Authentication failures are not quota recoveries') });
  assert.equal((await other.store.get(`jobs/${other.jobId}`)).status, 'failed');
  assert.equal((await readProviderStatus(other.store)).status, 'unknown');
});

async function recoveryJobs(setup, count, status = 'queued') {
  const original = await setup.store.get(`jobs/${setup.jobId}`);
  await setup.store.delete(`jobs/${setup.jobId}`);
  const ids = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
    ids.push(id);
    await setup.store.set(`jobs/${id}`, { ...original, id, status, updatedAt: new Date(Date.now() - 120_000).toISOString() });
  }
  return ids;
}

test('recovery stops at its deadline and durable cursor lets later jobs proceed after a stalled dispatch', async t => {
  const setup = await fixture(t, 2);
  const ids = await recoveryJobs(setup, 3);
  await setup.store.set('providers/openai', { status: 'ready', retryAt: null, checkedAt: new Date().toISOString(), version: 0 });
  let attempted = 0;
  let receivedSignal;
  const started = performance.now();
  const stopped = await recoverGrowthJobs({ store: setup.store, budgetMs: 80, dispatchJob: async (_id, _token, options) => {
    attempted += 1;
    receivedSignal = options.signal;
    assert.ok(options.timeoutMs <= 80);
    // Deliberately ignore cancellation to prove the coordinator itself has a
    // deadline even if a dependency never resolves.
    return new Promise(() => {});
  } });
  assert.ok(performance.now() - started < 1000);
  assert.equal(stopped.timedOut, true);
  assert.equal(attempted, 1);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(stopped.cursor, `jobs/${ids[0]}`);
  assert.equal((await setup.store.get(`jobs/${ids[0]}`)).status, 'queued');
  // The next real one-minute invocation is after the short coordinator lease.
  await setup.store.update('recovery/growth-jobs', current => ({ ...current, leaseUntil: new Date(Date.now() - 1).toISOString() }));
  const next = [];
  const result = await recoverGrowthJobs({ store: setup.store, now: Date.now() + 120_000, maximum: 2, dispatchJob: async (id, _token, options) => { assert.ok(options.timeoutMs <= 8000); next.push(id); } });
  assert.equal(result.timedOut, false);
  assert.deepEqual(next, ids.slice(1));
  const wrapped = [];
  await recoverGrowthJobs({ store: setup.store, now: Date.now() + 240_000, maximum: 1, dispatchJob: async id => { wrapped.push(id); } });
  assert.deepEqual(wrapped, [ids[0]], 'The original timed-out job is still recoverable after the cursor wraps');
});

test('concurrent recovery coordinators still admit one due quota probe', async t => {
  const setup = await fixture(t, 2);
  await recoveryJobs(setup, 2, 'blocked');
  await blockProviderQuota(setup.store, { now: Date.now() - 31 * 60_000 });
  const dispatched = [];
  const invoke = () => recoverGrowthJobs({ store: setup.store, dispatchJob: async id => { dispatched.push(id); } });
  const results = await Promise.all([invoke(), invoke()]);
  assert.equal(dispatched.length, 1);
  assert.equal(results.reduce((total, result) => total + result.dispatched, 0), 1);
  assert.ok(results.some(result => result.busy === true));
  assert.equal((await readProviderStatus(setup.store)).status, 'quota_exceeded');
  assert.equal((await invoke()).dispatched, 0, 'No second probe runs before the first real response');
});

test('legacy evidence scan checkpoints its cursor across a short recovery budget', async t => {
  const setup = await fixture(t, 2);
  const ids = await recoveryJobs(setup, 12, 'failed');
  const originalGet = setup.store.get;
  setup.store.get = async key => {
    if (key.startsWith('jobs/')) await new Promise(resolve => setTimeout(resolve, 5));
    return originalGet(key);
  };
  const first = await recoverGrowthJobs({ store: setup.store, budgetMs: 30, dispatchJob: async () => assert.fail('Failed non-quota jobs are never dispatched') });
  assert.equal(first.timedOut, true);
  const saved = await originalGet('recovery/growth-jobs');
  assert.equal(saved.phase, 'bootstrap');
  assert.ok(saved.cursor >= `jobs/${ids[0]}` && saved.cursor < `jobs/${ids.at(-1)}`);
  await setup.store.update('recovery/growth-jobs', current => ({ ...current, leaseUntil: new Date(Date.now() - 1).toISOString() }));
  const completed = await recoverGrowthJobs({ store: setup.store, budgetMs: 1000, dispatchJob: async () => assert.fail('Failed jobs remain failed') });
  assert.equal(completed.timedOut, false);
  assert.equal((await originalGet('recovery/growth-jobs')).phase, 'jobs');
});
