import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callCloudflareAnalysis as callCloudflareTransport,
  cloudflareAnalysisStatus,
  CLOUDFLARE_MAX_RESPONSE_BYTES,
  CLOUDFLARE_VISION_MODEL,
} from '../lib/cloudflare-analysis.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'server_only_cloudflare_token_123456789';
const PRIVATE_MESSAGE = `private provider diagnostic ${TOKEN} ${ACCOUNT}`;
const ENV = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN };
const JPEG = 'data:image/jpeg;base64,/9j/2Q==';
const OUTPUT = '{"observations":[]}';
const SCHEMA = { type: 'object', properties: { observations: { type: 'array' } }, required: ['observations'], additionalProperties: false };
const payload = overrides => ({
  input: { start: 120, end: 126, frames: [{ time: 120, image: JPEG }, { time: 126, image: JPEG }] },
  instructions: 'Use only the supplied visible evidence and original frame times.',
  schema: SCHEMA,
  ...overrides,
});
const successful = () => Response.json({ success: true, result: { response: OUTPUT } });
const SUBSCRIPTIONS_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/subscriptions`;
const COMPLETE_EMPTY_PAGE = { page: 1, per_page: 50, total_pages: 1, count: 0, total_count: 0 };

// Keep inference mocks specific to inference while preflight behavior has its
// own assertions against the raw transport below.
function callCloudflareAnalysis(value, options) {
  return callCloudflareTransport(value, {
    ...options,
    fetchImpl: async (url, init) => {
      if (url === SUBSCRIPTIONS_URL) {
        return Response.json({ success: true, result: [], result_info: COMPLETE_EMPTY_PAGE });
      }
      return options.fetchImpl(url, init);
    },
  });
}

async function rejectsWith(promise, status, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(typeof error.message, 'string');
    for (const secret of [TOKEN, ACCOUNT, PRIVATE_MESSAGE]) {
      assert.equal(String(error.stack).includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
    }
    return true;
  });
}

test('Cloudflare public status reports readiness without exposing account IDs or server tokens', () => {
  assert.deepEqual(cloudflareAnalysisStatus(ENV), { available: true, reason: 'ready', model: CLOUDFLARE_VISION_MODEL });
  assert.deepEqual(cloudflareAnalysisStatus({}), { available: false, reason: 'missing_credentials', model: CLOUDFLARE_VISION_MODEL });
  const publicStatus = JSON.stringify(cloudflareAnalysisStatus(ENV));
  assert.equal(publicStatus.includes(ACCOUNT), false);
  assert.equal(publicStatus.includes(TOKEN), false);
  assert.equal(cloudflareAnalysisStatus({ ...ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT.toUpperCase() }).available, true);
  assert.equal(cloudflareAnalysisStatus({ ...ENV, CLOUDFLARE_API_TOKEN: ` ${TOKEN}\n` }).available, true);
});

test('missing or malformed Cloudflare configuration fails before any network request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return successful(); };
  const cases = [
    [{}, 'missing_credentials', 'analysis_unavailable'],
    [{ CLOUDFLARE_API_TOKEN: TOKEN }, 'missing_credentials', 'analysis_unavailable'],
    [{ CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, 'missing_credentials', 'analysis_unavailable'],
    [{ ...ENV, CLOUDFLARE_ACCOUNT_ID: '../other-account' }, 'invalid_account_id', 'analysis_unavailable'],
    [{ ...ENV, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(31) }, 'invalid_account_id', 'analysis_unavailable'],
    [{ ...ENV, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(33) }, 'invalid_account_id', 'analysis_unavailable'],
    [{ ...ENV, CLOUDFLARE_AI_MODEL: '@cf/other/model' }, 'unsupported_model', 'analysis_unavailable'],
    [{ ...ENV, CLOUDFLARE_AI_MODEL: 'https://api.openai.com/v1/responses' }, 'unsupported_model', 'analysis_unavailable'],
    ...[`Bearer ${TOKEN}`, 'contains whitespace', 'truncated...token', 'truncated…token', `"${TOKEN}"`, `'${TOKEN}'`, 'x'.repeat(513)].map(token => [{ ...ENV, CLOUDFLARE_API_TOKEN: token }, 'invalid_key_format', 'analysis_key_format_invalid']),
  ];
  for (const [env, reason, code] of cases) {
    assert.equal(cloudflareAnalysisStatus(env).reason, reason);
    assert.equal(cloudflareAnalysisStatus(env).available, false);
    await rejectsWith(callCloudflareTransport(payload(), { env, fetchImpl }), 503, code);
  }
  assert.equal(calls, 0);
});

test('Cloudflare inference uses its fixed official model endpoint and documented multimodal JSON request', async () => {
  let calls = 0;
  const result = await callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${CLOUDFLARE_VISION_MODEL}`);
    assert.equal(new URL(url).search, '');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    const headers = new Headers(options.headers);
    assert.deepEqual([...headers.keys()].sort(), ['authorization', 'content-type']);
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(headers.get('content-type'), 'application/json');
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ['guided_json', 'max_tokens', 'messages', 'stream', 'temperature']);
    assert.equal(body.temperature, 0);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 2500);
    assert.deepEqual(body.guided_json, SCHEMA);
    assert.equal(body.messages[0].role, 'system');
    assert.ok(body.messages[0].content.startsWith(payload().instructions));
    assert.ok(body.messages[0].content.endsWith(JSON.stringify(SCHEMA)));
    assert.equal(body.messages[1].role, 'user');
    assert.deepEqual(body.messages[1].content, [
      { type: 'text', text: '원본 절대 시각 범위: 120~126초. 아래 프레임의 번호와 원본 시각을 그대로 사용하세요.' },
      { type: 'text', text: 'frameIndex: 0, 원본 시각 120초' },
      { type: 'image_url', image_url: { url: JPEG } },
      { type: 'text', text: 'frameIndex: 1, 원본 시각 126초' },
      { type: 'image_url', image_url: { url: JPEG } },
    ]);
    assert.equal(options.body.includes(TOKEN), false);
    assert.equal(options.body.includes(ACCOUNT), false);
    assert.equal(options.body.includes('openai'), false);
    return successful();
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { output: OUTPUT, model: CLOUDFLARE_VISION_MODEL });
});

