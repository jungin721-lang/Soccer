import { handleAnalysis } from '../analysis.js';

// The rebuilt app always uses the free Cloudflare path. Existing OpenAI
// bindings cannot trigger a paid fallback, including scheduled recovery.
export function growthAnalysisEnvironment(env = process.env) {
  return { ...env, SOCCER_AI_PROVIDER: 'cloudflare' };
}

// Configuration only: a real validated inference is required for liveVerified.
export async function analysisAvailability(env = process.env) {
  const response = await handleAnalysis(new Request('https://next-xi.internal/api/analysis'), {
    env: { ...growthAnalysisEnvironment(env), SOCCER_ANALYSIS_ACCESS_CODE: 'internal-server-readiness-check' },
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
