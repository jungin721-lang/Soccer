import { handleAnalysis } from '../analysis.js';

// Configuration check only, never claims that a live paid request passed.
export async function analysisAvailability(env = process.env) {
  const response = await handleAnalysis(new Request('https://next-xi.internal/api/analysis'), {
    env: { ...env, SOCCER_ANALYSIS_ACCESS_CODE: 'internal-server-readiness-check' },
  });
  return response.json();
}
export function netlifyOrigin(env = process.env) {
  const value = env.DEPLOY_PRIME_URL || env.DEPLOY_URL || env.URL;
  if (!value) throw new Error('Deployment origin is unavailable.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.netlify.app')) throw new Error('Invalid deployment origin.');
  return url.origin;
}
export function createBackgroundDispatch(origin) {
  return async (jobId, token, { signal, timeoutMs = 8_000 } = {}) => {
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(8_000, Number.isFinite(timeoutMs) ? timeoutMs : 8_000)));
    const response = await fetch(new URL('/.netlify/functions/growth-worker-background', origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, token }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status !== 202) throw new Error('Background function did not accept the job.');
  };
}
