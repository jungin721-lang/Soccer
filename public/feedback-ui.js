import { KIT_LABELS, FEEDBACK_MAX_BYTES, FEEDBACK_MAX_REPORTS, FEEDBACK_LINK_MAX_BYTES, parseFeedbackReport, parseFeedbackFragment, listFeedbackReports, saveFeedbackReport, removeFeedbackReport, formatEvidenceTime } from './feedback.js';

const $ = selector => document.querySelector(selector);
let reports = [], selectedId = null, busy = true, pendingDeleteId = null;
let previewReport = null, showingPreview = false, fragmentError = null, cloudPreview = false;
// Consume links both on first load and when another report opens in this tab.
// Remove private contents from the address before displaying or saving them.
function consumeReportLink() {
  if (!location.hash.startsWith('#report')) return false;
  const fragment = location.hash;
  fragmentError = null;
  try {
    history.replaceState(null, '', location.pathname + location.search);
    previewReport = parseFeedbackFragment(fragment); showingPreview = true; cloudPreview = false;
  } catch (failure) {
    previewReport = null; showingPreview = false;
    fragmentError = failure.message || '피드백 링크를 열지 못했어요. JSON 파일로 가져와 주세요.';
  }
  return true;
}
consumeReportLink();
let videoURL = null, videoNode = null, videoGeneration = 0;

