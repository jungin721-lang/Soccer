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
