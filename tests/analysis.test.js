import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAnalysis, MAX_ANALYSIS_BYTES } from '../lib/analysis.js';

const env = { SOCCER_AI_API_KEY: 'test-server-key', SOCCER_ANALYSIS_ACCESS_CODE: 'test-private-code-123' };
const image = 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224, 0, 16, 1, 2, 3, 4, 255, 217]).toString('base64');
const input = () => ({ videoId: 'local-12345678-1234-1234-1234-123456789abc', start: 57, end: 69, frames: [{ time: 57, image }, { time: 63, image }, { time: 69, image }], consent: true, accessCode: env.SOCCER_ANALYSIS_ACCESS_CODE });
const result = () => ({ identified: true, summary: '남색 11번이 동료를 도울 위치로 이동한 장면입니다.', observations: [{ skill: 'move', time: 63, note: '동료 옆 빈 공간에 위치합니다.', type: 'note', confidence: 'medium' }], limitations: ['12초 구간의 정지 프레임만으로 반복 능력을 판단할 수 없습니다.'], nextAction: '패스 후 동료가 볼 수 있는 공간으로 한 걸음 이동해 보세요.' });
const request = (value = input(), headers = {}) => new Request('https://next-xi.example/api/analysis', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://next-xi.example', ...headers }, body: typeof value === 'string' ? value : JSON.stringify(value) });
const upstream = value => async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const neverFetch = async () => { assert.fail('Invalid or unauthorized requests must never reach the paid API'); };

test('availability exposes no keys, access code, or model configuration', async () => {
  for (const [config, available] of [[{}, false], [{ ...env, SOCCER_ANALYSIS_ACCESS_CODE: 'short' }, false], [env, true]]) {
    const response = await handleAnalysis(new Request('https://next-xi.example/api/analysis'), { env: config, fetchImpl: neverFetch });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { available, reason: available ? 'ready' : 'missing_credentials' });
  }
});

test('unconfigured analysis returns actionable unavailable response without pretending it ran', async () => {
  const response = await handleAnalysis(request(), { env: {}, fetchImpl: neverFetch });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'analysis_unavailable');
});

test('cross-origin, malformed origins, cross-site fetch and unsupported methods are rejected', async () => {
  for (const headers of [{ origin: 'https://attacker.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await handleAnalysis(request(input(), headers), { env, fetchImpl: neverFetch })).status, 403);
  }
  assert.equal((await handleAnalysis(new Request('https://next-xi.example/api/analysis', { method: 'DELETE' }), { env, fetchImpl: neverFetch })).status, 405);
});

test('paid API is protected by a server-only pilot code', async () => {
  for (const accessCode of [undefined, '', 'wrong', 'x'.repeat(257)]) {
    const response = await handleAnalysis(request({ ...input(), accessCode }), { env, fetchImpl: neverFetch });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'invalid_access_code');
  }
});

test('input rejects missing consent, oversized/invalid clips and image data', async () => {
  const cases = [
    { consent: false }, { videoId: 'arJ6xMRKnbw' }, { start: 57, end: 70 }, { start: -1 }, { end: 57 },
    { frames: [{ time: 57, image }] }, { frames: Array.from({ length: 25 }, (_, n) => ({ time: 57 + n / 3, image })) },
    { frames: [{ time: 57, image }, { time: 57, image }] }, { frames: [{ time: 57, image }, { time: 70, image }] },
    { frames: [{ time: 57, image }, { time: 58, image: 'https://external.example/image.jpg' }] },
    { frames: [{ time: 57, image }, { time: 58, image: 'data:image/jpeg;base64,QQ==' }] },
  ];
  for (const change of cases) {
    const response = await handleAnalysis(request({ ...input(), ...change }), { env, fetchImpl: neverFetch });
    assert.equal(response.status, 400, JSON.stringify(change));
  }
  assert.equal((await handleAnalysis(request('{malformed'), { env, fetchImpl: neverFetch })).status, 400);
  assert.equal((await handleAnalysis(request(input(), { 'Content-Type': 'text/plain' }), { env, fetchImpl: neverFetch })).status, 415);
});

test('request body cap applies with and without a Content-Length header', async () => {
  const declared = request(input(), { 'content-length': String(MAX_ANALYSIS_BYTES + 1) });
  assert.equal((await handleAnalysis(declared, { env, fetchImpl: neverFetch })).status, 413);
  const actual = request(' '.repeat(MAX_ANALYSIS_BYTES + 1));
  assert.equal((await handleAnalysis(actual, { env, fetchImpl: neverFetch })).status, 413);
});

test('real provider contract sends selected JPEG frames, structured schema, no storage and server key only', async () => {
  let called = 0;
  const fetchImpl = async (url, options) => {
    called++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, `Bearer ${env.SOCCER_AI_API_KEY}`);
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'gpt-4.1-mini');
    assert.equal(payload.store, false);
    assert.equal(payload.text.format.type, 'json_schema');
    assert.equal(payload.text.format.strict, true);
    assert.equal(payload.input[0].content.filter(c => c.type === 'input_image').length, 3);
    assert.equal(options.body.includes(env.SOCCER_ANALYSIS_ACCESS_CODE), false);
    assert.equal(options.body.includes(env.SOCCER_AI_API_KEY), false);
    assert.match(payload.instructions, /identified=false/);
    assert.match(payload.instructions, /전국 순위/);
    return upstream(result())();
  };
  const response = await handleAnalysis(request(), { env, fetchImpl });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: result(), model: 'gpt-4.1-mini' });
  assert.equal(called, 1);
});

