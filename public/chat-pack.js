import { KIT_LABELS, validateTarget } from './growth-domain.js';

// This module reads only browser-decoded frames. It never uploads, stores, or
// reads the complete original file into JavaScript memory.
export const CHAT_PACK_MAX_BYTES = 8 * 1024 ** 2;
const CHAT_PACK_MAX_SOURCE_BYTES = 8 * 1024 ** 3;
const CHAT_PACK_NOTICE = '자동 시간표본 · 선수 미식별 · AI 분석 아님';
const CHAT_PACK_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', '3gp', '3g2']);
const CHAT_PACK_MIMES = new Set(['', 'application/octet-stream', 'video/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm', 'video/3gpp', 'video/3gpp2']);

function chatPackError(code, message) {
  const error = new Error(message);
  error.code = code;
  if (code === 'aborted') error.name = 'AbortError';
  return error;
}

function chatPackCheckSignal(signal) {
  if (signal?.aborted) throw chatPackError('aborted', '자료 만들기를 취소했습니다. 원본 영상은 기기에 그대로 있습니다.');
}

export function validateChatPackTarget(target) {
  try { return validateTarget(target); }
  catch { throw chatPackError('invalid_target', '유니폼 색상, 등번호 1~99번, 나이 5~18세를 확인해 주세요.'); }
}

export function validateChatPackFile(file) {
  if (!(file instanceof Blob) || typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size <= 0) {
    throw chatPackError('invalid_file', '스마트폰에 저장된 원본 영상 파일을 선택해 주세요.');
  }
  if (file.size > CHAT_PACK_MAX_SOURCE_BYTES) throw chatPackError('file_too_large', '8GiB 이하의 원본 영상을 선택해 주세요. 이 과정은 원본을 서버에 올리지 않습니다.');
  const extension = file.name.split('.').at(-1).toLowerCase();
  const type = file.type.toLowerCase().split(';')[0].trim();
  if (!CHAT_PACK_EXTENSIONS.has(extension) || !CHAT_PACK_MIMES.has(type)) {
    throw chatPackError('unsupported_file', 'MP4, MOV, M4V, WebM 또는 3GP 원본 영상을 선택해 주세요.');
  }
  return { size: file.size, type, extension };
}

export function planChatSamples(duration, { sampleSet = 0 } = {}) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw chatPackError('invalid_duration', '영상 길이를 읽지 못했습니다. 24시간 이하의 재생 가능한 원본을 선택해 주세요.');
  if (!Number.isInteger(sampleSet) || sampleSet < 0 || sampleSet > 2) throw chatPackError('invalid_sample_set', '시간표본 묶음은 1~3번 중에서 선택해 주세요.');
  const count = Math.min(6, Math.ceil(duration / 3));
  const binLength = duration / count;
  const length = Math.min(3, duration / count);
  const frames = Math.min(6, Math.max(1, Math.floor(length / 0.08)));
  const margin = Math.min(0.04, length / 20);
  return Array.from({ length: count }, (_, index) => {
    // A second set changes time positions within the same evenly sized bins;
    // it does not imply that the target player was found at those positions.
    const start = index * binLength + (binLength - length) * [0.2, 0.5, 0.8][sampleSet];
    const end = Math.min(duration, start + length);
    const times = Array.from({ length: frames }, (_, frame) => frames === 1 ? start : start + frame * (end - start - margin) / (frames - 1));
    return { index: index + 1, start, end, times };
  });
}

