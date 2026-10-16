import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalStore } from '../lib/growth/store.js';
import { readProviderStatus, blockProviderQuota, claimProviderProbe, markProviderSuccess, releaseProviderProbe, PROVIDER_QUOTA_COOLDOWN_MS } from '../lib/growth/provider.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'next-xi-provider-'));
  const store = await createLocalStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return store;
}

test('an absent provider record and a permitted attempt never claim a verified connection', async t => {
  const store = await fixture(t);
  assert.equal((await readProviderStatus(store)).status, 'unknown');
  const grant = await claimProviderProbe(store, 'first-job', { now: 1000 });
  assert.equal(grant.allowed, true);
  assert.equal((await readProviderStatus(store)).status, 'unknown');
  await markProviderSuccess(store, { owner: 'first-job', now: 2000 });
  assert.equal((await readProviderStatus(store)).status, 'unknown', 'A successful-request grant is required');
  await markProviderSuccess(store, { owner: 'first-job', grant, now: 2000 });
  assert.deepEqual(await readProviderStatus(store), { status: 'ready', retryAt: null, checkedAt: new Date(2000).toISOString(), probeLease: null, version: 0 });
});

test('waiting jobs cannot extend a provider quota cooldown or treat its expiry as success', async t => {
  const store = await fixture(t);
  const initial = await blockProviderQuota(store, { now: 1000 });
  assert.equal(Date.parse(initial.retryAt), 1000 + PROVIDER_QUOTA_COOLDOWN_MS);
  for (const now of [1001, 10000, 1000 + PROVIDER_QUOTA_COOLDOWN_MS - 1]) {
    assert.equal((await claimProviderProbe(store, 'waiting-job', { now })).allowed, false);
    assert.deepEqual(await readProviderStatus(store), initial);
  }
  assert.equal((await claimProviderProbe(store, 'probe-job', { now: 1000 + PROVIDER_QUOTA_COOLDOWN_MS })).allowed, true);
  assert.equal((await readProviderStatus(store)).status, 'quota_exceeded');
});

test('one CAS probe is admitted after cooldown and only its matching success clears quota', async t => {
  const store = await fixture(t);
  await blockProviderQuota(store, { now: 1000 });
  const now = 1000 + PROVIDER_QUOTA_COOLDOWN_MS + 1;
  const attempts = await Promise.all(Array.from({ length: 20 }, (_, index) => claimProviderProbe(store, `job-${index}`, { now })));
  const allowed = attempts.map((grant, index) => ({ grant, owner: `job-${index}` })).filter(item => item.grant.allowed);
  assert.equal(allowed.length, 1);
  const winner = allowed[0];
  await markProviderSuccess(store, { owner: 'another-job', grant: winner.grant, now: now + 1 });
  assert.equal((await readProviderStatus(store)).status, 'quota_exceeded');
  await releaseProviderProbe(store, 'another-job');
  assert.equal((await readProviderStatus(store)).probeLease.owner, winner.owner);
  await markProviderSuccess(store, { ...winner, now: now + 2 });
  assert.equal((await readProviderStatus(store)).status, 'ready');
  assert.equal((await readProviderStatus(store)).probeLease, null);
  const latestQuota = await blockProviderQuota(store, { now: now + 3 });
  await markProviderSuccess(store, { ...winner, now: now + 4 });
  assert.deepEqual(await readProviderStatus(store), latestQuota, 'An older in-flight success cannot erase a newer quota failure');
});

test('legacy quota evidence initializes unknown state once and never overwrites a newer verified success', async t => {
  const store = await fixture(t);
  const evidence = await blockProviderQuota(store, { now: 1000, onlyIfUnknown: true });
  assert.equal(evidence.checkedAt, new Date(1000).toISOString());
  await blockProviderQuota(store, { now: 2000, onlyIfUnknown: true });
  assert.deepEqual(await readProviderStatus(store), evidence);
  const grant = await claimProviderProbe(store, 'recovery-job', { now: Date.parse(evidence.retryAt) + 1 });
  await markProviderSuccess(store, { owner: 'recovery-job', grant, now: Date.parse(evidence.retryAt) + 2 });
  const verified = await readProviderStatus(store);
  await blockProviderQuota(store, { now: 3000, onlyIfUnknown: true });
  assert.deepEqual(await readProviderStatus(store), verified);
});