test('uncertain jersey identity may return an explicit abstention without observations', async () => {
  const abstention = { ...result(), identified: false, observations: [], summary: '남색 상의는 보이지만 11번 등번호를 확인하지 못했습니다.', nextAction: '등번호가 선명하게 보이는 구간을 선택해 주세요.' };
  const response = await handleAnalysis(request(), { env, fetchImpl: upstream(abstention) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, abstention);
});

test('invalid, contradictory and out-of-bounds results never become observations', async () => {
  const cases = [
    { ...result(), identified: false },
    { ...result(), observations: [{ ...result().observations[0], time: 70 }] },
    { ...result(), observations: [{ ...result().observations[0], time: 56 }] },
    { ...result(), observations: [{ ...result().observations[0], confidence: 'certain' }] },
    { ...result(), observations: [{ ...result().observations[0], skill: 'talent' }] },
    { ...result(), limitations: [] },
    { ...result(), limitations: ['가'.repeat(501)] },
    { ...result(), summary: '' },
  ];
  for (const value of cases) {
    const response = await handleAnalysis(request(), { env, fetchImpl: upstream(value) });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'analysis_invalid_result');
  }
  const ratingInjected = { ...result(), overallRating: 99, observations: [{ ...result().observations[0], rating: 5 }] };
  const response = await handleAnalysis(request(), { env, fetchImpl: upstream(ratingInjected) });
  assert.deepEqual((await response.json()).result, result());
});

test('provider authentication, rate limits, malformed output and incomplete output are explained safely', async () => {
  for (const [upstreamStatus, expectedStatus, code] of [[401, 503, 'analysis_credentials_rejected'], [403, 503, 'analysis_permission_denied'], [429, 429, 'analysis_rate_limited'], [500, 502, 'analysis_provider_failed']]) {
    const response = await handleAnalysis(request(), { env, fetchImpl: async () => new Response('secret upstream details', { status: upstreamStatus }) });
    assert.equal(response.status, expectedStatus);
    const text = await response.text(); assert.equal(JSON.parse(text).code, code); assert.equal(text.includes('secret upstream details'), false);
  }
  const incomplete = await handleAnalysis(request(), { env, fetchImpl: async () => new Response(JSON.stringify({ status: 'incomplete' })) });
  assert.equal((await incomplete.json()).code, 'analysis_incomplete');
  const malformed = await handleAnalysis(request(), { env, fetchImpl: async () => new Response(JSON.stringify({ output_text: 'not JSON' })) });
  assert.equal((await malformed.json()).code, 'analysis_invalid_result');
});

test('provider timeout and network errors finish with actionable errors', async () => {
  const timeout = await handleAnalysis(request(), { env, timeoutMs: 5, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })))) });
  assert.equal(timeout.status, 504);
  assert.equal((await timeout.json()).code, 'analysis_timeout');
  const offline = await handleAnalysis(request(), { env, fetchImpl: async () => { throw new Error('private DNS and secrets'); } });
  assert.equal(offline.status, 502);
  assert.equal((await offline.json()).code, 'analysis_provider_failed');
});

test('OPENAI_API_KEY fallback and explicit model work without leaking secrets to responses', async () => {
  const configured = { OPENAI_API_KEY: 'alternate-private-server-key', SOCCER_ANALYSIS_ACCESS_CODE: env.SOCCER_ANALYSIS_ACCESS_CODE, SOCCER_AI_MODEL: 'gpt-4.1' };
  const response = await handleAnalysis(request(), { env: configured, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer alternate-private-server-key');
    assert.equal(JSON.parse(options.body).model, 'gpt-4.1');
    return upstream(result())();
  } });
  const text = await response.text();
  assert.equal(JSON.parse(text).model, 'gpt-4.1');
  assert.equal(text.includes(configured.OPENAI_API_KEY), false);
});