function chatPackClock(time) {
  const milliseconds = Math.max(0, Math.round(time * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

function chatPackWaitVideo(video, { events, predicate, signal, timeout, code, message, trigger }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const name of events) video.removeEventListener(name, check);
      video.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (video.error) failed();
      else if (predicate()) finish();
    };
    const failed = () => finish(chatPackError('decode_failed', '이 브라우저에서 원본 영상을 해독하지 못했습니다. 스마트폰에서 재생되는 MP4(H.264) 영상으로 다시 선택해 주세요.'));
    const aborted = () => finish(chatPackError('aborted', '자료 만들기를 취소했습니다. 원본 영상은 기기에 그대로 있습니다.'));
    for (const name of events) video.addEventListener(name, check);
    video.addEventListener('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(chatPackError(code, message)), timeout);
    if (signal?.aborted) { aborted(); return; }
    try { trigger?.(); check(); }
    catch { finish(chatPackError('decode_failed', '영상 장면을 열지 못했습니다. 원본 파일을 다시 선택해 주세요.')); }
  });
}

async function chatPackOpenVideo(file, signal) {
  const video = document.createElement('video');
  let objectURL;
  const close = () => {
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* Cleanup must also work for unsupported codecs. */ }
    video.remove();
    if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
  };
  try {
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    // Attachment helps iOS Safari decode seeked frames without starting playback.
    video.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;pointer-events:none;';
    document.body?.append(video);
    objectURL = URL.createObjectURL(file);
    await chatPackWaitVideo(video, {
      events: ['loadedmetadata', 'durationchange', 'loadeddata'],
      predicate: () => video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0,
      signal, timeout: 15000, code: 'metadata_timeout',
      message: '영상 길이와 크기를 읽는 시간이 초과됐습니다. 화면을 켜 둔 상태에서 원본을 다시 선택해 주세요.',
      trigger: () => { video.src = objectURL; video.load(); },
    });
    planChatSamples(video.duration);
    await chatPackWaitVideo(video, {
      events: ['loadeddata', 'canplay', 'progress'], predicate: () => video.readyState >= 2,
      signal, timeout: 15000, code: 'decode_timeout',
      message: '첫 영상 장면을 해독하는 시간이 초과됐습니다. 스마트폰에서 재생되는 MP4 원본으로 다시 선택해 주세요.',
    });
    return { video, close };
  } catch (error) { close(); throw error; }
}

async function chatPackSeek(video, time, signal) {
  chatPackCheckSignal(signal);
  const needsSeek = Math.abs(video.currentTime - time) > 0.0001;
  let seeked = !needsSeek;
  const markSeeked = () => { seeked = true; };
  if (needsSeek) video.addEventListener('seeked', markSeeked);
  try {
    await chatPackWaitVideo(video, {
      events: ['seeked', 'loadeddata', 'canplay'],
      predicate: () => seeked && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - time) < 0.1,
      signal, timeout: 12000, code: 'seek_timeout',
      message: `${chatPackClock(time)} 장면을 여는 시간이 초과됐습니다. 화면을 켜 두고 다시 시도해 주세요.`,
      trigger: () => { if (needsSeek) video.currentTime = time; },
    });
    return video.currentTime;
  } finally { if (needsSeek) video.removeEventListener('seeked', markSeeked); }
}

function chatPackCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw chatPackError('canvas_unavailable', '이 브라우저에서 이미지 자료를 만들지 못했습니다. 최신 Safari 또는 Chrome에서 다시 시도해 주세요.');
  return { canvas, context };
}

