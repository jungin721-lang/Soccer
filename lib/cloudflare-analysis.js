// Cloudflare Workers AI only. This module never calls another AI provider.
// The account must remain on Workers Free for its daily allocation to stop
// without charges; the inference API has no per-request free-only switch.
export const CLOUDFLARE_VISION_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
export const CLOUDFLARE_MAX_RESPONSE_BYTES = 256 * 1024;
const API_ROOT = 'https://api.cloudflare.com/client/v4/accounts/';
const MAX_REQUEST_BYTES = 4 * 1024 ** 2;
const SAFE_ERROR = Symbol('sanitized-cloudflare-error');

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code, [SAFE_ERROR]: true });
}

function configuration(env) {
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const token = String(env.CLOUDFLARE_API_TOKEN || '').trim();
  const model = String(env.CLOUDFLARE_AI_MODEL || CLOUDFLARE_VISION_MODEL).trim();
  const invalidToken = Boolean(token) && (token.length > 512 || /\s|\.\.\.|…/.test(token) || /^["']|["']$/.test(token) || /^Bearer\b/i.test(token));
  const reason = !accountId || !token ? 'missing_credentials' : !/^[a-f\d]{32}$/i.test(accountId) ? 'invalid_account_id' : invalidToken ? 'invalid_key_format' : model !== CLOUDFLARE_VISION_MODEL ? 'unsupported_model' : 'ready';
  return { accountId, token, model, reason, available: reason === 'ready' };
}

/** Public status deliberately excludes the account ID and API token. */
export function cloudflareAnalysisStatus(env = process.env) {
  const { available, reason, model } = configuration(env);
  return { available, reason, model };
}

function abortedError() {
  return Object.assign(new Error('Cloudflare request aborted'), { name: 'AbortError' });
}

async function withAbort(promise, signal) {
  if (signal.aborted) throw abortedError();
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(abortedError());
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function boundedJSON(response, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > CLOUDFLARE_MAX_RESPONSE_BYTES) {
    response.body?.cancel().catch(() => {});
    throw failure(502, 'analysis_provider_failed', 'AI 서비스 응답이 허용된 크기를 초과했습니다.');
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > CLOUDFLARE_MAX_RESPONSE_BYTES) throw failure(502, 'analysis_provider_failed', 'AI 서비스 응답이 허용된 크기를 초과했습니다.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return null; }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* A timed-out stream may still be cancelling. */ }
  }
}

function providerFailure(status, payload) {
  // Inspect only documented numeric categories. Provider messages can include
  // sensitive request data and credentials, so never forward or log them.
  const codes = new Set(Array.isArray(payload?.errors) ? payload.errors.map(error => error?.code).filter(Number.isInteger) : []);
  if (codes.has(3036)) {
    const today = new Date();
    return Object.assign(failure(429, 'analysis_quota_exceeded', 'Cloudflare 무료 AI의 일일 한도에 도달했습니다. 다음 UTC 자정 이후 다시 시도해 주세요. 유료 서비스로 전환하지 않았습니다.'), {
      retryAt: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1)).toISOString(),
    });
  }
  if (codes.has(5035)) return failure(503, 'analysis_free_plan_required', '이 AI 요청에는 유료 플랜이 필요해 중단했습니다. 무료 계정에서 지원되는 설정을 확인해 주세요.');
  if (codes.has(5016)) return failure(503, 'analysis_model_terms_required', '서버 AI 모델의 이용 조건을 확인해야 합니다.');
  if (status === 401) return failure(503, 'analysis_credentials_rejected', 'Cloudflare가 서버 인증을 거절했습니다. 서버의 계정과 AI API 토큰 설정을 확인해야 합니다.');
  if (status === 403) return failure(503, 'analysis_permission_denied', 'Cloudflare가 AI 요청을 허용하지 않았습니다. 서버 API 토큰의 Workers AI 권한을 확인해야 합니다.');
  if (status === 429 || codes.has(3040)) return failure(429, 'analysis_rate_limited', '무료 AI 서비스의 요청 또는 처리 용량 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.');
  if (status === 404) return failure(503, 'analysis_model_unavailable', '설정한 무료 AI 모델을 사용할 수 없습니다.');
  return failure(502, 'analysis_provider_failed', 'Cloudflare AI 서비스에서 결과를 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
}

function completeEmptySubscriptions(payload) {
  if (!payload || payload.success !== true || !Array.isArray(payload.result) || payload.result.length !== 0 ||
      Object.keys(payload).some(key => !['success', 'errors', 'messages', 'result', 'result_info'].includes(key)) ||
      (Object.hasOwn(payload, 'errors') && (!Array.isArray(payload.errors) || payload.errors.length !== 0))) return false;
  // The official SinglePage account-subscription response need not include
  // result_info. If present, accept only an explicitly complete empty page.
  if (!Object.hasOwn(payload, 'result_info')) return true;
  const info = payload.result_info;
  if (!info || typeof info !== 'object' || Array.isArray(info) ||
      !['page', 'per_page', 'count', 'total_count'].every(key => Object.hasOwn(info, key)) ||
      Object.keys(info).some(key => !['page', 'per_page', 'count', 'total_count', 'total_pages'].includes(key))) return false;
  if (Object.hasOwn(info, 'page') && info.page !== 1) return false;
  if (Object.hasOwn(info, 'per_page') && (!Number.isSafeInteger(info.per_page) || info.per_page < 1)) return false;
  if (Object.hasOwn(info, 'count') && info.count !== 0) return false;
  if (Object.hasOwn(info, 'total_count') && info.total_count !== 0) return false;
  if (Object.hasOwn(info, 'total_pages') && ![0, 1].includes(info.total_pages)) return false;
  return true;
}

async function verifyFreePlan(config, fetchImpl, signal) {
  try {
    const response = await withAbort(fetchImpl(`${API_ROOT}${config.accountId}/subscriptions`, {
      method: 'GET', headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      signal, redirect: 'error', cache: 'no-store',
    }), signal);
    if (response.status === 401 || response.status === 403) {
      response.body?.cancel().catch(() => {});
      throw response.status === 401
        ? failure(503, 'analysis_credentials_rejected', 'Cloudflare가 무료 계정 조회의 토큰 인증을 거절했습니다. 서버에 저장한 전체 토큰과 만료·폐기 여부를 확인해 주세요. AI 추론은 실행하지 않았습니다.')
        : failure(503, 'analysis_permission_denied', 'Cloudflare 계정의 구독을 조회할 권한이 없습니다. 서버 토큰의 대상 계정과 Billing Read 권한을 확인해 주세요. AI 추론은 실행하지 않았습니다.');
    }
    const payload = await boundedJSON(response, signal);
    if (response.status !== 200 || !completeEmptySubscriptions(payload)) throw new Error('Unverified account plan');
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') throw error;
    if (error?.[SAFE_ERROR] && ['analysis_credentials_rejected', 'analysis_permission_denied'].includes(error.code)) throw error;
    throw failure(503, 'free_plan_unverified', 'Cloudflare 계정의 무료 플랜을 확인하지 못해 AI 호출을 중단했습니다. 서버 토큰의 Billing Read 권한과 계정 구독 상태를 확인해 주세요.');
  }
}

function requestBody(payload) {
  const { input, instructions, schema, image } = payload || {};
  if (!input || !Array.isArray(input.frames) || input.frames.length < 1 || input.frames.length > 24 ||
      typeof instructions !== 'string' || !instructions.trim() || instructions.length > 20000 ||
      !schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw failure(400, 'invalid_request', '분석할 장면과 응답 형식을 확인해 주세요.');
  }
  const imageValid = value => typeof value === 'string' && value.length <= 3_500_000 && /^data:image\/jpeg;base64,[A-Za-z\d+/]+={0,2}$/.test(value);
  const content = [{ type: 'text', text: `원본 절대 시각 범위: ${input.start}~${input.end}초. 아래 프레임의 번호와 원본 시각을 그대로 사용하세요.` }];
  if (image !== undefined) {
    if (!imageValid(image)) throw failure(400, 'invalid_request', '분석 장면은 JPEG 이미지여야 합니다.');
    content.push({ type: 'text', text: input.frames.map((frame, index) => `frameIndex: ${index}, 원본 시각 ${frame.time}초`).join('\n') });
    content.push({ type: 'image_url', image_url: { url: image } });
  } else {
    for (const [index, frame] of input.frames.entries()) {
      if (!imageValid(frame?.image)) throw failure(400, 'invalid_request', '분석 장면은 JPEG 이미지여야 합니다.');
      content.push({ type: 'text', text: `frameIndex: ${index}, 원본 시각 ${frame.time}초` });
      content.push({ type: 'image_url', image_url: { url: frame.image } });
    }
  }
  const body = JSON.stringify({
    messages: [{ role: 'system', content: instructions }, { role: 'user', content }],
    max_tokens: input.discover ? 3000 : 2500,
    temperature: 0,
    stream: false,
    guided_json: schema,
  });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw failure(413, 'invalid_request', '분석 장면 크기가 너무 큽니다. 더 작은 장면을 선택해 주세요.');
  return body;
}

/**
 * Transport only: the shared handler owns consent, origin, access-code, input
 * validation, instructions and result validation. An optional `image` is one
 * prepared contact sheet; without it, images use the documented content array.
 */
export async function callCloudflareAnalysis(payload, { env = process.env, fetchImpl = fetch, signal, timeoutMs = 48000 } = {}) {
  const config = configuration(env);
  if (!config.available) throw failure(503, config.reason === 'invalid_key_format' ? 'analysis_key_format_invalid' : 'analysis_unavailable', '무료 AI 서버의 Cloudflare 계정과 API 토큰 설정을 확인해야 합니다.');
  if (signal?.aborted) throw failure(499, 'analysis_cancelled', '분석 요청을 취소했습니다.');
  const body = requestBody(payload);
  const controller = new AbortController();
  let clientCancelled = false;
  const abort = () => { clientCancelled = true; controller.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 48000) : 48000;
  const timer = setTimeout(() => controller.abort(), duration);
  try {
    if (controller.signal.aborted) throw abortedError();
    // Recheck each inference batch. Nonempty, unreadable or incomplete account
    // subscriptions fail closed; no paid-plan identifier is guessed and no
    // acknowledgement flag can bypass the check. This requires Billing Read.
    await verifyFreePlan(config, fetchImpl, controller.signal);
    const response = await withAbort(fetchImpl(`${API_ROOT}${config.accountId}/ai/run/${config.model}`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body, signal: controller.signal, redirect: 'error', cache: 'no-store',
    }), controller.signal);
    const result = await boundedJSON(response, controller.signal);
    if (!response.ok || result?.success === false || (Array.isArray(result?.errors) && result.errors.length)) throw providerFailure(response.status, result);
    const output = result?.result?.response;
    if (result?.success !== true || typeof output !== 'string' || !output.trim()) throw failure(502, 'analysis_invalid_result', '장면 근거를 확인할 수 있는 AI 응답을 받지 못했습니다.');
    return { output, model: config.model };
  } catch (error) {
    if (clientCancelled) throw failure(499, 'analysis_cancelled', '분석 요청을 취소했습니다. 저장된 영상과 완료된 결과는 유지됩니다.');
    if (controller.signal.aborted || error?.name === 'AbortError') throw failure(504, 'analysis_timeout', '무료 AI 분석 시간이 초과됐습니다. 다시 시도해 주세요.');
    if (error?.[SAFE_ERROR]) throw error;
    throw failure(502, 'analysis_provider_failed', '무료 AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
