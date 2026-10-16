// Only the selected short segment is sent to the analysis server. The original
// video stays in the browser, and credentials for the AI provider never belong
// in this module or the generated static page.
const ANALYSIS_ENDPOINT = '/api/analysis';
const ANALYSIS_MAX_SECONDS = 12;
const ANALYSIS_MAX_FRAMES = 24;
const ANALYSIS_FRAME_INTERVAL = 0.5;
const ANALYSIS_FRAME_BYTES = 250_000;
const ANALYSIS_PAYLOAD_BYTES = 3_000_000;
const ANALYSIS_LONG_EDGE = 768;

function analysisCancelledError() {
  const error = new Error('분석을 취소했습니다. 영상은 기기에 그대로 보관됩니다.');
  error.name = 'AbortError';
  return error;
}

function analysisCheckSignal(signal) {
  if (signal?.aborted) throw analysisCancelledError();
}

function analysisByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function analysisContentIsJSON(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('application/json');
}

function analysisHTTPError(status) {
  if (status === 401 || status === 403) return new Error('분석 이용 코드가 올바르지 않습니다. 코드를 확인한 뒤 다시 시도해 주세요.');
  if (status === 404 || status === 405) return new Error('이 사이트에 분석 서버가 연결되지 않았습니다. 원본 저장은 완료되어 있으며, 분석 서버 연결 후 평가할 수 있습니다.');
  if (status === 413) return new Error('선택한 장면의 전송 용량이 큽니다. 더 짧은 구간을 선택해 주세요.');
  if (status === 429) return new Error('지금은 분석 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
  if (status === 503) return new Error('분석 서버 설정이 아직 완료되지 않았습니다. 원본 저장과 재생은 계속 이용할 수 있습니다.');
  if (status === 400 || status === 422) return new Error('이 구간을 분석 요청으로 처리하지 못했습니다. 다른 1~12초 구간을 선택해 주세요.');
  return new Error('분석 서버에서 결과를 받지 못했습니다. 원본은 보관되어 있으니 잠시 후 다시 시도해 주세요.');
}

export async function getAnalysisAvailability() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(ANALYSIS_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    // Static hosts commonly return index.html with status 200 for unknown URLs.
    // That is not an analysis API and must not be presented as ready.
    if (response.status === 404 || response.status === 405 || !analysisContentIsJSON(response)) {
      return { available: false, reason: 'backend_missing' };
    }
    let payload;
    try { payload = await response.json(); }
    catch { return { available: false, reason: 'invalid_response' }; }
    if (typeof payload?.available !== 'boolean') return { available: false, reason: 'invalid_response' };
    if (!response.ok && payload.available) return { available: false, reason: 'server_error' };
    const reason = typeof payload.reason === 'string' && /^[a-z0-9_]{1,80}$/i.test(payload.reason) ? payload.reason : (payload.available ? 'ready' : 'not_configured');
    return { available: response.ok && payload.available, reason };
  } catch {
    return { available: false, reason: controller.signal.aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

function analysisWaitForVideo(video, { events, predicate, signal, message, trigger, timeout = 15_000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const clean = () => {
      clearTimeout(timer);
      for (const name of events) video.removeEventListener(name, check);
      video.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clean();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (video.error) { failed(); return; }
      if (predicate()) finish();
    };
    const failed = () => finish(new Error('이 기기에서 영상을 해독할 수 없습니다. MP4(H.264) 영상으로 다시 저장해 주세요.'));
    const aborted = () => finish(analysisCancelledError());
    for (const name of events) video.addEventListener(name, check);
    video.addEventListener('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(new Error(message)), timeout);
    if (signal?.aborted) { aborted(); return; }
    try {
      trigger?.();
      check();
    } catch {
      finish(new Error('영상 장면을 불러오지 못했습니다. 영상을 다시 선택해 주세요.'));
    }
  });
}

function analysisValidateRequest({ blob, start, end, videoId, accessCode, consent, signal }) {
  analysisCheckSignal(signal);
  if (!(blob instanceof Blob) || blob.size <= 0) throw new Error('분석할 원본 파일을 이 기기에서 찾지 못했습니다. 원본을 다시 연결해 주세요.');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 1 || end - start > ANALYSIS_MAX_SECONDS) {
    throw new Error('영상 안에서 1~12초 길이의 분석 구간을 선택해 주세요.');
  }
  if (typeof videoId !== 'string' || !videoId.trim() || videoId.length > 200) throw new Error('영상 정보를 확인할 수 없습니다. 원본을 다시 연결해 주세요.');
  if (typeof accessCode !== 'string' || !accessCode.trim() || accessCode.length > 256) throw new Error('분석 이용 코드를 입력해 주세요.');
  if (consent !== true) throw new Error('선택한 장면을 분석 서버에 전송하는 데 동의해 주세요.');
  if (!globalThis.document?.createElement || !globalThis.URL?.createObjectURL) throw new Error('이 브라우저에서는 영상 장면을 준비할 수 없습니다. 최신 Safari 또는 Chrome에서 이용해 주세요.');
}

async function analysisExtractFrames({ blob, start, end, onProgress, signal }) {
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  let objectURL;
  try {
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    objectURL = URL.createObjectURL(blob);
    onProgress?.({ stage: 'preparing', message: '원본 영상에서 선택한 구간을 준비하고 있어요.' });
    await analysisWaitForVideo(video, {
      events: ['loadedmetadata', 'loadeddata', 'canplay', 'progress'],
      predicate: () => video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0,
      signal,
      message: '원본 영상을 여는 시간이 길어지고 있습니다. MP4 영상인지 확인한 뒤 다시 시도해 주세요.',
      trigger: () => { video.src = objectURL; video.load(); },
      timeout: 20_000,
    });
    if (!Number.isFinite(video.duration) || video.duration < 1 || start >= video.duration || end > video.duration + 0.05) {
      throw new Error('선택한 구간이 영상 길이를 벗어납니다. 영상 안에서 1~12초 구간을 선택해 주세요.');
    }
    const scale = Math.min(1, ANALYSIS_LONG_EDGE / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('이 브라우저에서 영상 장면을 준비하지 못했습니다. Safari 또는 Chrome에서 다시 시도해 주세요.');
    const count = Math.min(ANALYSIS_MAX_FRAMES, Math.ceil((end - start) / ANALYSIS_FRAME_INTERVAL));
    const frames = [];
    for (let index = 0; index < count; index += 1) {
      analysisCheckSignal(signal);
      const target = start + index * ANALYSIS_FRAME_INTERVAL;
      if (target >= end || target >= video.duration) break;
      await analysisWaitForVideo(video, {
        events: ['seeked', 'loadeddata', 'canplay'],
        predicate: () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.1,
        signal,
        message: '이 장면을 불러오지 못했습니다. 다른 구간을 선택하거나 MP4 영상으로 다시 시도해 주세요.',
        trigger: () => { if (Math.abs(video.currentTime - target) > 0.001) video.currentTime = target; },
      });
      analysisCheckSignal(signal);
      let image;
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        image = canvas.toDataURL('image/jpeg', 0.6);
      } catch {
        throw new Error('이 장면을 이미지로 준비하지 못했습니다. 다른 구간이나 MP4 원본으로 다시 시도해 주세요.');
      }
      if (!image.startsWith('data:image/jpeg;base64,') || analysisByteLength(image) > ANALYSIS_FRAME_BYTES) {
        throw new Error('장면 이미지의 용량이 큽니다. 더 낮은 해상도의 MP4 원본으로 다시 시도해 주세요.');
      }
      // Some browsers quantize media time. Keep its measured value inside the
      // selected bounds without rounding a fractional start to an earlier time.
      frames.push({ time: Math.max(start, Math.min(end, video.currentTime)), image });
      onProgress?.({ stage: 'extracting', message: `분석할 장면을 준비하고 있어요. ${frames.length}/${count}`, current: frames.length, total: count });
    }
    if (frames.length < 2 || frames.some((frame, index) => index > 0 && frame.time <= frames[index - 1].time)) {
      throw new Error('분석에 필요한 연속 장면을 준비하지 못했습니다. 다른 1~12초 구간을 선택해 주세요.');
    }
    return frames;
  } finally {
    try { video.pause(); video.removeAttribute('src'); video.load(); }
    catch { /* An unsupported codec must not prevent resource cleanup. */ }
    canvas.width = 0;
    canvas.height = 0;
    if (objectURL) URL.revokeObjectURL(objectURL);
  }
}

export async function analyzeOriginalClip({ blob, start, end, videoId, accessCode, consent, onProgress, signal } = {}) {
  const request = { blob, start, end, videoId, accessCode, consent, onProgress, signal };
  analysisValidateRequest(request);
  const frames = await analysisExtractFrames(request);
  analysisCheckSignal(signal);
  const body = JSON.stringify({ frames, videoId, start, end, accessCode, consent: true });
  if (analysisByteLength(body) > ANALYSIS_PAYLOAD_BYTES) throw new Error('선택한 장면의 전송 용량이 큽니다. 더 짧은 구간을 선택해 주세요.');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 90_000);
  try {
    analysisCheckSignal(signal);
    onProgress?.({ stage: 'sending', message: `선택한 ${frames.length}개 장면을 분석 서버로 전송하고 있어요.`, current: frames.length, total: frames.length });
    const pendingResponse = fetch(ANALYSIS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      signal: controller.signal,
    });
    onProgress?.({ stage: 'analyzing', message: '분석 서버의 응답을 기다리고 있어요. 선수 식별이 어려운 장면은 평가를 보류합니다.' });
    const response = await pendingResponse;
    if (!analysisContentIsJSON(response)) throw analysisHTTPError(response.ok ? 404 : response.status);
    if (!response.ok) throw analysisHTTPError(response.status);
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error('분석 결과를 읽지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    const result = payload?.result;
    if (!result || typeof result.identified !== 'boolean' || typeof result.summary !== 'string' || !Array.isArray(result.observations) || !Array.isArray(result.limitations)) {
      throw new Error('분석 결과의 형식이 올바르지 않습니다. 잠시 후 다시 시도해 주세요.');
    }
    analysisCheckSignal(signal);
    onProgress?.({ stage: 'complete', message: result.identified ? '선택한 구간의 관찰 결과를 받았어요.' : '선수 식별이 어려워 평가를 보류했어요.' });
    return payload;
  } catch (error) {
    if (signal?.aborted) throw analysisCancelledError();
    if (timedOut) throw new Error('분석 서버의 응답이 늦어지고 있습니다. 원본은 보관되어 있으니 잠시 후 다시 시도해 주세요.');
    if (error instanceof TypeError) throw new Error('분석 서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
