import { createChatPack } from './chat-pack.js';

const $ = selector => document.querySelector(selector);
const form = $('#chat-pack-form');
const picker = $('#chat-video-file');
const preview = $('#frame-preview');
const MAX_ORIGINAL_BYTES = 8 * 1024 ** 3;
const MAX_PACK_BYTES = 8 * 1024 ** 2;
const urls = new Set();
let selectedFile = null, controller = null, busy = false, lastPack = null, imageFiles = [], wakeLock = null, requestedSampleSet = 0;

const formatBytes = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const urlFor = blob => { const url = URL.createObjectURL(blob); urls.add(url); return url; };
function releaseURLs() { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }
function clearResults() {
  if (preview.open) preview.close();
  $('#preview-image').removeAttribute('src');
  releaseURLs(); lastPack = null; imageFiles = [];
  $('#pack-result').hidden = true;
  $('#frame-grid').replaceChildren();
  $('#download-pack').removeAttribute('href');
  $('#share-feedback').textContent = '';
  $('#copy-feedback').textContent = '';
}
function note(text) { $('#pack-notice').textContent = text; $('#pack-notice').hidden = !text; }
function clearError() { $('#pack-error').hidden = true; $('#pack-error-message').textContent = ''; }
function showError(error) {
  $('#pack-error-message').textContent = error?.message || '이 기기에서 자료를 만들지 못했어요. 원본을 다시 선택해 주세요.';
  $('#pack-error').hidden = false;
  $('#retry-pack').hidden = !selectedFile;
  $('#pack-error').scrollIntoView({block: 'nearest', behavior: 'smooth'});
}
function setBusy(value) {
  busy = value;
  for (const field of form.querySelectorAll('input,select,button')) field.disabled = value;
  $('#create-pack .button-label').textContent = value ? '작은 자료를 만드는 중…' : '작은 분석자료 만들기';
  $('#cancel-pack').disabled = !value;
  $('#cancel-pack').textContent = '만들기 취소';
  for (const link of document.querySelectorAll('.exit-link')) {
    if (value) link.setAttribute('aria-disabled', 'true'); else link.removeAttribute('aria-disabled');
  }
  $('#chat-pack-form').setAttribute('aria-busy', String(value));
}
async function keepScreenAwake() {
  if (!navigator.wakeLock?.request || document.hidden || !busy) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* The screen-on reminder remains visible. */ }
}
async function releaseScreen() { const lock = wakeLock; wakeLock = null; try { await lock?.release(); } catch { /* Already released by the browser. */ } }

function chooseFile(file) {
  if (!file || busy) return;
  clearError(); note(''); clearResults();
  selectedFile = null; requestedSampleSet = 0;
  $('#selected-file').hidden = true;
  $('#file-picker-label').textContent = '사진·파일에서 원본 선택';
  if (!file.size) { selectedFile = null; showError(new Error('비어 있는 영상이에요. 사진·파일 앱에서 원본을 다시 선택해 주세요.')); return; }
  if (file.size > MAX_ORIGINAL_BYTES) { selectedFile = null; showError(new Error('이 도구는 최대 약 8.6GB(8GiB) 원본까지 준비할 수 있어요. 더 작은 원본을 선택해 주세요.')); return; }
  if (!/\.(mp4|mov|m4v|webm|3gp)$/i.test(file.name) && !file.type.toLowerCase().startsWith('video/')) { selectedFile = null; showError(new Error('경기 영상 파일을 선택해 주세요. 사진이나 압축 파일은 원본 영상으로 사용할 수 없어요.')); return; }
  selectedFile = file;
  $('#selected-file-name').textContent = file.name;
  $('#selected-file-size').textContent = `${formatBytes(file.size)} · 이 기기에서만 처리`;
  $('#selected-file').hidden = false;
  $('#file-picker-label').textContent = '다른 원본 영상 선택';
}
picker.addEventListener('change', event => { const file = event.target.files?.[0]; chooseFile(file); picker.value = ''; });
$('#replace-file').addEventListener('click', () => picker.click());
$('#choose-another').addEventListener('click', () => { clearError(); picker.click(); });
for (const field of form.querySelectorAll('select,input:not([type=file])')) field.addEventListener('input', () => { requestedSampleSet = 0; if (lastPack) { clearResults(); note('선수 정보가 바뀌었어요. 바뀐 정보로 자료를 다시 만들어 주세요.'); } });

function progress(update, signal) {
  if (signal.aborted) return;
  const labels = {preparing: '원본 영상을 확인하고 있어요', sampling: '경기 속 순간을 고르고 있어요', encoding: '작은 이미지로 묶고 있어요', packaging: '첨부할 ZIP을 준비하고 있어요', completed: '작은 자료가 준비됐어요'};
  $('#progress-title').textContent = labels[update.phase] || '경기의 순간을 준비하고 있어요';
  $('#progress-message').textContent = update.message || '화면을 켜 두고 잠시 기다려 주세요.';
  const total = Number(update.total), completed = Number(update.completed);
  const percent = total > 0 && Number.isFinite(completed) ? Math.max(0, Math.min(100, Math.round(completed / total * 100))) : 0;
  $('#pack-progress-bar').setAttribute('aria-valuenow', String(percent));
  $('#pack-progress-bar > span').style.width = `${percent}%`;
  $('#progress-count').textContent = total > 0 && Number.isFinite(completed) ? `현재 단계 ${Math.min(completed, total)} / ${total}` : '파일 크기와 스마트폰 성능에 따라 걸리는 시간이 달라요.';
}

