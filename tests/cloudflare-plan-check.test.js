import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCloudflareFreePlan, CLOUDFLARE_MAX_RESPONSE_BYTES } from '../lib/cloudflare-analysis.js';

const ACCOUNT = 'abcdef0123456789abcdef0123456789';
const TOKEN = 'private_cloudflare_plan_check_token_1234567';
const PRIVATE_PLAN = 'private-family-plan-name';
const PRIVATE_MESSAGE = `${TOKEN} ${ACCOUNT} ${PRIVATE_PLAN}`;
const ENV = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN };
const URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/subscriptions`;

function assertPrivate(error) {
  const exposed = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const value of [ACCOUNT, TOKEN, PRIVATE_PLAN, PRIVATE_MESSAGE]) assert.equal(exposed.includes(value), false);
}

async function inspectFailure(response) {
  const calls = [];
  let caught;
  try {
    await inspectCloudflareFreePlan({ env: ENV, fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      assert.equal(url, URL);
      assert.equal(init.method, 'GET');
      return typeof response === 'function' ? response(init) : response;
    } });
  } catch (error) { caught = error; }
  assert.ok(caught, 'An unverified account must stop before inference');
  assertPrivate(caught);
  assert.deepEqual(calls, [{ url: URL, method: 'GET' }]);
  return caught;
}

test('read-only free-plan inspection performs one authenticated subscription GET and never invokes inference', async () => {
  for (const proof of [
    { success: true, result: [] },
    { success: true, errors: [], messages: [], result: [], result_info: { page: 1, per_page: 25 } },
    { success: true, errors: [], result: [], result_info: { page: 1, per_page: 25, total: 0 } },
    { success: true, errors: [], messages: [], result: [], result_info: { page: 1, per_page: 20, count: 0, total_count: 0 } },
  ]) {
    let calls = 0;
    const result = await inspectCloudflareFreePlan({ env: ENV, fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, URL);
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      assert.ok(init.signal instanceof AbortSignal);
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
      assert.equal(headers.get('accept'), 'application/json');
      assert.deepEqual([...headers.keys()].sort(), ['accept', 'authorization']);
      return Response.json(proof);
    } });
    assert.equal(calls, 1);
    assert.deepEqual(result, { ok: true, freePlanVerified: true, inferenceCalled: false });
    for (const secret of [ACCOUNT, TOKEN]) assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('contradictory metadata remains blocked while safe numeric pagination identifies the issue', async () => {
  const pagination = { page: 1, per_page: 25, total_count: 1 };
  const error = await inspectFailure(Response.json({
    success: true, errors: [], messages: [PRIVATE_MESSAGE], result: [], result_info: pagination,
  }));
  assert.equal(error.status, 503);
  assert.equal(error.code, 'free_plan_unverified');
  assert.deepEqual(error.diagnostics, {
    stage: 'subscription_lookup', reason: 'response_unverified', httpStatus: 200,
    errorCodes: [], emptyResult: true, pagination,
    shape: { success: true, errorsValid: true, envelopeUnknownFields: 0, paginationType: 'object', paginationFieldTypes: { page: 'number', per_page: 'number', total_count: 'number' }, paginationUnknownFields: 0, paginationExtensions: [] },
  });
});

test('subscription diagnostics reveal only fixed categories and bounded numeric codes and pagination', async () => {
  const error = await inspectFailure(Response.json({
    success: false,
    errors: [
      { code: 7003, message: PRIVATE_MESSAGE }, { code: 10000, message: PRIVATE_PLAN },
      { code: PRIVATE_MESSAGE }, { code: -1 }, { code: 1_000_001 }, { code: 1.5 },
      ...Array.from({ length: 12 }, (_, index) => ({ code: 8000 + index, message: PRIVATE_MESSAGE })),
    ],
    messages: [{ message: PRIVATE_MESSAGE }],
    result: null,
    result_info: { page: 0, per_page: 0, count: PRIVATE_MESSAGE, total_count: -1, total_pages: 1_000_001, cursor: PRIVATE_MESSAGE },
    token: TOKEN, account_id: ACCOUNT, private_plan_name: PRIVATE_PLAN,
  }, { status: 400 }));
  assert.equal(error.code, 'free_plan_unverified');
  assert.deepEqual(error.diagnostics, {
    stage: 'subscription_lookup', reason: 'lookup_rejected', httpStatus: 400,
    errorCodes: [7003, 10000, 8000, 8001, 8002, 8003, 8004, 8005],
    emptyResult: false, pagination: { page: 0, per_page: 0 },
    shape: { success: false, errorsValid: false, envelopeUnknownFields: 3, paginationType: 'object', paginationFieldTypes: { page: 'number', per_page: 'number', count: 'string', total_count: 'number', total_pages: 'number' }, paginationUnknownFields: 1, paginationExtensions: [{ type: 'string', empty: false }] },
  });
});

test('nonempty subscriptions including a zero-priced plan never pass the free-only guard or expose plan names', async () => {
  for (const state of ['Paid', 'Provisioned', 'Trial', 'Cancelled']) {
    const error = await inspectFailure(Response.json({
      success: true, errors: [], messages: [],
      result: [{ id: PRIVATE_MESSAGE, state, price: 0, rate_plan: { id: PRIVATE_PLAN, public_name: PRIVATE_PLAN } }],
    }));
    assert.equal(error.code, 'free_plan_unverified');
    assert.deepEqual(error.diagnostics, {
      stage: 'subscription_lookup', reason: 'subscriptions_present', httpStatus: 200,
      errorCodes: [], emptyResult: false, pagination: {},
      shape: { success: true, errorsValid: true, envelopeUnknownFields: 0, paginationType: 'undefined', paginationFieldTypes: {}, paginationUnknownFields: 0, paginationExtensions: [] },
    });
  }
});

test('HTTP 401 and 403 remain distinct and cancel unread private bodies without attempting inference', async () => {
  for (const [status, code] of [[401, 'analysis_credentials_rejected'], [403, 'analysis_permission_denied']]) {
    let cancelled = false;
    let consumed = false;
    const stream = new ReadableStream({
      pull() { consumed = true; },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const error = await inspectFailure(new Response(stream, { status, headers: { 'Content-Length': String(CLOUDFLARE_MAX_RESPONSE_BYTES + 1) } }));
    assert.equal(error.status, 503);
    assert.equal(error.code, code);
    assert.equal(error.diagnostics, undefined);
    assert.equal(cancelled, true);
    assert.equal(consumed, false);
  }
});

test('network failures and malformed upstream JSON are replaced by safe messages and cannot bypass the guard', async () => {
  for (const response of [
    new Response(PRIVATE_MESSAGE),
    () => { throw new Error(PRIVATE_MESSAGE); },
  ]) {
    const error = await inspectFailure(response);
    assert.equal(error.status, 503);
    assert.equal(error.code, 'free_plan_unverified');
  }
});

test('missing or unsupported configuration fails before any account or inference request', async () => {
  let calls = 0;
  for (const env of [{}, { ...ENV, CLOUDFLARE_ACCOUNT_ID: 'invalid-account' }, { ...ENV, CLOUDFLARE_AI_MODEL: '@cf/unsupported/paid-model' }]) {
    await assert.rejects(inspectCloudflareFreePlan({ env, fetchImpl: async () => { calls++; throw new Error('No request expected'); } }), error => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'analysis_unavailable');
      assertPrivate(error);
      return true;
    });
  }
  assert.equal(calls, 0);
});
