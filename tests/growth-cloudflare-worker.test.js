import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createLocalStore } from '../lib/growth/store.js';
import { createGrowthAPI } from '../lib/growth/api.js';
import { runGrowthJob, recoverGrowthJobs } from '../lib/growth/worker.js';
import { blockProviderQuota, readProviderStatus } from '../lib/growth/provider.js';
import { createGrowthWorkspace } from '../public/growth-domain.js';

const token = 'private-cloudflare-worker-test-token';
const target = { kit: 'red', number: 7, age: 9 };
const env = { SOCCER_AI_PROVIDER: 'cloudflare', SOCCER_FFMPEG_PATH: 'ffmpeg' };
const consentVersion = '2026-10-cloudflare-v24';
const digest = value => createHash('sha256').update(value).digest('hex');
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, seconds = 4, { frameRate = 10 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'next-xi-cloudflare-worker-'));
  const store = await createLocalStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const file = path.join(directory, 'original.mp4');
  const generated = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=${frameRate}`, '-t', String(seconds), '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
  assert.equal(generated.status, 0, 'Generate a real MP4 at the requested frame rate');
  const bytes = await readFile(file);
  const userId = randomUUID(), videoId = randomUUID(), jobId = randomUUID(), uploadId = randomUUID();
  const stamp = new Date().toISOString();
  const sourceKey = `media/${userId}/${videoId}/0/${digest(bytes)}`;
  const chunks = [{ index: 0, key: sourceKey, hash: digest(bytes), size: bytes.length }];
  const metadata = { id: videoId, kind: 'server', title: 'Cloudflare 실제 원본 테스트', fileName: 'original.mp4', size: bytes.length, mime: 'video/mp4', addedAt: stamp, duration: null, retentionPolicy: 'delete_after_analysis', target, context: {} };
  const workspace = createGrowthWorkspace();
  workspace.consents.guardian = true;
  workspace.consents.analysis = true;
  workspace.videos.push(metadata);
  await store.set(`users/${userId}`, { id: userId, deleting: false });
  await store.set(`workspaces/${userId}`, workspace);
  await store.putBinary(sourceKey, bytes);
  await store.set(`videos/${videoId}`, { ...metadata, userId, status: 'ready', chunkSize: 4 * 1024 * 1024, chunks });
  await store.set(`uploads/${uploadId}`, { id: uploadId, userId, videoId, status: 'completed', size: bytes.length, offset: bytes.length, chunkSize: 4 * 1024 * 1024, chunks });
  await store.set(`quotas/storage/${userId}`, { entries: [{ videoId, size: bytes.length, status: 'ready' }] });
  await store.set(`jobs/${jobId}`, { id: jobId, userId, videoId, provider: 'cloudflare', analysisConsentVersion: consentVersion, analysisConsentAt: stamp, target, context: {}, status: 'queued', stage: 'queued', createdAt: stamp, updatedAt: stamp, tokenHash: digest(token), cancelRequested: false, progress: {}, clips: [], result: null });
  return { store, file, bytes, sourceKey, userId, videoId, jobId };
}

function mockAnalysis(calls, { onObservation, discoveryDetections } = {}) {
  let observations = 0;
  return async (request, options) => {
    const input = await request.json();
    calls.push(input);
    assert.equal(options.env.SOCCER_AI_PROVIDER, 'cloudflare');
    assert.equal(options.env.SOCCER_ANALYSIS_ACCESS_CODE, token);
    assert.equal(input.accessCode, token);
    assert.equal(input.consent, true);
    assert.deepEqual(input.target, target);
    assert.ok(input.frames.length >= 1 && input.frames.length <= 4, 'Cloudflare accepts at most four actual JPEGs per request');
    assert.ok(Buffer.byteLength(JSON.stringify(input)) < 3_000_000);
    for (const [index, frame] of input.frames.entries()) {
      assert.ok(Number.isFinite(frame.time) && frame.time >= input.start && frame.time <= input.end);
      if (index) assert.ok(frame.time > input.frames[index - 1].time);
      assert.ok(frame.image.startsWith('data:image/jpeg;base64,') && frame.image.length <= 250_000);
      const jpeg = Buffer.from(frame.image.split(',')[1], 'base64');
      assert.deepEqual([...jpeg.subarray(0, 2), ...jpeg.subarray(-2)], [0xff, 0xd8, 0xff, 0xd9]);
    }
    if (input.mode === 'discover') return response({ mode: 'discover', detections: discoveryDetections ?? input.frames.map(frame => ({ time: frame.time, confidence: 'high', reason: '모의 응답: 색과 번호 확인' })), summary: '모의 표본 탐색', limitations: ['실제 AI 추론은 실행하지 않음'], model: 'mock-cloudflare-workers-ai' });
    observations += 1;
    const override = await onObservation?.(input, observations);
    if (override) return override;
    const evidence = input.frames.find(frame => Math.round(frame.time) >= Math.ceil(input.start) && Math.round(frame.time) <= Math.floor(input.end));
    assert.ok(evidence, 'An observation must cite a rounded actual JPEG time inside the clip');
    return response({ model: 'mock-cloudflare-workers-ai', result: { identified: true, summary: '실제 JPEG를 사용한 모의 관찰', observations: [{ skill: 'move', time: Math.round(evidence.time), note: '테스트용 위치 관찰', type: 'note', confidence: 'medium' }], limitations: ['모의 AI 응답이며 선수 평가가 아닙니다.'], nextAction: '코치와 실제 장면 확인' } });
  };
}

function assertClipEvidence(clip, call, discoveryTimes) {
  assert.ok(clip.end > clip.start && clip.end - clip.start <= 3);
  assert.deepEqual(clip.sampledTimes, call.frames.map(frame => frame.time));
  assert.ok(clip.sampledTimes.length <= 4);
  assert.ok(Number.isFinite(clip.referenceTime), 'Every review window must contain qualifying discovery evidence');
  assert.ok(discoveryTimes.has(clip.referenceTime), 'Reference time must come from discovery evidence');
  assert.ok(clip.sampledTimes.includes(clip.referenceTime), 'Keep the exact discovery anchor among observation JPEGs');
  for (const observation of clip.result.observations) assert.ok(clip.sampledTimes.some(time => Math.round(time) === observation.time));
}

test('Cloudflare decodes one-second discovery batches and anchors each short review with actual frame timestamps', async t => {
  const setup = await fixture(t);
  const calls = [];
  const completed = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, env, analysisHandler: mockAnalysis(calls) });
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  assert.equal(completed.progress.duration, 4);
  assert.equal(completed.progress.interval, 1);
  assert.equal(completed.progress.sampleCount, 5);
  assert.equal(completed.progress.sampledCount, 5);
  const discovery = calls.filter(call => call.mode === 'discover');
  assert.deepEqual(discovery.map(call => call.frames.length), [4, 1]);
  const discoveryTimes = new Set(discovery.flatMap(call => call.frames.map(frame => frame.time)));
  assert.deepEqual([...discoveryTimes], [0, 1, 2, 3, 3.9]);
  const observations = calls.filter(call => call.mode !== 'discover');
  assert.equal(observations.length, 2);
  assert.deepEqual(completed.clips.map(({ start, end }) => ({ start, end })), [{ start: 0, end: 3 }, { start: 2, end: 4 }]);
  for (const [index, clip] of completed.clips.entries()) {
    assert.ok(Number.isFinite(clip.referenceTime));
    assertClipEvidence(clip, observations[index], discoveryTimes);
  }
  assert.equal(completed.result.coverage.mode, 'sampled');
  assert.equal(completed.result.coverage.sampledFrames, discoveryTimes.size);
  assert.equal(completed.result.coverage.observationFrames, observations.reduce((total, call) => total + call.frames.length, 0));
  assert.equal(completed.result.coverage.analyzedSegments, 2);
  const workspace = await setup.store.get(`workspaces/${setup.userId}`);
  assert.equal(workspace.analyses.length, 2);
  assert.equal(workspace.observations.length, 0, 'Qualitative AI results never create human ability ratings');
  assert.equal(JSON.stringify(workspace).includes(token), false);
  assert.equal(JSON.stringify(workspace).includes('data:image/jpeg'), false);
});

test('Cloudflare counts a low-frame-rate tail fallback once without sending its duplicate JPEG to AI', async t => {
  const setup = await fixture(t, 4, { frameRate: 1 });
  const calls = [];
  const completed = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, env, analysisHandler: mockAnalysis(calls, { discoveryDetections: [] }) });
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  assert.equal(completed.stage, 'not_found');
  assert.equal(completed.progress.sampleCount, 5);
  assert.equal(completed.progress.sampledCount, 5, 'All requested plan positions, including 3.9s, are processed');
  assert.equal(completed.progress.sampledFrames, 4);
  assert.equal(completed.progress.duplicateSampleCount, 1);
  assert.equal(calls.length, 1, 'The duplicate final fallback never starts another AI request');
  assert.equal(calls[0].mode, 'discover');
  assert.deepEqual(calls[0].frames.map(frame => frame.time), [0, 1, 2, 3]);
  assert.equal(completed.result.coverage.mode, 'sampled');
  assert.equal(completed.result.coverage.sampledFrames, 4);
  assert.equal(completed.result.coverage.completedSampleRequests, 5);
  assert.equal(completed.result.coverage.skippedDuplicateRequests, 1);
  assert.equal(completed.result.coverage.observationFrames, 0);
  assert.equal(completed.clips.length, 0);
  assert.deepEqual(await setup.store.getBinary(setup.sourceKey), new Uint8Array(setup.bytes));
  assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length, 0);
});

test('Cloudflare resumes completed discovery and processes every qualifying activity window beyond six', async t => {
  const setup = await fixture(t, 100);
  const detections = [6, 21, 36, 51, 66, 81, 96].map(time => ({ time, confidence: 'high', reason: '모의 체크포인트: 지정 선수 확인' }));
  await setup.store.update(`jobs/${setup.jobId}`, current => ({ ...current, progress: { provider: 'cloudflare', duration: 100, sampleCount: 101, sampledCount: 101, sampledFrames: 101, lastSampledTime: 99.9, duplicateSampleCount: 0, interval: 1, detectedCount: detections.length, selectedCount: 0, completedCount: 0, status: 'analyzing', detections, segments: [], model: 'mock-cloudflare-workers-ai' } }));
  const calls = [];
  const completed = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, env, analysisHandler: mockAnalysis(calls) });
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  assert.equal(calls.filter(call => call.mode === 'discover').length, 0, 'Resume the saved scan without decoding or requesting it again');
  assert.equal(completed.clips.length, 7);
  assert.equal(completed.clips.length, completed.progress.selectedCount);
  assert.equal(completed.clips.length, completed.progress.completedCount);
  assert.equal(calls.length, completed.clips.length);
  const discoveryTimes = new Set(detections.map(item => item.time));
  for (const [index, clip] of completed.clips.entries()) assertClipEvidence(clip, calls[index], discoveryTimes);
  for (const detection of detections) assert.ok(completed.clips.some(clip => clip.start <= detection.time && clip.end >= detection.time), `Keep qualifying evidence at ${detection.time}s`);
  assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length, completed.clips.length);
});

test('Cloudflare retains evidence over protected HTTP after completion before removing the original', async t => {
  const setup = await fixture(t);
  const api = createGrowthAPI({ store: setup.store, env });
  const mediaReads = [];
  let origin;
  const server = http.createServer(async (request, result) => {
    try {
      const state = request.url.startsWith('/api/v2/media/') ? await setup.store.get(`jobs/${setup.jobId}`) : null;
      const served = await api(new Request(`${origin}${request.url}`, { method: request.method, headers: request.headers }));
      if (!served) { result.writeHead(404); result.end(); return; }
      if (state) mediaReads.push({ jobStatus: state.status, retentionStatus: state.retention?.status || null, retentionLeaseUntil: state.retention?.leaseUntil || null, authorized: request.headers.authorization === `Bearer ${token}`, hasCookie: Boolean(request.headers.cookie), status: served.status });
      result.writeHead(served.status, Object.fromEntries(served.headers));
      if (!served.body) { result.end(); return; }
      const stream = Readable.fromWeb(served.body);
      stream.on('error', () => result.destroy());
      result.on('close', () => stream.destroy());
      stream.pipe(result);
    } catch {
      if (!result.headersSent) result.writeHead(500);
      result.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const mediaURL = `${origin}/api/v2/media/${setup.videoId}?jobId=${setup.jobId}`;
  const unauthorized = await fetch(mediaURL);
  assert.equal(unauthorized.status, 404, 'The job ID alone cannot reveal the private original');
  await unauthorized.arrayBuffer();
  const calls = [];
  const completed = await runGrowthJob({ store: setup.store, jobId: setup.jobId, token, mediaURL, env, analysisHandler: mockAnalysis(calls) });
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  assert.equal(completed.retention?.status, 'completed', JSON.stringify(completed.retention));
  assert.equal(completed.clips.length, 2);
  assert.ok(mediaReads.some(read => read.jobStatus === 'running' && read.status < 400));
  const evidenceReads = mediaReads.filter(read => read.jobStatus === 'completed' && read.retentionStatus === 'preparing');
  assert.ok(evidenceReads.length >= completed.clips.length, 'Evidence encoding must read the protected original after analysis completion');
  assert.ok(evidenceReads.every(read => read.authorized && !read.hasCookie && read.status < 400 && Date.parse(read.retentionLeaseUntil) > Date.parse(completed.completedAt)));
  assert.equal(await setup.store.getBinary(setup.sourceKey), null);
  const removed = await fetch(mediaURL, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(removed.status, 404, 'The original route closes after successful evidence retention');
  await removed.arrayBuffer();
  for (const clip of completed.clips) {
    const record = await setup.store.get(`evidence/${clip.id}`);
    assert.ok(record && record.userId === setup.userId && record.analysisId === clip.id);
    const evidence = await fetch(`${origin}/api/v2/evidence/${clip.id}?jobId=${setup.jobId}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(evidence.status, 200);
    assert.equal(evidence.headers.get('content-type'), 'video/mp4');
    const bytes = Buffer.from(await evidence.arrayBuffer());
    assert.equal(bytes.length, record.size);
    assert.equal(digest(bytes), record.sha256);
    const decoded = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'null', '-'], { input: bytes });
    assert.equal(decoded.status, 0, 'Authenticated evidence HTTP responses contain playable MP4 bytes');
  }
});

