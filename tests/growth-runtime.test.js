import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createLocalStore } from '../lib/growth/store.js';
import { createGrowthAPI } from '../lib/growth/api.js';
import { runGrowthJob } from '../lib/growth/worker.js';
import { handleAnalysis } from '../lib/analysis.js';
import { analysisAvailability, netlifyOrigin, createBackgroundDispatch } from '../lib/growth/runtime.js';

test('runtime readiness requires only the server AI key and deployment origin stays pinned to Netlify', async () => {
  assert.deepEqual(await analysisAvailability({}), { available: false, reason: 'missing_credentials' });
  assert.deepEqual(await analysisAvailability({ SOCCER_AI_API_KEY: 'test-key-never-sent-live' }), { available: true, reason: 'ready' });
  assert.equal(netlifyOrigin({ DEPLOY_PRIME_URL: 'https://branch--next-xi.netlify.app/path', URL: 'https://custom.example' }), 'https://branch--next-xi.netlify.app');
  assert.equal(netlifyOrigin({ DEPLOY_URL: 'https://deployment-id--next-xi.netlify.app' }), 'https://deployment-id--next-xi.netlify.app');
  for (const env of [{}, { URL: 'https://external.example' }, { URL: 'http://next-xi.netlify.app' }, { URL: 'https://netlify.app.external.example' }]) assert.throws(() => netlifyOrigin(env));
});

test('background dispatch waits only for platform acceptance and keeps the job credential in the POST body', async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  try {
    globalThis.fetch = async (url, options) => {
      called += 1;
      assert.equal(String(url), 'https://next-xi.netlify.app/.netlify/functions/growth-worker-background');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { jobId: 'job-id', token: 'private-job-token' });
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(null, { status: called === 1 ? 202 : 500 });
    };
    const dispatch = createBackgroundDispatch('https://next-xi.netlify.app');
    await dispatch('job-id', 'private-job-token');
    await assert.rejects(dispatch('job-id', 'private-job-token'), /accept/);
  } finally { globalThis.fetch = originalFetch; }
});

test('background dispatch propagates the recovery deadline instead of waiting beyond it', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('recovery stopped')), 10);
  let received;
  try {
    globalThis.fetch = async (_url, options) => {
      received = options.signal;
      return new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    };
    const started = performance.now();
    await assert.rejects(createBackgroundDispatch('https://next-xi.netlify.app')('job', 'token', { signal: controller.signal, timeoutMs: 5000 }), /recovery stopped/);
    assert.ok(performance.now() - started < 1000);
    assert.equal(received.aborted, true);
  } finally { clearTimeout(timer); globalThis.fetch = originalFetch; }
});

