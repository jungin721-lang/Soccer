import { CLIP_LIMITS, planVideoClips, formatClipTime, videoClipSupport, inspectClipSource, createVideoClip } from './video-clips.js';
import { createVideoClipBundle } from './video-clips-bundle.js';
import { KIT_LABELS, parseFeedbackFragment } from './feedback.js';
import { planTargetClips } from './target-clips.js';

let targetReport = null;
let targetReportError = null;
let evidenceClips = [];
if (location.hash.startsWith('#report')) {
  const privateFragment = location.hash;
  const priorState = history.state && typeof history.state === 'object' && !Array.isArray(history.state) ? history.state : {};
  history.replaceState({ ...priorState, videoClipMode: 'evidence' }, '', `${location.pathname}${location.search}`);
  try {
    targetReport = parseFeedbackFragment(privateFragment);
    evidenceClips = planTargetClips(targetReport);
    if (!evidenceClips.length) throw new Error('확인된 대상 선수의 근거 시각이 없어요.');
  } catch (error) {
    targetReport = null;
    targetReportError = error?.message || '피드백의 근거 시각을 읽지 못했어요.';
  }
} else if (history.state?.videoClipMode === 'evidence') {
  targetReportError = '주소에서 지운 비공개 피드백 정보는 새로고침 후 남아 있지 않아요. 피드백에서 근거 장면 만들기를 다시 열어 주세요.';
}

const $ = selector => document.querySelector(selector);
const form = $('#video-clips-form');
const picker = $('#clip-video-file');
const player = $('#clip-preview');
const support = videoClipSupport();
const objectURLs = new Set();
let source = null;
let metadata = null;
let clips = [];
let currentIndex = 0;
let result = null;
let controller = null;
let busy = false;
let job = null;
let pausedJob = null;
let pauseReason = null;
let hasError = false;
let wakeLock = null;
let wakePending = false;
let sharing = false;
let pendingRelease = null;

const formatBytes = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const absoluteTime = value => formatClipTime(value);
const sourceRange = clip => `${absoluteTime(clip.start)} – ${absoluteTime(clip.end)}`;
const outputURL = file => { const url = URL.createObjectURL(file); objectURLs.add(url); return url; };

function notice(message) {
  $('#clip-notice').textContent = message;
  $('#clip-notice').hidden = !message;
}

function clearError() {
  hasError = false;
  $('#clip-error').hidden = true;
  $('#clip-error-message').textContent = '';
}