test('Cloudflare refuses another provider or stale consent before reading media or calling AI', async t => {
  for (const entry of [
    { name: 'missing provider', provider: undefined, version: consentVersion, environment: env, code: 'analysis_consent_required' },
    { name: 'OpenAI consent cannot authorize Cloudflare', provider: 'openai', version: '2026-10-growth-v2', environment: env, code: 'analysis_consent_required' },
    { name: 'stale Cloudflare consent', provider: 'cloudflare', version: '2026-10-growth-v2', environment: env, code: 'analysis_consent_required' },
    { name: 'Cloudflare job cannot run through OpenAI', provider: 'cloudflare', version: consentVersion, environment: { SOCCER_AI_PROVIDER: 'openai' }, code: 'analysis_provider_changed' },
  ]) await t.test(entry.name, async subtest => {
    const setup = await fixture(subtest, 1);
    await setup.store.update(`jobs/${setup.jobId}`, current => ({ ...current, provider: entry.provider, analysisConsentVersion: entry.version }));
    const refused = await runGrowthJob({ ...setup, token, localMediaInput: '/must-not-open-before-provider-consent-check.mp4', env: entry.environment, analysisHandler: async () => assert.fail('No provider request is authorized') });
    assert.equal(refused.status, 'failed');
    assert.equal(refused.error.code, entry.code);
    assert.equal(refused.clips.length, 0);
    assert.deepEqual(await setup.store.getBinary(setup.sourceKey), new Uint8Array(setup.bytes));
    assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length, 0);
  });
});