function chatPackCreateSheet(video, window, count, target) {
  const cellWidth = Math.max(320, Math.min(1024, video.videoWidth));
  const cellHeight = Math.max(180, Math.min(576, video.videoHeight));
  const gap = 16;
  const header = 124;
  const labelHeight = 38;
  const footer = 52;
  const width = cellWidth * 2 + gap * 3;
  const height = header + 3 * (cellHeight + labelHeight + gap) + footer;
  const { canvas, context } = chatPackCanvas(width, height);
  const font = Math.max(16, Math.min(28, Math.round(width / 60)));
  context.fillStyle = '#101e2b';
  context.fillRect(0, 0, width, height);
  context.textBaseline = 'top';
  context.fillStyle = '#ffffff';
  context.font = `600 ${font + 6}px system-ui, sans-serif`;
  context.fillText(`채팅용 경기 시간표본 ${String(window.index).padStart(2, '0')} / ${String(count).padStart(2, '0')}`, gap, 16);
  context.font = `${font}px system-ui, sans-serif`;
  context.fillStyle = '#dce7f0';
  context.fillText(`${KIT_LABELS[target.kit]} ${target.number}번 · ${target.age}세 · ${chatPackClock(window.start)}–${chatPackClock(window.end)}`, gap, 54);
  context.fillStyle = '#c7ef95';
  context.fillText(CHAT_PACK_NOTICE, gap, 88);
  context.font = `${Math.max(14, font - 2)}px system-ui, sans-serif`;
  context.fillStyle = '#dce7f0';
  context.fillText('일부 시간대만 포함 · 선수 능력치·전국 순위의 근거가 아닙니다.', gap, height - 34);
  for (let index = 0; index < 6; index++) {
    const x = gap + (index % 2) * (cellWidth + gap);
    const y = header + Math.floor(index / 2) * (cellHeight + labelHeight + gap);
    context.fillStyle = '#030b12';
    context.fillRect(x, y, cellWidth, cellHeight);
    if (index >= window.times.length) {
      context.fillStyle = '#8797a8';
      context.fillText('추가 표본 없음', x + 12, y + 12);
    }
  }
  return {
    canvas,
    draw(index, time) {
      const x = gap + (index % 2) * (cellWidth + gap);
      const y = header + Math.floor(index / 2) * (cellHeight + labelHeight + gap);
      const scale = Math.min(1, cellWidth / video.videoWidth, cellHeight / video.videoHeight);
      const drawWidth = Math.max(1, Math.round(video.videoWidth * scale));
      const drawHeight = Math.max(1, Math.round(video.videoHeight * scale));
      try { context.drawImage(video, x + Math.floor((cellWidth - drawWidth) / 2), y + Math.floor((cellHeight - drawHeight) / 2), drawWidth, drawHeight); }
      catch { throw chatPackError('frame_unreadable', '영상 장면을 이미지로 옮기지 못했습니다. 재생 가능한 원본을 다시 선택해 주세요.'); }
      context.fillStyle = '#ffffff';
      context.font = `600 ${font}px system-ui, sans-serif`;
      context.fillText(`${String(index + 1).padStart(2, '0')}  ${chatPackClock(time)}`, x + 8, y + cellHeight + 8);
    },
    close() { canvas.width = 0; canvas.height = 0; },
  };
}

function chatPackEncode(canvas, quality, signal) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    const finish = (blob, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(blob);
    };
    const aborted = () => finish(null, chatPackError('aborted', '자료 만들기를 취소했습니다. 원본 영상은 기기에 그대로 있습니다.'));
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(null, chatPackError('encoding_timeout', '이미지를 압축하는 시간이 초과됐습니다. 다른 앱을 닫고 화면을 켜 둔 상태에서 다시 시도해 주세요.')), 15000);
    if (signal?.aborted) { aborted(); return; }
    try {
      canvas.toBlob(blob => {
        if (!blob || !blob.size || blob.type !== 'image/jpeg') finish(null, chatPackError('encoding_failed', 'JPEG 이미지를 만들지 못했습니다. 최신 Safari 또는 Chrome에서 다시 시도해 주세요.'));
        else finish(blob);
      }, 'image/jpeg', quality);
    } catch { finish(null, chatPackError('encoding_failed', '이미지를 압축하지 못했습니다. 다른 앱을 닫고 다시 시도해 주세요.')); }
  });
}

