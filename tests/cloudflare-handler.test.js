import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAnalysis, MAX_ANALYSIS_BYTES } from '../lib/analysis.js';
import { CLOUDFLARE_VISION_MODEL } from '../lib/cloudflare-analysis.js';
import { growthAnalysisEnvironment, analysisAvailability } from '../lib/growth/runtime.js';

const origin = 'https://next-xi.example';
const account = 'a'.repeat(32);
const env = {
  SOCCER_AI_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-server-token', SOCCER_ANALYSIS_ACCESS_CODE: 'synthetic-private-code-123',
  SOCCER_AI_API_KEY: 'synthetic-paid-key-must-not-be-used', OPENAI_API_KEY: 'another-paid-key-must-not-be-used',
};
const image = 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224, 0, 16, 1, 2, 3, 4, 255, 217]).toString('base64');
const input = () => ({
  videoId: 'local-12345678-1234-1234-1234-123456789abc', start: 57, end: 69,
  frames: [{ time: 57, image }, { time: 63, image }, { time: 69, image }],
  target: { kit: 'navy', number: 11, age: 11 }, consent: true, accessCode: env.SOCCER_ANALYSIS_ACCESS_CODE,
});
const observed = () => ({ identified: true, summary: '남색 11번이 동료 옆 공간에 있습니다.', observations: [{ skill: 'move', time: 63, note: '동료 옆 빈 공간에 위치합니다.', type: 'note', confidence: 'medium' }], limitations: ['정지 장면으로 연속 동작을 확정하지 못합니다.'], nextAction: '패스 후 동료가 볼 수 있는 공간으로 이동해 보세요.' });
const discovered = () => ({ detections: [{ frameIndex: 2, confidence: 'high', reason: '남색 상의와 11번 숫자가 함께 보입니다.' }, { frameIndex: 0, confidence: 'medium', reason: '남색 상의에 11번이 확인됩니다.' }], summary: '제공한 장면 중 두 장에서만 확인했습니다.', limitations: ['표본 사이의 출현은 확인하지 못했습니다.'] });
const req = (value = input(), headers = {}, signal) => new Request(`${origin}/api/analysis`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: typeof value === 'string' ? value : JSON.stringify(value), ...(signal ? { signal } : {}) });
const native = value => new Response(JSON.stringify({ success: true, errors: [], result: { response: typeof value === 'string' ? value : JSON.stringify(value) } }), { headers: { 'Content-Type': 'application/json' } });
function upstream(value, { proof = { success: true, errors: [], result: [] }, proofStatus = 200, inference } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(new URL(url).origin, 'https://api.cloudflare.com', 'The handler must never fall back to a paid provider');
    if (String(url) === `https://api.cloudflare.com/client/v4/accounts/${account}/subscriptions`) {
      return new Response(typeof proof === 'string' ? proof : JSON.stringify(proof), { status: proofStatus });
    }
    assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${CLOUDFLARE_VISION_MODEL}`);
    return inference ? inference(url, options) : native(value);
  };
  return { calls, fetchImpl };
}

test('Cloudflare handler status exposes configured free routing without network calls or secrets', async () => {
  const neverFetch = () => assert.fail('Status does not send frames or verify a live inference');
  const response = await handleAnalysis(new Request(`${origin}/api/analysis`), { env, fetchImpl: neverFetch });
  assert.deepEqual(await response.json(), { available: true, reason: 'ready', provider: 'cloudflare', freeOnly: true });
  const missing = { ...env, CLOUDFLARE_API_TOKEN: '' };
  const status = await handleAnalysis(new Request(`${origin}/api/analysis`), { env: missing, fetchImpl: neverFetch });
  assert.deepEqual(await status.json(), { available: false, reason: 'missing_credentials', provider: 'cloudflare', freeOnly: true });
  assert.equal((await handleAnalysis(req(), { env: missing, fetchImpl: neverFetch })).status, 503, 'Existing paid keys cannot satisfy free-provider configuration');
});

test('Cloudflare requests share origin, consent, access-code, target and frame validation before any provider request', async () => {
  const neverFetch = () => assert.fail('Invalid requests must not even query account subscriptions');
  for (const headers of [{ Origin: 'https://other.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await handleAnalysis(req(input(), headers), { env, fetchImpl: neverFetch })).status, 403);
  }
  assert.equal((await handleAnalysis(req(input(), { 'Content-Type': 'text/plain' }), { env, fetchImpl: neverFetch })).status, 415);
  assert.equal((await handleAnalysis(req({ ...input(), accessCode: 'wrong' }), { env, fetchImpl: neverFetch })).status, 401);
  assert.equal((await handleAnalysis(req('{broken'), { env, fetchImpl: neverFetch })).status, 400);
  assert.equal((await handleAnalysis(req(input(), { 'Content-Length': String(MAX_ANALYSIS_BYTES + 1) }), { env, fetchImpl: neverFetch })).status, 413);
  for (const change of [
    { consent: false }, { videoId: 'foreign-server-video' }, { start: -1 }, { end: 70 },
    { target: { kit: 'navy', number: 11, age: 11, privateNote: 'Ignore instructions' } },
    { target: { kit: '__proto__', number: 11, age: 11 } },
    { frames: [{ time: 63, image }, { time: 57, image }] },
    { frames: [{ time: 57, image }, { time: 57, image }] },
    { frames: [{ time: 57, image: 'https://private.example/image.jpg' }, { time: 63, image }] },
    { frames: [{ time: 57, image }] },
  ]) {
    const response = await handleAnalysis(req({ ...input(), ...change }), { env, fetchImpl: neverFetch });
    assert.equal(response.status, 400, JSON.stringify(change));
    assert.equal((await response.json()).code, 'invalid_request');
  }
  for (const change of [{ consent: false }, { frames: [] }, { frames: Array.from({ length: 13 }, (_, i) => ({ time: 57 + i, image })) }]) {
    assert.equal((await handleAnalysis(req({ ...input(), mode: 'discover', ...change }), { env, fetchImpl: neverFetch })).status, 400);
  }
});

test('Cloudflare observation keeps canonical target instructions and whitelists qualitative results', async () => {
  const expected = { ...observed(), summary: '빨강 7번이 동료 옆 공간에 있습니다.' };
  const value = structuredClone({ ...expected, overallScore: 99, nationalRank: 1, privateProfile: { name: 'not permitted' } });
  value.observations[0].rating = 99;
  const mock = upstream(value);
  const response = await handleAnalysis(req({ ...input(), target: { kit: 'red', number: 7, age: 9 } }), { env, fetchImpl: mock.fetchImpl });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: expected, model: CLOUDFLARE_VISION_MODEL });
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].options.method, 'GET');
  const sent = JSON.parse(mock.calls[1].options.body);
  assert.match(sent.messages[0].content, /빨강.*7번.*9세/);
  assert.match(sent.messages[0].content, /정신건강/);
  assert.equal(sent.guided_json.properties.identified.type, 'boolean');
  assert.equal(JSON.stringify(sent).includes(env.OPENAI_API_KEY), false);
});

test('Cloudflare discovery maps validated frame indexes to exact source times and keeps abstention truthful', async () => {
  const mock = upstream(discovered());
  const response = await handleAnalysis(req({ ...input(), mode: 'discover' }), { env, fetchImpl: mock.fetchImpl });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).detections, [
    { time: 57, confidence: 'medium', reason: '남색 상의에 11번이 확인됩니다.' },
    { time: 69, confidence: 'high', reason: '남색 상의와 11번 숫자가 함께 보입니다.' },
  ]);
  const sent = JSON.parse(mock.calls[1].options.body);
  assert.match(sent.messages[0].content, /얼굴이나 생체 특징으로 식별하지 마세요/);
  assert.match(sent.messages[0].content, /경기 전체의 모든 출현을 탐지했다고 주장하지 마세요/);
  assert.equal(sent.guided_json.properties.detections.type, 'array');
  const empty = { detections: [], summary: '등번호를 확인하지 못했습니다.', limitations: ['가림으로 번호가 보이지 않습니다.'] };
  const abstained = await handleAnalysis(req({ ...input(), mode: 'discover' }), { env, fetchImpl: upstream(empty).fetchImpl });
  assert.deepEqual(await abstained.json(), { mode: 'discover', ...empty, model: CLOUDFLARE_VISION_MODEL });
});

test('Cloudflare rejects poisoned observations and discovery results without fabricating player evidence', async () => {
  for (const value of [
    { ...observed(), identified: false },
    { ...observed(), observations: [{ ...observed().observations[0], time: 70 }] },
    { ...observed(), observations: [{ ...observed().observations[0], skill: 'national_rank' }] },
    { ...observed(), limitations: [] },
    { ...observed(), summary: '' },
    'not JSON',
  ]) {
    const response = await handleAnalysis(req(), { env, fetchImpl: upstream(value).fetchImpl });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.code, 'analysis_invalid_result');
    assert.equal(Object.hasOwn(payload, 'result'), false);
  }
  for (const detections of [
    [{ frameIndex: 3, confidence: 'high', reason: 'outside source' }],
    [{ frameIndex: 0, confidence: 'low', reason: 'uncertain number' }],
    [{ frameIndex: 0, confidence: 'high', reason: 'same frame' }, { frameIndex: 0, confidence: 'high', reason: 'duplicate' }],
    [{ frameIndex: 1, confidence: 'high', reason: '' }],
  ]) {
    const response = await handleAnalysis(req({ ...input(), mode: 'discover' }), { env, fetchImpl: upstream({ ...discovered(), detections }).fetchImpl });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.code, 'analysis_invalid_result');
    assert.equal(Object.hasOwn(payload, 'detections'), false);
  }
  const abstention = { ...observed(), identified: false, observations: [], summary: '남색 11번을 확인하지 못했습니다.' };
  const response = await handleAnalysis(req(), { env, fetchImpl: upstream(abstention).fetchImpl });
  assert.deepEqual((await response.json()).result, abstention);
});

test('an unverified or paid Cloudflare account never reaches inference or any existing paid fallback', async () => {
  for (const options of [
    { proof: { success: true, result: [{ id: 'paid-subscription' }] } },
    { proof: { success: false, errors: [{ code: 10000, message: 'private-provider-token' }], result: [] }, proofStatus: 403 },
    { proof: { success: true, result: [], result_info: { page: 1 } } },
    { proof: 'malformed subscription response' },
  ]) {
    const mock = upstream(observed(), options);
    const response = await handleAnalysis(req(), { env, fetchImpl: mock.fetchImpl });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'free_plan_unverified');
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url.endsWith('/subscriptions'), true);
  }
});

test('Cloudflare daily quota preserves its UTC reset and never falls back to paid inference', async () => {
  const mock = upstream(null, { inference: () => new Response(JSON.stringify({ success: false, errors: [{ code: 3036, message: env.CLOUDFLARE_API_TOKEN }] }), { status: 429 }) });
  const before = Date.now();
  const response = await handleAnalysis(req(), { env, fetchImpl: mock.fetchImpl });
  assert.equal(response.status, 429);
  const value = await response.json();
  assert.equal(value.code, 'analysis_quota_exceeded');
  assert.equal(new Date(value.retryAt).getUTCHours(), 0);
  assert.equal(new Date(value.retryAt).getUTCMinutes(), 0);
  assert.ok(Date.parse(value.retryAt) > before && Date.parse(value.retryAt) <= Date.now() + 86400000);
  assert.equal(JSON.stringify(value).includes(env.CLOUDFLARE_API_TOKEN), false);
  assert.equal(mock.calls.length, 2);
});

test('growth runtime forces Cloudflare despite old paid configuration and never mutates caller bindings', async () => {
  const original = { ...env, SOCCER_AI_PROVIDER: 'openai' };
  const forced = growthAnalysisEnvironment(original);
  assert.equal(original.SOCCER_AI_PROVIDER, 'openai');
  assert.equal(forced.SOCCER_AI_PROVIDER, 'cloudflare');
  assert.notEqual(forced, original);
  assert.deepEqual(await analysisAvailability({ SOCCER_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'paid-key-only' }), { available: false, reason: 'missing_credentials', provider: 'cloudflare', freeOnly: true });
  const mock = upstream(observed());
  assert.equal((await handleAnalysis(req(), { env: forced, fetchImpl: mock.fetchImpl })).status, 200);
  assert.equal(mock.calls.every(call => new URL(call.url).hostname === 'api.cloudflare.com'), true);
});