test('Cloudflare recovery skips old consent and retries retention through daily quota without repeating AI', async t => {
  const setup = await fixture(t);
  const originalPutBinary = setup.store.putBinary;
  let interruptEvidence = true;
  setup.store.putBinary = async (key, bytes) => {
    if (interruptEvidence && key.startsWith('evidence-media/')) {
      interruptEvidence = false;
      throw Object.assign(new Error('Simulated evidence write interruption'), { code: 'evidence_write_interrupted' });
    }
    return originalPutBinary(key, bytes);
  };
  const calls = [];
  const pending = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, env, analysisHandler: mockAnalysis(calls) });
  assert.equal(pending.status, 'completed', JSON.stringify(pending.error));
  assert.equal(pending.retention.status, 'pending');
  assert.equal(pending.clips.length, 2);
  assert.deepEqual(await setup.store.getBinary(setup.sourceKey), new Uint8Array(setup.bytes), 'Keep original bytes until every evidence MP4 is durable');
  assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length, 2);
  const ineligible = [];
  for (const [provider, analysisConsentVersion] of [['openai', '2026-10-growth-v2'], ['cloudflare', '2026-10-growth-v2']]) {
    const id = randomUUID();
    const old = { ...pending, id, provider, analysisConsentVersion, status: 'queued', stage: 'queued', progress: {}, clips: [], result: null, retention: null };
    await setup.store.set(`jobs/${id}`, old);
    ineligible.push(old);
  }
  const recoveryNow = Date.now() + 120_000;
  await blockProviderQuota(setup.store, { provider: 'cloudflare', now: recoveryNow });
  const providerBefore = await readProviderStatus(setup.store, { provider: 'cloudflare' });
  const dispatches = [];
  const recovered = await recoverGrowthJobs({ store: setup.store, env, now: recoveryNow, dispatchJob: async (id, replacement) => { dispatches.push({ id, token: replacement }); } });
  assert.equal(recovered.dispatched, 1, 'Completed retention work bypasses the AI quota gate');
  assert.equal(dispatches[0].id, setup.jobId);
  assert.notEqual(dispatches[0].token, token);
  const resumed = await setup.store.get(`jobs/${setup.jobId}`);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.tokenHash, digest(dispatches[0].token));
  for (const old of ineligible) assert.deepEqual(await setup.store.get(`jobs/${old.id}`), old, 'Do not rotate or restart another provider or stale consent');
  assert.deepEqual(await readProviderStatus(setup.store, { provider: 'cloudflare' }), providerBefore, 'Retention recovery neither claims an AI probe nor changes quota state');
  const callsBefore = calls.length;
  const retained = await runGrowthJob({ ...setup, token: dispatches[0].token, localMediaInput: setup.file, env, analysisHandler: async () => assert.fail('Completed discovery and observations must not run again during retention recovery') });
  assert.equal(retained.status, 'completed', JSON.stringify(retained.error));
  assert.equal(retained.retention.status, 'completed', JSON.stringify(retained.retention));
  assert.deepEqual(retained.clips.map(clip => clip.id), pending.clips.map(clip => clip.id));
  assert.equal(calls.length, callsBefore);
  assert.deepEqual(await readProviderStatus(setup.store, { provider: 'cloudflare' }), providerBefore);
  assert.equal(await setup.store.getBinary(setup.sourceKey), null, 'Release original bytes only after evidence preparation succeeds');
  const workspace = await setup.store.get(`workspaces/${setup.userId}`);
  assert.equal(workspace.videos[0].sourceStatus, 'deleted_after_analysis');
  for (const clip of retained.clips) {
    const record = await setup.store.get(`evidence/${clip.id}`);
    assert.ok(record && record.analysisId === clip.id && record.userId === setup.userId);
    const bytes = await setup.store.getBinary(record.key);
    assert.ok(bytes instanceof Uint8Array && bytes.length === record.size);
    const decoded = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'null', '-'], { input: Buffer.from(bytes) });
    assert.equal(decoded.status, 0, 'The retained evidence MP4 is genuinely decodable');
    assert.ok(workspace.analyses.find(item => item.id === clip.id)?.evidence);
  }
});

