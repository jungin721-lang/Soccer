import { validateChatPackFile, validateChatPackTarget } from './chat-pack.js';

// Decode the original through a Blob URL. Never read or slice the source file:
// each result is a new, silent video encoded from a continuous source interval.
export const CLIP_LIMITS = Object.freeze({
  maxSourceBytes: 8 * 1024 ** 3,
  maxClipBytes: 24 * 1024 ** 2,
  chunkSeconds: 60,
  overlapSeconds: 5,
  maxLongEdge: 1920,
  frameRate: 30,
});

const VIDEO_BIT_RATE = 2_200_000;
const MAX_SOURCE_SECONDS = 86400;
const MAX_CLIP_SECONDS = CLIP_LIMITS.chunkSeconds + CLIP_LIMITS.overlapSeconds;
const MIME_CANDIDATES = [
  ['video/mp4;codecs=avc1.42E01E', 'mp4'],
  ['video/mp4;codecs=avc1.42001E', 'mp4'],
  ['video/mp4;codecs=avc1', 'mp4'],
  // Safari versions can advertise only the generic MP4 recorder. Its returned
  // MIME may identify H.264; otherwise the manifest leaves the codec unknown.
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9', 'webm'],
  ['video/webm;codecs=vp8', 'webm'],
];

function clipError(code, message) {
  const error = new Error(message);
  error.code = code;
  if (code === 'aborted') error.name = 'AbortError';
  return error;
}

function checkSignal(signal) {
  if (signal?.aborted) throw clipError('aborted', '영상 만들기를 취소했습니다. 같은 구간을 다시 만들 수 있습니다.');
}

function checkForeground() {
  if (globalThis.document?.hidden) throw clipError('backgrounded', '화면이 꺼지거나 다른 앱으로 이동해 중단했습니다. 화면을 켜 두고 같은 구간을 다시 만들어 주세요.');
}

function checkDuration(duration) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SOURCE_SECONDS) {
    throw clipError('invalid_duration', '24시간 이하의 재생 가능한 원본 영상을 선택해 주세요.');
  }
}

export function validateVideoClipFile(file) {
  return validateChatPackFile(file);
}

export function validateVideoClipTarget(target) {
  return validateChatPackTarget(target);
}

export function planVideoClips(duration, options = {}) {
  checkDuration(duration);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw clipError('invalid_options', '영상 구간 설정을 확인해 주세요.');
  const chunkSeconds = options.chunkSeconds === undefined ? CLIP_LIMITS.chunkSeconds : options.chunkSeconds;
  const overlapSeconds = options.overlapSeconds === undefined ? Math.min(CLIP_LIMITS.overlapSeconds, chunkSeconds / 2) : options.overlapSeconds;
  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0 || chunkSeconds > CLIP_LIMITS.chunkSeconds ||
      !Number.isFinite(overlapSeconds) || overlapSeconds < 0 || overlapSeconds >= chunkSeconds) {
    throw clipError('invalid_options', '구간 길이는 60초 이하, 겹치는 시간은 구간 길이보다 짧게 설정해 주세요.');
  }
  // Guard pathological sub-millisecond options before allocating an array.
  const count = Math.ceil(duration / chunkSeconds);
  if (count > MAX_SOURCE_SECONDS) throw clipError('invalid_options', '구간 길이를 늘려 주세요. 한 영상은 최대 86,400개 구간으로 나눌 수 있습니다.');
  return Array.from({ length: count }, (_, offset) => {
    const start = offset === 0 ? 0 : offset * chunkSeconds - overlapSeconds;
    const end = Math.min(duration, (offset + 1) * chunkSeconds);
    return { index: offset + 1, start, end, duration: end - start };
  });
}

export function formatClipTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw clipError('invalid_time', '영상 시간을 확인해 주세요.');
  const milliseconds = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(milliseconds)) throw clipError('invalid_time', '영상 시간을 확인해 주세요.');
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const rest = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

