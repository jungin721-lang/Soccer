import { createNetlifyStore } from '../../lib/growth/store.js';
import { createGrowthAPI } from '../../lib/growth/api.js';
import { analysisAvailability, netlifyOrigin, createBackgroundDispatch } from '../../lib/growth/runtime.js';
export default async request => {
  try {
    const store = await createNetlifyStore();
    return await createGrowthAPI({ store, dispatchJob: createBackgroundDispatch(netlifyOrigin()), availability: analysisAvailability })(request);
  } catch {
    return Response.json({ code: 'storage_unavailable', error: '비공개 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
};
export const config = { path: '/api/v2/*' };