function element(tag, className = '', content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function message(selector, content) { const node = $(selector); node.textContent = content; node.hidden = !content; }
function status(content) { message('#feedback-status', content); }
function error(content) { message('#feedback-error', content); }
function setBusy(value) {
  busy = value;
  $('#feedback-file').disabled = value;
  $('#import-text').disabled = value;
  $('#feedback-text').disabled = value;
  $('#confirm-delete').disabled = value;
  $('.import-card').setAttribute('aria-busy', String(value));
  for (const button of document.querySelectorAll('.report-list button,.delete-button,.shared-preview button')) button.disabled = value;
}
function reviewedDate(report) {
  return report.reviewedAt ? `검토 날짜: ${new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(report.reviewedAt))} (UTC · 파일 기준)` : '검토 날짜 미기록';
}
function targetText(report) { return `${KIT_LABELS[report.target.kit]} ${report.target.number}번 · ${report.target.age}세`; }
function releaseVideo() {
  videoGeneration += 1;
  if (videoNode) { videoNode.pause(); videoNode.removeAttribute('src'); videoNode.load(); videoNode = null; }
  if (videoURL) { URL.revokeObjectURL(videoURL); videoURL = null; }
}
function renderLibrary() {
  const list = $('#report-list'); list.replaceChildren();
  $('#report-count').textContent = `${reports.length} / ${FEEDBACK_MAX_REPORTS}`;
  $('#library-empty').hidden = reports.length > 0;
  if (previewReport) {
    const preview = element('button'); preview.type = 'button'; preview.disabled = busy; preview.setAttribute('aria-current', String(showingPreview));
    preview.append(element('strong', '', previewReport.title), element('span', '', cloudPreview ? '계정에 보관한 피드백' : '링크로 받은 미저장 피드백'));
    preview.addEventListener('click', () => { if (busy) return; showingPreview = true; status(cloudPreview ? '계정에 보관한 피드백이에요.' : '아직 저장하지 않은 링크의 피드백이에요.'); error(''); render(); });
    list.append(preview);
  }
  for (const report of reports) {
    const button = element('button'); button.type = 'button'; button.setAttribute('aria-current', String(!showingPreview && report.id === selectedId)); button.disabled = busy;
    button.append(element('strong', '', report.title), element('span', '', targetText(report)));
    button.addEventListener('click', () => { if (busy) return; selectedId = report.id; showingPreview = false; cloudPreview = false; status(''); error(''); render(); });
    list.append(button);
  }
}
function card(title, eyebrow = '') {
  const section = element('section', 'card report-card');
  if (eyebrow) section.append(element('p', 'eyebrow', eyebrow));
  section.append(element('h3', '', title));
  return section;
}
function list(items) {
  const node = element('ul', 'plain-list');
  for (const item of items) node.append(element('li', '', item));
  return node;
}
function labeledParagraph(label, content, className = '') {
  const node = element('p', className);
  node.append(element('span', 'fact-label', label), document.createTextNode(content));
  return node;
}
function addLocalVideo(section, report, evidenceButtons) {
  const wrap = element('div', 'local-video');
  wrap.append(element('p', '', '근거 시각은 원본 영상 기준이에요. 같은 원본을 이 기기에서 연결하면 해당 시각으로 이동할 수 있어요. 영상은 저장하거나 전송하지 않으며 페이지를 벗어나면 연결이 풀립니다.'));
  const label = element('label', 'button secondary file-label', '원본 영상 연결');
  const input = element('input'); input.type = 'file'; input.accept = 'video/*,.mp4,.mov,.m4v,.webm,.3gp'; input.setAttribute('aria-label', '근거 시각을 확인할 원본 영상 선택'); label.append(input);
  const video = element('video', 'local-player'); video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.muted = true; video.hidden = true; video.setAttribute('aria-label', '이 기기에서 연결한 원본 영상');
  const note = element('p', 'video-status'); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
  const clear = element('button', 'remove-video', '영상 연결 해제'); clear.type = 'button'; clear.hidden = true;
  const reset = () => { releaseVideo(); video.hidden = true; clear.hidden = true; for (const button of evidenceButtons) button.disabled = true; };
  clear.addEventListener('click', () => { reset(); note.textContent = '영상 연결을 해제했어요. 피드백은 그대로 보관돼요.'; });
  input.addEventListener('change', () => {
    const file = input.files?.[0]; input.value = ''; if (!file) return;
    reset(); note.textContent = '';
    if (!file.size || file.size > 8 * 1024 ** 3 || (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|3gp)$/i.test(file.name))) { note.textContent = '재생 가능한 8GiB 이하의 원본 영상을 골라 주세요.'; return; }
    const generation = videoGeneration;
    let metadataTimer = setTimeout(() => {
      if (generation !== videoGeneration) return;
      reset(); note.textContent = '영상 정보를 읽는 시간이 초과됐어요. 이 기기에서 재생되는 원본을 다시 선택해 주세요.';
    }, 15000);
    const stopTimer = () => { clearTimeout(metadataTimer); metadataTimer = null; };
    video.onloadedmetadata = () => {
      if (generation !== videoGeneration) { stopTimer(); return; }
      stopTimer();
      const lastEvidence = Math.max(...report.observations.map(item => item.endTime ?? item.time));
      if (!Number.isFinite(video.duration) || Math.abs(video.duration - report.source.durationSeconds) > Math.max(1.5, report.source.durationSeconds * 0.002) || lastEvidence > video.duration) {
        reset(); note.textContent = '파일에 적힌 원본 길이와 맞지 않아요. 분할본 대신 같은 원본 영상을 선택해 주세요.'; return;
      }
      video.hidden = false; clear.hidden = false;
      for (const button of evidenceButtons) button.disabled = false;
      note.textContent = '연결한 영상이 같은 경기·선수인지 직접 확인해 주세요. 길이만 확인했으며 선수나 원본의 일치는 자동 검증하지 않았어요.';
    };
    video.onerror = () => { if (generation !== videoGeneration) return; stopTimer(); reset(); note.textContent = '이 브라우저에서 재생되지 않아요. 기기에서 재생되는 MP4 원본으로 다시 선택해 주세요.'; };
    try { videoURL = URL.createObjectURL(file); videoNode = video; video.src = videoURL; video.load(); } catch { stopTimer(); reset(); note.textContent = '영상을 연결하지 못했어요. 원본 파일을 다시 선택해 주세요.'; }
  });
  for (const button of evidenceButtons) button.addEventListener('click', () => {
    if (!videoURL || video.hidden) return;
    try {
      video.currentTime = Number(button.dataset.time);
      video.scrollIntoView({ block: 'nearest' });
      const playing = video.play();
      playing?.catch(() => { note.textContent = '선택한 시각으로 이동했어요. 영상의 재생 버튼을 눌러 주세요.'; });
    } catch { note.textContent = '해당 시각을 열지 못했어요. 원본 영상의 재생 위치를 확인해 주세요.'; }
  });
  wrap.append(label, video, note, clear); section.append(wrap);
}
function addEvidenceClipsLink(heading, report) {
  const action = element('div', 'local-video');
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  if (bytes.byteLength <= FEEDBACK_LINK_MAX_BYTES) {
    const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const link = element('a', 'button secondary file-label', '근거 장면만 영상으로 만들기');
    link.id = 'create-evidence-clips'; link.href = `/video-clips.html#report=${encoded}`; link.referrerPolicy = 'no-referrer';
    action.append(element('p', 'help', '이 피드백에서 확인한 시각을 사용합니다. 새 선수 탐색이 아닙니다.'), link);
  } else {
    action.append(element('p', 'help', '이 피드백은 링크로 전달하기에 커서 근거 장면 만들기를 열 수 없어요. 링크용 결과는 64KiB 이하까지 지원합니다.'));
  }
  heading.append(action);
}
function renderReport(report) {
  const root = $('#feedback-report'); root.replaceChildren();
  const heading = element('section', 'card report-card');
  const badges = element('div', 'report-badges'); badges.append(element('span', 'report-badge', '채팅 검토 결과'), element('span', 'report-badge muted-badge', '자동 분석 결과 아님'), element('span', 'report-badge muted-badge', '전문가 검토 미확인'));
  if (showingPreview) {
    const preview = element('div', 'shared-preview');
    preview.append(element('strong', '', cloudPreview ? '계정에 비공개 보관한 피드백' : '링크로 받은 피드백 · 아직 저장하지 않았어요'), element('p', '', '가져온 내용과 선수 정보를 확인해 주세요. 이 앱은 작성자나 검토 내용의 정확성을 인증하지 않습니다.'));
    const save = element('button', 'button secondary', '이 기기에 저장'); save.type = 'button'; save.disabled = busy;
    save.addEventListener('click', () => importReport(JSON.stringify(report)));
    preview.append(save); heading.append(preview);
  }
  heading.append(badges, element('h2', '', report.title));
  const target = element('div', 'report-target');
  target.append(element('span', '', `${KIT_LABELS[report.target.kit]} 유니폼`), element('span', '', `${report.target.number}번`), element('span', '', `${report.target.age}세`));
  heading.append(target, element('p', 'report-date', reviewedDate(report)), element('p', 'summary-text', report.summary));
  addEvidenceClipsLink(heading, report);
  root.append(heading);

  const scope = card('어디까지 살펴봤나요?', 'THE SCOPE OF THIS REVIEW');
  const counts = element('div', 'source-counts');
  counts.append(element('span', '', `원본 ${formatEvidenceTime(report.source.durationSeconds)}`), element('span', '', `검토 ${report.source.reviewedFrames}프레임`), element('span', '', `대상 확인 ${report.source.confirmedTargetFrames}프레임`));
  scope.append(counts, element('p', 'source-detail', report.source.description), element('p', 'help', `${report.source.kind === 'still_frames' ? '일부 정지화면' : '일부 영상 프레임'}을 바탕으로 한 검토예요. 경기 전체를 연속으로 확인한 결과가 아닙니다. 위 범위와 선수 정보는 가져온 파일의 기록이며 앱이 확인하지 않았어요.`));
  root.append(scope);

  const evidence = card('보인 장면, 조심스러운 해석', 'FACTS BEFORE INTERPRETATIONS');
  evidence.append(element('p', 'help', '확인한 사실과 해석을 따로 읽어 주세요. 근거 시각은 원본 기준이며, 영상 연결 후 누르면 그 시각으로 이동해요.'));
  const evidenceButtons = [];
  for (const observation of report.observations) {
    const item = element('section', 'observation');
    const time = `${formatEvidenceTime(observation.time)}${observation.endTime !== undefined ? ` – ${formatEvidenceTime(observation.endTime)}` : ''}`;
    const button = element('button', 'evidence-time', `↗ ${time}`); button.type = 'button'; button.dataset.time = String(observation.time); button.disabled = true; button.setAttribute('aria-label', `원본 ${time} 근거 장면으로 이동`); evidenceButtons.push(button);
    item.append(button, labeledParagraph('관찰한 사실', observation.fact), labeledParagraph('가능한 해석', observation.interpretation, 'interpretation'), labeledParagraph('아직 모르는 점', observation.uncertainty, 'uncertainty'));
    evidence.append(item);
  }
  addLocalVideo(evidence, report, evidenceButtons); root.append(evidence);
  const unknown = card('이 자료로는 알 수 없어요', 'LEAVE ROOM FOR WHAT WE CANNOT SEE'); unknown.append(list(report.unobserved)); root.append(unknown);

  for (const training of report.training) {
    const section = element('section', 'card report-card training-card'); section.append(element('p', 'eyebrow', 'YOUR NEXT SMALL PRACTICE'));
    const title = element('div', 'training-heading'); title.append(element('h3', '', training.title), element('span', '', `${training.minutes}분 연습`)); section.append(title);
    section.append(element('p', 'training-reason', training.reason));
    const goal = element('div', 'training-goal'); goal.append(labeledParagraph('이번 연습의 목표', training.goal)); section.append(goal);
    const meta = element('div', 'training-meta'); meta.append(element('span', '', `횟수 · ${training.frequency}`), element('span', '', `준비물 · ${training.equipment.length ? training.equipment.join(', ') : '별도 준비물 없음'}`)); section.append(meta);
    const steps = element('ol', 'training-steps');
    for (const step of training.steps) {
      const item = element('li'); const title = element('h4', '', step.label); title.append(element('span', '', `${step.minutes}분`)); item.append(title, list(step.instructions)); steps.append(item);
    }
    section.append(steps);
    const success = element('div', 'success-note'); success.append(labeledParagraph('이렇게 되면 한 걸음 성공', training.success)); section.append(success); root.append(section);
  }
  const limits = card('피드백을 읽을 때 기억해 주세요'); limits.append(list(report.limitations), element('p', 'help', '이 페이지는 직접 가져온 채팅 검토 결과를 보여 줍니다. 파일의 작성자·내용·전문성을 인증하지 않으며 점수, 건강 진단, 선수의 전체 능력을 산출하지 않습니다.')); root.append(limits);
  const deleteRow = element('div', 'delete-row'); const remove = element('button', 'delete-button', '이 기기의 피드백 지우기'); remove.type = 'button'; remove.disabled = busy; remove.addEventListener('click', () => requestDelete(report)); deleteRow.append(remove); if (!showingPreview) root.append(deleteRow);
}
function render() {
  releaseVideo(); renderLibrary();
  const report = showingPreview ? previewReport : reports.find(item => item.id === selectedId);
  $('#feedback-empty').hidden = Boolean(report); $('#feedback-report').hidden = !report;
  if (report) renderReport(report); else $('#feedback-report').replaceChildren();
}
async function importReport(input) {
  if (busy) return;
  error(''); status('');
  let report;
  try { report = parseFeedbackReport(input); } catch (failure) { error(failure.message); return; }
  const existing = reports.find(item => item.id === report.id);
  if (existing && !window.confirm(`“${existing.title}”와 같은 식별자의 피드백이에요. 가져온 내용으로 바꿀까요?`)) { status('가져오기를 취소했어요. 저장된 피드백은 그대로예요.'); return; }
  setBusy(true);
  try {
    report = await saveFeedbackReport(report);
    reports = [report, ...reports.filter(item => item.id !== report.id)]; selectedId = report.id; previewReport = null; showingPreview = false; cloudPreview = false;
    $('#feedback-text').value = ''; $('.paste-details').open = false;
    render(); status('피드백을 이 브라우저에 저장했어요. 새로고침해도 다시 볼 수 있어요.');
  } catch (failure) { error(failure.message); }
  finally { setBusy(false); }
}
$('#feedback-file').addEventListener('change', async () => {
  const picker = $('#feedback-file'); const file = picker.files?.[0]; picker.value = ''; if (!file || busy) return;
  if (!/\.json$/i.test(file.name) || !file.size || file.size > FEEDBACK_MAX_BYTES) { status(''); error('비어 있지 않은 1MiB 이하의 분석 결과 JSON 파일을 선택해 주세요.'); return; }
  try { await importReport(await file.text()); } catch { error('파일을 읽지 못했어요. 기기에 저장된 JSON 파일을 다시 선택해 주세요.'); }
});
$('#import-text').addEventListener('click', () => importReport($('#feedback-text').value));
function requestDelete(report) {
  if (busy) return;
  pendingDeleteId = report.id;
  $('#delete-description').textContent = report.title;
  const dialog = $('#delete-dialog');
  if (typeof dialog.showModal === 'function') { dialog.showModal(); $('#cancel-delete').focus(); }
  else if (window.confirm(`“${report.title}” 피드백을 이 기기에서 지울까요?`)) deleteSelected();
  else pendingDeleteId = null;
}
$('#cancel-delete').addEventListener('click', () => { pendingDeleteId = null; $('#delete-dialog').close(); });
$('#delete-dialog').addEventListener('cancel', () => { pendingDeleteId = null; });
$('#confirm-delete').addEventListener('click', deleteSelected);
async function deleteSelected() {
  if (!pendingDeleteId || busy) return;
  const deleting = pendingDeleteId; setBusy(true); error('');
  try {
    await removeFeedbackReport(deleting);
    reports = reports.filter(item => item.id !== deleting);
    selectedId = reports[0]?.id ?? null; showingPreview = false; pendingDeleteId = null;
    if ($('#delete-dialog').open) $('#delete-dialog').close();
    render(); status('이 브라우저에서 피드백을 지웠어요. 원래 JSON 파일은 그대로예요.');
  } catch (failure) { error(failure.message); }
  finally { setBusy(false); }
}
window.addEventListener('pagehide', releaseVideo);
window.addEventListener('hashchange', () => {
  if (!consumeReportLink()) return;
  if ($('#delete-dialog').open) $('#delete-dialog').close();
  pendingDeleteId = null;
  error(fragmentError || '');
  status(showingPreview ? '링크의 피드백을 미리 보고 있어요. 주소에서 내용은 지웠으며, ‘이 기기에 저장’을 누르기 전에는 보관하지 않습니다.' : '');
  render();
});
async function start() {
  setBusy(true);
  try {
    const saved = await listFeedbackReports(); reports = saved.reports; selectedId = reports[0]?.id ?? null;
    if (saved.invalidCount) error('저장된 결과 중 형식이 맞지 않는 항목은 열지 않았어요. 원래 JSON 파일을 다시 가져와 주세요.');
  } catch (failure) { error(failure.message); }
  finally {
    if (fragmentError) error(fragmentError);
    if (showingPreview) status('링크의 피드백을 미리 보고 있어요. 주소에서 내용은 지웠으며, ‘이 기기에 저장’을 누르기 전에는 보관하지 않습니다.');
    render(); setBusy(false);
  }
}
start();