export function videoClipSupport() {
  const unavailable = reason => ({ supported: false, mimeType: null, extension: null, reason });
  if (typeof globalThis.document?.createElement !== 'function' || typeof globalThis.MediaRecorder !== 'function' ||
      typeof globalThis.MediaRecorder.isTypeSupported !== 'function' ||
      typeof globalThis.HTMLCanvasElement?.prototype?.captureStream !== 'function') {
    return unavailable('이 브라우저는 영상 만들기를 지원하지 않습니다. 최신 Chrome 또는 Safari에서 다시 시도해 주세요.');
  }
  let video;
  try { video = document.createElement('video'); } catch { return unavailable('이 브라우저에서 영상 재생 기능을 열지 못했습니다.'); }
  for (const [mimeType, extension] of MIME_CANDIDATES) {
    try {
      const playable = typeof video.canPlayType !== 'function' || video.canPlayType(mimeType);
      const h264Playable = mimeType !== 'video/mp4' || typeof video.canPlayType !== 'function' || video.canPlayType('video/mp4;codecs="avc1.42E01E"');
      if (MediaRecorder.isTypeSupported(mimeType) && playable && h264Playable) {
        return { supported: true, mimeType, extension };
      }
    } catch { /* Browser codec probes can throw for an unknown MIME string. */ }
  }
  return unavailable('이 브라우저에는 재생 가능한 MP4(H.264) 또는 WebM 영상 인코더가 없습니다. 최신 Chrome 또는 Safari에서 다시 시도해 주세요.');
}

function emitProgress(onProgress, phase, completed, total, extra = {}) {
  const message = phase === 'encoding' ? '화면을 켜 둔 채 영상을 만드는 중입니다.' : phase === 'complete' ? '영상 구간을 만들었습니다.' : '원본 영상 구간을 여는 중입니다.';
  try { onProgress?.({ phase, completed, total, message, fraction: total > 0 ? Math.min(1, completed / total) : 0, ...extra }); }
  catch { /* UI callbacks must not interrupt media cleanup. */ }
}

function waitVideo(video, { events, predicate, signal, timeout, code, message, trigger }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const event of events) video.removeEventListener(event, check);
      video.removeEventListener('error', failed);
      document.removeEventListener('visibilitychange', visibility);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (video.error) failed();
      else if (predicate()) finish();
    };
    const failed = () => finish(clipError('decode_failed', '원본 영상을 해독하지 못했습니다. 스마트폰에서 재생되는 MP4(H.264) 원본으로 다시 선택해 주세요.'));
    const aborted = () => finish(clipError('aborted', '영상 만들기를 취소했습니다. 같은 구간을 다시 만들 수 있습니다.'));
    const visibility = () => { if (document.hidden) finish(clipError('backgrounded', '다른 앱으로 이동해 중단했습니다. 화면을 켜 두고 같은 구간을 다시 만들어 주세요.')); };
    for (const event of events) video.addEventListener(event, check);
    video.addEventListener('error', failed);
    document.addEventListener('visibilitychange', visibility);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(clipError(code, message)), timeout);
    if (signal?.aborted) { aborted(); return; }
    if (document.hidden) { visibility(); return; }
    try { trigger?.(); check(); }
    catch { failed(); }
  });
}

async function openVideo(file, signal) {
  if (typeof globalThis.document?.createElement !== 'function' || typeof globalThis.URL?.createObjectURL !== 'function') {
    throw clipError('browser_unavailable', '영상 만들기는 기기의 웹 브라우저에서 실행해 주세요.');
  }
  checkForeground();
  const video = document.createElement('video');
  let objectURL;
  const close = () => {
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* Unsupported source codecs also need cleanup. */ }
    video.remove();
    if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
  };
  try {
    video.preload = 'auto';
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.playbackRate = 1;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;pointer-events:none;';
    document.body?.append(video);
    objectURL = URL.createObjectURL(file);
    await waitVideo(video, {
      events: ['loadedmetadata', 'durationchange', 'loadeddata'],
      predicate: () => video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0,
      signal, timeout: 15000, code: 'metadata_timeout',
      message: '영상 길이와 크기를 읽는 시간이 초과됐습니다. 원본 파일을 다시 선택해 주세요.',
      trigger: () => { video.src = objectURL; video.load(); },
    });
    checkDuration(video.duration);
    if (!Number.isSafeInteger(video.videoWidth) || !Number.isSafeInteger(video.videoHeight) || video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw clipError('invalid_dimensions', '원본 영상의 화면 크기를 읽지 못했습니다.');
    }
    return { video, close };
  } catch (error) { close(); throw error; }
}

