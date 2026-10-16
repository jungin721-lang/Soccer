import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalStore } from '../lib/growth/store.js';
import { createGrowthAPI } from '../lib/growth/api.js';
import { checkFreeAnalysisConnection } from '../lib/growth/connection-check.js';
import { readProviderStatus } from '../lib/growth/provider.js';

const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-token-not-live', SOCCER_AI_API_KEY: 'must-never-be-used' };
const now = Date.parse('2026-10-16T12:00:00Z');
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'next-xi-connection-'));
  const store = await createLocalStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return store;
}
function upstream(calls, { paid = false, quota = false, hallucinate = false } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    assert.ok(url.startsWith('https://api.cloudflare.com/'));
    if (url.endsWith('/subscriptions')) return Response.json({ success: true, result: paid ? [{ rate_plan: { id: 'paid' } }] : [] });
    if (quota) return Response.json({ success: false, errors: [{ code: 3036, message: 'untrusted-provider-error' }] }, { status: 429 });
    return Response.json({ success: true, result: { response: JSON.stringify({ detections: hallucinate ? [{ frameIndex: 0, confidence: 'high', reason: '11번' }] : [], summary: '검은 합성 이미지에는 사람이 없습니다.', limitations: ['실제 경기 검증이 아닙니다.'] }) } });
  };
}

test('missing free credentials cannot use an old paid key or reserve a synthetic check', async t => {
  const store = await fixture(t); let calls = 0;
  const response = await checkFreeAnalysisConnection({ store, env: { SOCCER_AI_API_KEY: env.SOCCER_AI_API_KEY }, fetchImpl: async () => { calls++; throw Error('forbidden'); }, now });
  assert.equal(response.status, 503); assert.equal(calls, 0);
  assert.deepEqual(await store.list('connection-checks/'), []);
});

test('a real transport-shaped synthetic response verifies only the free provider without reading user footage', async t => {
  const store = await fixture(t); const calls = [];
  const response = await checkFreeAnalysisConnection({ store, env, fetchImpl: upstream(calls), now });
  assert.equal(response.status, 200); assert.equal(response.body.liveVerified, true); assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1].options.body);
  const images = body.messages[1].content.filter(item => item.type === 'image_url');
  assert.equal(images.length, 1); assert.ok(images[0].image_url.url.startsWith('data:image/jpeg;base64,'));
  assert.ok(images[0].image_url.url.length < 1000);
  assert.equal(JSON.stringify(body).includes(env.SOCCER_AI_API_KEY), false);
  assert.equal((await readProviderStatus(store, { provider: 'cloudflare' })).status, 'ready');
  assert.equal((await readProviderStatus(store)).status, 'unknown');
  assert.deepEqual(await store.list('videos/'), []);
});

test('daily quota pauses until UTC midnight and a repeated check cannot call a paid fallback', async t => {
  const store = await fixture(t); const calls = [];
  const response = await checkFreeAnalysisConnection({ store, env, fetchImpl: upstream(calls, { quota: true }), now });
  assert.equal(response.status, 429); assert.equal(response.body.code, 'analysis_quota_exceeded');
  assert.equal(response.body.retryAt, '2026-10-17T00:00:00.000Z');
  const repeated = await checkFreeAnalysisConnection({ store, env, fetchImpl: upstream(calls), now: now + 61_000 });
  assert.equal(repeated.status, 429); assert.equal(calls.length, 2);
  assert.equal((await readProviderStatus(store)).status, 'unknown');
});

test('paid or unverifiable plans stop before inference and never mark the connection ready', async t => {
  const store = await fixture(t); const calls = [];
  const response = await checkFreeAnalysisConnection({ store, env, fetchImpl: upstream(calls, { paid: true }), now });
  assert.equal(response.status, 503); assert.equal(response.body.code, 'free_plan_unverified'); assert.equal(calls.length, 1);
  assert.equal((await readProviderStatus(store, { provider: 'cloudflare' })).status, 'unknown');
});

test('connection checks enforce a global five-per-day and one-minute limit even under concurrency', async t => {
  const store = await fixture(t); const calls = [];
  const simultaneous = await Promise.all(Array.from({ length: 5 }, () => checkFreeAnalysisConnection({ store, env, fetchImpl: upstream(calls), now })));
  assert.equal(simultaneous.filter(item => item.status === 200).length, 1); assert.equal(calls.length, 2);
  for (let minute = 1; minute < 5; minute++) assert.equal((await checkFreeAnalysisConnection({ store, env, fetchImpl: upstream(calls), now: now + minute * 60_000 })).status, 200);
  assert.equal((await checkFreeAnalysisConnection({ store, env, fetchImpl: upstream(calls), now: now + 5 * 60_000 })).body.code, 'connection_check_limited');
  assert.equal(calls.length, 10);
});

test('hallucinated detection in a black test image cannot establish a verified connection', async t => {
  const store = await fixture(t);
  const response = await checkFreeAnalysisConnection({ store, env, fetchImpl: upstream([], { hallucinate: true }), now });
  assert.equal(response.status, 502); assert.equal(response.body.code, 'analysis_invalid_result');
  assert.equal((await readProviderStatus(store, { provider: 'cloudflare' })).status, 'unknown');
});

test('the synthetic check route requires a signed-in same-origin request', async t => {
  const store = await fixture(t); const api = createGrowthAPI({ store, env });
  const request = headers => new Request('https://next-xi.example/api/v2/analysis/check', { method: 'POST', headers });
  assert.equal((await api(request({ Origin: 'https://next-xi.example' }))).status, 401);
  assert.equal((await api(request({ Origin: 'https://attacker.example' }))).status, 403);
  assert.deepEqual(await store.list('connection-checks/'), []);
});