function showError(error) {
  hasError = true;
  $('#clip-error-message').textContent = error?.message || '이 기기에서 영상을 만들지 못했어요. 원본을 다시 확인해 주세요.';
  $('#clip-error').hidden = false;
  $('#retry-clip').textContent = metadata ? '현재 구간 다시 시도' : '원본 다시 확인하기';
  updateControls();
  $('#clip-error').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function clearOutput() {
  player.pause();
  player.removeAttribute('src');
  player.load();
  for (const url of objectURLs) URL.revokeObjectURL(url);
  objectURLs.clear();
  result = null;
  if (pausedJob === 'bundle') pausedJob = 'create';
  pendingRelease = null;
  $('#clip-result').hidden = true;
  $('#discard-confirm').hidden = true;
  $('#clip-save-confirm').checked = false;
  $('#confirm-next').disabled = true;
  $('#download-clip').removeAttribute('href');
  $('#download-manifest').removeAttribute('href');
  $('#download-clip-bundle').removeAttribute('href');
  $('#download-clip-bundle').hidden = true;
  $('#download-clip-zip').hidden = false;
  $('#clip-prompt').value = '';
  $('#clip-save-status').textContent = '';
  $('#clip-share-status').textContent = '';
  $('#clip-copy-status').textContent = '';
  $('#clip-bundle-status').textContent = '';
}

function updateControls() {
  const locked = busy || Boolean(result);
  for (const field of form.querySelectorAll('input, select, button')) field.disabled = locked || !support.supported || Boolean(targetReportError);
  if (targetReport) for (const field of [$('#clip-target-kit'), $('#clip-target-number'), $('#clip-target-age'), $('#clip-length')]) field.disabled = true;
  $('#target-source-confirm').disabled = locked || !metadata || !targetReport || !support.supported;
  const valid = Boolean(source && metadata && clips.length && $('#clip-rights-consent').checked && (!targetReport || $('#target-source-confirm').checked) && !targetReportError && form.checkValidity());
  const create = $('#create-first-clip');
  create.disabled = busy || !support.supported || !valid;
  create.hidden = Boolean(result || pausedJob || hasError);
  create.querySelector('span').textContent = targetReport ? currentIndex === 0 ? '첫 근거 영상 만들기' : `${currentIndex + 1}번째 근거 영상 만들기` : currentIndex === 0 ? '첫 번째 영상 만들기' : `${currentIndex + 1}번째 영상 만들기`;
  $('#clip-form-note').textContent = targetReportError ? '피드백에서 근거 장면 만들기를 다시 열어 주세요.' : !support.supported ? '영상 생성 기능을 지원하는 브라우저가 필요해요.' : result ? targetReport ? '원본을 바꾸려면 아래의 ‘원본 영상 다시 선택’을 눌러 주세요.' : '선수 정보와 원본을 바꾸려면 아래의 ‘원본·선수 정보 바꾸기’를 눌러 주세요.' : busy ? '현재 작업이 끝나면 설정을 바꿀 수 있어요.' : pausedJob ? '부분 생성 파일은 보관하지 않아요. 아래에서 현재 구간을 처음부터 다시 시작해 주세요.' : targetReport ? '원본 길이를 확인한 뒤 위의 동일 원본 확인과 공유 동의에 체크해 주세요.' : '원본과 선수 정보를 확인하고 공유 동의에 체크해 주세요.';
  form.setAttribute('aria-busy', String(busy));
  $('#cancel-clip').disabled = !busy || Boolean(controller?.signal.aborted);
  $('#resume-clip').hidden = !pausedJob || busy || !support.supported;
  $('#resume-clip').textContent = pausedJob === 'inspect' ? '원본 다시 확인하기' : pausedJob === 'bundle' ? '채팅용 ZIP 다시 만들기' : '현재 구간 다시 만들기';
  $('#retry-clip').hidden = !source || busy || !support.supported;
  for (const button of [$('#next-clip'), $('#reset-clips'), $('#share-clip'), $('#download-clip-zip')]) button.disabled = busy || sharing;
  $('#confirm-next').disabled = !$('#clip-save-confirm').checked || busy || sharing;
  for (const link of document.querySelectorAll('.exit-link')) {
    if (busy) link.setAttribute('aria-disabled', 'true');
    else link.removeAttribute('aria-disabled');
  }
}

function renderPlan() {
  $('#clip-plan').hidden = !metadata || !clips.length;
  if (!metadata || !clips.length) return;
  const completed = currentIndex + (result ? 1 : 0);
  $('#clip-plan-count').textContent = `총 ${clips.length}개`;
  $('#clip-plan-summary').textContent = targetReport ? `${absoluteTime(metadata.duration)} 원본 · 확인된 근거 앞 3초·뒤 5초 · 현재 ${completed} / ${clips.length}개 생성` : `${absoluteTime(metadata.duration)} 원본 · 앞 ${CLIP_LIMITS.overlapSeconds}초 겹침 · 현재 ${completed} / ${clips.length}개 생성`;
  const list = $('#clip-plan-list');
  list.replaceChildren();
  const first = currentIndex > 3 ? currentIndex - 2 : 0;
  const visibleClips = clips.slice(first, first + 6);
  for (let offset = 0; offset < visibleClips.length; offset++) {
    const clip = visibleClips[offset];
    const index = first + offset;
    const item = document.createElement('li');
    if (index === currentIndex) item.className = result ? 'done' : 'current';
    else if (index < currentIndex) item.className = 'done';
    const title = document.createElement('span');
    title.textContent = `${String(index + 1).padStart(2, '0')} 영상${index < completed ? ' · 생성함' : index === currentIndex ? ' · 현재' : ''}`;
    const range = document.createElement('span');
    range.textContent = sourceRange(clip);
    item.append(title, range);
    list.append(item);
  }
  const unshown = clips.length - visibleClips.length;
  $('#clip-plan-more').hidden = unshown === 0;
  $('#clip-plan-more').textContent = `현재 구간 주변을 표시했어요. 나머지 ${unshown}개도 같은 순서로 이어집니다.`;
}

function rebuildPlan() {
  currentIndex = 0;
  pausedJob = null;
  clips = !metadata || targetReportError ? [] : targetReport ? evidenceClips.map(clip => ({ ...clip, end: Math.min(clip.end, metadata.duration), duration: Math.min(clip.end, metadata.duration) - clip.start })) : planVideoClips(metadata.duration, { chunkSeconds: Number($('#clip-length').value), overlapSeconds: CLIP_LIMITS.overlapSeconds });
  renderPlan();
  updateControls();
}

function readTarget() {
  if (targetReport) return { ...targetReport.target };
  return { kit: $('#clip-target-kit').value, number: Number($('#clip-target-number').value), age: Number($('#clip-target-age').value) };
}

async function releaseScreen() {
  const lock = wakeLock;
  wakeLock = null;
  try { await lock?.release(); } catch { /* Browsers may release the lock before this call. */ }
}

async function keepScreenAwake() {
  if (!busy || document.hidden || wakeLock || wakePending) return;
  if (!navigator.wakeLock?.request) {
    $('#clip-wake-note').textContent = '이 브라우저는 화면 유지 요청을 지원하지 않아요. 자동 잠금을 늦추고 화면을 켜 두세요. 다른 앱으로 이동하면 현재 구간을 중단합니다.';
    return;
  }
  wakePending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!busy || document.hidden || controller?.signal.aborted) { await lock.release(); return; }
    wakeLock = lock;
    $('#clip-wake-note').textContent = '화면 유지가 요청됐어요. 기기 설정에 따라 잠길 수 있으니 이 페이지를 계속 열어 두세요. 다른 앱으로 이동하면 현재 구간을 중단합니다.';
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
      if (busy && !document.hidden && !controller?.signal.aborted) void keepScreenAwake();
    }, { once: true });
  } catch {
    $('#clip-wake-note').textContent = '화면 유지 요청을 사용할 수 없어요. 자동 잠금을 늦추고 화면을 켜 두세요. 다른 앱으로 이동하면 현재 구간을 중단합니다.';
  } finally { wakePending = false; }
}