form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  clearError(); note('');
  if (!selectedFile) { showError(new Error('먼저 사진·파일 앱에서 경기 원본을 선택해 주세요.')); return; }
  if (!form.reportValidity()) return;
  const target = {kit: form.elements.kit.value, number: Number(form.elements.number.value), age: Number(form.elements.age.value)};
  const file = selectedFile, sampleSet = requestedSampleSet; requestedSampleSet = 0;
  clearResults(); controller = new AbortController(); const signal = controller.signal;
  setBusy(true); $('#pack-progress').hidden = false;
  progress({phase: 'preparing', completed: 0, total: 0}, signal);
  $('#pack-progress').scrollIntoView({block: 'nearest', behavior: 'smooth'});
  keepScreenAwake();
  try {
    const result = await createChatPack(file, {target, sampleSet, signal, onProgress: update => progress(update, signal)});
    if (signal.aborted) throw new DOMException('취소', 'AbortError');
    if (!(result?.zip instanceof Blob) || result.zip.size < 1 || result.zip.size > MAX_PACK_BYTES || !Array.isArray(result.files)) throw new Error('첨부 자료를 안전한 크기로 준비하지 못했어요. 원본을 다시 선택해 주세요.');
    renderPack(result, target);
    $('#pack-result').hidden = false;
    $('#result-title').focus({preventScroll: true});
    $('#pack-result').scrollIntoView({block: 'start', behavior: 'smooth'});
  } catch (error) {
    clearResults();
    if (signal.aborted || error?.name === 'AbortError') note('자료 만들기를 취소했어요. 원본은 그대로예요. 같은 영상으로 다시 만들 수 있어요.');
    else showError(error);
  } finally {
    controller = null; $('#pack-progress').hidden = true; setBusy(false); releaseScreen();
  }
});
$('#retry-pack').addEventListener('click', () => { if (!busy) form.requestSubmit(); });
$('#cancel-pack').addEventListener('click', () => {
  if (!busy || !controller) return;
  controller.abort(); $('#cancel-pack').disabled = true; $('#cancel-pack').textContent = '만들기를 정리하고 있어요…';
  $('#progress-message').textContent = '취소하고 있어요. 원본 파일은 변경하지 않습니다.';
});

function renderPack(pack, target) {
  releaseURLs(); lastPack = pack;
  const actualTarget = target || pack.manifest?.target || {kit: form.elements.kit.value, number: Number(form.elements.number.value), age: Number(form.elements.age.value)};
  imageFiles = pack.files.filter(file => file instanceof Blob && (file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name || '')));
  if (!imageFiles.length) throw new Error('공유할 이미지가 만들어지지 않았어요. 다른 원본으로 다시 시도해 주세요.');
  $('#download-pack').href = urlFor(pack.zip);
  $('#download-pack').download = 'NEXT-XI-chat-pack.zip';
  $('#pack-summary').textContent = `JPEG 이미지 ${imageFiles.length}장 · ZIP ${formatBytes(pack.zip.size)} · 원본은 이 기기에 그대로`;
  const grid = $('#frame-grid'); grid.replaceChildren();
  for (const [index, file] of imageFiles.entries()) {
    const url = urlFor(file), safeName = (file.name || `NEXT-XI-match-${index + 1}.jpg`).split(/[\\/]/).at(-1);
    const card = document.createElement('article'); card.className = 'frame-card';
    const previewButton = document.createElement('button'); previewButton.type = 'button'; previewButton.className = 'frame-preview-button'; previewButton.setAttribute('aria-label', `자료 ${index + 1} 크게 보기`);
    const image = document.createElement('img'); image.src = url; image.alt = `경기 정지화면 묶음 ${index + 1} · 자동 선수 식별 결과 아님`; image.loading = 'lazy';
    previewButton.append(image); previewButton.addEventListener('click', () => openPreview(url, index));
    const info = document.createElement('div'); info.className = 'frame-info';
    const title = document.createElement('strong'); title.textContent = `경기 순간 ${String(index + 1).padStart(2, '0')}`;
    const detail = document.createElement('p'); detail.textContent = `${safeName} · ${formatBytes(file.size)}`;
    const download = document.createElement('a'); download.className = 'button secondary'; download.href = url; download.download = safeName; download.textContent = '이미지 저장'; download.setAttribute('aria-label', `자료 ${index + 1} JPEG 저장`);
    info.append(title, detail, download); card.append(previewButton, info); grid.append(card);
  }
  const supportsFileShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && (() => { try { return navigator.canShare({files: imageFiles}); } catch { return false; } })();
  $('#share-images').hidden = !supportsFileShare;
  $('#share-images').disabled = false;
  $('#share-feedback').textContent = supportsFileShare ? '공유 버튼에서 직접 보낼 앱을 선택할 수 있어요.' : '공유 버튼이 없는 브라우저에서는 ZIP이나 개별 이미지를 내려받아 첨부해 주세요.';
  const sampleSet = Number(pack.manifest?.sampling?.sampleSet) || 0;
  const alternatives = pack.manifest?.sampling?.alternateTimesAvailable === true;
  $('#alternate-pack').hidden = !alternatives;
  $('#alternate-pack').textContent = sampleSet === 2 ? '처음 시점으로 다시 만들기' : '다른 시점 자료 만들기';
  $('#alternate-note').hidden = !alternatives;
  $('#alternate-note').textContent = alternatives ? `대표 시점 ${sampleSet + 1} / 3 · 선수가 잘 보이지 않으면 다른 시점으로 다시 준비할 수 있어요. 세 가지 시점을 돌아가며 고르며, 선수를 찾아내는 기능은 아닙니다.` : '';
  const selectedKit = [...form.elements.kit.options].find(option => option.value === actualTarget.kit)?.textContent || actualTarget.kit;
  $('#chat-prompt').value = `첨부한 자료는 경기 영상에서 시간 간격으로 고른 일부 정지화면입니다. 대상은 ${selectedKit} 유니폼 ${actualTarget.number}번, ${actualTarget.age}세 선수입니다. 자동 선수 식별·추적 결과는 아닙니다. 실제로 보이는 행동을 근거로 잘한 점과 다음 훈련을 제안해 주세요. 판단하기 어려운 부분은 관찰 부족으로 표시하고, 화면 밖 움직임·경기 전체의 능력치·전국 순위는 추정하지 말아 주세요.`;
  $('#pack-result').hidden = false;
}

