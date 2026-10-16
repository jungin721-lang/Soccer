import { makeAutoScanPlan, selectAutoSegments } from './auto-analysis.js';

// Only sampled still images and selected short segments go to the server. The original
// video stays in the browser, and credentials for the AI provider never belong
// in this module or the generated static page.
const ANALYSIS_ENDPOINT = '/api/analysis';
const ANALYSIS_MAX_SECONDS = 12;
const ANALYSIS_MAX_FRAMES = 24;
const ANALYSIS_FRAME_INTERVAL = 0.5;
const ANALYSIS_FRAME_BYTES = 250_000;
const ANALYSIS_PAYLOAD_BYTES = 3_000_000;
const ANALYSIS_LONG_EDGE = 1280;

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

function analysisHTTPError(status, code) {
  if (code === 'analysis_credentials_rejected') return new Error('OpenAI가 서버의 API 키 인증을 거절했습니다. 운영자가 Netlify에 등록한 전체 API 키와 호출 권한을 확인해야 합니다.');
  if (code === 'analysis_timeout') return new Error('AI 응답 시간이 초과됐습니다. 완료된 결과는 보관되어 있으니 이어서 분석할 수 있습니다.');
  if (code === 'analysis_invalid_result') return new Error('장면 근거를 확인할 수 있는 AI 응답을 받지 못했습니다. 이번 구간의 관찰을 만들지 않았으며 완료된 결과는 보관됩니다.');
  if (status === 401 || status === 403) return new Error('분석 이용 코드가 올바르지 않습니다. 코드를 확인한 뒤 다시 시도해 주세요.');
  if (status === 404 || status === 405) return new Error('이 사이트에 분석 서버가 연결되지 않았습니다. 원본 저장은 완료되어 있으며, 분석 서버 연결 후 평가할 수 있습니다.');
  if (status === 413) return new Error('장면 전송 용량이 허용 크기를 넘었습니다. 완료된 결과는 보관되며 다시 시도할 수 있습니다.');
  if (status === 429) return new Error('지금은 분석 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
  if (status === 503) return new Error('분석 서버 설정이 아직 완료되지 않았습니다. 원본 저장과 재생은 계속 이용할 수 있습니다.');
  if (status === 400 || status === 422) return new Error('영상 장면을 분석 요청으로 처리하지 못했습니다. 완료된 결과는 보관되며 다시 시도할 수 있습니다.');
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

function analysisValidateOriginal({ blob, videoId, accessCode, consent, signal }) {
  analysisCheckSignal(signal);
  if (!(blob instanceof Blob) || blob.size <= 0) throw new Error('분석할 원본 파일을 이 기기에서 찾지 못했습니다. 원본을 다시 연결해 주세요.');
  if (typeof videoId !== 'string' || !videoId.trim() || videoId.length > 200) throw new Error('영상 정보를 확인할 수 없습니다. 원본을 다시 연결해 주세요.');
  if (typeof accessCode !== 'string' || !accessCode.trim() || accessCode.length > 256) throw new Error('분석 이용 코드를 입력해 주세요.');
  if (consent !== true) throw new Error('선택한 장면을 분석 서버에 전송하는 데 동의해 주세요.');
  if (!globalThis.document?.createElement || !globalThis.URL?.createObjectURL) throw new Error('이 브라우저에서는 영상 장면을 준비할 수 없습니다. 최신 Safari 또는 Chrome에서 이용해 주세요.');
}

function analysisValidateRequest(request) {
  const { start, end, referenceTime } = request;
  // Validate timestamps before accessing the browser, including in a plain Node
  // environment where only request-boundary tests run.
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 1 || end - start > ANALYSIS_MAX_SECONDS) {
    throw new Error('영상 안에서 1~12초 길이의 분석 구간을 선택해 주세요.');
  }
  if (referenceTime !== undefined && (!Number.isFinite(referenceTime) || referenceTime < start || referenceTime >= end)) throw new Error('선수 식별 근거의 시각이 분석 구간과 일치하지 않습니다.');
  analysisValidateOriginal(request);
}

async function analysisOpenVideo(blob, signal, onProgress) {
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  let objectURL;
  const close = () => {
    try { video.pause(); video.removeAttribute('src'); video.load(); }
    catch { /* An unsupported codec must not prevent resource cleanup. */ }
    canvas.width = 0;
    canvas.height = 0;
    if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
  };
  try {
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    objectURL = URL.createObjectURL(blob);
    onProgress?.({ stage: 'preparing', message: '원본 영상의 길이와 재생 상태를 확인하고 있어요.' });
    await analysisWaitForVideo(video, {
      events: ['loadedmetadata', 'loadeddata', 'canplay', 'progress'],
      predicate: () => video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0,
      signal,
      message: '원본 영상을 여는 시간이 길어지고 있습니다. MP4 영상인지 확인한 뒤 다시 시도해 주세요.',
      trigger: () => { video.src = objectURL; video.load(); },
      timeout: 20_000,
    });
    makeAutoScanPlan(video.duration);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('이 브라우저에서 영상 장면을 준비하지 못했습니다. Safari 또는 Chrome에서 다시 시도해 주세요.');
    return { video, canvas, context, duration: video.duration, close };
  } catch (error) {
    close();
    throw error;
  }
}

async function analysisCaptureFrame(session, target, { signal, longEdge = ANALYSIS_LONG_EDGE, maxBytes = ANALYSIS_FRAME_BYTES, start = 0, end = session.duration } = {}) {
  const { video, canvas, context } = session;
  analysisCheckSignal(signal);
  const needsSeek = Math.abs(video.currentTime - target) > 0.001;
  let seekCompleted = !needsSeek;
  const markSeeked = () => { seekCompleted = true; };
  if (needsSeek) video.addEventListener('seeked', markSeeked);
  try {
    await analysisWaitForVideo(video, {
      events: ['seeked', 'loadeddata', 'canplay'],
      predicate: () => seekCompleted && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.1,
      signal,
      message: '영상 장면을 불러오지 못했습니다. 완료된 결과는 보관되며 다시 시도할 수 있습니다.',
      trigger: () => { if (needsSeek) video.currentTime = target; },
    });
  } finally {
    if (needsSeek) video.removeEventListener('seeked', markSeeked);
  }
  analysisCheckSignal(signal);
  let image;
  let edge = longEdge;
  do {
    const scale = Math.min(1, edge / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      image = canvas.toDataURL('image/jpeg', 0.6);
    } catch {
      throw new Error('이 장면을 이미지로 준비하지 못했습니다. MP4 원본으로 다시 시도해 주세요.');
    }
    if (!image.startsWith('data:image/jpeg;base64,')) throw new Error('영상 장면을 JPEG 이미지로 준비하지 못했습니다.');
    if (analysisByteLength(image) <= maxBytes) break;
    edge = Math.floor(edge * 0.8);
  } while (edge >= 256);
  if (analysisByteLength(image) > maxBytes) throw new Error('장면 이미지의 용량을 줄이지 못했습니다. 완료된 결과는 보관되며 다시 시도할 수 있습니다.');
  return { time: Math.max(start, Math.min(end, video.currentTime)), image };
}

async function analysisExtractFrames({ blob, start, end, referenceTime, onProgress, signal }) {
  const session = await analysisOpenVideo(blob, signal, onProgress);
  try {
    if (start >= session.duration || end > session.duration + 0.05) throw new Error('자동으로 준비한 구간이 영상 길이와 일치하지 않습니다. 처음부터 다시 분석해 주세요.');
    const count = Math.min(ANALYSIS_MAX_FRAMES, Math.ceil((end - start) / ANALYSIS_FRAME_INTERVAL));
    const times = Array.from({ length: count }, (_, index) => start + index * ANALYSIS_FRAME_INTERVAL).filter(time => time < end && time < session.duration);
    if (referenceTime !== undefined) {
      const closest = times.reduce((best, time, index) => Math.abs(time - referenceTime) < Math.abs(times[best] - referenceTime) ? index : best, 0);
      times[closest] = referenceTime;
      times.sort((a, b) => a - b);
    }
    const frames = [];
    for (let index = 0; index < times.length; index += 1) {
      analysisCheckSignal(signal);
      const target = times[index];
      const imageBudget = referenceTime === undefined ? Math.floor(2_700_000 / times.length) : (target === referenceTime ? ANALYSIS_FRAME_BYTES : Math.floor((2_700_000 - ANALYSIS_FRAME_BYTES) / (times.length - 1)));
      frames.push(await analysisCaptureFrame(session, target, { signal, start, end, maxBytes: Math.min(ANALYSIS_FRAME_BYTES, imageBudget) }));
      onProgress?.({ stage: 'extracting', message: `분석할 장면을 준비하고 있어요. ${frames.length}/${times.length}`, current: frames.length, total: times.length });
    }
    if (frames.length < 2 || frames.some((frame, index) => index > 0 && frame.time <= frames[index - 1].time)) {
      throw new Error('자동 분석에 필요한 연속 장면을 준비하지 못했습니다. 완료된 결과는 보관되어 있으니 다시 시도해 주세요.');
    }
    return frames;
  } finally {
    session.close();
  }
}

async function analysisPost(payload, signal, onProgress) {
  analysisCheckSignal(signal);
  const body = JSON.stringify(payload);
  if (analysisByteLength(body) > ANALYSIS_PAYLOAD_BYTES) throw new Error('자동 분석 장면의 전송 용량을 줄이지 못했습니다. 완료된 결과는 보관되어 있으니 다시 시도해 주세요.');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 90_000);
  try {
    analysisCheckSignal(signal);
    onProgress?.({ stage: 'sending', message: `${payload.frames.length}개 장면을 분석 서버로 전송하고 있어요.`, current: payload.frames.length, total: payload.frames.length });
    const pendingResponse = fetch(ANALYSIS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      signal: controller.signal,
    });
    onProgress?.({ stage: 'analyzing', message: '분석 서버의 응답을 기다리고 있어요. 선수 식별이 어려운 장면은 평가를 보류합니다.' });
    const response = await pendingResponse;
    if (!analysisContentIsJSON(response)) throw analysisHTTPError(response.ok ? 404 : response.status);
    if (!response.ok) {
      let serverCode;
      try { serverCode = (await response.json()).code; } catch {}
      throw analysisHTTPError(response.status, serverCode);
    }
    let responseData;
    try { responseData = await response.json(); }
    catch { throw new Error('분석 결과를 읽지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    analysisCheckSignal(signal);
    return responseData;
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

function analysisValidText(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function analysisValidateClipResponse(payload, start, end) {
  const result = payload?.result;
  const skills = ['touch', 'pass', 'dribble', 'shoot', 'defend', 'scan', 'move', 'team'];
  if (!result || typeof result.identified !== 'boolean' || !analysisValidText(result.summary, 1800) || !Array.isArray(result.observations) || result.observations.length > 6 || !Array.isArray(result.limitations) || result.limitations.length < 1 || result.limitations.length > 8 || result.limitations.some(item => !analysisValidText(item, 500)) || !analysisValidText(result.nextAction, 1200) || !analysisValidText(payload.model, 100)) {
    throw new Error('분석 결과의 형식이 올바르지 않습니다. 완료된 결과는 보관되며 다시 시도할 수 있습니다.');
  }
  if (!result.identified && result.observations.length) throw new Error('선수 식별 결과가 일치하지 않아 이 구간의 관찰을 저장하지 않았습니다.');
  for (const item of result.observations) {
    if (!item || !skills.includes(item.skill) || !['strength', 'focus', 'note'].includes(item.type) || !['low', 'medium', 'high'].includes(item.confidence) || !Number.isInteger(item.time) || item.time < Math.ceil(start) || item.time > Math.floor(end) || !analysisValidText(item.note, 1200)) throw new Error('장면 근거를 확인할 수 없어 이 구간의 관찰을 저장하지 않았습니다.');
  }
  return payload;
}

export async function analyzeOriginalClip({ blob, start, end, referenceTime, videoId, accessCode, consent, onProgress, signal } = {}) {
  const request = { blob, start, end, referenceTime, videoId, accessCode, consent, onProgress, signal };
  analysisValidateRequest(request);
  const frames = await analysisExtractFrames(request);
  const payload = analysisValidateClipResponse(await analysisPost({ frames, videoId, start, end, accessCode, consent: true }, signal, onProgress), start, end);
  onProgress?.({ stage: 'complete', message: payload.result.identified ? '선택한 구간의 관찰 결과를 받았어요.' : '선수 식별이 어려워 평가를 보류했어요.' });
  return payload;
}

function analysisValidateDiscovery(payload, frames) {
  if (!payload || payload.mode !== 'discover' || !Array.isArray(payload.detections) || payload.detections.length > frames.length || !analysisValidText(payload.summary, 1500) || !Array.isArray(payload.limitations) || payload.limitations.length > 8 || payload.limitations.some(item => !analysisValidText(item, 500)) || !analysisValidText(payload.model, 100)) {
    throw new Error('선수 탐색 결과의 형식이 올바르지 않습니다. 완료된 탐색 기록은 보관됩니다.');
  }
  const used = new Set();
  const detections = payload.detections.map(item => {
    if (!item || !Number.isFinite(item.time) || !['medium', 'high'].includes(item.confidence) || !analysisValidText(item.reason, 500)) throw new Error('선수 식별 근거를 확인할 수 없어 이번 탐색 결과를 저장하지 않았습니다.');
    let index = frames.findIndex(frame => frame.time === item.time);
    if (index < 0) index = frames.findIndex(frame => Math.abs(frame.time - item.time) <= 0.15);
    if (index < 0 || used.has(index)) throw new Error('선수 탐색 시각이 보낸 장면과 일치하지 않아 이번 탐색 결과를 저장하지 않았습니다.');
    used.add(index);
    return { time: frames[index].time, confidence: item.confidence, reason: item.reason.trim() };
  }).sort((a, b) => a.time - b.time);
  return { ...payload, detections };
}

function analysisCopyReport(report) {
  return { ...report, detections: report.detections.map(item => ({ ...item })), segments: report.segments.map(item => ({ ...item })) };
}

function analysisInitialReport(plan, snapshot) {
  const report = { duration: plan.duration, sampleCount: plan.sampleCount, sampledCount: 0, interval: plan.interval, detectedCount: 0, selectedCount: 0, completedCount: 0, status: 'scanning', detections: [], segments: [], message: '전체 시간대 표본 탐색을 시작합니다.', model: '' };
  if (!snapshot) return report;
  const valid = Math.abs(snapshot.duration - plan.duration) <= 0.01 && snapshot.sampleCount === plan.sampleCount && Number.isFinite(snapshot.interval) && Math.abs(snapshot.interval - plan.interval) <= 0.000001 && Number.isInteger(snapshot.sampledCount) && snapshot.sampledCount >= 0 && snapshot.sampledCount <= plan.sampleCount && Array.isArray(snapshot.detections) && snapshot.detections.length <= snapshot.sampledCount && snapshot.detections.every((item, index, items) => item && Number.isFinite(item.time) && ['medium', 'high'].includes(item.confidence) && analysisValidText(item.reason, 500) && plan.times.slice(0, snapshot.sampledCount).some(time => Math.abs(time - item.time) <= 0.15) && (index === 0 || item.time > items[index - 1].time)) && Array.isArray(snapshot.segments) && snapshot.segments.length <= 6 && Number.isInteger(snapshot.completedCount) && snapshot.completedCount >= 0 && snapshot.completedCount <= snapshot.segments.length;
  if (!valid) throw new Error('이전 자동 분석 기록이 이 원본 영상과 일치하지 않습니다. 새 분석으로 다시 시작해 주세요.');
  const expected = snapshot.sampledCount === plan.sampleCount ? selectAutoSegments(snapshot.detections, plan.duration) : [];
  const selectionPending = snapshot.segments.length === 0 && snapshot.completedCount === 0;
  if (!selectionPending && (snapshot.segments.length !== expected.length || snapshot.segments.some((item, index) => !item || Math.abs(item.start - expected[index].start) > 0.000001 || Math.abs(item.end - expected[index].end) > 0.000001))) throw new Error('이전 자동 분석 구간을 확인하지 못했습니다. 새 분석으로 다시 시작해 주세요.');
  report.sampledCount = snapshot.sampledCount;
  report.detections = snapshot.detections.map(item => ({ time: item.time, confidence: item.confidence, reason: item.reason }));
  report.detectedCount = report.detections.length;
  report.segments = expected;
  report.selectedCount = expected.length;
  report.completedCount = snapshot.completedCount;
  report.model = typeof snapshot.model === 'string' && snapshot.model.length <= 100 ? snapshot.model : '';
  report.message = `저장된 표본 ${report.sampledCount}개와 구간 결과 ${report.completedCount}개를 유지하며 이어서 시작합니다.`;
  return report;
}

export async function analyzeOriginalVideo({ blob, videoId, accessCode, consent, onProgress, onScan, onClip, signal, scanSnapshot } = {}) {
  analysisValidateOriginal({ blob, videoId, accessCode, consent, signal });
  if (typeof onScan !== 'function' || typeof onClip !== 'function') throw new Error('분석 결과 저장 기능을 연결하지 못했습니다. 페이지를 다시 연 뒤 시도해 주세요.');
  let report;
  let session;
  try {
    session = await analysisOpenVideo(blob, signal, onProgress);
    const plan = makeAutoScanPlan(session.duration);
    report = analysisInitialReport(plan, scanSnapshot);
    await onScan(analysisCopyReport(report));
    // One decoder and canvas are reused throughout discovery. At most twelve
    // small JPEGs exist at once; no complete video or all scan frames are read.
    while (report.sampledCount < plan.sampleCount) {
      analysisCheckSignal(signal);
      const frames = [];
      let imageBytes = 0;
      for (let index = report.sampledCount; index < plan.sampleCount && frames.length < 12; index += 1) {
        const frame = await analysisCaptureFrame(session, plan.times[index], { signal, longEdge: 1280 });
        const frameBytes = analysisByteLength(frame.image);
        if (frames.length && imageBytes + frameBytes > 2_000_000) break;
        if (frames.length && frame.time <= frames[frames.length - 1].time) throw new Error('영상의 시간순 표본을 준비하지 못했습니다. 완료된 결과는 보관됩니다.');
        frames.push(frame);
        imageBytes += frameBytes;
        onProgress?.({ stage: 'scanning', message: `전체 시간대 표본 탐색 · 장면 ${index + 1}/${plan.sampleCount} 준비`, current: index + 1, total: plan.sampleCount });
      }
      const payload = analysisValidateDiscovery(await analysisPost({ mode: 'discover', videoId, start: 0, end: plan.duration, frames, accessCode, consent: true }, signal, onProgress), frames);
      // Advance only after a valid response. A failed paid request is never
      // retried automatically, and its sample indices remain pending on resume.
      report.sampledCount += frames.length;
      report.detections.push(...payload.detections);
      report.detectedCount = report.detections.length;
      report.model = payload.model;
      report.message = `전체 시간대 표본 ${report.sampledCount}/${plan.sampleCount}개 확인 · 남색 11번 식별 표본 ${report.detectedCount}개`;
      await onScan(analysisCopyReport(report));
      onProgress?.({ stage: 'scanning', message: report.message, current: report.sampledCount, total: plan.sampleCount });
    }
    session.close();
    session = null;
    analysisCheckSignal(signal);
    if (!report.detections.length) {
      report.status = 'not_found';
      report.message = `${report.sampleCount}개 표본에서 남색 상의와 등번호 11을 함께 확인하지 못해 평가를 보류했습니다. 영상에 선수가 없다는 뜻은 아닙니다.`;
      await onScan(analysisCopyReport(report));
      onProgress?.({ stage: 'complete', message: report.message, current: report.sampledCount, total: report.sampleCount });
      return analysisCopyReport(report);
    }
    report.segments = selectAutoSegments(report.detections, report.duration);
    report.selectedCount = report.segments.length;
    report.status = 'analyzing';
    report.message = `식별 근거가 있는 ${report.selectedCount}개 구간을 자동으로 골랐습니다. ${report.completedCount}개 결과가 저장되어 있습니다.`;
    await onScan(analysisCopyReport(report));
    for (let index = report.completedCount; index < report.segments.length; index += 1) {
      analysisCheckSignal(signal);
      const segment = report.segments[index];
      const center = (segment.start + segment.end) / 2;
      const reference = report.detections.filter(item => item.time >= segment.start && item.time < segment.end).sort((a, b) => Number(b.confidence === 'high') - Number(a.confidence === 'high') || Math.abs(a.time - center) - Math.abs(b.time - center))[0];
      onProgress?.({ stage: 'analyzing', message: `자동 선택 구간 ${index + 1}/${report.selectedCount} 분석을 시작합니다.`, current: index, total: report.selectedCount });
      const payload = await analyzeOriginalClip({ blob, ...segment, referenceTime: reference?.time, videoId, accessCode, consent: true, signal, onProgress: progress => onProgress?.({ ...progress, message: `자동 선택 구간 ${index + 1}/${report.selectedCount} · ${progress.message}` }) });
      // Persist each real result before beginning the next paid request.
      await onClip({ ...segment, result: payload.result, model: payload.model });
      report.completedCount += 1;
      report.model = payload.model;
      report.message = `자동 선택 구간 ${report.completedCount}/${report.selectedCount}개의 결과를 저장했습니다.`;
      await onScan(analysisCopyReport(report));
    }
    report.status = 'completed';
    report.message = `전체 시간대의 ${report.sampleCount}개 표본을 탐색하고 자동 선택한 ${report.completedCount}개 구간을 확인했습니다. 표본 사이의 모든 플레이를 연속 분석한 결과는 아닙니다.`;
    await onScan(analysisCopyReport(report));
    onProgress?.({ stage: 'complete', message: report.message, current: report.completedCount, total: report.selectedCount });
    return analysisCopyReport(report);
  } catch (originalError) {
    const error = signal?.aborted ? analysisCancelledError() : originalError;
    if (report) {
      report.status = signal?.aborted || error.name === 'AbortError' ? 'cancelled' : (report.completedCount > 0 ? 'partial' : 'failed');
      report.message = report.status === 'cancelled' ? `분석을 중단했습니다. 확인한 표본 ${report.sampledCount}개와 저장된 구간 결과 ${report.completedCount}개는 유지됩니다.` : `${error.message} 확인한 표본 ${report.sampledCount}개와 저장된 구간 결과 ${report.completedCount}개는 유지됩니다.`;
      report.message = report.message.slice(0, 1500);
      error.scanReport = analysisCopyReport(report);
      try { await onScan(analysisCopyReport(report)); }
      catch { /* Preserve the original failure and already persisted clip results. */ }
    }
    throw error;
  } finally {
    session?.close();
  }
}