export async function inspectClipSource(file, { signal } = {}) {
  checkSignal(signal);
  validateVideoClipFile(file);
  const opened = await openVideo(file, signal);
  try {
    checkSignal(signal);
    return { duration: opened.video.duration, width: opened.video.videoWidth, height: opened.video.videoHeight };
  } finally { opened.close(); }
}

function normalizeClip(clip) {
  if (!clip || typeof clip !== 'object' || !Number.isSafeInteger(clip.index) || clip.index < 1 ||
      !Number.isFinite(clip.start) || clip.start < 0 || !Number.isFinite(clip.end) || clip.end <= clip.start ||
      clip.end > MAX_SOURCE_SECONDS || clip.end - clip.start > MAX_CLIP_SECONDS + 1e-6 ||
      (clip.duration !== undefined && (!Number.isFinite(clip.duration) || Math.abs(clip.duration - (clip.end - clip.start)) > 1e-6))) {
    throw clipError('invalid_clip', '65초 이하의 올바른 영상 구간을 선택해 주세요.');
  }
  return { index: clip.index, start: clip.start, end: clip.end, duration: clip.end - clip.start };
}

async function seekVideo(video, start, signal) {
  const needsSeek = Math.abs(video.currentTime - start) > 0.0001;
  let seeked = !needsSeek;
  const markSeeked = () => { seeked = true; };
  if (needsSeek) video.addEventListener('seeked', markSeeked);
  try {
    await waitVideo(video, {
      events: ['seeked', 'loadeddata', 'canplay'],
      predicate: () => seeked && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - start) < 0.12,
      signal, timeout: 15000, code: 'seek_timeout',
      message: `${formatClipTime(start)} 구간을 여는 시간이 초과됐습니다. 같은 구간을 다시 시도해 주세요.`,
      trigger: () => { if (needsSeek) video.currentTime = start; },
    });
  } finally { if (needsSeek) video.removeEventListener('seeked', markSeeked); }
}