async function chatPackFitSheet(canvas, maximumBytes, signal) {
  let scaled;
  try {
    for (let scaleAttempt = 0; scaleAttempt < 4; scaleAttempt++) {
      chatPackCheckSignal(signal);
      const source = scaled?.canvas || canvas;
      for (const quality of [0.86, 0.74, 0.62, 0.5, 0.38]) {
        const blob = await chatPackEncode(source, quality, signal);
        if (blob.size <= maximumBytes) return blob;
      }
      if (scaleAttempt === 3) break;
      const next = chatPackCanvas(Math.max(1, Math.floor(source.width * 0.8)), Math.max(1, Math.floor(source.height * 0.8)));
      next.context.drawImage(source, 0, 0, next.canvas.width, next.canvas.height);
      if (scaled) { scaled.canvas.width = 0; scaled.canvas.height = 0; }
      scaled = next;
    }
    throw chatPackError('pack_too_large', '자료를 8MiB 이하로 줄이지 못했습니다. 브라우저를 새로 열고 다시 시도해 주세요.');
  } finally { if (scaled) { scaled.canvas.width = 0; scaled.canvas.height = 0; } }
}

const CHAT_PACK_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let result = value;
  for (let bit = 0; bit < 8; bit++) result = (result & 1) ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  return result >>> 0;
});

function chatPackCRC32(bytes, signal) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    if (index % 65536 === 0) chatPackCheckSignal(signal);
    crc = CHAT_PACK_CRC_TABLE[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function buildStoredZip(entries, { signal, maxBytes = CHAT_PACK_MAX_BYTES } = {}) {
  chatPackCheckSignal(signal);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 22 || maxBytes > 25 * 1024 ** 2) throw chatPackError('invalid_zip', '자료 크기 설정을 확인해 주세요.');
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 32) throw chatPackError('invalid_zip', '자료 파일 목록을 확인하지 못했습니다.');
  const encoder = new TextEncoder();
  const names = new Set();
  const prepared = entries.map(entry => {
    if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.length > 120 || /[\\/\u0000-\u001f]/.test(entry.name) || entry.name.includes('..') || names.has(entry.name)) throw chatPackError('invalid_zip', '자료 파일 이름을 확인하지 못했습니다.');
    names.add(entry.name);
    const name = encoder.encode(entry.name);
    if (name.length > 255) throw chatPackError('invalid_zip', '자료 파일 이름이 너무 깁니다.');
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    if (!(data instanceof Blob) && !(data instanceof Uint8Array)) throw chatPackError('invalid_zip', '자료 파일 내용을 확인하지 못했습니다.');
    return { name, data, size: data instanceof Blob ? data.size : data.byteLength };
  });
  const predictedSize = 22 + prepared.reduce((total, entry) => total + entry.size + 76 + entry.name.byteLength * 2, 0);
  if (!Number.isSafeInteger(predictedSize) || predictedSize > maxBytes) throw chatPackError('pack_too_large', `채팅용 자료는 ZIP 전체가 ${Math.floor(maxBytes / 1024 ** 2)}MiB 이하여야 합니다.`);
  const chunks = [];
  const directory = [];
  let offset = 0;
  for (const entry of prepared) {
    chatPackCheckSignal(signal);
    const bytes = entry.data instanceof Blob ? new Uint8Array(await entry.data.arrayBuffer()) : entry.data;
    chatPackCheckSignal(signal);
    const crc = chatPackCRC32(bytes, signal);
    const local = new Uint8Array(30 + entry.name.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true); // UTF-8 file names, no data descriptor.
    header.setUint16(12, 0x0021, true); // 1980-01-01, no original file metadata.
    header.setUint32(14, crc, true);
    header.setUint32(18, bytes.byteLength, true);
    header.setUint32(22, bytes.byteLength, true);
    header.setUint16(26, entry.name.length, true);
    local.set(entry.name, 30);
    const central = new Uint8Array(46 + entry.name.length);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(14, 0x0021, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, bytes.byteLength, true);
    record.setUint32(24, bytes.byteLength, true);
    record.setUint16(28, entry.name.length, true);
    record.setUint32(42, offset, true);
    central.set(entry.name, 46);
    chunks.push(local, bytes);
    directory.push(central);
    offset += local.byteLength + bytes.byteLength;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  chatPackCheckSignal(signal);
  const directorySize = directory.reduce((total, entry) => total + entry.byteLength, 0);
  const ending = new Uint8Array(22);
  const record = new DataView(ending.buffer);
  record.setUint32(0, 0x06054b50, true);
  record.setUint16(8, prepared.length, true);
  record.setUint16(10, prepared.length, true);
  record.setUint32(12, directorySize, true);
  record.setUint32(16, offset, true);
  const zip = new Blob([...chunks, ...directory, ending], { type: 'application/zip' });
  if (zip.size !== predictedSize || zip.size > maxBytes) throw chatPackError('pack_too_large', `채팅용 자료를 ${Math.floor(maxBytes / 1024 ** 2)}MiB 이하 ZIP으로 만들지 못했습니다.`);
  return zip;
}