const discoveryInput = () => ({ ...input(), mode: 'discover', start: 0, end: 3600, frames: [{ time: 30.25, image }, { time: 1800.5, image }, { time: 3599, image }] });
const discoveryResult = () => ({ detections: [{ frameIndex: 1, confidence: 'high', reason: '같은 프레임에서 남색 상의와 등번호 11이 보입니다.' }], summary: '표본 프레임 한 장에서 남색 11번을 확인했습니다.', limitations: ['표본 프레임 사이에 등장한 장면은 놓칠 수 있습니다.'] });

test('discovery sends indexed full-video samples with a distinct strict schema and conservative prompt', async () => {
  let called = 0;
  const response = await handleAnalysis(request(discoveryInput()), { env, fetchImpl: async (url, options) => {
    called++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const payload = JSON.parse(options.body);
    assert.equal(payload.text.format.name, 'youth_soccer_player_discovery');
    assert.equal(payload.text.format.strict, true);
    assert.deepEqual(payload.text.format.schema.required, ['detections', 'summary', 'limitations']);
    assert.equal(payload.store, false);
    assert.match(payload.instructions, /같은 프레임 속 같은 선수/);
    assert.match(payload.instructions, /얼굴이나 생체 특징으로 식별하지/);
    assert.match(payload.instructions, /detections=\[\]/);
    const text = payload.input[0].content.filter(c => c.type === 'input_text').map(c => c.text).join('\n');
    assert.match(text, /frameIndex: 1, 영상 시각 1800.5초/);
    return upstream(discoveryResult())();
  } });
  assert.equal(response.status, 200);
  assert.equal(called, 1);
  assert.deepEqual(await response.json(), { mode: 'discover', detections: [{ time: 1800.5, confidence: 'high', reason: discoveryResult().detections[0].reason }], summary: discoveryResult().summary, limitations: discoveryResult().limitations, model: 'gpt-4.1-mini' });
});

test('discovery accepts a single frame and up to twelve frames across at most 24 hours', async () => {
  const cases = [
    { ...discoveryInput(), end: 0.5, frames: [{ time: 0, image }] },
    { ...discoveryInput(), end: 86400, frames: Array.from({ length: 12 }, (_, index) => ({ time: index * 7200, image })) },
  ];
  for (const value of cases) {
    const response = await handleAnalysis(request(value), { env, fetchImpl: upstream({ ...discoveryResult(), detections: [] }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).detections, []);
  }
  // A long interval does not silently convert an ordinary clip request into discovery.
  const { mode, ...legacy } = discoveryInput();
  assert.equal((await handleAnalysis(request(legacy), { env, fetchImpl: neverFetch })).status, 400);
});

test('discovery rejects unknown mode, unsafe intervals, unordered frames and excess frame count before paid calls', async () => {
  const cases = [
    { mode: 'whole_game_rating' }, { start: -1 }, { end: 86400.01 }, { end: 0 }, { frames: [] },
    { frames: Array.from({ length: 13 }, (_, index) => ({ time: index, image })) },
    { frames: [{ time: 1, image }, { time: 1, image }] },
    { frames: [{ time: 1, image }, { time: 0, image }] },
    { frames: [{ time: 3601, image }] },
    { frames: [{ time: 1, image: 'data:image/png;base64,AAAA' }] },
    { frames: [{ time: 1, image: 'https://outside.example/image.jpg' }] },
    { consent: false },
  ];
  for (const change of cases) {
    const response = await handleAnalysis(request({ ...discoveryInput(), ...change }), { env, fetchImpl: neverFetch });
    assert.equal(response.status, 400, JSON.stringify(change));
  }
});

test('discovery uses the same credentials, access code, origin checks and request size limits', async () => {
  assert.equal((await handleAnalysis(request(discoveryInput()), { env: {}, fetchImpl: neverFetch })).status, 503);
  assert.equal((await handleAnalysis(request({ ...discoveryInput(), accessCode: 'wrong' }), { env, fetchImpl: neverFetch })).status, 401);
  assert.equal((await handleAnalysis(request(discoveryInput(), { origin: 'https://other.example' }), { env, fetchImpl: neverFetch })).status, 403);
  assert.equal((await handleAnalysis(request(discoveryInput(), { 'Content-Length': String(MAX_ANALYSIS_BYTES + 1) }), { env, fetchImpl: neverFetch })).status, 413);
});

test('discovery rejects invented, repeated or uncertain frame indices instead of guessing timestamps', async () => {
  const cases = [
    [{ frameIndex: -1, confidence: 'high', reason: '보임' }],
    [{ frameIndex: 3, confidence: 'high', reason: '보임' }],
    [{ frameIndex: 0.5, confidence: 'high', reason: '보임' }],
    [{ frameIndex: '1', confidence: 'high', reason: '보임' }],
    [{ frameIndex: 1, confidence: 'low', reason: '추측' }],
    [{ frameIndex: 1, confidence: 'medium', reason: '' }],
    [{ frameIndex: 1, confidence: 'high', reason: '가'.repeat(501) }],
    [discoveryResult().detections[0], discoveryResult().detections[0]],
  ];
  for (const detections of cases) {
    const response = await handleAnalysis(request(discoveryInput()), { env, fetchImpl: upstream({ ...discoveryResult(), detections }) });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'analysis_invalid_result');
  }
});