function setBusy(value) {
  busy = value;
  if (value) $('#cancel-clip').textContent = '만들기 취소';
  $('#clip-progress').hidden = !value;
  updateControls();
  if (value) void keepScreenAwake();
  else void releaseScreen();
}

function progress(update, signal) {
  if (signal.aborted) return;
  const titles = {
    inspecting: '원본 영상을 확인하고 있어요', opening: '현재 구간을 열고 있어요', preparing: '현재 구간을 준비하고 있어요',
    seeking: '구간의 시작으로 이동하고 있어요', recording: '영상의 움직임을 담고 있어요',
    encoding: '작은 영상으로 만들고 있어요', finalizing: '파일과 기록을 마무리하고 있어요',
    packaging: '파일과 기록을 마무리하고 있어요', completed: '현재 영상이 준비됐어요', complete: '현재 영상이 준비됐어요'
  };
  $('#clip-progress-title').textContent = titles[update.phase] || '현재 구간을 만들고 있어요';
  $('#clip-progress-message').textContent = update.message || '화면을 켜 두고 이 페이지를 유지해 주세요.';
  const total = Number(update.total);
  const completed = Number(update.completed);
  const measurable = Number.isFinite(total) && total > 0 && Number.isFinite(completed);
  const percent = measurable ? Math.max(0, Math.min(100, Math.round(completed / total * 100))) : 0;
  const bar = $('#clip-progress-bar');
  bar.setAttribute('aria-valuenow', String(percent));
  bar.setAttribute('aria-valuetext', measurable ? `${percent}%` : '진행 확인 중');
  bar.querySelector('span').style.width = `${percent}%`;
  $('#clip-progress-count').textContent = job === 'create' ? `${currentIndex + 1} / ${clips.length}번째 영상 · 원본 ${sourceRange(clips[currentIndex])}${measurable ? ` · 현재 단계 ${percent}%` : ''}` : job === 'bundle' ? '이미 완성된 영상과 JSON만 묶어요. 원본은 다시 읽지 않습니다.' : '파일 크기와 스마트폰 성능에 따라 시간이 달라요.';
}

function handleInterruption(task) {
  if (task === 'bundle' && !result) task = 'create';
  pausedJob = task;
  if (task === 'bundle') {
    notice('ZIP 만들기를 중단했어요. 완성된 영상과 JSON은 그대로예요. 아래 버튼을 눌러 ZIP을 다시 만들 수 있습니다.');
    return;
  }
  notice(pauseReason === 'hidden' ? '화면이 잠기거나 다른 앱으로 이동해 현재 작업을 중단했어요. 이 페이지로 돌아온 뒤 아래 버튼을 누르면 현재 구간을 처음부터 다시 시작해요.' : '만들기를 취소했어요. 원본은 그대로이며, 완성되지 않은 임시 파일은 해제했어요. 아래 버튼으로 다시 시작할 수 있습니다.');
}

async function inspectSource() {
  if (!source || busy || !support.supported || targetReportError) return;
  clearError();
  notice('');
  pausedJob = null;
  pauseReason = null;
  job = 'inspect';
  const taskController = new AbortController();
  controller = taskController;
  setBusy(true);
  progress({ phase: 'inspecting', message: '길이와 해상도를 이 기기에서 확인해요.' }, taskController.signal);
  try {
    const inspected = await inspectClipSource(source, { signal: taskController.signal });
    if (taskController.signal.aborted) { handleInterruption('inspect'); return; }
    if (!Number.isFinite(inspected.duration) || inspected.duration <= 0 || !inspected.width || !inspected.height) throw new Error('원본의 길이나 해상도를 읽을 수 없어요. 이 브라우저에서 재생할 수 있는 영상을 선택해 주세요.');
    if (targetReport && Math.abs(inspected.duration - targetReport.source.durationSeconds) > 0.2) throw new Error(`피드백의 원본 길이(${absoluteTime(targetReport.source.durationSeconds)})와 선택한 영상(${absoluteTime(inspected.duration)})이 달라요. 이 피드백을 받은 동일한 원본 영상을 선택해 주세요. 다른 영상에서는 근거 구간을 만들 수 없습니다.`);
    metadata = inspected;
    $('#clip-source-duration').textContent = absoluteTime(metadata.duration);
    $('#clip-source-dimensions').textContent = `${metadata.width} × ${metadata.height}`;
    $('#clip-output-format').textContent = `${String(support.extension || '').replace(/^\./, '').toUpperCase()} · ${support.mimeType}`;
    $('#clip-metadata').hidden = false;
    rebuildPlan();
  } catch (error) {
    if (taskController.signal.aborted || error?.name === 'AbortError') handleInterruption('inspect');
    else showError(error);
  } finally {
    controller = null;
    job = null;
    setBusy(false);
  }
}