function chatPackReadme(manifest) {
  return `NEXT XI 채팅용 경기 시간표본\n\n${CHAT_PACK_NOTICE}\n\n대상: ${manifest.target.kitLabel} ${manifest.target.number}번, ${manifest.target.age}세\n영상 길이: ${chatPackClock(manifest.video.durationSeconds)}\n구성: 시간표본 이미지 ${manifest.sheets.length}장, 총 ${manifest.sampling.totalFrames}프레임\n\n이 자료는 기기 안에서 원본의 일부 시간대만 뽑은 이미지입니다. 선수 추적, 선수 식별, AI 분석을 수행하지 않았습니다. 원본 영상은 이 자료에 들어 있지 않으며 원본 파일명·프로필 이름·건강 정보를 넣지 않았습니다. 이미지에 다른 사람의 모습이 포함될 수 있습니다. 공유할 권한이 있는 자료만 직접 채팅에 첨부해 주세요.\n\n채팅에 JPEG 이미지를 첨부하고 다음과 같이 요청할 수 있습니다.\n“대상은 ${manifest.target.kitLabel} ${manifest.target.number}번 ${manifest.target.age}세 선수입니다. 유니폼 색과 등번호가 명확히 확인되는 장면만 근거로 삼고, 확인되지 않으면 식별 불가라고 말해 주세요. 각 이미지에 적힌 원본 절대 시각을 함께 인용해 관찰 가능한 움직임과 다음 훈련 과제를 설명해 주세요. 보이지 않는 플레이·능력치·전국 순위·성격·건강 상태를 추정하지 마세요.”\n\n한계\n- 전체 경기의 연속 동영상이 아니며 중요한 장면이나 대상 선수가 빠질 수 있습니다.\n- 정지 이미지 사이의 실제 움직임과 공의 궤적을 확인할 수 없습니다.\n- 표시 시각은 브라우저가 이동한 원본 시각이며 실제 프레임 표시 시각은 코덱에 따라 조금 다를 수 있습니다.\n- 관찰 근거가 부족하면 추가 영상이나 선명한 장면이 필요합니다.\n- ZIP을 받지 못하는 채팅에서는 JPEG 이미지를 직접 첨부하세요.\n`;
}