function encodeContinuous(video, canvas, context, stream, support, clip, signal, onProgress) {
  return new Promise((resolve, reject) => {
    let recorder;
    let settled = false;
    let stopping = false;
    let raf;
    let watchdog;
    let stopTimeout;
    let playTimeout;
    let startedAt;
    let lastFrameAt;
    let lastAdvanceAt;
    let bufferingAt;
    let lastSourceTime = video.currentTime;
    let lastProgressAt = -1;
    let bytes = 0;
    const chunks = [];
    const actualStart = video.currentTime;
    let actualEnd = actualStart;
    const timeMap = [{ clipSeconds: 0, sourceSeconds: actualStart }];
    let recordedSeconds = 0;
    const cleanup = () => {
      cancelAnimationFrame(raf);
      clearInterval(watchdog);
      clearTimeout(stopTimeout);
      clearTimeout(playTimeout);
      video.pause();
      video.removeEventListener('ended', ended);
      video.removeEventListener('error', decodeFailed);
      video.removeEventListener('waiting', buffering);
      video.removeEventListener('stalled', buffering);
      video.removeEventListener('playing', resumed);
      video.removeEventListener('seeking', discontinuity);
      video.removeEventListener('ratechange', rateChanged);
      document.removeEventListener('visibilitychange', visibility);
      signal?.removeEventListener('abort', aborted);
      if (recorder) {
        recorder.removeEventListener('dataavailable', data);
        recorder.removeEventListener('error', recorderFailed);
        recorder.removeEventListener('stop', stopped);
      }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        chunks.length = 0;
        try { if (recorder?.state !== 'inactive') recorder?.stop(); } catch { /* Tracks are stopped in the caller's finally block. */ }
        reject(error);
      } else resolve(result);
    };
    const fail = (code, message) => finish(clipError(code, message));
    const aborted = () => fail('aborted', '영상 만들기를 취소했습니다. 같은 구간을 다시 만들 수 있습니다.');
    const visibility = () => { if (document.hidden) fail('backgrounded', '다른 앱으로 이동하거나 화면이 꺼져 중단했습니다. 화면을 켜 두고 같은 구간을 다시 만들어 주세요.'); };
    const decodeFailed = () => fail('decode_failed', '구간 재생 중 원본 영상을 해독하지 못했습니다. 같은 구간을 다시 시도해 주세요.');
    const buffering = () => { bufferingAt ??= performance.now(); };
    const resumed = () => {
      if (bufferingAt !== undefined && performance.now() - bufferingAt > 350) {
        fail('playback_stalled', '원본 재생이 멈춰 중단했습니다. 화면을 켜 두고 같은 구간을 다시 만들어 주세요.');
      }
      bufferingAt = undefined;
    };
    const discontinuity = () => fail('playback_discontinuity', '구간 재생 시간이 갑자기 바뀌어 중단했습니다. 같은 구간을 다시 만들어 주세요.');
    const rateChanged = () => { if (video.playbackRate !== 1) discontinuity(); };
    const recorderFailed = () => fail('encode_failed', '영상 인코더가 중단됐습니다. 같은 구간을 다시 만들거나 다른 브라우저를 사용해 주세요.');
    const data = event => {
      if (settled || !event.data?.size) return;
      // Do not label bytes as another container even if a browser ignores the request.
      if (event.data.type && event.data.type.split(';')[0].toLowerCase() !== support.mimeType.split(';')[0].toLowerCase()) {
        fail('container_mismatch', '브라우저가 요청한 영상 형식을 만들지 못했습니다. 다른 브라우저에서 다시 시도해 주세요.');
        return;
      }
      bytes += event.data.size;
      if (bytes > CLIP_LIMITS.maxClipBytes) {
        fail('clip_too_large', '만든 영상이 24MiB를 넘었습니다. 화질을 자동으로 낮추지 않았습니다. 더 짧은 구간으로 다시 만들어 주세요.');
        return;
      }
      chunks.push(event.data);
    };
    const stopped = () => {
      if (settled) return;
      if (!stopping || actualEnd < clip.end - 0.12) {
        fail('truncated_clip', '영상이 구간 끝까지 만들어지지 않았습니다. 같은 구간을 다시 시도해 주세요.');
        return;
      }
      if (!bytes) { fail('empty_clip', '브라우저가 영상 데이터를 만들지 못했습니다. 다른 브라우저에서 다시 시도해 주세요.'); return; }
      const mimeType = recorder.mimeType || support.mimeType;
      if (mimeType.split(';')[0].toLowerCase() !== support.mimeType.split(';')[0].toLowerCase()) {
        fail('container_mismatch', '브라우저가 요청한 영상 형식을 만들지 못했습니다.');
        return;
      }
      const blob = new Blob(chunks, { type: mimeType });
      chunks.length = 0;
      if (blob.size > CLIP_LIMITS.maxClipBytes) { fail('clip_too_large', '만든 영상이 24MiB를 넘었습니다. 더 짧은 구간으로 다시 만들어 주세요.'); return; }
      finish(null, { blob, mimeType, actualStart, actualEnd, timeMap, recordedSeconds });
    };
    const stop = () => {
      if (settled || stopping) return;
      actualEnd = Math.min(video.currentTime, video.duration);
      if (actualEnd < clip.end - 0.12) { fail('truncated_clip', '영상이 구간 끝에 도달하지 못했습니다. 같은 구간을 다시 만들어 주세요.'); return; }
      stopping = true;
      video.pause();
      recordedSeconds = (performance.now() - startedAt) / 1000;
      timeMap.push({ clipSeconds: recordedSeconds, sourceSeconds: actualEnd });
      cancelAnimationFrame(raf);
      clearTimeout(playTimeout);
      clearInterval(watchdog);
      stopTimeout = setTimeout(() => fail('recorder_timeout', '영상 파일을 마무리하는 시간이 초과됐습니다. 같은 구간을 다시 만들어 주세요.'), 10000);
      try { recorder.stop(); } catch { recorderFailed(); }
    };
    const ended = () => {
      if (video.currentTime >= clip.end - 0.12) {
        try { context.drawImage(video, 0, 0, canvas.width, canvas.height); } catch { decodeFailed(); return; }
        stop();
      } else fail('truncated_clip', '원본 재생이 요청한 구간보다 일찍 끝났습니다. 같은 구간을 다시 만들어 주세요.');
    };
    const frame = now => {
      if (settled || stopping) return;
      if (now - lastFrameAt > 1000) { fail('playback_stalled', '영상 장면 처리가 멈춰 중단했습니다. 화면을 켜 두고 같은 구간을 다시 만들어 주세요.'); return; }
      lastFrameAt = now;
      if (video.error) { decodeFailed(); return; }
      if (video.readyState >= 2) {
        try { context.drawImage(video, 0, 0, canvas.width, canvas.height); }
        catch { fail('frame_unreadable', '원본 장면을 영상으로 옮기지 못했습니다. 같은 구간을 다시 시도해 주세요.'); return; }
      }
      const sourceTime = video.currentTime;
      const elapsed = (now - startedAt) / 1000;
      if (sourceTime < lastSourceTime - 0.12 || sourceTime - actualStart > elapsed + 0.35) { discontinuity(); return; }
      if (sourceTime > lastSourceTime + 0.001) {
        lastSourceTime = sourceTime;
        lastAdvanceAt = now;
      }
      if (elapsed >= timeMap.at(-1).clipSeconds + 1 && sourceTime > timeMap.at(-1).sourceSeconds) {
        timeMap.push({ clipSeconds: elapsed, sourceSeconds: sourceTime });
      }
      if (sourceTime >= clip.end) { stop(); return; }
      if (now - lastProgressAt >= 200) {
        lastProgressAt = now;
        emitProgress(onProgress, 'encoding', Math.max(0, sourceTime - clip.start), clip.duration, { sourceTime, start: clip.start, end: clip.end });
      }
      raf = requestAnimationFrame(frame);
    };
    try {
      checkSignal(signal);
      checkForeground();
      recorder = new MediaRecorder(stream, { mimeType: support.mimeType, videoBitsPerSecond: VIDEO_BIT_RATE });
      recorder.addEventListener('dataavailable', data);
      recorder.addEventListener('error', recorderFailed);
      recorder.addEventListener('stop', stopped);
      video.addEventListener('ended', ended);
      video.addEventListener('error', decodeFailed);
      video.addEventListener('waiting', buffering);
      video.addEventListener('stalled', buffering);
      video.addEventListener('playing', resumed);
      video.addEventListener('seeking', discontinuity);
      video.addEventListener('ratechange', rateChanged);
      document.addEventListener('visibilitychange', visibility);
      signal?.addEventListener('abort', aborted, { once: true });
      startedAt = performance.now();
      lastFrameAt = startedAt;
      lastAdvanceAt = startedAt;
      // Timeslices bound retained data; cumulative output is rejected at 24 MiB.
      recorder.start(1000);
      playTimeout = setTimeout(() => fail('play_timeout', '원본 재생을 시작하지 못했습니다. 화면을 켜 둔 상태에서 같은 구간을 다시 만들어 주세요.'), 8000);
      Promise.resolve(video.play()).then(() => { clearTimeout(playTimeout); }, () => fail('play_failed', '원본 영상을 재생하지 못했습니다. 같은 구간을 다시 시도해 주세요.'));
      watchdog = setInterval(() => {
        if (settled || stopping) return;
        const now = performance.now();
        if ((bufferingAt !== undefined && now - bufferingAt > 350) || now - lastAdvanceAt > 1000 || (now - startedAt) / 1000 - (video.currentTime - actualStart) > 0.75) {
          fail('playback_stalled', '원본 영상 재생이 지연돼 중단했습니다. 화면을 켜 두고 같은 구간을 다시 만들어 주세요.');
        } else if (now - startedAt > (clip.duration + 12) * 1000) {
          fail('encode_timeout', '영상 만들기 시간이 초과됐습니다. 같은 구간을 다시 만들어 주세요.');
        }
      }, 250);
      raf = requestAnimationFrame(frame);
    } catch (error) {
      finish(error?.code ? error : clipError('encode_failed', '이 브라우저에서 영상 인코더를 시작하지 못했습니다. 다른 브라우저에서 다시 시도해 주세요.'));
    }
  });
}