test('discovery uses the larger fixed output budget and one contact sheet retains every original frame index', async () => {
  const input = { start: 90, end: 96, discover: true, frames: [{ time: 90 }, { time: 92.5 }, { time: 96 }] };
  const sheet = 'data:image/jpeg;base64,Y29udGFjdA==';
  await callCloudflareAnalysis(payload({ input, image: sheet }), { env: ENV, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 3000);
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.guided_json, SCHEMA);
    const content = body.messages[1].content;
    assert.equal(content.length, 3);
    assert.equal(content[1].text, 'frameIndex: 0, 원본 시각 90초\nframeIndex: 1, 원본 시각 92.5초\nframeIndex: 2, 원본 시각 96초');
    assert.deepEqual(content.filter(part => part.type === 'image_url'), [{ type: 'image_url', image_url: { url: sheet } }]);
    return successful();
  } });
});

test('each inference batch first verifies empty subscriptions using a server-only GET and the same abort signal', async () => {
  const requests = [];
  const signals = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method });
    if (url === SUBSCRIPTIONS_URL) {
      const headers = new Headers(options.headers);
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
      assert.equal(headers.get('accept'), 'application/json');
      assert.deepEqual([...headers.keys()].sort(), ['accept', 'authorization']);
      assert.equal(headers.get('cookie'), null);
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.equal(new URL(url).search, '');
      assert.ok(options.signal instanceof AbortSignal);
      signals.push(options.signal);
      return Response.json({ success: true, result: [] });
    }
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${CLOUDFLARE_VISION_MODEL}`);
    assert.equal(options.signal, signals.at(-1));
    return successful();
  };
  for (let batch = 0; batch < 2; batch++) assert.equal((await callCloudflareTransport(payload(), { env: ENV, fetchImpl })).output, OUTPUT);
  assert.deepEqual(requests.map(request => request.method), ['GET', 'POST', 'GET', 'POST']);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
});

test('free-plan verification accepts empty official SinglePage responses with optional metadata', async () => {
  for (const proof of [
    { success: true, result: [] },
    { success: true, errors: [], result: [] },
    { success: true, errors: [], messages: [], result: [] },
    { success: true, errors: [], messages: [], result: [], result_info: { page: 1, per_page: 25 } },
    { success: true, result: [], result_info: { page: 1, per_page: 25, total: 0 } },
    ...[false, 0, null, ''].map(value => ({ success: true, result: [], result_info: { page: 1, per_page: 25, has_more: value } })),
    ...[null, {}, { before: '', after: '' }, { before: null, after: null }].map(cursors => ({ success: true, result: [], result_info: { page: 1, per_page: 25, cursors } })),
    { success: true, result: [], result_info: {} },
    { success: true, result: [], result_info: { page: 0, per_page: 0, count: 0, total_count: 0, total_pages: 0 } },
    { success: true, result: [], result_info: { page: 1, per_page: 20, count: 0, total_count: 0 } },
    { success: true, result: [], result_info: COMPLETE_EMPTY_PAGE },
    { success: true, result: [], result_info: { ...COMPLETE_EMPTY_PAGE, total_pages: 0 } },
    ...['page', 'per_page', 'count', 'total_count'].map(missing => {
      const info = { ...COMPLETE_EMPTY_PAGE }; delete info[missing];
      return { success: true, result: [], result_info: info };
    }),
  ]) {
    let inferenceCalls = 0;
    const result = await callCloudflareTransport(payload(), { env: ENV, fetchImpl: async url => {
      if (url === SUBSCRIPTIONS_URL) return Response.json(proof);
      inferenceCalls++;
      return successful();
    } });
    assert.equal(result.output, OUTPUT);
    assert.equal(inferenceCalls, 1);
  }
});

test('nonempty, malformed, forbidden and contradictory subscription proofs block inference', async () => {
  const proofs = [
    null,
    {},
    { success: false, result: [] },
    { success: true },
    { success: true, result: null },
    { success: true, result: {} },
    { success: true, result: [{ id: 'paid-subscription', plan: { name: 'Workers Paid' } }] },
    { success: true, result: [], errors: null },
    { success: true, result: [], errors: {} },
    { success: true, result: [], errors: [{ code: 3036, message: PRIVATE_MESSAGE }] },
    { success: true, result: [], result_info: null },
    { success: true, result: [], result_info: [] },
    { success: true, result: [], has_more: true },
    { success: true, result: [], cursor: 'next-page' },
    ...[
      { page: -1 }, { page: 2 }, { page: '1' }, { count: 1 }, { total_count: 1 },
      { count: '0' }, { total_count: -1 }, { total: 1 }, { total: '0' }, { total: null }, { total_pages: 2 }, { per_page: -1 }, { per_page: 1.5 }, { cursor: 'next-page' }, { has_more: true }, { total_entries: 1 }, { extra: {} }, { extra: [] },
      { cursors: { before: '', after: 'next-page' } }, { cursors: { before: 'previous-page', after: '' } }, { cursors: { unknown: '' } }, { cursors: [] }, { cursors: true },
    ].map(overrides => ({ success: true, result: [], result_info: { ...COMPLETE_EMPTY_PAGE, ...overrides } })),
  ];
  for (const proof of proofs) {
    let inferenceCalls = 0;
    await rejectsWith(callCloudflareTransport(payload(), { env: ENV, fetchImpl: async url => {
      if (url === SUBSCRIPTIONS_URL) return Response.json(proof);
      inferenceCalls++;
      return successful();
    } }), 503, 'free_plan_unverified');
    assert.equal(inferenceCalls, 0);
  }
  for (const status of [201, 400, 401, 403, 404, 429, 503]) {
    let inferenceCalls = 0;
    await rejectsWith(callCloudflareTransport(payload(), { env: ENV, fetchImpl: async url => {
      if (url === SUBSCRIPTIONS_URL) return Response.json({ success: true, result: [] }, { status });
      inferenceCalls++;
      return successful();
    } }), 503, status === 401 ? 'analysis_credentials_rejected' : status === 403 ? 'analysis_permission_denied' : 'free_plan_unverified');
    assert.equal(inferenceCalls, 0);
  }
});

test('network failure and malformed subscription JSON fail closed without exposing diagnostics or invoking inference', async () => {
  for (const proofResponse of [() => new Response(PRIVATE_MESSAGE), () => new Response(null), () => { throw Object.assign(new Error(PRIVATE_MESSAGE), { status: 403, code: 'forged_provider_code' }); }]) {
    let inferenceCalls = 0;
    await rejectsWith(callCloudflareTransport(payload(), { env: ENV, fetchImpl: async url => {
      if (url === SUBSCRIPTIONS_URL) return proofResponse();
      inferenceCalls++;
      return successful();
    } }), 503, 'free_plan_unverified');
    assert.equal(inferenceCalls, 0);
  }
});

test('subscription authentication and permission failures cancel private bodies before inference', async () => {
  for (const [upstreamStatus, code] of [[401, 'analysis_credentials_rejected'], [403, 'analysis_permission_denied']]) {
    let cancelled = false; let consumed = false; let inferenceCalls = 0;
    const body = new ReadableStream({ pull() { consumed = true; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    await rejectsWith(callCloudflareTransport(payload(), { env: ENV, fetchImpl: async url => {
      if (url === SUBSCRIPTIONS_URL) return new Response(body, { status: upstreamStatus, headers: { 'Content-Length': String(CLOUDFLARE_MAX_RESPONSE_BYTES + 1) } });
      inferenceCalls++; return successful();
    } }), 503, code);
    assert.equal(cancelled, true); assert.equal(consumed, false); assert.equal(inferenceCalls, 0);
  }
});

test('subscription proof reading enforces declared and streamed response caps and cancels excess bytes', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    let inferenceCalls = 0;
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(Buffer.alloc(CLOUDFLARE_MAX_RESPONSE_BYTES + 1, 32)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await rejectsWith(callCloudflareTransport(payload(), { env: ENV, fetchImpl: async url => {
      if (url === SUBSCRIPTIONS_URL) return new Response(body, { headers: declared ? { 'Content-Length': String(CLOUDFLARE_MAX_RESPONSE_BYTES + 1) } : {} });
      inferenceCalls++;
      return successful();
    } }), 503, 'free_plan_unverified');
    assert.equal(cancelled, true);
    assert.equal(inferenceCalls, 0);
    assert.equal(pulls, declared ? 0 : 1);
  }
});

test('subscription preflight times out during fetch or body reading before any inference', { timeout: 1000 }, async () => {
  for (const streaming of [false, true]) {
    let inferenceCalls = 0;
    let providerSignal;
    let cancelled = false;
    await rejectsWith(callCloudflareTransport(payload(), { env: ENV, timeoutMs: 15, fetchImpl: async (url, options) => {
      if (url !== SUBSCRIPTIONS_URL) { inferenceCalls++; return successful(); }
      providerSignal = options.signal;
      if (!streaming) return new Promise(() => {});
      return new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }, { highWaterMark: 0 }));
    } }), 504, 'analysis_timeout');
    assert.equal(providerSignal.aborted, true);
    assert.equal(inferenceCalls, 0);
    assert.equal(cancelled, streaming);
  }
});

test('active browser cancellation interrupts an uncooperative subscription preflight', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let providerSignal;
  let inferenceCalls = 0;
  const pending = callCloudflareTransport(payload(), { env: ENV, signal: controller.signal, timeoutMs: 500, fetchImpl: async (url, options) => {
    if (url !== SUBSCRIPTIONS_URL) { inferenceCalls++; return successful(); }
    providerSignal = options.signal;
    return new Promise(() => {});
  } });
  controller.abort();
  await rejectsWith(pending, 499, 'analysis_cancelled');
  assert.equal(providerSignal.aborted, true);
  assert.equal(inferenceCalls, 0);
});

test('transport rejects invalid frame encodings, malformed envelopes and oversized requests before fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return successful(); };
  const invalid = [
    payload({ input: null }),
    payload({ input: { frames: [] } }),
    payload({ input: { frames: Array.from({ length: 25 }, () => ({ time: 0, image: JPEG })) } }),
    payload({ instructions: '' }),
    payload({ instructions: 'x'.repeat(20001) }),
    payload({ schema: [] }),
    payload({ schema: null }),
    payload({ image: 'https://private.example/frame.jpg' }),
    payload({ image: 'data:image/png;base64,YQ==' }),
    payload({ image: 'data:image/jpeg;base64,Y Q==' }),
    payload({ input: { frames: [{ time: 0, image: `data:image/jpeg;base64,${'A'.repeat(3_500_000)}` }] } }),
    payload({ input: { frames: [{ time: 0, image: 'file:///private/frame.jpg' }] } }),
  ];
  for (const value of invalid) await rejectsWith(callCloudflareTransport(value, { env: ENV, fetchImpl }), 400, 'invalid_request');
  const largeImage = `data:image/jpeg;base64,${'A'.repeat(2_200_000)}`;
  await rejectsWith(callCloudflareTransport(payload({ input: { start: 0, end: 1, frames: [{ time: 0, image: largeImage }, { time: 1, image: largeImage }] } }), { env: ENV, fetchImpl }), 413, 'invalid_request');
  assert.equal(calls, 0);
});

test('documented Cloudflare quota, free-plan, terms and capacity failures have distinct safe categories', async () => {
  const cases = [
    [429, 3036, 429, 'analysis_quota_exceeded'],
    [403, 5035, 503, 'analysis_free_plan_required'],
    [403, 5016, 503, 'analysis_model_terms_required'],
    [503, 3040, 429, 'analysis_rate_limited'],
    [429, 9999, 429, 'analysis_rate_limited'],
    [401, 9999, 503, 'analysis_credentials_rejected'],
    [403, 9999, 503, 'analysis_permission_denied'],
    [404, 9999, 503, 'analysis_model_unavailable'],
    [500, 9999, 502, 'analysis_provider_failed'],
  ];
  for (const [upstreamStatus, providerCode, status, code] of cases) {
    await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async () => Response.json({ success: false, errors: [{ code: providerCode, message: PRIVATE_MESSAGE }] }, { status: upstreamStatus }) }), status, code);
  }
});

test('Cloudflare application failures are recognized on HTTP success and arbitrary diagnostic text is never trusted', async () => {
  await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async () => Response.json({ success: false, errors: [{ code: 3036, message: PRIVATE_MESSAGE }] }) }), 429, 'analysis_quota_exceeded');
  await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async () => Response.json({ success: true, result: { response: OUTPUT }, errors: [{ code: 3040, message: PRIVATE_MESSAGE }] }) }), 429, 'analysis_rate_limited');
  await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async () => Response.json({ success: false, errors: [{ code: '3036', message: `3036 ${PRIVATE_MESSAGE}` }] }, { status: 500 }) }), 502, 'analysis_provider_failed');
  await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async () => { throw new Error(PRIVATE_MESSAGE); } }), 502, 'analysis_provider_failed');
  await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async () => { throw Object.assign(new Error(PRIVATE_MESSAGE), { status: 403, code: 'forged_provider_code' }); } }), 502, 'analysis_provider_failed');
});

test('Cloudflare daily quota exhaustion reports the next UTC midnight for retry', async () => {
  const nextMidnight = time => new Date((Math.floor(time / 86400_000) + 1) * 86400_000).toISOString();
  const before = Date.now();
  await assert.rejects(callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async () => Response.json({ success: false, errors: [{ code: 3036, message: PRIVATE_MESSAGE }] }, { status: 429 }) }), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'analysis_quota_exceeded');
    assert.ok([nextMidnight(before), nextMidnight(Date.now())].includes(error.retryAt));
    assert.equal(new Date(error.retryAt).getUTCHours(), 0);
    return true;
  });
});

test('missing, malformed and empty Cloudflare result envelopes fail safely without returning provider data', async () => {
  const responses = [
    new Response(PRIVATE_MESSAGE),
    new Response(null),
    Response.json(null),
    Response.json({}),
    Response.json({ success: true }),
    Response.json({ success: true, result: {} }),
    Response.json({ success: true, result: { response: null } }),
    Response.json({ success: true, result: { response: { text: OUTPUT } } }),
    Response.json({ success: true, result: { response: '   ' } }),
    Response.json({ result: { response: OUTPUT } }),
  ];
  for (const response of responses) await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async () => response }), 502, 'analysis_invalid_result');
});

test('an oversized declared Cloudflare response is cancelled before its body is consumed', async () => {
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream({ pull() { pulls++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const response = new Response(body, { headers: { 'Content-Length': String(CLOUDFLARE_MAX_RESPONSE_BYTES + 1) } });
  await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async () => response }), 502, 'analysis_provider_failed');
  assert.equal(cancelled, true);
  assert.equal(pulls, 0);
});

test('the response limit counts streamed bytes, accepts its exact boundary and cancels overflow', async () => {
  const json = JSON.stringify({ success: true, result: { response: OUTPUT } });
  const exact = Buffer.from(json + ' '.repeat(CLOUDFLARE_MAX_RESPONSE_BYTES - Buffer.byteLength(json)));
  assert.equal(exact.byteLength, CLOUDFLARE_MAX_RESPONSE_BYTES);
  const accepted = await callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async () => new Response(exact) });
  assert.deepEqual(accepted, { output: OUTPUT, model: CLOUDFLARE_VISION_MODEL });
  let cancelled = false;
  let index = 0;
  const parts = [exact.subarray(0, 1000), exact.subarray(1000), Buffer.from(' ')];
  const body = new ReadableStream({
    pull(controller) { if (index < parts.length) controller.enqueue(parts[index++]); },
    cancel() { cancelled = true; },
  });
  await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, fetchImpl: async () => new Response(body) }), 502, 'analysis_provider_failed');
  assert.equal(cancelled, true);
});

test('a pre-aborted browser request never sends frames to Cloudflare', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await rejectsWith(callCloudflareTransport(payload(), { env: ENV, signal: controller.signal, fetchImpl: async () => { calls++; return successful(); } }), 499, 'analysis_cancelled');
  assert.equal(calls, 0);
});

test('active cancellation returns promptly even when the upstream fetch ignores abort', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let providerSignal;
  let started;
  const inferenceStarted = new Promise(resolve => { started = resolve; });
  const pending = callCloudflareAnalysis(payload(), { env: ENV, signal: controller.signal, timeoutMs: 500, fetchImpl: async (_url, options) => {
    providerSignal = options.signal;
    started();
    return new Promise(() => {});
  } });
  await inferenceStarted;
  controller.abort();
  await rejectsWith(pending, 499, 'analysis_cancelled');
  assert.equal(providerSignal.aborted, true);
});

test('transport timeout is enforced even when the upstream fetch ignores abort', { timeout: 1000 }, async () => {
  let providerSignal;
  await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, timeoutMs: 15, fetchImpl: async (_url, options) => {
    providerSignal = options.signal;
    return new Promise(() => {});
  } }), 504, 'analysis_timeout');
  assert.equal(providerSignal.aborted, true);
});

test('timeout also interrupts a stalled response stream and cancels its reader', { timeout: 1000 }, async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull() {}, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, timeoutMs: 15, fetchImpl: async () => new Response(body) }), 504, 'analysis_timeout');
  assert.equal(cancelled, true);
});

test('active cancellation during response reading cancels the Cloudflare body', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({
    pull() { queueMicrotask(() => controller.abort()); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await rejectsWith(callCloudflareAnalysis(payload(), { env: ENV, signal: controller.signal, timeoutMs: 500, fetchImpl: async () => new Response(body) }), 499, 'analysis_cancelled');
  assert.equal(cancelled, true);
});
