import { createNetlifyStore } from '../../lib/growth/store.js';
import { runGrowthJob } from '../../lib/growth/worker.js';
import { netlifyOrigin, createBackgroundDispatch, growthAnalysisEnvironment } from '../../lib/growth/runtime.js';
export default async request => {
  try {
    const raw = await request.text();
    if (raw.length > 1024) return new Response(null, { status: 400 });
    const body = JSON.parse(raw);
    if (!/^[a-f\d-]{36}$/i.test(body.jobId || '') || !/^[A-Za-z\d_-]{40,100}$/.test(body.token || '')) return new Response(null, { status: 400 });
    const store = await createNetlifyStore();
    const origin = netlifyOrigin();
    const job = await store.get(`jobs/${body.jobId}`);
    await runGrowthJob({ store, jobId: body.jobId, token: body.token,
      mediaURL: `${origin}/api/v2/media/${job?.videoId}?jobId=${body.jobId}`,
      dispatchContinuation: createBackgroundDispatch(origin), budgetMs: 8 * 60_000, env: growthAnalysisEnvironment(),
    });
  } catch (error) {
    console.error('Growth worker stopped', ['unauthorized_job','worker_configuration'].includes(error.code) ? error.code : 'worker_error');
  }
  return new Response(null, { status: 204 });
};
