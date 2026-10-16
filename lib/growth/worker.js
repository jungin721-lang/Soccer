import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { access } from 'node:fs/promises';
import { handleAnalysis, validateAnalysisTarget } from '../analysis.js';
import { makeAutoScanPlan, selectAutoSegments } from '../../public/auto-analysis.js';
import { readProviderStatus, blockProviderQuota, claimProviderProbe, markProviderSuccess, releaseProviderProbe } from './provider.js';
import { finalizeOriginalRetention } from './retention.js';

const JOB_PREFIX = 'jobs/';
const LEASE_MS = 90_000;
const MAX_BODY_BYTES = 3_000_000;
const CLOUDFLARE_CONSENT_VERSION = '2026-10-cloudflare-v24';
const providerFor = env => env.SOCCER_AI_PROVIDER === 'cloudflare' ? 'cloudflare' : 'openai';
const cloudflareConsent = job => job?.provider === 'cloudflare' && job.analysisConsentVersion === CLOUDFLARE_CONSENT_VERSION;
const retentionNeeded = job => job?.status === 'completed' && job.stage === 'completed' && job.progress?.status === 'completed' && job.result?.identified === true && job.clips?.length > 0 && job.retention?.status !== 'completed';

function workerError(message, code = 'worker_failed', status = 500) {
  return Object.assign(new Error(message), { code, status, publicMessage: message });
}
function cancelledError() { return workerError('분석을 중단했습니다. 이미 저장된 관찰 결과는 유지됩니다.', 'cancelled', 409); }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function validToken(token, expected) {
  if (typeof token !== 'string' || token.length < 12 || token.length > 256 || /[\r\n]/.test(token) || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(expected, 'hex'));
}
function copy(value) { return structuredClone(value); }
function leaseTime(value) { return typeof value === 'number' ? value : Date.parse(value || '') || 0; }

async function ffmpegBinary(env) {
  if (env.SOCCER_FFMPEG_PATH) return env.SOCCER_FFMPEG_PATH;
  try {
    const { default: binary } = await import('ffmpeg-static');
    if (typeof binary === 'string') { await access(binary); return binary; }
  } catch { /* Local development can use an installed FFmpeg executable. */ }
  return 'ffmpeg';
}

function runFFmpeg(binary, args, { signal, timeoutMs = 30_000, maxOutput = 400_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelledError()); return; }
    let process;
    let finished = false;
    let outputSize = 0;
    let errorSize = 0;
    const output = [];
    const errors = [];
    let timer;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => {
      process?.kill('SIGKILL');
      finish(cancelledError());
    };
    try {
      // No shell is involved. Do not log these arguments: HTTPS input headers
      // include the ephemeral private-media token.
      process = spawn(binary, ['-nostdin', '-hide_banner', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { finish(workerError('서버의 영상 처리 도구를 실행하지 못했습니다.', 'ffmpeg_unavailable')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { process.kill('SIGKILL'); finish(workerError('서버에서 영상을 여는 시간이 초과됐습니다. 저장된 결과는 유지됩니다.', 'media_timeout')); }, timeoutMs);
    process.on('error', () => finish(workerError('서버의 영상 처리 도구를 실행하지 못했습니다.', 'ffmpeg_unavailable')));
    process.stdout.on('data', chunk => {
      outputSize += chunk.length;
      if (outputSize > maxOutput) { process.kill('SIGKILL'); finish(workerError('분석 장면의 크기를 줄여야 합니다.', 'frame_too_large')); }
      else output.push(chunk);
    });
    process.stderr.on('data', chunk => {
      // Probe metadata can contain the input URL/headers. Keep a bounded buffer
      // only for duration parsing; it is never stored, returned, or logged.
      if (errorSize < 65_536) errors.push(chunk.subarray(0, 65_536 - errorSize));
      errorSize += chunk.length;
    });
    process.on('close', code => finish(null, { code, output: Buffer.concat(output), metadata: Buffer.concat(errors).toString('utf8') }));
  });
}

function mediaArguments(input, token) {
  // A filename and declared MIME type do not establish the actual container.
  // Limit demuxers before opening bytes so an uploaded HLS/concat manifest
  // cannot make FFmpeg fetch references chosen by the uploader.
  const containers = ['-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm'];
  if (!/^https?:\/\//i.test(input)) return [...containers, '-i', input];
  let url;
  try { url = new URL(input); } catch { throw workerError('비공개 원본 영상 주소를 확인하지 못했습니다.', 'media_unavailable'); }
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw workerError('비공개 원본에는 보안 연결이 필요합니다.', 'media_unavailable');
  // The media endpoint intentionally bounds each HTTP Range response. FFmpeg
  // resumes premature range EOF at the next byte while retaining its header.
  // Do not enable reconnect_at_eof: genuine EOF must finish so a missing final
  // frame can fall back to an earlier seek instead of reconnecting forever.
  return [...containers, '-protocol_whitelist', 'http,https,tcp,tls', '-rw_timeout', '25000000', '-reconnect', '1', '-reconnect_delay_max', '1', '-headers', `Authorization: Bearer ${token}\r\n`, '-i', url.href];
}

async function probeDuration(binary, inputArguments, signal) {
  const result = await runFFmpeg(binary, [...inputArguments], { signal, maxOutput: 1024 });
  // Container comments are also printed to stderr and can contain the word
  // "Duration". Match FFmpeg's complete format-summary line, not user metadata.
  const found = result.metadata.match(/^[ \t]*Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?),\s*start:/m);
  if (!found) throw workerError('서버에서 원본 영상의 길이를 읽지 못했습니다. 재생 가능한 MP4 원본인지 확인해 주세요.', 'media_unreadable');
  const duration = Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3]);
  makeAutoScanPlan(duration);
  return duration;
}