test('Cloudflare daily quota holds the source and completed result while isolating OpenAI state', async t => {
  const setup = await fixture(t);
  await blockProviderQuota(setup.store, { provider: 'openai' });
  const openaiBefore = await readProviderStatus(setup.store, { provider: 'openai' });
  const calls = [];
  const handler = mockAnalysis(calls, { onObservation: (_input, count) => count === 2 ? response({ code: 'analysis_quota_exceeded', error: 'private upstream response must not be forwarded' }, 429) : null });
  const blocked = await runGrowthJob({ ...setup, token, localMediaInput: setup.file, env, analysisHandler: handler });
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked.error));
  assert.equal(blocked.stage, 'quota');
  assert.equal(blocked.clips.length, 1);
  assert.equal(blocked.progress.completedCount, 1);
  assert.equal((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length, 1);
  assert.deepEqual(await setup.store.getBinary(setup.sourceKey), new Uint8Array(setup.bytes));
  const cloudflare = await readProviderStatus(setup.store, { provider: 'cloudflare' });
  assert.equal(cloudflare.status, 'quota_exceeded');
  assert.equal(Date.parse(cloudflare.retryAt), (Math.floor(Date.parse(cloudflare.checkedAt) / 86_400_000) + 1) * 86_400_000);
  assert.equal(blocked.retryAt, cloudflare.retryAt);
  assert.deepEqual(await readProviderStatus(setup.store, { provider: 'openai' }), openaiBefore);
  assert.equal(JSON.stringify(blocked.error).includes('private upstream'), false);
  const callsBefore = calls.length;
  const held = await runGrowthJob({ ...setup, token, localMediaInput: '/must-not-decode-during-daily-cooldown.mp4', env, analysisHandler: handler });
  assert.equal(held.status, 'blocked');
  assert.equal(held.retryAt, blocked.retryAt);
  assert.equal(calls.length, callsBefore);
  assert.deepEqual(held.clips, blocked.clips);
  assert.deepEqual(await readProviderStatus(setup.store, { provider: 'cloudflare' }), cloudflare);
  assert.deepEqual(await readProviderStatus(setup.store, { provider: 'openai' }), openaiBefore);
});

