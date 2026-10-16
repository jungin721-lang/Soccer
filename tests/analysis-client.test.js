import test from 'node:test';
import assert from 'node:assert/strict';
import { getAnalysisAvailability, analyzeOriginalClip } from '../public/analysis-client.js';

test('a static host HTML fallback cannot masquerade as a connected analysis API', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [200, 404]) {
      globalThis.fetch = async () => new Response('<!doctype html><title>NEXT XI</title>', { status, headers: { 'Content-Type': 'text/html' } });
      assert.deepEqual(await getAnalysisAvailability(), { available: false, reason: 'backend_missing' });
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ available: false, reason: 'ai_not_configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await getAnalysisAvailability(), { available: false, reason: 'ai_not_configured' });
    globalThis.fetch = async () => new Response(JSON.stringify({ available: true, reason: 'ready' }), { headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await getAnalysisAvailability(), { available: true, reason: 'ready' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unreachable or malformed analysis status stays unavailable without an uncaught error', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('Network details must not reach the UI'); };
    assert.deepEqual(await getAnalysisAvailability(), { available: false, reason: 'network_error' });
    globalThis.fetch = async () => new Response('{', { headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await getAnalysisAvailability(), { available: false, reason: 'invalid_response' });
    globalThis.fetch = async () => new Response(JSON.stringify({ available: 'yes' }), { headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await getAnalysisAvailability(), { available: false, reason: 'invalid_response' });
    globalThis.fetch = async () => new Response(JSON.stringify({ available: true }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await getAnalysisAvailability(), { available: false, reason: 'server_error' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('consent, segment bounds and an original file are required before any network or video access', async () => {
  const request = { blob: new Blob(['video'], { type: 'video/mp4' }), start: 0, end: 2, videoId: 'local-video', accessCode: 'pilot-code', consent: true };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('Must never send a rejected request'); };
  try {
    await assert.rejects(analyzeOriginalClip({ ...request, consent: false }), /동의/);
    await assert.rejects(analyzeOriginalClip({ ...request, end: 13 }), /1~12초/);
    await assert.rejects(analyzeOriginalClip({ ...request, end: 0.5 }), /1~12초/);
    await assert.rejects(analyzeOriginalClip({ ...request, start: -1 }), /1~12초/);
    await assert.rejects(analyzeOriginalClip({ ...request, end: NaN }), /1~12초/);
    await assert.rejects(analyzeOriginalClip({ ...request, blob: new Blob([]) }), /원본 파일/);
    await assert.rejects(analyzeOriginalClip({ ...request, accessCode: '' }), /이용 코드/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(analyzeOriginalClip({ ...request, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