function openPreview(url, index) {
  $('#preview-image').src = url; $('#preview-title').textContent = `경기 순간 ${String(index + 1).padStart(2, '0')}`;
  if (typeof preview.showModal === 'function') preview.showModal();
  else { $('#share-feedback').textContent = '이 브라우저에서는 크게 보기가 지원되지 않아요. 이미지를 저장한 뒤 사진·파일 앱에서 확인해 주세요.'; $('#preview-image').removeAttribute('src'); }
}
$('#close-preview').addEventListener('click', () => preview.close());
preview.addEventListener('click', event => { if (event.target === preview) { const rect = preview.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) preview.close(); } });
preview.addEventListener('close', () => $('#preview-image').removeAttribute('src'));
$('#share-images').addEventListener('click', async () => {
  if (!imageFiles.length || typeof navigator.share !== 'function') return;
  const button = $('#share-images'); button.disabled = true;
  try { await navigator.share({files: imageFiles, title: 'NEXT XI · 경기 정지화면 자료', text: '시간 간격으로 고른 경기 정지화면입니다. 자동 분석 결과가 아닙니다.'}); $('#share-feedback').textContent = '선택한 앱으로 공유했어요. 이 채팅에서도 첨부한 자료를 확인해 주세요.'; }
  catch (error) { $('#share-feedback').textContent = error?.name === 'AbortError' ? '공유를 취소했어요. 자료는 이 페이지에 그대로 있어요.' : '공유를 완료하지 못했어요. ZIP 또는 개별 이미지를 내려받아 첨부해 주세요.'; }
  finally { button.disabled = false; }
});
$('#alternate-pack').addEventListener('click', () => {
  if (busy || !lastPack || !selectedFile) return;
  requestedSampleSet = ((Number(lastPack.manifest?.sampling?.sampleSet) || 0) + 1) % 3;
  form.requestSubmit();
});
$('#copy-prompt').addEventListener('click', async () => {
  try { if (!navigator.clipboard?.writeText) throw new Error('unsupported'); await navigator.clipboard.writeText($('#chat-prompt').value); $('#copy-feedback').textContent = '설명을 복사했어요. 자료와 함께 채팅에 붙여 넣어 주세요.'; }
  catch { $('#chat-prompt').focus(); $('#chat-prompt').select(); $('#copy-feedback').textContent = '설명 문장을 길게 눌러 복사한 뒤 채팅에 붙여 넣어 주세요.'; }
});
document.addEventListener('click', event => { if (!busy) return; const link = event.target.closest('.exit-link'); if (link) { event.preventDefault(); note('아직 자료를 만들고 있어요. 페이지를 나가려면 먼저 ‘만들기 취소’를 눌러 주세요.'); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && busy) keepScreenAwake(); });
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { controller?.abort(); releaseScreen(); releaseURLs(); });
window.addEventListener('pageshow', event => { if (event.persisted && lastPack && !busy) renderPack(lastPack); });