test('new report-only worker removes real MP4 after verified synthetic feedback without storing evidence videos',async t=>{
 const setup=await fixture(t);const calls=[];
 await setup.store.update(`videos/${setup.videoId}`,v=>({...v,retentionPolicy:'report_only'}));
 await setup.store.update(`workspaces/${setup.userId}`,w=>({...w,videos:w.videos.map(v=>({...v,retentionPolicy:'report_only'}))}));
 await setup.store.update(`jobs/${setup.jobId}`,j=>({...j,retentionPolicy:'report_only'}));
 const result=await runGrowthJob({store:setup.store,jobId:setup.jobId,token,localMediaInput:setup.file,env,analysisHandler:mockAnalysis(calls)});
 assert.equal(result.status,'completed');assert.equal(result.retention.status,'completed');assert.equal(result.result.identified,true);
 assert.equal(await setup.store.getBinary(setup.sourceKey),null);assert.deepEqual(await setup.store.list(`evidence-media/${setup.userId}/`),[]);
 assert.ok((await setup.store.get(`workspaces/${setup.userId}`)).analyses.length>0);
 const count=calls.length;await runGrowthJob({store:setup.store,jobId:setup.jobId,token,localMediaInput:setup.file,env,analysisHandler:mockAnalysis(calls)});assert.equal(calls.length,count);
});
test('report-only not-found cleanup resumes after interruption without repeating mock AI discovery',async t=>{
 const setup=await fixture(t,1);const calls=[];
 await setup.store.update(`videos/${setup.videoId}`,v=>({...v,retentionPolicy:'report_only'}));
 await setup.store.update(`workspaces/${setup.userId}`,w=>({...w,videos:w.videos.map(v=>({...v,retentionPolicy:'report_only'}))}));
 await setup.store.update(`jobs/${setup.jobId}`,j=>({...j,retentionPolicy:'report_only'}));
 const remove=setup.store.delete.bind(setup.store);let interrupted=false;
 setup.store.delete=async key=>{if(!interrupted&&key===setup.sourceKey){interrupted=true;throw new Error('synthetic interruption');}return remove(key);};
 const run=()=>runGrowthJob({store:setup.store,jobId:setup.jobId,token,localMediaInput:setup.file,env,analysisHandler:mockAnalysis(calls,{discoveryDetections:[]})});
 const first=await run();assert.equal(first.status,'completed');assert.equal(first.result.identified,false);assert.equal(first.retention.status,'pending');assert.ok(await setup.store.getBinary(setup.sourceKey));
 const count=calls.length,second=await run();assert.equal(second.retention.status,'completed');assert.equal(second.result.identified,false);assert.equal(await setup.store.getBinary(setup.sourceKey),null);assert.equal(calls.length,count);
});