async function extractFrame(binary, inputArguments, time, { signal, maxBytes = 250_000 } = {}) {
  for (let edge = 1280; edge >= 256; edge = Math.floor(edge * 0.8)) {
    const filter = `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
    let result;
    try {
      // Input seeking picks the next decoded frame. Close to the end of a
      // low-frame-rate video that frame may not exist, so try a small earlier
      // seek. showinfo + copyts supplies the decoded frame's real timestamp;
      // never label the fallback image with the originally requested time.
      for (const offset of [0, 0.25, 1]) {
        result = await runFFmpeg(binary, ['-loglevel', 'info', '-ss', String(Math.max(0, time - offset)), '-copyts', '-start_at_zero', ...inputArguments, '-map', '0:v:0', '-frames:v', '1', '-vf', `${filter},showinfo`, '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { signal });
        if (result.output.length > 0) break;
      }
    } catch (error) {
      if (error.code === 'frame_too_large') continue;
      throw error;
    }
    if (result.code !== 0 || result.output.length < 10 || result.output[0] !== 0xff || result.output[1] !== 0xd8 || result.output.at(-2) !== 0xff || result.output.at(-1) !== 0xd9) throw workerError('서버에서 영상 장면을 해독하지 못했습니다. 저장된 관찰 결과는 유지됩니다.', 'media_decode_failed');
    const image = `data:image/jpeg;base64,${result.output.toString('base64')}`;
    const actualTime = Number(result.metadata.match(/\bpts_time:\s*([\d.]+)/)?.[1]);
    if (!Number.isFinite(actualTime) || actualTime < 0) throw workerError('해독한 장면의 실제 시각을 확인하지 못했습니다.', 'media_timestamp_failed');
    if (Buffer.byteLength(image) <= maxBytes) return { time: actualTime, image };
  }
  throw workerError('분석 장면을 전송 크기에 맞추지 못했습니다. 저장된 관찰 결과는 유지됩니다.', 'frame_too_large');
}

async function encodeEvidence(binary, inputArguments, clip, signal) {
  const duration = clip.end - clip.start;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 12.000001) throw workerError('근거 영상의 시간 범위를 확인하지 못했습니다.', 'evidence_range_invalid');
  const encoded = await runFFmpeg(binary, ['-loglevel', 'error', '-ss', String(clip.start), ...inputArguments, '-t', String(duration), '-map', '0:v:0', '-an', '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-r', '24', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1800k', '-maxrate', '1800k', '-bufsize', '3600k', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { signal, maxOutput: 8 * 1024 ** 2 });
  if (encoded.code !== 0 || encoded.output.length < 16 || encoded.output.toString('ascii', 4, 8) !== 'ftyp') throw workerError('원본을 정리하기 전에 재생 가능한 근거 영상을 만들지 못했습니다.', 'evidence_encode_failed');
  return encoded.output;
}

function safeProviderError(status, code, provider = 'openai') {
  const messages = {
    analysis_unavailable: '서버에 AI API 키가 연결되지 않아 분석을 실행하지 못했습니다.',
    analysis_key_format_invalid: '서버에 등록한 AI API 키의 형식이 올바르지 않습니다.',
    analysis_credentials_rejected: 'AI 서비스가 서버 API 키 인증을 거절했습니다.',
    analysis_permission_denied: '서버 API 키에 AI 분석 호출 권한이 없습니다.',
    analysis_quota_exceeded: 'AI 서비스의 결제 또는 사용 한도에 도달했습니다.',
    analysis_rate_limited: 'AI 서비스의 요청 한도에 도달했습니다. 저장된 결과는 유지됩니다.',
    analysis_model_unavailable: '서버에 설정한 AI 모델을 사용할 수 없습니다.',
    analysis_invalid_result: '영상 근거를 확인할 수 있는 AI 결과를 받지 못했습니다.',
    analysis_timeout: 'AI 분석 서버의 응답 시간이 초과됐습니다.',
    analysis_cancelled: '분석 요청을 중단했습니다.',
    analysis_free_plan_unverified: '무료 전용 AI 연결의 요금제와 모델을 확인하지 못했습니다. 원본과 저장된 결과는 유지됩니다.',
    free_plan_unverified: '무료 전용 AI 연결의 요금제를 확인하지 못했습니다. 원본과 저장된 결과는 유지되며 다른 유료 AI로 전환하지 않았습니다.',
    analysis_free_plan_required: '이 설정은 무료 전용 AI 조건을 충족하지 않아 중단했습니다. 원본과 저장된 결과는 유지됩니다.',
    analysis_free_model_required: '무료 전용으로 허용된 AI 모델이 필요합니다. 다른 유료 제공자로 전환하지 않았습니다.',
    analysis_license_required: '무료 AI 모델의 이용 조건을 확인해야 해 중단했습니다. 원본은 유지되며 다른 유료 AI로 전환하지 않았습니다.',
    analysis_model_terms_required: '무료 AI 모델의 이용 조건을 확인해야 해 중단했습니다. 원본은 유지되며 다른 유료 AI로 전환하지 않았습니다.',
  };
  if (provider === 'cloudflare') {
    messages.analysis_unavailable = '서버의 무료 Cloudflare 계정과 AI API 토큰 설정을 확인하지 못했습니다. 다른 유료 AI로 전환하지 않았습니다.';
    messages.analysis_quota_exceeded = '무료 AI의 일일 한도에 도달했습니다. 원본과 저장된 결과는 유지하며 다음 UTC 자정 이후 다시 확인합니다.';
    messages.analysis_credentials_rejected = 'Cloudflare가 서버 인증을 거절했습니다. 무료 계정과 API 토큰 설정을 확인해야 합니다.';
  }
  return workerError(messages[code] || 'AI 분석 결과를 받지 못했습니다. 이미 저장된 관찰 결과는 유지됩니다.', code || 'analysis_failed', status);
}

async function providerGate(store, jobId, provider) {
  const grant = await claimProviderProbe(store, jobId, { provider });
  if (!grant.allowed) throw Object.assign(safeProviderError(429, 'analysis_quota_exceeded', provider), { providerBlocked: true, retryAt: grant.nextAttemptAt || grant.retryAt });
  return grant;
}

async function callAnalysis(handler, payload, { env, token, signal, store, jobId, provider }) {
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BODY_BYTES) throw workerError('분석 장면의 전송 용량이 허용 크기를 넘었습니다.', 'request_too_large');
  const grant = await providerGate(store, jobId, provider);
  const request = new Request('https://next-xi.internal/api/analysis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, accessCode: token, consent: true }), signal });
  let response;
  try { response = await handler(request, { env: { ...env, SOCCER_ANALYSIS_ACCESS_CODE: token } }); }
  catch { if (signal.aborted) throw cancelledError(); throw workerError('AI 분석 서버에 연결하지 못했습니다.', 'analysis_failed'); }
  let value;
  try { value = await response.json(); } catch { throw workerError('AI 분석 서버의 응답을 읽지 못했습니다.', 'analysis_invalid_result'); }
  if (!response.ok) {
    const error = safeProviderError(response.status, value?.code, provider);
    if (value?.code === 'analysis_quota_exceeded') {
      const blocked = await blockProviderQuota(store, { provider });
      error.retryAt = blocked.retryAt;
    }
    throw error;
  }
  if (typeof value?.model !== 'string' || !value.model.trim() || value.model.length > 100) throw workerError('AI 모델의 응답 정보를 확인하지 못했습니다.', 'analysis_invalid_result');
  return { payload: value, grant };
}

function progressFor(plan, provider) {
  return { duration: plan.duration, sampleCount: plan.sampleCount, sampledCount: 0, interval: plan.interval, detectedCount: 0, selectedCount: 0, completedCount: 0, status: 'scanning', detections: [], segments: [], message: '서버에서 전체 시간대의 표본 탐색을 시작합니다.', model: '', ...(provider === 'cloudflare' ? { provider, sampledFrames: 0, duplicateSampleCount: 0, observationFrames: 0, lastSampledTime: null } : {}) };
}

function resultFor(job) {
  const clips = job.clips || [];
  const progress = job.progress || {};
  const identified = clips.some(clip => clip.result.identified);
  const totalSegmentSeconds = clips.reduce((total, clip) => total + clip.end - clip.start, 0);
  let coveredSeconds = 0, coveredUntil = 0;
  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    coveredSeconds += Math.max(0, clip.end - Math.max(clip.start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, clip.end);
  }
  return {
    analysisIds: clips.map(clip => clip.id),
    summary: progress.status === 'not_found' ? '표본에서 지정한 유니폼 색과 등번호를 함께 확인하지 못해 선수 평가를 보류했습니다.' : (clips.length ? `자동으로 선택한 ${clips.length}개 구간의 영상 관찰 결과가 저장되었습니다.` : '원본 영상의 표본을 탐색하고 있습니다.'),
    limitations: ['전체 시간대에서 추출한 표본을 확인한 결과이며, 표본 사이의 모든 플레이를 연속으로 분석한 것은 아닙니다.', 'AI 관찰은 능력 점수나 전국 순위를 대신하지 않으며 코치의 확인이 필요합니다.'],
    coverage: { mode: 'sampled', duration: progress.duration || 0, sampledFrames: progress.provider === 'cloudflare' ? progress.sampledFrames || 0 : progress.sampledCount || 0, analyzedSegments: clips.length, analyzedSeconds: Number((progress.provider === 'cloudflare' ? coveredSeconds : totalSegmentSeconds).toFixed(3)), ...(progress.provider === 'cloudflare' ? { discoveryIntervalSeconds: 1, observationFrames: progress.observationFrames || 0, completedSampleRequests: progress.sampledCount || 0, skippedDuplicateRequests: progress.duplicateSampleCount || 0, segmentSecondsIncludingOverlap: Number(totalSegmentSeconds.toFixed(3)) } : {}) },
    identified,
  };
}

function qualitativeResult(value, segment) {
  const text = (item, maximum) => typeof item === 'string' && item.trim().length > 0 && item.length <= maximum;
  if (!value || typeof value.identified !== 'boolean' || !text(value.summary, 1800) || !Array.isArray(value.observations) || value.observations.length > 6 || (!value.identified && value.observations.length) || !Array.isArray(value.limitations) || value.limitations.length < 1 || value.limitations.length > 8 || value.limitations.some(item => !text(item, 500)) || !text(value.nextAction, 1200)) throw workerError('분석 결과의 영상 근거를 확인하지 못했습니다.', 'analysis_invalid_result');
  const observations = value.observations.map(item => {
    if (!item || !['touch', 'pass', 'dribble', 'shoot', 'defend', 'scan', 'move', 'team'].includes(item.skill) || !['strength', 'focus', 'note'].includes(item.type) || !['low', 'medium', 'high'].includes(item.confidence) || !Number.isInteger(item.time) || item.time < Math.ceil(segment.start) || item.time > Math.floor(segment.end) || !text(item.note, 1200) || Object.hasOwn(item, 'rating')) throw workerError('장면 근거가 없는 점수나 관찰은 저장하지 않았습니다.', 'analysis_invalid_result');
    return { skill: item.skill, time: item.time, note: item.note, type: item.type, confidence: item.confidence };
  });
  return { identified: value.identified, summary: value.summary, observations, limitations: [...value.limitations], nextAction: value.nextAction };
}

async function syncWorkspace(store, job) {
  const clips = job.clips || [];
  const duration = job.progress?.duration;
  await store.update(`workspaces/${job.userId}`, current => {
    if (!current) throw workerError('선수의 성장 공간을 찾지 못했습니다.', 'workspace_missing');
    if (!(current.videos || []).some(video => video.id === job.videoId)) throw workerError('삭제된 원본의 분석 결과는 다시 추가하지 않았습니다.', 'media_missing');
    let changed = false;
    let analyses = Array.isArray(current.analyses) ? [...current.analyses] : [];
    for (const clip of clips) {
      if (!analyses.some(item => item.id === clip.id)) { analyses.push(copy(clip)); changed = true; }
    }
    const videos = (current.videos || []).map(video => {
      if (video.id !== job.videoId || !duration || video.duration === duration) return video;
      changed = true;
      return { ...video, duration };
    });
    return changed ? { ...current, videos, analyses, revision: (current.revision || 0) + 1 } : current;
  });
  if (duration) await store.update(`videos/${job.videoId}`, current => {
    if (!current || current.userId !== job.userId) throw workerError('삭제된 원본 정보를 다시 저장하지 않았습니다.', 'media_missing');
    return current.duration === duration ? current : { ...current, duration };
  });
}

/** Server-only durable worker. The browser is not part of its lifetime. */
export async function runGrowthJob({ store, jobId, token, mediaURL, localMediaInput, signal, budgetMs = 8 * 60_000, dispatchContinuation, analysisHandler = handleAnalysis, env = process.env } = {}) {
  if (!store || typeof store.update !== 'function' || typeof jobId !== 'string') throw workerError('분석 작업 저장소를 연결하지 못했습니다.', 'worker_configuration');
  const key = `${JOB_PREFIX}${jobId}`;
  const owner = randomUUID();
  const started = Date.now();
  const budget = Math.min(8 * 60_000, Math.max(100, Number.isFinite(budgetMs) ? budgetMs : 8 * 60_000));
  const provider = providerFor(env);
  const cloudflare = provider === 'cloudflare';
  let job = await store.update(key, current => {
    if (!current || !validToken(token, current.tokenHash)) throw workerError('분석 작업 인증을 확인하지 못했습니다.', 'unauthorized_job', 401);
    if (current.cancelRequested || current.status === 'cancelled' || (current.status === 'completed' && !(cloudflare && cloudflareConsent(current) && retentionNeeded(current)))) return current;
    if (current.leaseOwner && leaseTime(current.leaseUntil) > Date.now()) return current;
    const retentionOnly = cloudflare && retentionNeeded(current);
    return { ...current, status: retentionOnly ? 'completed' : 'running', stage: retentionOnly ? 'completed' : current.progress?.sampledCount ? 'scanning' : 'probing', error: null, leaseOwner: owner, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), dispatchPendingUntil: null, updatedAt: new Date().toISOString() };
  });
  if (job.leaseOwner !== owner) return job;
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  signal?.addEventListener('abort', externalAbort, { once: true });
  let budgetExpired = false;
  let heartbeatFailure;
  let heartbeatPending;
  const budgetTimer = setTimeout(() => { budgetExpired = true; controller.abort(); }, budget);
  const mutate = async (update, { allowCancelled = false, refreshSnapshot = true } = {}) => {
    const committed = await store.update(key, current => {
      if (!current || !validToken(token, current.tokenHash) || current.leaseOwner !== owner) throw workerError('다른 실행에서 이 분석 작업을 이어받았습니다.', 'lease_lost', 409);
      if (!allowCancelled && (current.cancelRequested || current.status === 'cancelled')) throw cancelledError();
      const updated = update(current);
      return { ...updated, updatedAt: new Date().toISOString(), leaseUntil: updated.leaseOwner === null ? null : new Date(Date.now() + LEASE_MS).toISOString() };
    });
    // A slower heartbeat response must not replace a newer in-memory clip
    // checkpoint; its CAS write is safe, but response ordering can differ.
    if (refreshSnapshot) job = committed;
    return committed;
  };
  const heartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = mutate(current => current, { refreshSnapshot: false }).catch(error => { heartbeatFailure = error; controller.abort(); }).finally(() => { heartbeatPending = null; });
  }, 25_000);
  const check = async ({ paid = false } = {}) => {
    if (signal?.aborted) throw cancelledError();
    if (Date.now() - started >= budget) { budgetExpired = true; throw cancelledError(); }
    // Leave enough invocation time for the provider's 48-second timeout and a
    // durable write. Do not start a paid call at the edge of a checkpoint.
    if (paid && budget >= 60_000 && budget - (Date.now() - started) < 55_000) { budgetExpired = true; throw cancelledError(); }
    if (heartbeatFailure) throw heartbeatFailure;
    const [account, workspace] = await Promise.all([store.get(`users/${job.userId}`), store.get(`workspaces/${job.userId}`)]);
    if (!account || account.deleting || workspace?.consents?.analysis !== true) throw cancelledError();
    await mutate(current => current);
  };
  const checkpoint = async (progress, options) => mutate(current => {
    const updated = { ...current, progress: copy(progress), stage: ['scanning', 'analyzing', 'completed', 'not_found'].includes(progress.status) ? progress.status : 'scanning' };
    updated.result = resultFor(updated);
    return updated;
  }, options);
  let terminal;
  try {
    await check();
    if (cloudflare && !cloudflareConsent(job)) throw workerError('Cloudflare 무료 분석에 새로 동의한 작업만 실행할 수 있습니다. 원본은 유지됩니다.', 'analysis_consent_required', 409);
    if (!cloudflare && job.provider === 'cloudflare') throw workerError('이 작업의 Cloudflare 제공자 설정이 바뀌었습니다. 다른 유료 AI로 전환하지 않았습니다.', 'analysis_provider_changed', 409);
    const video = await store.get(`videos/${job.videoId}`);
    if (!video || video.userId !== job.userId) throw workerError('이 선수의 비공개 원본 영상을 찾지 못했습니다.', 'media_missing');
    let target;
    try { target = validateAnalysisTarget(job.target); }
    catch { throw workerError('분석할 선수의 유니폼 색상, 등번호와 나이를 확인하지 못했습니다.', 'invalid_target'); }
    const input = localMediaInput || mediaURL;
    if (typeof input !== 'string' || !input) throw workerError('비공개 원본 영상 경로를 연결하지 못했습니다.', 'media_missing');
    const inputArguments = mediaArguments(input, token);
    const binary = await ffmpegBinary(env);
    const finishRetention = async () => {
      try {
        job = await finalizeOriginalRetention({ store, job, signal: controller.signal, createEvidence: ({ clip, signal: evidenceSignal }) => encodeEvidence(binary, inputArguments, clip, evidenceSignal) });
      } catch (error) {
        job = await store.update(key, current => {
          if (!current || current.status !== 'completed' || current.retention?.status === 'completed') return current;
          const errorCode = /^[a-z_]{1,80}$/.test(error?.code || '') ? error.code : 'evidence_retention_pending';
          return { ...current, retention: { ...(current.retention || {}), status: 'pending', errorCode }, updatedAt: new Date().toISOString() };
        });
      }
      job = await store.update(key, current => current?.leaseOwner === owner ? { ...current, leaseOwner: null, leaseUntil: null } : current);
      if (budgetExpired && job?.retention?.status !== 'completed' && typeof dispatchContinuation === 'function') {
        try { await dispatchContinuation(jobId, token); } catch { /* The scheduler also retries persisted retention work. */ }
      }
      return job;
    };
    if (cloudflare && job.status === 'completed') {
      await syncWorkspace(store, job);
      return await finishRetention();
    }
    if (analysisHandler === handleAnalysis) {
      const availability = await handleAnalysis(new Request('https://next-xi.internal/api/analysis'), { env: { ...env, SOCCER_ANALYSIS_ACCESS_CODE: token } });
      const ready = await availability.json();
      if (!ready.available) throw safeProviderError(503, ready.reason === 'invalid_key_format' ? 'analysis_key_format_invalid' : ready.reason === 'free_model_required' ? 'analysis_free_model_required' : ready.reason === 'free_plan_unverified' ? 'free_plan_unverified' : 'analysis_unavailable', provider);
    }
    await providerGate(store, jobId, provider);
    const duration = await probeDuration(binary, inputArguments, controller.signal);
    const plan = makeAutoScanPlan(duration, { provider });
    let progress = job.progress?.sampleCount ? copy(job.progress) : progressFor(plan, provider);
    if (Math.abs((progress.duration || 0) - duration) > 0.01 || progress.sampleCount !== plan.sampleCount || !Number.isInteger(progress.sampledCount) || progress.sampledCount < 0 || progress.sampledCount > plan.sampleCount || !Array.isArray(progress.detections)) throw workerError('저장된 분석 기록과 원본 영상의 길이가 일치하지 않습니다.', 'media_changed');
    if (cloudflare && (progress.provider !== 'cloudflare' || !Number.isInteger(progress.sampledFrames) || progress.sampledFrames < 0 || progress.sampledFrames > progress.sampledCount)) throw workerError('무료 분석의 저장된 표본 계획을 확인하지 못했습니다. 다른 제공자의 분석을 이어받지 않았습니다.', 'checkpoint_provider_mismatch');
    progress.completedCount = (job.clips || []).length;
    if (cloudflare) progress.observationFrames = (job.clips || []).reduce((total, clip) => total + (clip.sampledTimes?.length || 0), 0);
    progress.status = progress.sampledCount < progress.sampleCount ? 'scanning' : 'analyzing';
    await checkpoint(progress);
    await syncWorkspace(store, job);
    while (progress.sampledCount < plan.sampleCount) {
      await check();
      const frames = [];
      let bytes = 0;
      let requestedCount = 0;
      let duplicateCount = 0;
      let lastFrameTime = cloudflare ? progress.lastSampledTime : null;
      for (let index = progress.sampledCount; index < plan.sampleCount && frames.length < (cloudflare ? 4 : 12); index += 1) {
        if (Date.now() - started >= budget || controller.signal.aborted) { budgetExpired ||= Date.now() - started >= budget; throw cancelledError(); }
        const frame = await extractFrame(binary, inputArguments, plan.times[index], { signal: controller.signal });
        if (frames.length && bytes + frame.image.length > 2_000_000) break;
        requestedCount += 1;
        if (cloudflare && Number.isFinite(lastFrameTime) && frame.time <= lastFrameTime + 0.000001) { duplicateCount += 1; continue; }
        if (frames.length && frame.time <= frames.at(-1).time) throw workerError('원본에서 서로 다른 시간순 표본을 준비하지 못했습니다.', 'media_timestamp_failed');
        frames.push(frame);
        lastFrameTime = frame.time;
        bytes += frame.image.length;
      }
      let acceptedGrant;
      if (frames.length) {
        await check({ paid: true });
        const { payload: response, grant } = await callAnalysis(analysisHandler, { mode: 'discover', videoId: `local-${job.videoId}`, start: 0, end: duration, frames, target }, { env, token, signal: controller.signal, store, jobId, provider });
        if (response.mode !== 'discover' || !Array.isArray(response.detections) || response.detections.length > frames.length || response.detections.some((detection, index, detections) => !detection || !frames.some(frame => frame.time === detection.time) || !['medium', 'high'].includes(detection.confidence) || typeof detection.reason !== 'string' || !detection.reason.trim() || detection.reason.length > 500 || (index > 0 && detection.time <= detections[index - 1].time))) throw workerError('탐색 결과의 영상 근거를 확인하지 못했습니다.', 'analysis_invalid_result');
        progress.detections.push(...response.detections);
        progress.model = response.model;
        acceptedGrant = grant;
      }
      progress.sampledCount += cloudflare ? requestedCount : frames.length;
      if (cloudflare) {
        progress.sampledFrames += frames.length;
        progress.duplicateSampleCount = (progress.duplicateSampleCount || 0) + duplicateCount;
        progress.lastSampledTime = lastFrameTime;
      }
      progress.detectedCount = progress.detections.length;
      progress.message = cloudflare ? `1초 간격 탐색 위치 ${progress.sampledCount}/${progress.sampleCount}개를 처리하고 고유 표본 ${progress.sampledFrames}개를 확인했습니다. 표본 사이의 움직임은 분석하지 않았습니다.` : `서버에서 전체 시간대 표본 ${progress.sampledCount}/${progress.sampleCount}개를 확인했습니다.`;
      await checkpoint(progress, { allowCancelled: true });
      if (acceptedGrant) await markProviderSuccess(store, { provider, owner: jobId, grant: acceptedGrant });
    }
    progress.segments = selectAutoSegments(progress.detections, duration, cloudflare ? { provider } : 6);
    progress.selectedCount = progress.segments.length;
    if ((job.clips || []).length > progress.selectedCount || (job.clips || []).some((clip, index) => Math.abs(clip.start - progress.segments[index].start) > 0.000001 || Math.abs(clip.end - progress.segments[index].end) > 0.000001)) throw workerError('저장된 관찰 결과와 자동 선택 구간이 일치하지 않습니다.', 'checkpoint_mismatch');
    if (!progress.selectedCount) {
      progress.status = 'not_found';
      progress.message = '표본에서 지정한 유니폼 색과 등번호를 함께 확인하지 못해 선수 평가를 보류했습니다.';
      await checkpoint(progress);
      terminal = 'not_found';
    } else {
      progress.status = 'analyzing';
      await checkpoint(progress);
      for (let index = (job.clips || []).length; index < progress.segments.length; index += 1) {
        await check();
        const segment = progress.segments[index];
        if (cloudflare && segment.end - segment.start > 3.000001) throw workerError('무료 분석의 근거 구간은 3초 이하여야 합니다.', 'checkpoint_mismatch');
        const count = cloudflare ? 4 : Math.min(24, Math.ceil((segment.end - segment.start) * 2));
        const times = cloudflare ? Array.from({ length: count }, (_, frameIndex) => segment.start + frameIndex * Math.max(0, segment.end - segment.start - Math.min(0.1, (segment.end - segment.start) / 10)) / (count - 1)) : Array.from({ length: count }, (_, frameIndex) => segment.start + frameIndex * 0.5).filter(time => time < segment.end);
        const center = (segment.start + segment.end) / 2;
        const reference = progress.detections.filter(item => item.time >= segment.start && (cloudflare ? item.time <= segment.end : item.time < segment.end)).sort((a, b) => Number(b.confidence === 'high') - Number(a.confidence === 'high') || Math.abs(a.time - center) - Math.abs(b.time - center))[0];
        if (cloudflare && !reference) throw workerError('등번호 탐색 근거가 없는 구간을 분석하지 않았습니다.', 'checkpoint_anchor_missing');
        if (reference) {
          const closest = times.reduce((best, time, frameIndex) => Math.abs(time - reference.time) < Math.abs(times[best] - reference.time) ? frameIndex : best, 0);
          times[closest] = reference.time;
          times.sort((a, b) => a - b);
        }
        const frames = [];
        for (const time of times) {
          if (controller.signal.aborted || Date.now() - started >= budget) { budgetExpired ||= Date.now() - started >= budget; throw cancelledError(); }
          const maximum = reference && time === reference.time ? 250_000 : Math.min(250_000, Math.floor((2_700_000 - (reference ? 250_000 : 0)) / (times.length - (reference ? 1 : 0))));
          const frame = await extractFrame(binary, inputArguments, time, { signal: controller.signal, maxBytes: maximum });
          if (cloudflare && (frame.time < segment.start || frame.time > segment.end || (frames.length && frame.time <= frames.at(-1).time))) continue;
          if (frame.time < segment.start || frame.time > segment.end || (frames.length && frame.time <= frames.at(-1).time)) throw workerError('이 구간에서 서로 다른 시간순 장면을 충분히 준비하지 못했습니다.', 'media_timestamp_failed');
          frames.push(frame);
        }
        if (cloudflare && (frames.length < 2 || !frames.some(frame => Math.abs(frame.time - reference.time) <= 0.000001))) throw workerError('근거 등번호 장면과 서로 다른 시간의 표본을 함께 준비하지 못했습니다. 원본은 유지됩니다.', 'media_timestamp_failed');
        await check({ paid: true });
        const { payload: response, grant } = await callAnalysis(analysisHandler, { videoId: `local-${job.videoId}`, ...segment, frames, target }, { env, token, signal: controller.signal, store, jobId, provider });
        const clip = { id: randomUUID(), jobId, videoId: job.videoId, createdAt: new Date().toISOString(), ...segment, result: qualitativeResult(response.result, segment), model: response.model };
        if (cloudflare) {
          if (clip.result.observations.some(item => !frames.some(frame => Math.round(frame.time) === item.time))) throw workerError('실제로 보낸 표본 시각에 대응하지 않는 관찰은 저장하지 않았습니다.', 'analysis_invalid_result');
          clip.sampledTimes = frames.map(frame => frame.time);
          clip.referenceTime = reference.time;
          progress.observationFrames = (progress.observationFrames || 0) + frames.length;
        }
        progress.completedCount = index + 1;
        progress.model = response.model;
        progress.message = `자동 선택한 구간 ${progress.completedCount}/${progress.selectedCount}개의 관찰 결과를 서버에 저장했습니다.`;
        await mutate(current => {
          const clips = [...(current.clips || []), clip];
          const updated = { ...current, clips, progress: copy(progress), stage: 'analyzing' };
          updated.result = resultFor(updated);
          return updated;
        }, { allowCancelled: true });
        await syncWorkspace(store, job);
        await markProviderSuccess(store, { provider, owner: jobId, grant });
      }
      progress.status = 'completed';
      progress.message = cloudflare ? '1초 간격 표본 탐색과 발견한 모든 근거 구간의 표본 관찰을 마쳤습니다. 모든 프레임이나 모든 플레이를 확인한 결과는 아닙니다.' : '전체 시간대 표본 탐색과 자동 선택 구간 분석을 마쳤습니다. 저장된 결과는 다시 접속해 확인할 수 있습니다.';
      await checkpoint(progress);
      terminal = 'completed';
    }
    clearInterval(heartbeat);
    if (heartbeatPending) await heartbeatPending;
    job = await mutate(current => ({ ...current, status: 'completed', stage: terminal, error: null, result: resultFor(current), completedAt: new Date().toISOString(), leaseOwner: null, leaseUntil: null }));
    if (cloudflare && terminal === 'completed' && job.result?.identified) return await finishRetention();
    return job;
  } catch (error) {
    clearInterval(heartbeat);
    if (heartbeatPending) await heartbeatPending;
    const current = await store.get(key);
    if (!current || !validToken(token, current.tokenHash) || current.leaseOwner !== owner) return current;
    const cancelled = current.cancelRequested || current.status === 'cancelled' || signal?.aborted || heartbeatFailure?.code === 'cancelled' || (!budgetExpired && error.code === 'cancelled');
    if (budgetExpired && !cancelled) {
      job = await store.update(key, value => value?.leaseOwner === owner && validToken(token, value.tokenHash) ? { ...value, status: 'queued', stage: value.stage || 'scanning', leaseOwner: null, leaseUntil: null, updatedAt: new Date().toISOString() } : value);
      if (typeof dispatchContinuation === 'function') {
        try { await dispatchContinuation(jobId, token); }
        catch { /* A trusted recovery scheduler can dispatch this queued checkpoint. */ }
      }
      return job;
    }
    if (!cancelled && error.code === 'analysis_quota_exceeded') {
      const providerStatus = await readProviderStatus(store, { provider });
      const retryAt = error.providerBlocked ? (error.retryAt || providerStatus.retryAt) : providerStatus.retryAt;
      const message = cloudflare ? '무료 AI의 일일 한도로 분석을 기다리고 있습니다. 원본과 완료된 결과는 유지하며 다음 UTC 자정 이후 서버가 무료 연결을 다시 확인합니다. 다른 유료 AI로 전환하지 않습니다.' : 'AI 제공자의 API 잔액 또는 결제 한도로 분석을 기다리고 있습니다. 원본과 완료된 결과는 유지하며 예정된 시각에 서버가 다시 연결을 확인합니다.';
      return store.update(key, value => {
        if (!value || value.leaseOwner !== owner || !validToken(token, value.tokenHash)) return value;
        if (value.cancelRequested || value.status === 'cancelled') return { ...value, status: 'cancelled', stage: 'cancelled', leaseOwner: null, leaseUntil: null, updatedAt: new Date().toISOString() };
        return { ...value, status: 'blocked', stage: 'quota', retryAt, error: { code: 'analysis_quota_exceeded', message }, progress: { ...(value.progress || {}), status: 'blocked', message }, leaseOwner: null, leaseUntil: null, updatedAt: new Date().toISOString() };
      });
    }
    const publicMessage = cancelled ? cancelledError().publicMessage : (error.publicMessage || '서버 분석을 마치지 못했습니다. 이미 저장된 관찰 결과는 유지됩니다.');
    job = await store.update(key, value => {
      if (!value || value.leaseOwner !== owner || !validToken(token, value.tokenHash)) return value;
      return { ...value, status: cancelled ? 'cancelled' : 'failed', stage: cancelled ? 'cancelled' : 'failed', error: { code: cancelled ? 'cancelled' : (error.code || 'worker_failed'), message: publicMessage }, progress: { ...(value.progress || {}), status: cancelled ? 'cancelled' : 'failed', message: publicMessage }, leaseOwner: null, leaseUntil: null, updatedAt: new Date().toISOString() };
    });
    return job;
  } finally {
    clearTimeout(budgetTimer);
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', externalAbort);
    try { await releaseProviderProbe(store, jobId, { provider }); } catch { /* The durable provider lease also expires if storage is unavailable during cleanup. */ }
  }
}

/** Trusted scheduler only. Rotating a hash allows recovery without saved raw tokens. */
export async function recoverGrowthJobs({ store, dispatchJob, now = Date.now(), maximum = 10, budgetMs = 20_000, signal, env = process.env } = {}) {
  if (!store || typeof dispatchJob !== 'function') throw workerError('분석 복구 실행기를 연결하지 못했습니다.', 'worker_configuration');
  const controller = new AbortController();
  const budget = Math.min(20_000, Math.max(20, Number.isFinite(budgetMs) ? budgetMs : 20_000));
  const deadline = Date.now() + budget;
  const owner = randomUUID();
  const providerKind = providerFor(env);
  const cloudflare = providerKind === 'cloudflare';
  const eligible = job => cloudflare ? cloudflareConsent(job) : job?.provider !== 'cloudflare';
  const recoveryKey = cloudflare ? 'recovery/growth-jobs/cloudflare' : 'recovery/growth-jobs';
  const deadlineError = () => workerError('분석 복구의 이번 실행 예산을 사용했습니다.', 'recovery_deadline');
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(deadlineError()); }, budget);
  const abort = () => controller.abort(signal.reason || deadlineError());
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const ensureActive = () => {
    if (controller.signal.aborted) throw controller.signal.reason || deadlineError();
    if (Date.now() >= deadline) { timedOut = true; controller.abort(deadlineError()); throw controller.signal.reason; }
  };
  // Store adapters may not support cancellation. Stop awaiting them at the
  // deadline; every later mutation still checks its lease or job token, and
  // already committed dispatch checkpoints remain recoverable next time.
  const within = action => {
    ensureActive();
    return new Promise((resolve, reject) => {
      const interrupted = () => reject(controller.signal.reason || deadlineError());
      controller.signal.addEventListener('abort', interrupted, { once: true });
      Promise.resolve().then(() => { ensureActive(); return action(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', interrupted));
    });
  };
  let dispatched = 0;
  let scanned = 0;
  let cursor = null;
  let claimed = false;
  let state;
  const checkpoint = async patch => {
    state = await within(() => store.update(recoveryKey, current => {
      ensureActive();
      if (current?.leaseOwner !== owner) throw workerError('다른 실행에서 분석 복구를 이어받았습니다.', 'recovery_lease_lost');
      return { ...current, ...patch, updatedAt: new Date().toISOString() };
    }));
    cursor = state.cursor || null;
  };
  try {
    state = await within(() => store.update(recoveryKey, current => {
      ensureActive();
      if (current?.leaseOwner && leaseTime(current.leaseUntil) > Date.now()) return current;
      return { ...(current || {}), leaseOwner: owner, leaseUntil: new Date(deadline + 5_000).toISOString() };
    }));
    if (state.leaseOwner !== owner) return { dispatched: 0, scanned: 0, timedOut: false, busy: true };
    claimed = true;
    const listed = await within(() => store.list(JOB_PREFIX));
    const keys = listed.map(item => typeof item === 'string' ? item : item.key).filter(Boolean).sort();
    const initialProvider = await within(() => readProviderStatus(store, { provider: providerKind }));
    if (!state.phase) await checkpoint({ phase: initialProvider.status === 'unknown' ? 'bootstrap' : 'jobs', cursor: null, latestQuotaAt: null });
    if (state.phase === 'bootstrap' && initialProvider.status === 'unknown') {
      // Bootstrap can span several scheduler invocations; save its own cursor
      // and latest real quota timestamp instead of restarting a long scan.
      let latest = Number.isFinite(state.latestQuotaAt) ? state.latestQuotaAt : null;
      for (const key of keys.filter(key => !state.cursor || key > state.cursor)) {
        const recorded = await within(() => store.get(key));
        if (eligible(recorded) && recorded?.status === 'failed' && recorded.error?.code === 'analysis_quota_exceeded') {
          const observedAt = Math.min(now, Date.parse(recorded.updatedAt || recorded.createdAt));
          if (Number.isFinite(observedAt)) latest = latest === null ? observedAt : Math.max(latest, observedAt);
        }
        await checkpoint({ phase: 'bootstrap', cursor: key, latestQuotaAt: latest });
      }
      if (latest !== null) await within(() => blockProviderQuota(store, { provider: providerKind, now: latest, onlyIfUnknown: true }));
      await checkpoint({ phase: 'jobs', cursor: null, latestQuotaAt: null });
    } else if (state.phase === 'bootstrap') await checkpoint({ phase: 'jobs', cursor: null, latestQuotaAt: null });
    const ordered = state.cursor ? [...keys.filter(key => key > state.cursor), ...keys.filter(key => key <= state.cursor)] : keys;
    for (const key of ordered) {
      if (dispatched >= maximum) break;
      ensureActive();
      const processJob = async () => {
        let previous = await within(() => store.get(key));
        if (!previous || previous.cancelRequested || !eligible(previous)) return;
        const legacyQuota = previous.status === 'failed' && previous.error?.code === 'analysis_quota_exceeded';
        const retentionOnly = cloudflare && retentionNeeded(previous);
        if (!['queued', 'running', 'blocked'].includes(previous.status) && !legacyQuota && !retentionOnly) return;
        if (leaseTime(previous.dispatchPendingUntil) > now || (previous.leaseOwner && leaseTime(previous.leaseUntil) > now) || (previous.status === 'queued' && Date.parse(previous.updatedAt || previous.createdAt) > now - 60_000)) return;
        const [account, workspace] = await within(() => Promise.all([store.get(`users/${previous.userId}`), store.get(`workspaces/${previous.userId}`)]));
        if (!account || account.deleting || workspace?.consents?.analysis !== true || !workspace.videos?.some(video => video.id === previous.videoId)) {
          await within(() => store.update(key, current => {
            ensureActive();
            return current && !current.cancelRequested && (['queued', 'running', 'blocked'].includes(current.status) || (current.status === 'failed' && current.error?.code === 'analysis_quota_exceeded') || (cloudflare && retentionNeeded(current))) ? { ...current, status: 'cancelled', stage: 'cancelled', cancelRequested: true, leaseOwner: null, leaseUntil: null, error: { code: 'analysis_consent_required', message: '계정·원본 또는 현재 분석 동의를 확인할 수 없어 자동 재개를 중단했습니다.' }, updatedAt: new Date(now).toISOString() } : current;
          }));
          return;
        }
        if (legacyQuota) {
          const observedAt = Math.min(now, Date.parse(previous.updatedAt || previous.createdAt));
          if (!Number.isFinite(observedAt)) return;
          const evidence = await within(() => blockProviderQuota(store, { provider: providerKind, now: observedAt, onlyIfUnknown: true }));
          previous = await within(() => store.update(key, current => {
            ensureActive();
            return current?.status === 'failed' && current.error?.code === 'analysis_quota_exceeded' && !current.cancelRequested ? { ...current, status: 'blocked', stage: 'quota', retryAt: evidence.status === 'quota_exceeded' ? evidence.retryAt : null, quotaMigratedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() } : current;
          }));
        }
        if (!retentionOnly) {
          const provider = await within(() => readProviderStatus(store, { provider: providerKind }));
          if (provider.status === 'quota_exceeded') {
            if (leaseTime(provider.retryAt) > now) return;
            const probe = await within(() => claimProviderProbe(store, previous.id, { provider: providerKind, now }));
            if (!probe.allowed) return;
          } else if (previous.status === 'blocked' && provider.status !== 'ready') return;
        }
        const token = randomBytes(32).toString('base64url');
        const digest = tokenHash(token);
        const job = await within(() => store.update(key, current => {
          ensureActive();
          if (!current || !eligible(current) || current.cancelRequested || (!['queued', 'running', 'blocked'].includes(current.status) && !(cloudflare && retentionNeeded(current))) || leaseTime(current.dispatchPendingUntil) > now || (current.leaseOwner && leaseTime(current.leaseUntil) > now) || (current.status === 'queued' && Date.parse(current.updatedAt || current.createdAt) > now - 60_000)) return current;
          return { ...current, status: retentionOnly ? 'completed' : 'queued', tokenHash: digest, leaseOwner: null, leaseUntil: null, dispatchPendingUntil: new Date(now + 60_000).toISOString(), recoveryAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
        }));
        if (!job || job.tokenHash !== digest) return;
        try {
          await within(() => dispatchJob(job.id, token, { signal: controller.signal, timeoutMs: Math.max(1, Math.min(8_000, deadline - Date.now() - 250)) }));
          dispatched += 1;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // No raw token is saved; a later invocation rotates the queued job.
        }
      };
      scanned += 1;
      await checkpoint({ phase: 'jobs', cursor: key });
      // Advance the scan cursor before a potentially slow network dispatch.
      // The job itself already retains its retry/dispatch checkpoint, so a
      // timed-out attempt is revisited after other keys instead of starving
      // every later job at the beginning of each scheduler invocation.
      await processJob();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    if (claimed && !controller.signal.aborted) {
      try { await within(() => store.update(recoveryKey, current => current?.leaseOwner === owner ? { ...current, leaseOwner: null, leaseUntil: null } : current)); }
      catch (error) { if (!controller.signal.aborted) throw error; }
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  return { dispatched, scanned, timedOut, cursor };
}