test('a queued upload is analyzed over protected HTTP ranges after its browser session closes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'next-xi-runtime-'));
  const store = await createLocalStore(directory);
  const movie = path.join(directory, 'original.mp4');
  const generated = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=5', '-t', '36', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', movie]);
  assert.equal(generated.status, 0);
  const bytes = await readFile(movie);
  const dispatches = [], mediaRequests = [], upstreamCalls = [];
  const env = { SOCCER_AI_API_KEY: 'test-key-never-sent-live' };
  const api = createGrowthAPI({ store, availability: () => analysisAvailability(env), dispatchJob: async (id, token) => { dispatches.push({ id, token }); } });
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      const headers = new Headers(req.headers);
      // Force 4 KiB ranges through the real API, much smaller than production's
      // 4 MiB ceiling, so probe/decode must resume several HTTP requests. The
      // final low-FPS sample also exercises genuine-EOF handling and fallback.
      if (req.url.startsWith('/api/v2/media/') && req.headers.authorization && req.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (match) headers.set('Range', `bytes=${match[1]}-${Math.min(Number(match[1]) + 4095, match[2] ? Number(match[2]) : Infinity)}`);
      }
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
      const result = await api(request);
      if (!result) { res.writeHead(404); res.end(); return; }
      if (req.url.startsWith('/api/v2/media/')) mediaRequests.push({ path: req.url, bearer: Boolean(req.headers.authorization?.startsWith('Bearer ')), cookie: Boolean(req.headers.cookie), range: req.headers.range || null, status: result.status, bytes: Number(result.headers.get('content-length')), returnedRange: result.headers.get('content-range') });
      res.writeHead(result.status, Object.fromEntries(result.headers));
      if (!result.body) { res.end(); return; }
      const stream = Readable.fromWeb(result.body);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  let cookie;
  const request = async (route, { method = 'GET', body, headers = {}, authenticated = true } = {}) => {
    const json = body !== undefined && !Buffer.isBuffer(body);
    return fetch(`${origin}/api/v2${route}`, { method, headers: { ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(!['GET', 'HEAD'].includes(method) ? { Origin: origin } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: json ? JSON.stringify(body) : body }) });
  };
  const credentials = { email: 'runtime-parent@example.com', password: 'private-test-password-123', guardianName: '보호자', guardianConsent: true, adult: true };
  const registered = await request('/auth/register', { method: 'POST', body: credentials });
  assert.equal(registered.status, 201, await registered.clone().text());
  cookie = registered.headers.get('set-cookie').split(';')[0];
  const target = { kit: 'red', number: 7, age: 9 };
  const started = await request('/uploads', { method: 'POST', body: { fileName: 'original.mp4', title: 'HTTP 원본 테스트', size: bytes.length, mime: 'video/mp4', target, rightsConsent: true } });
  assert.equal(started.status, 201, await started.clone().text());
  const { upload } = await started.json();
  for (let offset = 0; offset < bytes.length; offset += upload.chunkSize) {
    const chunk = await request(`/uploads/${upload.id}`, { method: 'PUT', body: bytes.subarray(offset, offset + upload.chunkSize), headers: { 'Upload-Offset': String(offset) } });
    assert.equal(chunk.status, 200, await chunk.clone().text());
  }
  const completedUpload = await request(`/uploads/${upload.id}/complete`, { method: 'POST' });
  assert.equal(completedUpload.status, 200);
  const { video } = await completedUpload.json();
  const queued = await request('/jobs', { method: 'POST', body: { videoId: video.id, analysisConsent: true } });
  assert.equal(queued.status, 202, await queued.clone().text());
  const queuedJob = (await queued.json()).job;
  assert.equal(dispatches.length, 1);
  assert.equal(queuedJob.status, 'queued');
  assert.equal(JSON.stringify(queuedJob).includes(dispatches[0].token), false);
  // The page/session is gone before the asynchronous server worker starts.
  assert.equal((await request('/auth/logout', { method: 'POST' })).status, 200);
  cookie = null;
  assert.equal((await request('/workspace')).status, 401);
  assert.equal((await request(`/media/${video.id}`)).status, 404);
  const handler = async (analysisRequest, options) => {
    const input = await analysisRequest.clone().json();
    return handleAnalysis(analysisRequest, { ...options, fetchImpl: async (_url, providerOptions) => {
      const provider = JSON.parse(providerOptions.body);
      upstreamCalls.push({ mode: input.mode || 'observe', frames: input.frames.map(frame => ({ time: frame.time, jpegBytes: frame.image.length })), target: input.target });
      assert.match(provider.instructions, /빨강/);
      assert.match(provider.instructions, /7/);
      assert.doesNotMatch(provider.instructions, /남색.*11번/);
      const result = input.mode === 'discover' ? { detections: [...new Set([0, input.frames.length - 1])].map(frameIndex => ({ frameIndex, confidence: 'high', reason: '모의 응답에서 지정 유니폼과 번호를 확인했습니다.' })), summary: '모의 표본 탐색', limitations: ['테스트용 응답입니다.'] } : { identified: true, summary: '실제 HTTP 원본 프레임에 대한 모의 관찰', observations: [{ skill: 'move', time: Math.ceil(input.start), note: '코치 확인용 모의 위치 관찰', type: 'note', confidence: 'medium' }], limitations: ['실제 AI 정확도를 검증한 결과가 아닙니다.'], nextAction: '코치와 장면을 함께 확인합니다.' };
      return Response.json({ status: 'completed', output_text: JSON.stringify(result) });
    } });
  };
  const job = await runGrowthJob({ store, jobId: dispatches[0].id, token: dispatches[0].token, mediaURL: `${origin}/api/v2/media/${video.id}?jobId=${queuedJob.id}`, analysisHandler: handler, env });
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.progress.duration, 36);
  assert.equal(job.progress.completedCount, 2);
  assert.equal(upstreamCalls.filter(call => call.mode === 'discover').length, 1);
  assert.equal(upstreamCalls.filter(call => call.mode === 'observe').length, 2);
  assert.ok(upstreamCalls.every(call => call.frames.length <= (call.mode === 'discover' ? 12 : 24) && call.frames.every(frame => frame.jpegBytes <= 250_000)));
  const privateReads = mediaRequests.filter(item => item.bearer);
  assert.ok(privateReads.length > 3, 'Probe and all FFmpeg extraction requests use the protected HTTP route');
  const successfulReads = privateReads.filter(item => item.status === 206);
  assert.ok(successfulReads.length > 3);
  assert.ok(successfulReads.every(item => item.bytes <= 4096 && item.range?.startsWith('bytes=') && !item.cookie && item.path.endsWith(`?jobId=${queuedJob.id}`)));
  assert.ok(successfulReads.some(item => item.returnedRange?.startsWith('bytes 4096-')), 'FFmpeg must reconnect with an authenticated next-byte range');
  const login = await request('/auth/login', { method: 'POST', body: { email: credentials.email, password: credentials.password } });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const restored = await (await request('/workspace')).json();
  assert.equal(restored.analyses.length, 2);
  assert.equal(restored.videos[0].duration, 36);
  assert.equal(restored.observations.length, 0);
  const listed = await (await request('/jobs')).json();
  assert.equal(listed.jobs[0].status, 'completed');
  assert.equal(Object.hasOwn(listed.jobs[0], 'tokenHash'), false);
  assert.equal(Object.hasOwn(listed.jobs[0], 'clips'), false);
  assert.equal(JSON.stringify(restored).includes('data:image/jpeg'), false);
  assert.equal(JSON.stringify(restored).includes(dispatches[0].token), false);
  assert.equal((await request(`/media/${video.id}?jobId=${queuedJob.id}`, { authenticated: false, headers: { Authorization: `Bearer ${dispatches[0].token}` } })).status, 404, 'A completed job no longer authorizes worker media reads');
});