export async function createVideoClip(file, { clip, target, signal, onProgress } = {}) {
  checkSignal(signal);
  validateVideoClipFile(file);
  const cleanTarget = validateVideoClipTarget(target);
  const window = normalizeClip(clip);
  const support = videoClipSupport();
  if (!support.supported) throw clipError('unsupported_browser', support.reason);
  checkForeground();
  emitProgress(onProgress, 'opening', 0, window.duration);
  const opened = await openVideo(file, signal);
  let canvas;
  let stream;
  try {
    const { video } = opened;
    if (window.end > video.duration + 0.001 || window.start >= video.duration) throw clipError('invalid_clip', '선택한 구간이 원본 영상 길이를 벗어납니다. 원본을 다시 선택해 주세요.');
    await seekVideo(video, window.start, signal);
    checkSignal(signal);
    checkForeground();
    const scale = Math.min(1, CLIP_LIMITS.maxLongEdge / Math.max(video.videoWidth, video.videoHeight));
    // Even dimensions are accepted by H.264 encoders; at most one source pixel
    // of aspect-ratio rounding is introduced, with no crop or stretching box.
    const width = Math.max(2, Math.floor(video.videoWidth * scale / 2) * 2);
    const height = Math.max(2, Math.floor(video.videoHeight * scale / 2) * 2);
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw clipError('canvas_unavailable', '이 브라우저에서 영상 화면을 만들지 못했습니다.');
    context.drawImage(video, 0, 0, width, height);
    stream = canvas.captureStream(CLIP_LIMITS.frameRate);
    // Canvas streams contain video only. Never attach source or microphone audio.
    if (!stream.getVideoTracks().length || stream.getAudioTracks().length) throw clipError('invalid_capture', '소리 없는 영상 화면을 만들지 못했습니다.');
    const encoded = await encodeContinuous(video, canvas, context, stream, support, window, signal, onProgress);
    checkSignal(signal);
    checkForeground();
    const stamp = formatClipTime(window.start).replaceAll(':', '-').replace('.', '-');
    const filename = `clip-${String(window.index).padStart(2, '0')}-${stamp}.${support.extension}`;
    const output = new File([encoded.blob], filename, { type: encoded.mimeType });
    const codec = encoded.mimeType.match(/codecs\s*=\s*"?([^;"\s]+)/i)?.[1] ?? null;
    const manifest = {
      version: 1,
      kind: 'continuous-video-clip',
      source: {
        duration: video.duration, width: video.videoWidth, height: video.videoHeight,
        requested: { start: window.start, end: window.end, duration: window.duration },
        actual: { start: encoded.actualStart, end: encoded.actualEnd, duration: encoded.actualEnd - encoded.actualStart },
        timeMap: encoded.timeMap,
      },
      clip: { index: window.index },
      output: {
        filename, mimeType: encoded.mimeType, codec, width, height,
        frameRate: CLIP_LIMITS.frameRate, frameRateRequested: CLIP_LIMITS.frameRate, frameRateMeasured: null,
        videoBitsPerSecond: VIDEO_BIT_RATE, videoBitsPerSecondRequested: VIDEO_BIT_RATE, measurementsVerified: false,
        bytes: output.size, durationSeconds: encoded.recordedSeconds, durationSource: 'recording_wall_clock',
      },
      processing: { method: 'browser-canvas-mediarecorder', realTime: true, soundOmitted: true },
      target: cleanTarget,
      analysis: { performed: false, playerIdentified: false },
      limits: { ...CLIP_LIMITS },
    };
    emitProgress(onProgress, 'complete', window.duration, window.duration, { sourceTime: encoded.actualEnd, start: window.start, end: window.end });
    return { file: output, manifest };
  } finally {
    if (stream) for (const track of stream.getTracks()) { try { track.stop(); } catch { /* Stop every track even if one browser track throws. */ } }
    if (canvas) { canvas.width = 0; canvas.height = 0; canvas.remove(); }
    opened.close();
  }
}