export async function createChatPack(file, { target = { kit: 'navy', number: 11, age: 11 }, sampleSet = 0, signal, onProgress } = {}) {
  chatPackCheckSignal(signal);
  const source = validateChatPackFile(file);
  const cleanTarget = validateChatPackTarget(target);
  planChatSamples(1, { sampleSet });
  if (!globalThis.document?.createElement || !globalThis.URL?.createObjectURL || typeof File !== 'function') throw chatPackError('browser_unsupported', '최신 Safari 또는 Chrome에서 원본 영상을 선택해 주세요.');
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  let session;
  let completed = 0;
  let total = 0;
  const progress = (phase, message) => onProgress?.({ phase, completed, total, message });
  progress('preparing', '원본을 올리지 않고 기기에서 영상 길이를 읽고 있어요.');
  try {
    session = await chatPackOpenVideo(file, signal);
    const { video } = session;
    const plan = planChatSamples(video.duration, { sampleSet });
    total = plan.reduce((sum, window) => sum + window.times.length, 0);
    const files = [];
    const sheets = [];
    const maximumImageBytes = Math.floor((CHAT_PACK_MAX_BYTES - 128 * 1024) / plan.length);
    for (const window of plan) {
      chatPackCheckSignal(signal);
      const sheet = chatPackCreateSheet(video, window, plan.length, cleanTarget);
      const frames = [];
      try {
        for (let index = 0; index < window.times.length; index++) {
          const time = await chatPackSeek(video, window.times[index], signal);
          chatPackCheckSignal(signal);
          sheet.draw(index, time);
          frames.push({ time, label: chatPackClock(time) });
          completed++;
          progress('sampling', `장면 ${completed}/${total} · ${chatPackClock(time)} 시간표본을 준비했어요.`);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        progress('encoding', `${window.index}/${plan.length}번 이미지를 채팅에 맞는 크기로 압축하고 있어요.`);
        const blob = await chatPackFitSheet(sheet.canvas, maximumImageBytes, signal);
        const name = `next-xi-sample-${String(window.index).padStart(2, '0')}.jpg`;
        files.push(new File([blob], name, { type: 'image/jpeg' }));
        sheets.push({ file: name, index: window.index, start: window.start, end: window.end, frames });
      } finally { sheet.close(); }
    }
    // Stop the decoder before packaging; only the small generated files remain.
    const videoMetadata = { durationSeconds: video.duration, width: video.videoWidth, height: video.videoHeight };
    session.close();
    session = null;
    chatPackCheckSignal(signal);
    const manifest = {
      schema: 'next-xi-chat-pack/v1', createdAt: new Date().toISOString(), purpose: 'manual_chat_review',
      target: { ...cleanTarget, kitLabel: KIT_LABELS[cleanTarget.kit] }, video: videoMetadata,
      analysis: { performed: false, playerIdentified: false, ratingsGenerated: false },
      sampling: { method: 'uniform_time_windows', sampleSet, alternateTimesAvailable: videoMetadata.durationSeconds / plan.length > 3.08, windowCount: plan.length, totalFrames: total, maxWindowSeconds: 3, continuousCoverage: false },
      sheets,
      limitations: [CHAT_PACK_NOTICE, '전체 경기의 일부 시간대만 뽑았으며 중요한 장면이나 대상 선수가 빠질 수 있습니다.', '정지 이미지로 실제 움직임·공의 궤적·능력치·전국 순위를 확정할 수 없습니다.', '시각은 브라우저의 이동 시각이며 실제 프레임 표시 시각과 조금 다를 수 있습니다.', '다른 시점 묶음도 자동 시간표본이며 선수 탐색이 아닙니다. 짧은 영상에서는 묶음을 바꿔도 같은 시점이 나올 수 있습니다.'],
    };
    files.push(new File([`${JSON.stringify(manifest, null, 2)}\n`], 'manifest.json', { type: 'application/json' }));
    files.push(new File([chatPackReadme(manifest)], 'README.txt', { type: 'text/plain;charset=utf-8' }));
    progress('packaging', '이미지와 설명을 8MiB 이하 ZIP으로 묶고 있어요.');
    const zip = await buildStoredZip(files.map(item => ({ name: item.name, data: item })), { signal });
    chatPackCheckSignal(signal);
    const metrics = { sourceBytes: source.size, zipBytes: zip.size, imageCount: sheets.length, frameCount: total, sampleSet, alternateTimesAvailable: manifest.sampling.alternateTimesAvailable, processingMs: Math.round((globalThis.performance?.now?.() ?? Date.now()) - startedAt) };
    progress('completed', `시간표본 이미지 ${sheets.length}장을 만들었어요. 선수 식별·AI 분석은 수행하지 않았어요.`);
    return { files, zip, manifest, metrics };
  } finally { session?.close(); }
}