// Account storage is explicit; the existing browser library is never uploaded automatically.
let accountReports = [], accountOwner = null, accountLoading = false;
async function accountAPI(path = '', options = {}) {
  const response = await fetch('/api/v2/feedback' + path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000), ...options, headers: { 'Content-Type': 'application/json' } });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) clearAccountPreview();
    throw new Error(value.error || '계정 피드백에 연결하지 못했어요.');
  }
  return value;
}
function clearAccountPreview() {
  accountReports = []; accountOwner = null;
  $('#account-feedback-list').replaceChildren();
  if (cloudPreview) { previewReport = null; showingPreview = false; cloudPreview = false; render(); }
}
function accountLibrary() {
  const list = $('#account-feedback-list'); list.replaceChildren();
  for (const report of accountReports) {
    const row = element('div', 'button-row');
    const open = element('button', 'button secondary', report.title); open.type = 'button';
    open.addEventListener('click', () => { previewReport = report; showingPreview = true; cloudPreview = true; render(); status('계정에 보관한 채팅 피드백입니다. 자동 분석 결과와는 구분해요.'); });
    const remove = element('button', 'button secondary', '계정에서 삭제'); remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm('계정의 이 피드백을 모든 기기에서 삭제할까요? 이 브라우저에 따로 저장한 사본은 유지됩니다.')) return;
      remove.disabled = true;
      try { await accountAPI('/' + encodeURIComponent(report.id), { method: 'DELETE' }); if (cloudPreview && previewReport?.id === report.id) { previewReport = null; showingPreview = false; cloudPreview = false; render(); } await refreshAccount(); }
      catch (failure) { $('#account-feedback-status').textContent = failure.message; }
      finally { remove.disabled = false; }
    });
    row.append(open, remove); list.append(row);
  }
}
async function refreshAccount() {
  if (accountLoading) return;
  accountLoading = true;
  try {
    const result = await accountAPI();
    if (accountOwner && accountOwner !== result.userId) clearAccountPreview();
    accountOwner = result.userId; accountReports = result.reports;
    if (cloudPreview && !accountReports.some(row => row.id === previewReport?.id)) { previewReport = null; showingPreview = false; cloudPreview = false; render(); }
    accountLibrary(); $('#account-feedback-status').textContent = `계정에 ${accountReports.length}개 보관 중 · 자동 동기화`;
  } catch (failure) { $('#account-feedback-status').textContent = failure.message || '연결을 확인하고 다시 시도해 주세요.'; }
  finally { accountLoading = false; }
}
$('#save-account-feedback').addEventListener('click', async event => {
  const report = showingPreview ? previewReport : reports.find(row => row.id === selectedId);
  if (!report) { $('#account-feedback-status').textContent = '먼저 저장할 피드백을 열어 주세요.'; return; }
  event.target.disabled = true;
  try { await accountAPI('', { method: 'POST', body: JSON.stringify(report) }); await refreshAccount(); $('#account-feedback-status').textContent = '계정에 비공개 저장했어요. 같은 계정의 다른 기기에서 열 수 있어요.'; }
  catch (failure) { $('#account-feedback-status').textContent = failure.message || '저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.'; }
  finally { event.target.disabled = false; }
});
$('#refresh-account-feedback').addEventListener('click', refreshAccount);
setInterval(() => { if (!document.hidden) refreshAccount(); }, 5000);
window.addEventListener('focus', refreshAccount);
window.addEventListener('online', refreshAccount);
refreshAccount();