test('discovery validates summary and limitations and strips provider score or timestamp additions', async () => {
  for (const change of [{ summary: '' }, { summary: '가'.repeat(1501) }, { limitations: ['가'.repeat(501)] }, { limitations: Array(9).fill('제한') }, { limitations: [null] }]) {
    const response = await handleAnalysis(request(discoveryInput()), { env, fetchImpl: upstream({ ...discoveryResult(), ...change }) });
    assert.equal(response.status, 502);
  }
  const provider = { ...discoveryResult(), overallScore: 99, detections: [{ ...discoveryResult().detections[0], time: 999999, rating: 5 }] };
  const response = await handleAnalysis(request(discoveryInput()), { env, fetchImpl: upstream(provider) });
  const value = await response.json();
  assert.equal(value.detections[0].time, 1800.5);
  assert.equal(Object.hasOwn(value, 'overallScore'), false);
  assert.equal(Object.hasOwn(value.detections[0], 'rating'), false);
});

test('discovery returns detections in video order while preserving exact input timestamps', async () => {
  const detections = [
    { frameIndex: 2, confidence: 'high', reason: '11번 확인' },
    { frameIndex: 0, confidence: 'medium', reason: '남색 11번 확인' },
  ];
  const response = await handleAnalysis(request(discoveryInput()), { env, fetchImpl: upstream({ ...discoveryResult(), detections }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).detections.map(item => item.time), [30.25, 3599]);
});

test('discovery errors finish after one provider attempt, including timeouts and malformed output', async () => {
  let calls = 0;
  const response = await handleAnalysis(request(discoveryInput()), { env, timeoutMs: 5, fetchImpl: async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' }))));
  } });
  assert.equal(response.status, 504);
  assert.equal(calls, 1);
  const malformed = await handleAnalysis(request(discoveryInput()), { env, fetchImpl: upstream(result()) });
  assert.equal(malformed.status, 502);
  assert.equal((await malformed.json()).code, 'analysis_invalid_result');
});

test('obviously masked or malformed server keys are rejected before a paid call without exposing any key detail', async () => {
  const keys = ['sk-...', 'sk-proj-…', 'first second', 'first\nsecond', 'first\tsecond', '"test-private-key"', "'test-private-key'", 'Bearer test-private-key', 'Bearer'];
  for (const key of keys) {
    const config = { ...env, SOCCER_AI_API_KEY: key };
    const status = await handleAnalysis(new Request('https://next-xi.example/api/analysis'), { env: config, fetchImpl: neverFetch });
    assert.deepEqual(await status.json(), { available: false, reason: 'invalid_key_format' });
    for (const value of [input(), discoveryInput()]) {
      const response = await handleAnalysis(request(value), { env: config, fetchImpl: neverFetch });
      assert.equal(response.status, 503);
      const payload = await response.json();
      assert.equal(payload.code, 'analysis_key_format_invalid');
      assert.deepEqual(Object.keys(payload).sort(), ['code', 'error']);
      assert.equal(JSON.stringify(payload).includes(key), false);
    }
  }
});