test('Cloudflare quota pauses until the next UTC midnight independently of paid provider state', async t => {
  const store = await fixture(t);
  const stamp = Date.parse('2026-10-16T15:42:31.000Z');
  const openai = await blockProviderQuota(store, { now: stamp });
  const cloudflare = await blockProviderQuota(store, { now: stamp, provider: 'cloudflare' });
  assert.equal(cloudflare.retryAt, '2026-10-17T00:00:00.000Z');
  assert.equal(openai.retryAt, '2026-10-16T16:12:31.000Z');
  assert.deepEqual(await store.list('providers/'), ['providers/cloudflare', 'providers/openai']);
  assert.deepEqual(await readProviderStatus(store), openai);
  for (const now of [stamp + 1, Date.parse('2026-10-16T23:59:59.999Z')]) {
    assert.equal((await claimProviderProbe(store, 'cf-waiting', { now, provider: 'cloudflare' })).allowed, false);
    assert.deepEqual(await readProviderStatus(store, { provider: 'cloudflare' }), cloudflare, 'Waiting does not extend the daily reset');
  }
  const grant = await claimProviderProbe(store, 'cf-at-reset', { now: Date.parse(cloudflare.retryAt), provider: 'cloudflare' });
  assert.equal(grant.allowed, true);
  assert.equal((await readProviderStatus(store, { provider: 'cloudflare' })).status, 'quota_exceeded', 'UTC reset alone is not a successful inference');
  await markProviderSuccess(store, { owner: 'cf-at-reset', grant, now: Date.parse(cloudflare.retryAt) + 1, provider: 'cloudflare' });
  assert.equal((await readProviderStatus(store, { provider: 'cloudflare' })).status, 'ready');
  assert.deepEqual(await readProviderStatus(store), openai, 'A Cloudflare recovery never clears an OpenAI quota');
});

test('Cloudflare daily reset handles UTC boundaries and leap dates without using local time', async t => {
  const store = await fixture(t);
  for (const [stamp, reset] of [
    ['2026-10-16T00:00:00.000Z', '2026-10-17T00:00:00.000Z'],
    ['2026-10-16T23:59:59.999Z', '2026-10-17T00:00:00.000Z'],
    ['2028-02-28T23:59:59.000Z', '2028-02-29T00:00:00.000Z'],
    ['2028-02-29T23:59:59.000Z', '2028-03-01T00:00:00.000Z'],
    ['2026-12-31T23:59:59.999Z', '2027-01-01T00:00:00.000Z'],
  ]) {
    assert.equal((await blockProviderQuota(store, { now: Date.parse(stamp), provider: 'cloudflare' })).retryAt, reset);
  }
  assert.equal((await readProviderStatus(store)).status, 'unknown');
});

test('Cloudflare admits one reset probe and rejects stale successes after a new daily quota failure', async t => {
  const store = await fixture(t);
  const start = Date.parse('2026-10-16T12:00:00.000Z');
  const blocked = await blockProviderQuota(store, { now: start, provider: 'cloudflare' });
  const reset = Date.parse(blocked.retryAt);
  const grants = await Promise.all(Array.from({ length: 20 }, (_, index) => claimProviderProbe(store, `cf-job-${index}`, { now: reset, provider: 'cloudflare' })));
  const winners = grants.map((grant, index) => ({ grant, owner: `cf-job-${index}` })).filter(item => item.grant.allowed);
  assert.equal(winners.length, 1);
  const winner = winners[0];
  const repeated = await claimProviderProbe(store, winner.owner, { now: reset + 1, provider: 'cloudflare' });
  assert.equal(repeated.probeToken, winner.grant.probeToken, 'The same live probe keeps its lease');
  await releaseProviderProbe(store, 'wrong-owner', { provider: 'cloudflare' });
  assert.equal((await readProviderStatus(store, { provider: 'cloudflare' })).probeLease.owner, winner.owner);
  const newFailure = await blockProviderQuota(store, { now: reset + 2, provider: 'cloudflare' });
  assert.equal(newFailure.retryAt, '2026-10-18T00:00:00.000Z');
  await markProviderSuccess(store, { ...winner, now: reset + 3, provider: 'cloudflare' });
  assert.deepEqual(await readProviderStatus(store, { provider: 'cloudflare' }), newFailure);
  assert.equal((await readProviderStatus(store)).status, 'unknown');
});

test('provider grants cannot verify another provider with the same state version', async t => {
  const store = await fixture(t);
  const openai = await claimProviderProbe(store, 'same-job', { now: 1000 });
  const cloudflare = await claimProviderProbe(store, 'same-job', { now: 1000, provider: 'cloudflare' });
  await markProviderSuccess(store, { owner: 'same-job', grant: openai, now: 2000, provider: 'cloudflare' });
  await markProviderSuccess(store, { owner: 'same-job', grant: cloudflare, now: 2000 });
  assert.equal((await readProviderStatus(store, { provider: 'cloudflare' })).status, 'unknown');
  assert.equal((await readProviderStatus(store)).status, 'unknown');
  await markProviderSuccess(store, { owner: 'same-job', grant: cloudflare, now: 2001, provider: 'cloudflare' });
  await markProviderSuccess(store, { owner: 'same-job', grant: openai, now: 2001 });
  assert.equal((await readProviderStatus(store, { provider: 'cloudflare' })).status, 'ready');
  assert.equal((await readProviderStatus(store)).status, 'ready');
});
