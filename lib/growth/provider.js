import { randomUUID } from 'node:crypto';

const providerKey = provider => {
  if (!['openai', 'cloudflare'].includes(provider)) throw new Error('지원하지 않는 분석 제공자입니다.');
  return `providers/${provider}`;
};
export const PROVIDER_QUOTA_COOLDOWN_MS = 30 * 60_000;
// The worker checkpoints within eight minutes. A probe covers that complete
// invocation plus a minute, including decode preparation and provider timeout.
const PROBE_LEASE_MS = 9 * 60_000;
const iso = value => new Date(value).toISOString();
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;

function normalizeProvider(value) {
  if (!value) return { status: 'unknown', retryAt: null, checkedAt: null, probeLease: null, version: 0 };
  if (!['unknown', 'ready', 'quota_exceeded'].includes(value.status)) throw new Error('공급자 연결 상태를 읽지 못했습니다.');
  const probe = value.probeLease;
  return {
    status: value.status,
    retryAt: Number.isFinite(time(value.retryAt)) ? value.retryAt : null,
    checkedAt: Number.isFinite(time(value.checkedAt)) ? value.checkedAt : null,
    probeLease: probe && typeof probe.owner === 'string' && typeof probe.token === 'string' && Number.isFinite(time(probe.until)) ? { owner: probe.owner, token: probe.token, until: probe.until } : null,
    version: Number.isSafeInteger(value.version) && value.version >= 0 ? value.version : 0,
  };
}

export async function readProviderStatus(store, { provider = 'openai' } = {}) {
  return normalizeProvider(await store.get(providerKey(provider)));
}

/** Call only for a quota response actually returned by the paid provider. */
export async function blockProviderQuota(store, { now = Date.now(), onlyIfUnknown = false, provider = 'openai' } = {}) {
  const retry = provider === 'cloudflare' ? (Math.floor(now / 86_400_000) + 1) * 86_400_000 : now + PROVIDER_QUOTA_COOLDOWN_MS;
  return store.update(providerKey(provider), value => {
    const current = normalizeProvider(value);
    if (onlyIfUnknown && current.status !== 'unknown') return current;
    return { status: 'quota_exceeded', retryAt: iso(retry), checkedAt: iso(now), probeLease: null, version: current.version + 1 };
  });
}

/** Quota stays blocked until one real request succeeds; elapsed time is no proof. */
export async function claimProviderProbe(store, owner, { now = Date.now(), provider = 'openai' } = {}) {
  if (typeof owner !== 'string' || !owner || owner.length > 100) throw new Error('공급자 확인 작업을 식별하지 못했습니다.');
  const candidate = randomUUID();
  const state = await store.update(providerKey(provider), value => {
    const current = normalizeProvider(value);
    if (current.status !== 'quota_exceeded' || time(current.retryAt) > now) return current;
    if (current.probeLease && time(current.probeLease.until) > now && current.probeLease.owner !== owner) return current;
    const token = current.probeLease?.owner === owner && time(current.probeLease.until) > now ? current.probeLease.token : candidate;
    return { ...current, probeLease: { owner, token, until: iso(now + PROBE_LEASE_MS) } };
  });
  const allowed = state.status !== 'quota_exceeded' || Boolean(state.probeLease?.owner === owner && time(state.probeLease.until) > now);
  return { provider, allowed, status: state.status, retryAt: state.retryAt, checkedAt: state.checkedAt, version: state.version, probeToken: allowed ? state.probeLease?.token || null : null, nextAttemptAt: state.probeLease && time(state.probeLease.until) > now ? state.probeLease.until : state.retryAt };
}

/** A stale in-flight success cannot clear a newer quota failure. */
export async function markProviderSuccess(store, { owner, grant, now = Date.now(), provider = 'openai' } = {}) {
  return store.update(providerKey(provider), value => {
    const current = normalizeProvider(value);
    if (!grant || grant.provider !== provider || grant.version !== current.version) return current;
    if (current.status === 'quota_exceeded' && (!current.probeLease || current.probeLease.owner !== owner || current.probeLease.token !== grant.probeToken)) return current;
    return { status: 'ready', retryAt: null, checkedAt: iso(now), probeLease: null, version: current.version };
  });
}

export async function releaseProviderProbe(store, owner, { provider = 'openai' } = {}) {
  return store.update(providerKey(provider), value => {
    const current = normalizeProvider(value);
    return current.probeLease?.owner === owner ? { ...current, probeLease: null } : current;
  });
}