test('server key guard permits outer whitespace and does not invent an arbitrary prefix or length requirement', async () => {
  for (const key of ['  test-server-key  ', 'future-format-key', 'x']) {
    const config = { ...env, SOCCER_AI_API_KEY: key };
    const status = await handleAnalysis(new Request('https://next-xi.example/api/analysis'), { env: config, fetchImpl: neverFetch });
    assert.deepEqual(await status.json(), { available: true, reason: 'ready' });
    const response = await handleAnalysis(request(), { env: config, fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${key.trim()}`);
      return upstream(result())();
    } });
    assert.equal(response.status, 200);
  }
});

test('primary SOCCER key takes precedence over fallback and an invalid primary is never silently replaced', async () => {
  const configured = { ...env, OPENAI_API_KEY: 'fallback-server-key' };
  const response = await handleAnalysis(request(), { env: configured, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${env.SOCCER_AI_API_KEY}`);
    return upstream(result())();
  } });
  assert.equal(response.status, 200);
  const invalidPrimary = await handleAnalysis(request(), { env: { ...configured, SOCCER_AI_API_KEY: 'sk-...' }, fetchImpl: neverFetch });
  assert.equal((await invalidPrimary.json()).code, 'analysis_key_format_invalid');
});

test('provider quota and request-rate errors are distinct and never echo provider secrets', async () => {
  const privateMessage = 'Incorrect API key provided: sk-private-echo-should-never-leak';
  const cases = [
    [{ code: 'insufficient_quota', type: 'insufficient_quota' }, 'analysis_quota_exceeded'],
    [{ code: 'billing_hard_limit_reached' }, 'analysis_quota_exceeded'],
    [{ type: 'insufficient_quota' }, 'analysis_quota_exceeded'],
    [{ code: 'rate_limit_exceeded', type: 'rate_limit_error' }, 'analysis_rate_limited'],
    [{ code: privateMessage, type: privateMessage }, 'analysis_rate_limited'],
    [{}, 'analysis_rate_limited'],
  ];
  for (const [error, expected] of cases) {
    const response = await handleAnalysis(request(), { env, fetchImpl: async () => new Response(JSON.stringify({ error: { ...error, message: privateMessage } }), { status: 429 }) });
    assert.equal(response.status, 429);
    const text = await response.text();
    assert.equal(JSON.parse(text).code, expected);
    assert.equal(text.includes(privateMessage), false);
    assert.equal(text.includes('sk-private'), false);
  }
});

test('provider authentication and permission errors remain distinct even when upstream bodies are HTML or contain key echoes', async () => {
  for (const [status, expected] of [[401, 'analysis_credentials_rejected'], [403, 'analysis_permission_denied']]) {
    for (const body of ['<html>private-proxy-auth-rejection</html>', JSON.stringify({ error: { code: 'invalid_api_key', message: 'secret-key-fragment-123' } })]) {
      const response = await handleAnalysis(request(), { env, fetchImpl: async () => new Response(body, { status }) });
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.equal(JSON.parse(text).code, expected);
      assert.equal(text.includes('private-proxy-auth'), false);
      assert.equal(text.includes('secret-key-fragment'), false);
    }
  }
  const ownCode = await handleAnalysis(request({ ...input(), accessCode: 'wrong-user-code' }), { env, fetchImpl: neverFetch });
  assert.equal(ownCode.status, 401);
  assert.equal((await ownCode.json()).code, 'invalid_access_code');
});

test('a model-unavailable error requires the exact allowlisted upstream code at HTTP404', async () => {
  const missing = await handleAnalysis(request(), { env, fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'model_not_found', message: 'secret-provider-context' } }), { status: 404 }) });
  assert.equal(missing.status, 503);
  const payload = await missing.json();
  assert.equal(payload.code, 'analysis_model_unavailable');
  assert.equal(JSON.stringify(payload).includes('secret-provider-context'), false);
  for (const body of ['<html>not found</html>', JSON.stringify({ error: { code: 'unknown_model_error', message: 'model_not_found' } })]) {
    const response = await handleAnalysis(request(), { env, fetchImpl: async () => new Response(body, { status: 404 }) });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'analysis_provider_failed');
  }
});

test('provider error parsing is bounded and handles oversized, malformed and non-JSON bodies safely', async () => {
  const bodies = [
    ' '.repeat(16_385) + JSON.stringify({ error: { code: 'insufficient_quota' } }),
    JSON.stringify({ error: { code: 'insufficient_quota', message: 'private-key-echo'.repeat(1500) } }),
    '{malformed-provider-json', '<html>upstream private details</html>',
  ];
  for (const body of bodies) {
    const response = await handleAnalysis(request(), { env, fetchImpl: async () => new Response(body, { status: 429 }) });
    assert.equal(response.status, 429);
    const text = await response.text();
    assert.equal(JSON.parse(text).code, 'analysis_rate_limited');
    assert.equal(text.includes('private-key-echo'), false);
    assert.equal(text.includes('private details'), false);
  }
});
