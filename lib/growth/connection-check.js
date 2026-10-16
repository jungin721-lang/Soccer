import { randomUUID } from 'node:crypto';
import { handleAnalysis } from '../analysis.js';
import { growthAnalysisEnvironment } from './runtime.js';
import { blockProviderQuota, claimProviderProbe, markProviderSuccess, releaseProviderProbe } from './provider.js';

// A generated black 64x64 JPEG. Never read or transmit an uploaded child image
// just to check whether the server can reach the free inference provider.
const SYNTHETIC_IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgKCgsKCw0NDQ0NDRAPEBAQEBAQEBAQEBASEhIVFRUSEhIQEBISFBQVFRcXFxUVFRUXFxkZGR4eHBwjIyQrKzP/xABLAAEBAAAAAAAAAAAAAAAAAAAACAEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAEAAQAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AJ/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//9k=';

export async function checkFreeAnalysisConnection({ store, env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const internalCode = randomUUID();
  const settings = { ...growthAnalysisEnvironment(env), SOCCER_ANALYSIS_ACCESS_CODE: internalCode };
  const available = await (await handleAnalysis(new Request('https://next-xi.internal/api/analysis'), { env: settings })).json();
  if (!available.available) return { status: 503, body: { code: 'analysis_unavailable', error: '운영자의 Cloudflare 무료 계정 연결이 필요합니다. 영상이나 결과를 만들지 않았습니다.' } };
  const owner = `connection-${randomUUID()}`;
  const grant = await claimProviderProbe(store, owner, { provider: 'cloudflare', now });
  if (!grant.allowed) return { status: 429, body: { code: 'analysis_quota_exceeded', error: '무료 분석 한도 갱신을 기다리고 있습니다.', retryAt: grant.nextAttemptAt || grant.retryAt } };
  try {
    const ticket = randomUUID();
    const day = new Date(now).toISOString().slice(0, 10);
    const reservation = await store.update(`connection-checks/cloudflare/${day}`, previous => {
      const value = previous || { count: 0, lastAt: null };
      if (value.count >= 5 || (value.lastAt !== null && now - value.lastAt < 60_000)) return value;
      return { count: value.count + 1, lastAt: now, ticket };
    });
    if (reservation.ticket !== ticket) return { status: 429, body: { code: 'connection_check_limited', error: '연결 점검은 서비스 전체에서 하루 5번, 1분 간격으로 실행할 수 있습니다. 잠시 뒤 다시 확인해 주세요.' } };
    const body = { mode: 'discover', videoId: `local-${randomUUID()}`, start: 0, end: 1, frames: [{ time: 0, image: SYNTHETIC_IMAGE }], target: { kit: 'navy', number: 11, age: 11 }, consent: true, accessCode: internalCode };
    const response = await handleAnalysis(new Request('https://next-xi.internal/api/analysis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { env: settings, fetchImpl });
    const result = await response.json();
    if (!response.ok) {
      if (result.code === 'analysis_quota_exceeded') {
        const blocked = await blockProviderQuota(store, { provider: 'cloudflare', now });
        result.retryAt = blocked.retryAt;
      }
      return { status: response.status, body: result };
    }
    if (result.mode !== 'discover' || result.detections.length !== 0) return { status: 502, body: { code: 'analysis_invalid_result', error: '사람이 없는 점검 이미지에서 선수를 찾는 응답이 나와 연결 검증을 통과시키지 않았습니다.' } };
    await markProviderSuccess(store, { provider: 'cloudflare', owner, grant, now });
    return { status: 200, body: { ok: true, provider: 'cloudflare', freeOnly: true, liveVerified: true, checkedAt: new Date(now).toISOString(), message: '합성 이미지로 실제 무료 AI 응답을 확인했습니다. 실제 경기의 선수 식별 정확도를 검증한 것은 아닙니다.' } };
  } finally {
    await releaseProviderProbe(store, owner, { provider: 'cloudflare' });
  }
}
