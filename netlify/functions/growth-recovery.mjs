import { createNetlifyStore } from '../../lib/growth/store.js';
import { recoverGrowthJobs } from '../../lib/growth/worker.js';
import { netlifyOrigin, createBackgroundDispatch } from '../../lib/growth/runtime.js';
export default async () => {
  const store = await createNetlifyStore();
  await recoverGrowthJobs({ store, dispatchJob: createBackgroundDispatch(netlifyOrigin()), maximum: 10 });
  return new Response(null, { status: 204 });
};
export const config = { schedule: '*/10 * * * *' };