function chooseSource(file) {
  if (!file || busy || result || targetReportError) return;
  clearError();
  notice('');
  clearOutput();
  source = null;
  metadata = null;
  clips = [];
  currentIndex = 0;
  pausedJob = null;
  $('#target-source-confirm').checked = false;
  $('#clip-selected-file').hidden = true;
  $('#clip-metadata').hidden = true;
  $('#clip-plan').hidden = true;
  $('#clip-file-label').textContent = '사진·파일에서 원본 선택';
  if (!file.size) { showError(new Error('비어 있는 영상이에요. 원본을 다시 선택해 주세요.')); return; }
  if (file.size > CLIP_LIMITS.maxSourceBytes) { showError(new Error('원본은 최대 8GiB (약 8.6GB)까지 선택할 수 있어요. 더 작은 영상을 선택해 주세요.')); return; }
  if (!String(file.type).toLowerCase().startsWith('video/') && !/\.(mp4|mov|m4v|webm|3gp)$/i.test(file.name)) { showError(new Error('영상 파일을 선택해 주세요. 사진이나 압축 파일은 사용할 수 없어요.')); return; }
  source = file;
  $('#clip-file-name').textContent = file.name;
  $('#clip-file-size').textContent = `${formatBytes(file.size)} · 원본 전송 없음`;
  $('#clip-selected-file').hidden = false;
  $('#clip-file-label').textContent = '다른 원본 영상 선택';
  updateControls();
  void inspectSource();
}

function createPrompt(clip, actual, target, kitLabel) {
  return [
    `이 영상의 실제 범위는 원본의 절대시각 ${sourceRange(actual)}입니다. 계획한 범위는 ${sourceRange(clip)}이며, 전체 ${clips.length}개 중 ${currentIndex + 1}번째 영상입니다. 원본 전체를 분석한 결과는 아닙니다.`,
    '영상 안 재생시간과 원본 시각의 대응은 함께 첨부한 JSON 기록의 source.timeMap을 참고해 주세요.',
    `대상은 ${kitLabel} 유니폼, 등번호 ${target.number}번, ${target.age}세 선수입니다. 이 정보는 사용자가 입력한 설명이며 자동 식별 결과가 아닙니다.`,
    targetReport ? '이 구간은 이전 피드백에 기록된 근거 시각의 앞 3초·뒤 5초를 포함해 준비했습니다. 겹치는 근거 구간은 합쳤습니다. 이 페이지에서 새로운 선수 탐색이나 자동 식별을 실행한 것은 아닙니다.' : currentIndex > 0 ? `앞 구간과 처음 ${Math.min(CLIP_LIMITS.overlapSeconds, clip.duration)}초가 겹칩니다. 겹친 장면을 중복으로 세지 말아 주세요.` : '이 영상은 원본의 첫 구간입니다.',
    '등번호로 대상이 확인될 때만 관찰을 연결해 주세요. 번호가 읽히지 않으면 ‘식별 불가’, 화면 밖 행동은 ‘확인 불가’로 표시해 주세요. 원본 절대시각과 함께 실제로 보이는 행동, 잘한 점, 다음 연습을 알려 주세요. 모든 플레이를 확인했다고 단정하지 말아 주세요.'
  ].join('\n\n');
}

function showResult(output, clip, target, kitLabel) {
  const file = output.file;
  if (!(file instanceof Blob) || !file.size) throw new Error('완성된 영상 파일이 비어 있어요. 현재 구간을 다시 시도해 주세요.');
  if (file.size > CLIP_LIMITS.maxClipBytes) throw new Error('완성 파일이 24MiB 제한을 넘었어요. 30초 모드로 바꿔 다시 시도해 주세요.');
  const mime = String(file.type).toLowerCase();
  const extension = mime.startsWith('video/mp4') ? 'mp4' : mime.startsWith('video/webm') ? 'webm' : null;
  if (!extension) throw new Error('생성된 영상 형식을 확인하지 못했어요. 파일이 준비됐다고 표시할 수 없습니다.');
  if (!output.manifest || typeof output.manifest !== 'object') throw new Error('원본 시각 기록을 만들지 못했어요. 현재 구간을 다시 시도해 주세요.');
  const baseName = (file.name || `NEXT-XI-clip-${String(currentIndex + 1).padStart(3, '0')}`).replace(/\.[^/.]+$/, '');
  const videoFile = file instanceof File && file.name.toLowerCase().endsWith(`.${extension}`) ? file : new File([file], `${baseName}.${extension}`, { type: file.type });
  const manifestFile = new File([JSON.stringify(output.manifest, null, 2)], `${baseName}.manifest.json`, { type: 'application/json' });
  const recorded = output.manifest.source?.actual;
  const actual = recorded && Number.isFinite(recorded.start) && Number.isFinite(recorded.end) ? recorded : clip;
  result = { file: videoFile, manifest: output.manifest, manifestFile, clip, requestedSave: false, requestedManifest: false, shared: false, bundle: null };
  player.muted = true;
  player.defaultMuted = true;
  player.src = outputURL(videoFile);
  player.load();
  $('#download-clip').href = outputURL(videoFile);
  $('#download-clip').download = videoFile.name;
  $('#download-clip').textContent = `${extension.toUpperCase()} 영상 다운로드`;
  $('#download-manifest').href = outputURL(manifestFile);
  $('#download-manifest').download = manifestFile.name;
  $('#clip-result-title').textContent = `${currentIndex + 1}번째 ${targetReport ? '근거 ' : ''}영상이 준비됐어요`;
  $('#clip-result-summary').textContent = `전체 ${clips.length}개 중 ${currentIndex + 1}개 생성 · 실제 원본 ${sourceRange(actual)} · ${formatBytes(videoFile.size)}`;
  $('#clip-result-format').textContent = `${extension.toUpperCase()} · ${videoFile.type}`;
  $('#clip-prompt').value = createPrompt(clip, actual, target, kitLabel);
  $('#clip-save-status').textContent = '아직 저장·공유를 요청하지 않았어요. 다운로드 버튼은 저장 요청이며 실제 기기 저장 완료를 확인할 수는 없습니다.';
  $('#clip-share-status').textContent = '';
  $('#clip-copy-status').textContent = '';
  $('#clip-bundle-status').textContent = '영상 첨부가 안 되면 채팅용 ZIP을 만드세요. 영상과 JSON 기록만 묶으며, ZIP도 채팅에서 허용해야 첨부할 수 있어요.';
  const hasNext = currentIndex < clips.length - 1;
  $('#next-clip').hidden = !hasNext;
  $('#clip-next-title').textContent = hasNext ? '저장을 확인하고 다음 구간으로' : targetReport ? '기록된 근거 구간을 모두 만들었어요' : '계획한 모든 구간을 만들었어요';
  $('#clip-next-help').textContent = hasNext ? `다음은 ${currentIndex + 2}번째 영상 · 원본 ${sourceRange(clips[currentIndex + 1])}입니다. 진행하면 지금 영상의 미리보기와 임시 파일이 해제돼요.` : '이전 구간의 저장 여부는 확인할 수 없어요. 마지막 영상과 기록도 직접 저장해 주세요. 분석이나 외부 전송은 실행되지 않았습니다.';
  $('#clip-result').hidden = false;
  renderPlan();
  $('#clip-result-title').focus({ preventScroll: true });
  $('#clip-result').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function makeCurrentClip() {
  if (busy || result || !support.supported || !source || targetReportError) return;
  if (!metadata) { await inspectSource(); return; }
  if (!form.reportValidity() || !$('#clip-rights-consent').checked) return;
  if (targetReport && !$('#target-source-confirm').checked) { notice('위에서 피드백을 받은 동일한 원본인지 확인해 주세요.'); $('#target-source-confirm').focus(); return; }
  const clip = clips[currentIndex];
  if (!clip) return;
  const target = readTarget();
  const kitLabel = targetReport ? KIT_LABELS[target.kit] : $('#clip-target-kit').selectedOptions[0].textContent;
  clearError();
  notice('');
  pausedJob = null;
  pauseReason = null;
  job = 'create';
  const taskController = new AbortController();
  controller = taskController;
  setBusy(true);
  progress({ phase: 'preparing', message: '현재 구간을 작은 연속 영상으로 만들어요.' }, taskController.signal);
  $('#clip-progress').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  try {
    const output = await createVideoClip(source, { clip, target, signal: taskController.signal, onProgress: update => progress(update, taskController.signal) });
    if (taskController.signal.aborted) { handleInterruption('create'); return; }
    showResult(output, clip, target, kitLabel);
  } catch (error) {
    if (taskController.signal.aborted || error?.name === 'AbortError') handleInterruption('create');
    else showError(error);
  } finally {
    controller = null;
    job = null;
    setBusy(false);
  }
}

async function makeBundle() {
  if (!result || busy || sharing || result.bundle) return;
  const current = result;
  clearError();
  notice('');
  pausedJob = null;
  pauseReason = null;
  job = 'bundle';
  const taskController = new AbortController();
  controller = taskController;
  setBusy(true);
  progress({ phase: 'packaging', message: '완성된 영상과 JSON 기록을 채팅용 ZIP으로 묶고 있어요.' }, taskController.signal);
  try {
    const bundle = await createVideoClipBundle({ file: current.file, manifest: current.manifest }, { signal: taskController.signal });
    if (taskController.signal.aborted) { handleInterruption('bundle'); return; }
    if (!(bundle instanceof Blob) || !bundle.size || bundle.size > 25 * 1024 ** 2) throw new Error('ZIP이 비어 있거나 25MiB 제한을 넘었어요. 영상과 JSON을 각각 다운로드해 주세요.');
    current.bundle = bundle;
    $('#download-clip-bundle').href = outputURL(bundle);
    $('#download-clip-bundle').download = bundle.name || `NEXT-XI-clip-${currentIndex + 1}.zip`;
    $('#download-clip-bundle').hidden = false;
    $('#download-clip-zip').hidden = true;
    $('#clip-bundle-status').textContent = `ZIP 준비 완료 · ${formatBytes(bundle.size)}. ‘채팅용 ZIP 다운로드’를 눌러 저장한 뒤 이 채팅에 첨부해 주세요. ZIP 생성만으로 기기에 저장되지는 않습니다.`;
    $('#download-clip-bundle').focus({ preventScroll: true });
  } catch (error) {
    if (taskController.signal.aborted || error?.name === 'AbortError') handleInterruption('bundle');
    else {
      $('#clip-bundle-status').textContent = error?.message || 'ZIP을 만들지 못했어요. 영상과 JSON을 각각 다운로드해 주세요.';
      notice('ZIP을 만들지 못했지만 완성된 영상과 JSON은 그대로예요. 각각 저장하거나 ZIP 만들기를 다시 시도해 주세요.');
    }
  } finally {
    controller = null;
    job = null;
    setBusy(false);
  }
}

function requestRelease(action) {
  if (!result || busy || sharing) return;
  pendingRelease = action;
  player.pause();
  $('#clip-save-confirm').checked = false;
  $('#confirm-next').disabled = true;
  $('#discard-confirm-message').textContent = result.requestedSave || result.shared ? '저장 요청이나 공유 창 완료만으로 기기 저장을 보장할 수 없어요. 파일 앱이나 받은 채팅을 확인해 주세요. 진행하면 현재 영상과 기록의 임시 파일을 해제합니다.' : '현재 영상의 저장·공유를 아직 요청하지 않았어요. 진행하면 지금 영상과 기록의 임시 파일이 해제되어 이 페이지에서 다시 저장할 수 없습니다. 먼저 다운로드하거나, 해제에 동의해 주세요.';
  $('#confirm-next').textContent = action === 'next' ? targetReport ? '확인하고 다음 근거 영상 만들기' : '확인하고 다음 영상 만들기' : '확인하고 새로 준비하기';
  $('#discard-confirm').hidden = false;
  $('#discard-confirm').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('#clip-save-confirm').focus({ preventScroll: true });
}

picker.addEventListener('change', event => {
  const file = event.target.files?.[0];
  picker.value = '';
  chooseSource(file);
});
$('#replace-clip-file').addEventListener('click', () => { if (!busy && !result) picker.click(); });
$('#choose-another-clip').addEventListener('click', () => { if (!busy && !result) picker.click(); });
form.addEventListener('submit', event => { event.preventDefault(); void makeCurrentClip(); });
$('#clip-rights-consent').addEventListener('change', updateControls);
$('#target-source-confirm').addEventListener('change', updateControls);
$('#clip-length').addEventListener('change', () => {
  if (busy || result) return;
  clearError();
  rebuildPlan();
  notice(metadata ? '영상 길이가 바뀌어 전체 계획을 처음부터 다시 준비했어요. 이전에 저장한 자료는 원본 시각으로 구분해 주세요.' : '');
});
for (const field of [$('#clip-target-kit'), $('#clip-target-number'), $('#clip-target-age')]) {
  field.addEventListener('input', () => {
    if (busy || result) return;
    clearError();
    rebuildPlan();
  });
}
$('#cancel-clip').addEventListener('click', () => {
  if (!busy || !controller) return;
  pauseReason = 'cancel';
  controller.abort();
  $('#cancel-clip').textContent = '임시 파일을 정리하고 있어요…';
  updateControls();
});
$('#resume-clip').addEventListener('click', () => { if (pausedJob === 'inspect') void inspectSource(); else if (pausedJob === 'bundle') void makeBundle(); else void makeCurrentClip(); });
$('#retry-clip').addEventListener('click', () => { if (metadata) void makeCurrentClip(); else void inspectSource(); });
$('#download-clip').addEventListener('click', () => {
  if (!result) return;
  result.requestedSave = true;
  $('#clip-save-status').textContent = '영상 다운로드를 요청했어요. 저장 완료는 확인할 수 없으니 파일 앱·다운로드 폴더에서 확인해 주세요. JSON 기록도 별도로 저장해 주세요.';
});
$('#download-manifest').addEventListener('click', () => {
  if (!result) return;
  result.requestedManifest = true;
  $('#clip-save-status').textContent = `JSON 기록 다운로드를 요청했어요.${result.requestedSave ? ' 영상도 다운로드를 요청한 상태예요.' : ' 영상은 별도로 다운로드해 주세요.'} 실제 저장 여부는 파일 앱·다운로드 폴더에서 확인해 주세요.`;
});
$('#download-clip-zip').addEventListener('click', () => { void makeBundle(); });
$('#download-clip-bundle').addEventListener('click', () => {
  if (!result?.bundle) return;
  result.requestedSave = true;
  result.requestedManifest = true;
  $('#clip-save-status').textContent = '영상과 JSON을 담은 ZIP 다운로드를 요청했어요. 실제 저장 완료는 확인할 수 없으니 파일 앱·다운로드 폴더에서 확인해 주세요.';
});
$('#share-clip').addEventListener('click', async () => {
  if (!result || sharing || busy) return;
  const files = [result.file, result.manifestFile];
  let supported = false;
  try { supported = typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files }); } catch { /* Fall back to two visible downloads. */ }
  if (!supported) {
    $('#clip-share-status').textContent = '이 브라우저는 영상과 JSON 두 파일의 공유를 지원하지 않아요. 위의 영상·JSON 다운로드 버튼으로 각각 저장한 뒤 직접 첨부해 주세요.';
    return;
  }
  sharing = true;
  updateControls();
  try {
    await navigator.share({ files, title: `NEXT XI · ${currentIndex + 1}번째 경기 영상` });
    if (result) result.shared = true;
    $('#clip-share-status').textContent = '공유 창이 완료됐어요. 실제 파일 저장이나 채팅 전송 여부는 선택한 앱에서 확인해 주세요.';
  } catch (error) {
    $('#clip-share-status').textContent = error?.name === 'AbortError' ? '공유를 취소했어요. 현재 영상과 기록은 그대로예요.' : '공유하지 못했어요. 영상과 JSON을 각각 다운로드해 직접 첨부해 주세요.';
  } finally { sharing = false; updateControls(); }
});
$('#copy-clip-prompt').addEventListener('click', async () => {
  const prompt = $('#clip-prompt');
  if (!prompt.value) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(prompt.value);
    $('#clip-copy-status').textContent = '설명을 복사했어요. 영상·기록과 함께 채팅에 붙여 넣어 주세요.';
  } catch {
    prompt.focus();
    prompt.select();
    prompt.setSelectionRange(0, prompt.value.length);
    $('#clip-copy-status').textContent = '설명을 선택했어요. 길게 눌러 복사한 뒤 채팅에 붙여 넣어 주세요.';
  }
});
$('#next-clip').addEventListener('click', () => requestRelease('next'));
$('#reset-clips').addEventListener('click', () => requestRelease('reset'));
$('#clip-save-confirm').addEventListener('change', updateControls);
$('#keep-current-clip').addEventListener('click', () => {
  pendingRelease = null;
  $('#discard-confirm').hidden = true;
  $('#clip-save-confirm').checked = false;
});
$('#confirm-next').addEventListener('click', () => {
  if (!result || busy || sharing || !$('#clip-save-confirm').checked) return;
  const action = pendingRelease;
  if (!action) return;
  const nextIndex = currentIndex + 1;
  clearOutput();
  clearError();
  pausedJob = null;
  if (action === 'next' && nextIndex < clips.length) {
    currentIndex = nextIndex;
    renderPlan();
    updateControls();
    void makeCurrentClip();
  } else {
    rebuildPlan();
    notice(targetReport ? '현재 영상과 기록의 임시 파일을 해제했어요. 피드백을 받은 원본을 다시 선택할 수 있습니다. 대상 선수와 근거 시각은 그대로이며, 첫 번째 근거 영상부터 다시 시작해요.' : '현재 영상과 기록의 임시 파일을 해제했어요. 원본·선수 정보·영상 길이를 바꿀 수 있습니다. 계획은 첫 번째 영상부터 다시 시작해요.');
    $('#setup-title').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && busy && controller && !controller.signal.aborted) {
    pauseReason = 'hidden';
    controller.abort();
    updateControls();
    void releaseScreen();
  } else if (!document.hidden && busy && !controller?.signal.aborted) void keepScreenAwake();
});
for (const link of document.querySelectorAll('.exit-link')) link.addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (busy) {
    event.preventDefault();
    notice('작업 중이에요. 먼저 만들기를 취소한 뒤 이동해 주세요.');
  } else if (result) {
    if (!window.confirm('이 페이지를 나가면 현재 영상과 기록의 임시 파일이 해제됩니다. 파일 앱에서 저장을 확인했거나, 자료를 해제하고 이동해도 될까요?')) event.preventDefault();
    else clearOutput();
  }
});
window.addEventListener('beforeunload', event => {
  if (busy || result) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => {
  if (controller && !controller.signal.aborted) controller.abort();
  void releaseScreen();
  clearOutput();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  renderPlan();
  updateControls();
  if (source && !busy) notice('이 페이지를 떠날 때 임시 파일을 해제했어요. 원본을 다시 선택할 필요 없이 현재 구간을 다시 만들 수 있습니다.');
});

if (targetReport) {
  document.body.classList.add('target-report-mode');
  document.title = '확인된 피드백 장면만 만들기 · NEXT XI';
  $('#page-title').textContent = '확인된 장면만,\n작은 영상으로.';
  $('.hero-copy > p:not(.eyebrow)').textContent = '이전에 확인한 근거 시각 주변만 준비해요.\n피드백을 받은 원본을 한 번 선택해 주세요.';
  $('.art-note').textContent = '근거 앞 3초 · 뒤 5초';
  $('.shirt').textContent = targetReport.target.number;
  const intro = $('.intro-note > span:last-child');
  const title = document.createElement('strong');
  title.textContent = '확인된 피드백 장면만 준비해요.';
  intro.replaceChildren(title, document.createTextNode('이전에 확인한 근거 시각을 사용합니다. 새로운 선수 탐색이나 자동 식별은 실행하지 않아요.'));
  $('#target-report-banner').hidden = false;
  $('#target-report-summary').textContent = `${targetReport.title} · ${KIT_LABELS[targetReport.target.kit]} ${targetReport.target.number}번 · ${targetReport.target.age}세 · 근거 영상 ${evidenceClips.length}개`;
  $('#clip-target-kit').value = targetReport.target.kit;
  $('#clip-target-number').value = targetReport.target.number;
  $('#clip-target-age').value = targetReport.target.age;
  $('#clip-target-kit').closest('fieldset').querySelector('.help').textContent = '이전 피드백에 기록된 대상 선수 정보예요. 이 모드에서는 바꿀 수 없으며, 선수를 새로 식별하지 않습니다.';
  $('#clip-file-help').textContent = '이 피드백을 받은 동일한 원본을 선택해 주세요. 원본을 서버나 AI 서비스로 보내지 않으며, 유료 API를 사용하지 않습니다.';
  $('#clip-length-options').hidden = true;
  $('#clip-length').closest('fieldset').querySelector('legend').lastChild.textContent = '원본과 공유 확인';
  $('#clip-plan-title').textContent = '확인된 근거 시각의 영상 계획';
  $('.plan-card > p:last-child').textContent = '원본 절대시각을 표시해요. 근거 앞뒤를 포함하고 겹치는 구간은 합쳤습니다. 여기에 없는 선수 장면은 새로 찾지 않아요.';
  $('.scope-card > h2').textContent = '근거가 있는 장면의\n앞뒤 움직임을 이어서.';
  $('.scope-card > p:not(.eyebrow)').textContent = '피드백에 기록된 근거 시각 앞뒤만 영상으로 만들어요. 하나를 저장한 다음, 다음 근거 영상을 만드세요.';
  $('.scope-footnote').textContent = '이전에 확인한 장면의 맥락을 다시 볼 수 있어요. 새로 선수를 찾거나, 대상의 모든 플레이를 골라내는 기능은 아닙니다.';
  $('.result-description').textContent = '이전 피드백의 근거 시각 주변을 담은 연속 영상입니다. 새로운 선수 식별이나 자동 분석은 실행하지 않았어요. 원치 않는 노출을 확인해 주세요. 원본의 소리는 포함하지 않습니다.';
  $('#clip-error > .help').textContent = '피드백을 받은 동일한 원본인지 확인해 주세요. 원본이 재생되지 않으면 호환되는 MP4로 변환해야 하며, 확장자만 바꿔도 해결되지 않습니다.';
  $('#next-clip').firstChild.textContent = '다음 근거 영상 만들기 ';
  $('#reset-clips').textContent = '원본 영상 다시 선택';
} else if (targetReportError) {
  $('#target-report-error').hidden = false;
  $('#target-report-error-message').textContent = targetReportError;
  $('.workspace').hidden = true;
  $('#page-title').textContent = '근거 장면의 정보를\n확인해 주세요.';
  $('.hero-copy > p:not(.eyebrow)').textContent = '피드백의 근거 시각을 읽지 못했어요.\n피드백에서 이 화면을 다시 열어 주세요.';
  $('.intro-note').hidden = true;
}

if (!support.supported) {
  $('#unsupported-browser').hidden = false;
  $('#unsupported-reason').textContent = support.reason || '이 브라우저에 영상 녹화·인코딩 기능이 없어 연속 영상을 만들 수 없습니다.';
  $('#clip-form-note').textContent = '영상 생성 기능을 지원하는 브라우저가 필요해요.';
}
updateControls();
