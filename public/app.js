import { SKILLS, SCALE, parseYouTube, parseTimestamp, formatTime, getScores } from './domain.js';
import { deriveTrainingPlan } from './plans.js';
import { validateVideoFile, formatBytes, readVideoMetadata, saveOriginalVideo, getOriginalVideo, deleteOriginalVideo } from './media-store.js';
import { getAnalysisAvailability, analyzeOriginalVideo } from './analysis-client.js';

const $ = (s, root = document) => root.querySelector(s);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  video: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4z"/>',
  chart: '<path d="m12 3 9 6-3 10H6L3 9z"/><path d="m12 3 1 8 8-2-9 5-6 5 3-8-6-2 9 5z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  trend: '<path d="m3 17 6-6 4 4 8-10M15 5h6v6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  play: '<path d="m9 5 11 7-11 7z"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  spark: '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  edit: '<path d="m16 3 5 5L9 20l-6 1 1-6zM13 6l5 5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  leaf: '<path d="M20 3c-12 0-17 3-17 10a7 7 0 0 0 7 7c7 0 10-5 10-17zM4 20 15 9"/>',
  moon: '<path d="M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>',
  ball: '<circle cx="12" cy="12" r="9"/><path d="m12 7 5 4-2 6H9l-2-6zM12 3v4m9 4h-4M18 20l-3-3m-9 3 3-3M3 11h4"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 3M12 17h.01"/>',
  flag: '<path d="M4 22V3c6-4 10 4 16 0v11c-6 4-10-4-16 0"/>',
  bookmark: '<path d="M6 3h12v19l-6-4-6 4z"/>'
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.info}</svg>`;
const navItems = [['dashboard', 'grid', '대시보드'], ['videos', 'video', '경기 영상'], ['report', 'chart', '성장 리포트'], ['training', 'target', '훈련 플랜'], ['history', 'trend', '성장 기록']];
const mobileNavLabels = { dashboard: '홈', videos: '영상', report: '리포트', training: '훈련', history: '성장' };
const sampleRatings = [3.8, 3.6, 3.2, 2.8, 3.1, 2.6, 3.4, 4.2];
let state, page = location.hash.slice(1) || 'dashboard', demo = false, selectedVideo = 'arJ6xMRKnbw', week = 1, trainingTab = 'skill', reportSkill = null, modalReturn = null, pending = false;
let previewTime = null, autoplayNext = false;
let originalURL = null, playerGeneration = 0, registrationKind = 'file', selectedOriginal = null, selectedOriginalMeta = null, selectionToken = 0, metadataLoading = false, savingOriginal = false, generatedTitle = '';
let selectedMetadataPromise = null, analysisController = null, analysisBusy = false;
const isOriginal = video => video?.kind === 'file';
const makeId = () => crypto.randomUUID();
const dateLabel = value => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date(value));
const playerName = () => state.player.name || '남색 11번';
const scores = () => demo ? SKILLS.map((s, i) => ({ ...s, value: sampleRatings[i], count: 4 })) : getScores(state.observations);
const ratedCount = () => getScores(state.observations).filter(s => s.value !== null).length;
const badge = (text, cls = '') => `<span class="badge ${cls}">${text}</span>`;
function sectionHeader(eyebrow, title, sub, action = '') { return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${sub}</p></div>${action}</div>`; }
function empty(iconName, title, detail, button = '') { return `<div class="empty-state"><span class="empty-icon">${icon(iconName)}</span><h3>${title}</h3><p>${detail}</p>${button}</div>`; }
function render() {
  releaseOriginalPlayer();
  if (!navItems.some(n => n[0] === page) && page !== 'profile') page = 'dashboard';
  const label = navItems.find(n => n[0] === page)?.[2] || '선수 프로필';
  $('#app').innerHTML = `<div class="app-shell"><aside id="workspace-menu" class="sidebar" aria-label="주 메뉴">
    <a class="brand" href="#dashboard"><span class="brand-symbol">↗</span><span>NEXT <b>XI</b><small>GROW YOUR GAME</small></span></a>
    <button class="player-switch" data-action="navigate" data-page="profile"><span class="mini-shirt">11</span><span><strong>${escape(playerName())}</strong><small>U${state.player.age} · 나의 선수</small></span>${icon('chevron')}</button>
    <div class="nav-caption">MY WORKSPACE</div><nav>${navItems.map(([id, ico, name]) => `<a href="#${id}" class="nav-link ${page === id ? 'active' : ''}" ${page === id ? 'aria-current="page"' : ''}>${icon(ico)}<span>${name}</span>${id === 'videos' ? `<span class="nav-count">${state.videos.length}</span>` : ''}${page === id ? '<span class="nav-active-dot"></span>' : ''}</a>`).join('')}</nav>
    <div class="nav-divider"></div><a href="#profile" class="nav-link ${page === 'profile' ? 'active' : ''}">${icon('user')}<span>선수 프로필</span></a>
    <div class="sidebar-bottom"><div class="small-inspiration"><span class="tiny-ball">${icon('ball')}</span><strong>작은 한 걸음,<br>더 큰 가능성.</strong><p>비교보다 성장에 집중해요.</p></div><button class="help-button" data-action="help">${icon('help')}<span>이용 가이드</span>${icon('external')}</button><div class="workspace-label"><span class="status-dot"></span>개인 개발 워크스페이스</div></div>
  </aside><div class="mobile-overlay" data-action="menu" aria-hidden="true"></div><div class="main-shell"><header class="topbar"><div class="breadcrumb"><button class="mobile-menu icon-button" data-action="menu" aria-label="메뉴 열기" aria-controls="workspace-menu" aria-expanded="false">${icon('menu')}</button><span class="crumb-home">나의 성장 공간</span>${icon('chevron')}<strong>${label}</strong></div><div class="topbar-actions"><span class="private-label">${icon('leaf')}나의 성장 기록</span><button class="profile-avatar" data-action="navigate" data-page="profile" aria-label="선수 프로필">11</button></div></header>
    ${demo ? `<div class="demo-banner">${icon('info')}<span><strong>예시 리포트 체험 중</strong> · 아래 능력치와 추천은 실제 영상 분석 결과가 아닙니다.</span><button data-action="demo">체험 끝내기 ${icon('close')}</button></div>` : ''}
    <main id="main" tabindex="-1">${({ dashboard: dashboardPage, videos: videosPage, report: reportPage, training: trainingPage, history: historyPage, profile: profilePage }[page])()}</main>
    <footer class="site-footer"><span class="footer-brand">NEXT XI</span><span>더 나은 내일을 향한, 오늘의 플레이.</span><span class="footer-note">U11 선수의 성장에 맞춘 기록</span></footer>
  </div><nav class="mobile-bottom-nav" aria-label="빠른 메뉴">${navItems.map(([id, ico, name]) => `<button type="button" class="mobile-nav-item ${page === id ? 'active' : ''}" data-action="navigate" data-page="${id}" aria-label="${name}" ${page === id ? 'aria-current="page"' : ''}>${icon(ico)}<span>${mobileNavLabels[id]}</span></button>`).join('')}</nav></div>`;
  syncMobileMenu();
  if (page === 'videos') attachPlayer();
  document.querySelectorAll('.video-thumb > img').forEach(img => { const loaded = () => img.classList.add('loaded'); img.addEventListener('load', loaded, { once: true }); if (img.complete && img.naturalWidth) loaded(); });
}
function dashboardPage() {
  const count = state.observations.length;
  const latestOriginal = state.videos.find(isOriginal);
  const latestAnalysis = latestOriginal && (state.analyses || []).filter(a => a.videoId === latestOriginal.id).at(-1);
  const focus = deriveTrainingPlan(state.observations).focus;
  const done = state.completed.filter(i => i.startsWith('week1-') && i.endsWith('-' + focus)).length;
  return `${sectionHeader('YOUR NEXT CHAPTER', '성장은, 오늘도 계속됩니다.', '한 경기의 결과보다 중요한 건, 다음 경기의 작은 변화예요.', `<button class="button primary" data-action="add-video">${icon('plus')}경기 영상 등록</button>`)}
  ${latestOriginal ? `<section class="upload-receipt" role="status"><span class="receipt-icon">${icon('check')}</span><div><span class="eyebrow">ORIGINAL SAVED</span><h2>저장 완료 · ${escape(latestOriginal.title)}</h2><p>${formatBytes(latestOriginal.size)}${latestOriginal.duration ? ' · ' + formatTime(latestOriginal.duration) : ''} · 이 기기의 브라우저에 보관 중</p><p>${latestAnalysis ? '앱이 분석한 플레이 피드백을 확인할 수 있어요.' : '자동 분석을 시작하면 앱이 남색 11번을 찾아 플레이를 살펴봐요.'}</p></div><div class="receipt-actions"><button class="button primary small" data-action="analyze-video" data-id="${latestOriginal.id}">${icon('spark')}${canResumeAuto(autoJobFor(latestOriginal.id)) ? '자동 분석 이어서 하기' : '남색 11번 자동 분석'}</button><button class="button secondary small" data-action="open-video" data-id="${latestOriginal.id}">영상 보기 ${icon('arrow')}</button></div></section>` : ''}
  ${latestOriginal && !demo ? autoStatusCard(autoJobFor(latestOriginal.id), true) : ''}
  ${latestAnalysis && !demo ? `<section class="card dashboard-feedback"><div><span class="eyebrow">LATEST AI FEEDBACK</span><h3>${latestAnalysis.result.identified ? '최근 장면의 피드백이 도착했어요.' : '이 장면은 선수 확인이 어려워요.'}</h3><p>${escape(latestAnalysis.result.summary)}</p><span class="field-help">AI 초안 · 전체 경기 능력치가 아닌 선택 구간의 관찰입니다.</span></div><button class="button secondary" data-action="open-video" data-id="${latestOriginal.id}">근거와 다음 연습 보기 ${icon('arrow')}</button></section>` : ''}
  <section class="hero-card"><div class="hero-copy"><div class="hero-tag"><span></span>EVERY LITTLE STEP COUNTS</div><h2>어제의 나를 넘어,<br>내일의 나를 향해.</h2><p>경기 속 작은 발견을 나만의 성장으로.<br>${escape(playerName())} 선수의 다음 한 걸음을 함께 찾아요.</p><button class="button lime" data-action="navigate" data-page="videos">내 경기 살펴보기 ${icon('arrow')}</button></div><img class="hero-art" src="/assets/hero-pitch.svg" alt="남색 11번 유니폼과 축구 경기장 일러스트"><span class="hero-bottom-note">YOUR GAME. YOUR GROWTH.</span></section>
  <div class="stats-grid"><div class="stat-card"><span class="stat-icon green">${icon('video')}</span><div><span class="stat-label">등록한 경기</span><strong>${String(state.videos.length).padStart(2, '0')}<small>경기</small></strong></div><span class="stat-foot">성장의 출발점</span></div><div class="stat-card"><span class="stat-icon blue">${icon('bookmark')}</span><div><span class="stat-label">기록한 장면</span><strong>${String(count).padStart(2, '0')}<small>개</small></strong></div><span class="stat-foot">평가와 연결되는 근거</span></div><div class="stat-card"><span class="stat-icon violet">${icon('chart')}</span><div><span class="stat-label">관찰한 능력</span><strong>${ratedCount()}<small>/ 8 항목</small></strong></div><span class="stat-foot">${ratedCount() ? '직접 기록한 관찰 평가' : '첫 관찰을 기다리고 있어요'}</span></div><div class="stat-card"><span class="stat-icon peach">${icon('target')}</span><div><span class="stat-label">첫 주 훈련 실천</span><strong>${done}<small>/ 3 과제</small></strong></div><span class="stat-foot">작은 실천이 만드는 변화</span></div></div>
  <div class="dashboard-grid"><section class="card capability-card"><div class="card-heading"><div><h2>나의 플레이, 한눈에</h2><p>8가지 관점으로 발견하는 나만의 가능성</p></div><button class="text-button" data-action="navigate" data-page="report">리포트 보기 ${icon('chevron')}</button></div><div class="radar-layout"><div class="radar-wrap">${radarChart(scores(), !demo && !ratedCount())}</div><div class="radar-summary">${demo ? `<span class="badge amber">예시 데이터</span><h3>협력하는 플레이가<br>나의 강점이에요.</h3><p>공을 받기 전 주변 확인을 더하면,<br>다음 선택이 한결 여유로워져요.</p>` : ratedCount() ? `<span class="badge green">관찰 기록 ${count}개</span><h3>작은 발견이<br>쌓이고 있어요.</h3><p>${ratedCount()}개 항목에 직접 기록한 평가가 있어요.<br>여러 경기의 장면을 더해 보세요.</p>` : `<span class="badge subtle">아직 평가 전이에요</span><h3>점수보다 먼저, <br>플레이를 살펴봐요.</h3><p>영상을 보고 근거 장면을 기록하면<br>나의 플레이 지도가 채워져요.</p>`}<div class="legend"><span class="legend-dot"></span>${demo ? '예시 능력치' : '기록한 능력치'}<span class="legend-ring"></span>5단계 행동 기준</div><button class="button secondary small" data-action="${demo ? 'navigate' : 'demo'}" ${demo ? 'data-page="report"' : ''}>${demo ? '자세히 살펴보기' : '예시 리포트 체험'} ${icon('arrow')}</button></div></div><div class="card-bottom-note">${icon('info')}관찰하지 못한 능력은 0점이 아닌 ‘관찰 부족’으로 표시해요.</div></section>
  <section class="card next-step-card"><div class="card-heading"><div><span class="eyebrow">YOUR NEXT STEP</span><h2>지금, 한 걸음부터</h2></div><span class="step-number">01</span></div><div class="next-step-visual">${icon('flag')}<span class="path-dot one"></span><span class="path-dot two"></span><span class="path-dot three"></span></div><h3>${latestOriginal ? '영상은 맡기고,<br>성장에 집중해요.' : '나를 발견하는<br>첫 경기를 열어볼까요?'}</h3><p>${latestOriginal ? '남색 11번이 보이는 순간을<br>앱이 탐색하고 분석해요.' : '남색 유니폼 11번 선수를 찾아,<br>기억하고 싶은 장면 하나를 남겨요.'}</p><button class="button dark full" data-action="${latestOriginal ? 'analyze-video' : 'navigate'}" ${latestOriginal ? `data-id="${latestOriginal.id}"` : 'data-page="videos"'}>${latestOriginal ? '남색 11번 자동 분석' : '00:57부터 영상 보기'} ${icon('arrow')}</button><div class="next-step-note">${icon('clock')}${latestOriginal ? '시작 시간 입력 없이, 앱이 찾아서' : '한 장면의 기록부터 시작해요'}</div></section></div>
  <div class="bottom-grid"><section class="card recent-card"><div class="card-heading"><div><h2>나의 경기 영상</h2><p>성장의 순간을 놓치지 않도록</p></div><button class="text-button" data-action="navigate" data-page="videos">전체 보기 ${icon('chevron')}</button></div>${state.videos.length ? videoRow(state.videos[0]) : empty('video', '첫 경기를 등록해요', '유튜브 링크로 시작할 수 있어요.')}</section><section class="card growth-note"><span class="note-icon">${icon('leaf')}</span><div><span class="eyebrow">GROW AT YOUR PACE</span><h3>비교의 기준은,<br>어제의 나.</h3><p>지금은 전국 순위보다 나의 변화를 기록해요.<br>같은 기준의 데이터가 쌓이면 비교가 시작됩니다.</p></div></section></div>`;
}
function radarChart(data, isEmpty = false) {
  const cx = 190, cy = 160, radius = 108;
  const point = (i, r) => [cx + Math.sin(i * Math.PI / 4) * r, cy - Math.cos(i * Math.PI / 4) * r];
  const poly = r => SKILLS.map((s, i) => point(i, r).join(',')).join(' ');
  const valid = data.filter(d => d.value !== null).length;
  return `<svg viewBox="0 0 380 330" class="radar-chart" role="img" aria-label="${isEmpty ? '아직 평가 전인 8개 항목 스파이더맵' : `${demo ? '예시 ' : ''}8개 항목 스파이더맵. ` + data.map(d => `${d.name}: ${d.value === null ? '관찰 부족' : d.value.toFixed(1) + '단계'}`).join(', ')}"><defs><linearGradient id="radar-fill" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#b8dd71" stop-opacity=".45"/><stop offset="1" stop-color="#7eb8a0" stop-opacity=".2"/></linearGradient></defs>${[1, 2, 3, 4, 5].map(n => `<polygon points="${poly(radius * n / 5)}" fill="${n === 5 ? '#f5f8f5' : 'none'}" stroke="#e0e7e2" stroke-width="1"/>`).reverse().join('')}${SKILLS.map((s, i) => { const p = point(i, radius); return `<line x1="${cx}" y1="${cy}" x2="${p[0]}" y2="${p[1]}" stroke="#e0e7e2"/>`; }).join('')}${!isEmpty && valid === 8 ? `<polygon points="${data.map((d, i) => point(i, radius * d.value / 5).join(',')).join(' ')}" fill="url(#radar-fill)" stroke="#638c55" stroke-width="2"/>` : ''}${!isEmpty ? data.map((d, i) => { if (d.value === null) return ''; const p = point(i, radius * d.value / 5); return `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="#648c53" stroke="white" stroke-width="2"/>`; }).join('') : `<circle cx="${cx}" cy="${cy}" r="31" fill="white" stroke="#e0e7e2"/><text x="${cx}" y="${cy + 5}" text-anchor="middle" fill="#8b968f" font-size="13" font-weight="600">평가 전</text>`}${SKILLS.map((s, i) => { const p = point(i, radius + 29); return `<text x="${p[0]}" y="${p[1] + 5}" text-anchor="middle" font-size="12" fill="#627069" font-weight="550">${s.short}</text>`; }).join('')}</svg>`;
}
function videoThumb(video, large = false) { return `<div class="video-thumb ${large ? 'large' : ''}">${isOriginal(video) ? '' : `<img src="https://i.ytimg.com/vi/${video.id}/hqdefault.jpg" alt="${escape(video.title)} 영상 썸네일" loading="lazy">`}<span class="thumbnail-fallback">${icon('ball')}<span>${isOriginal(video) ? 'ORIGINAL FILM · NAVY 11' : 'NAVY 11 · MATCH FILM'}</span></span><span class="play-circle">${icon('play')}</span><span class="video-start">${formatTime(video.start || 0)}부터</span></div>`; }
function videoRow(video) { return `<button class="video-row" data-action="open-video" data-id="${video.id}">${videoThumb(video)}<span class="video-row-content"><span class="badge subtle">${isOriginal(video) ? '이 기기의 원본 영상' : '영상 등록 완료'}</span><strong>${escape(video.title)}</strong><span>남색 유니폼 · 등번호 11 <span class="dot-divider">·</span> ${dateLabel(video.addedAt)} 등록</span></span>${icon('chevron')}</button>`; }
function videosPage() {
  const video = state.videos.find(v => v.id === selectedVideo) || state.videos[0];
  if (video) selectedVideo = video.id;
  return `${sectionHeader('MATCH LIBRARY', '경기 속에서, 나를 발견해요.', '한 장면씩 살펴보고, 다음 플레이를 위한 힌트를 남겨요.', `<button class="button primary" data-action="add-video">${icon('plus')}영상 등록</button>`)}
  <div class="video-workspace"><section class="video-main"><div class="video-player" id="video-player">${video ? playerPlaceholder(video) : empty('video', '아직 등록한 영상이 없어요', '사진·파일 앱의 원본 영상 또는 유튜브 링크를 등록해 주세요.')} </div><div class="video-details"><div><div class="eyebrow">MATCH FILM ${video ? String(state.videos.indexOf(video) + 1).padStart(2, '0') : '00'}</div><h2>${escape(video?.title || '경기 영상')}</h2><p>분석 대상 <strong>남색 유니폼 · 11번</strong> ${badge('U' + state.player.age, 'subtle')}</p></div>${video ? isOriginal(video) ? `<div class="heading-actions"><button class="button secondary small" data-action="download-original" data-id="${video.id}">${icon('download')}원본 내보내기</button><button class="button danger small" data-action="delete-video" data-id="${video.id}">${icon('trash')}영상 삭제</button></div>` : `<a class="button secondary small" href="https://www.youtube.com/watch?v=${video.id}&t=${previewTime ?? video.start ?? 0}s" target="_blank" rel="noopener noreferrer">YouTube에서 열기 ${icon('external')}</a>` : ''}</div><div class="video-message">${icon('info')}<div><strong>원본 영상에서 남색 11번을 자동으로 탐색할 수 있어요.</strong><p>${isOriginal(video) ? `원본은 이 기기의 브라우저에 저장됩니다. 자동 분석에 동의하면 탐색과 구간 분석에 필요한 정지 화면을 AI 서비스로 전송해요. 브라우저 데이터를 지우면 삭제될 수 있어요. 사진·파일 앱의 원본도 계속 보관해 주세요. ${formatBytes(video.size)}${video.duration ? ' · ' + formatTime(video.duration) : ''}` : '자동 선수 추적·AI 평가는 아직 연결되지 않았어요. 재생이 제한되면 YouTube에서 확인하고 장면의 시간을 기록해 주세요.'}</p></div></div>${isOriginal(video) ? analysisPanel(video) : ''}<section class="card observations-card"><div class="card-heading"><div><h2>기억할 장면</h2><p>이 영상에서 남긴 근거와 관찰 기록</p></div>${video ? `<button class="button secondary small" data-action="add-observation">${icon('plus')}장면 기록</button>` : ''}</div>${video ? observationList(state.observations.filter(o => o.videoId === video.id)) : ''}</section></section><aside class="video-side"><section class="card identity-card"><span class="eyebrow">FOCUS PLAYER</span><img src="/assets/jersey-11.svg" alt="남색 11번 유니폼"><h3>${escape(playerName())}</h3><p>남색 유니폼 <span class="dot-divider">·</span> 등번호 11</p><div class="identity-facts"><span>연령<strong>U${state.player.age}</strong></span><span>포지션<strong>${escape(state.player.position)}</strong></span></div><span class="focus-confirm">${icon('target')}이 선수만 관찰해요</span></section><section class="card playlist"><div class="card-heading"><h3>내 경기 목록</h3><span class="number-pill">${state.videos.length}</span></div>${state.videos.map((v, i) => `<button class="playlist-item ${v.id === selectedVideo ? 'selected' : ''}" data-action="open-video" data-id="${v.id}"><span class="playlist-index">${String(i + 1).padStart(2, '0')}</span><span><strong>${escape(v.title)}</strong><small>${isOriginal(v) ? '원본 · ' + formatBytes(v.size) : formatTime(v.start || 0) + '부터'} · ${state.observations.filter(o => o.videoId === v.id).length}개 장면</small></span>${icon(v.id === selectedVideo ? 'play' : 'chevron')}</button>`).join('')}</section><div class="tip-card">${icon('spark')}<div><strong>무엇을 보면 좋을까요?</strong><p>공을 받을 때뿐 아니라, 공이 없을 때 어디로 움직이는지도 살펴보세요.</p></div></div></aside></div>`;
}
function playerPlaceholder(video) { return `<div class="player-placeholder"><div class="player-pitch-lines"></div><span class="player-kicker">${isOriginal(video) ? 'ORIGINAL FILM' : 'MATCH FILM'} · NAVY 11</span><button class="big-play" data-action="play" aria-label="${escape(video.title)} 재생">${icon('play')}</button><h3>${escape(video.title)}</h3><p>${formatTime(previewTime ?? video.start ?? 0)}부터 남색 11번 선수를 확인해요</p><span class="player-bottom">${isOriginal(video) ? '내 기기에 보관한 원본 영상' : 'YouTube 플레이어로 재생'} ${icon(isOriginal(video) ? 'video' : 'external')}</span></div>`; }
function releaseOriginalPlayer() {
  playerGeneration++;
  const player = $('#video-player video');
  if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
  if (originalURL) { URL.revokeObjectURL(originalURL); originalURL = null; }
}
async function loadPlayer(autoplay = true) {
  const video = state.videos.find(v => v.id === selectedVideo);
  const container = $('#video-player');
  if (!video || !container) return;
  releaseOriginalPlayer();
  container.classList.remove('original-recovery');
  if (!isOriginal(video)) {
    container.innerHTML = `<iframe title="${escape(video.title)} — YouTube 플레이어" src="https://www.youtube-nocookie.com/embed/${video.id}?start=${previewTime ?? video.start ?? 0}&autoplay=1&rel=0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
    return;
  }
  const generation = playerGeneration;
  container.innerHTML = `<div class="original-loading" role="status"><span class="loading-spinner"></span>이 기기의 원본을 불러오고 있어요.</div>`;
  try {
    const blob = await getOriginalVideo(video.id);
    if (generation !== playerGeneration || !container.isConnected) return;
    if (!blob) {
      container.classList.add('original-recovery');
      container.innerHTML = `<div class="original-missing">${icon('video')}<h3>이 브라우저에서 원본을 찾지 못했어요.</h3><p>다른 기기에서 등록했거나 브라우저 저장소가 정리되었을 수 있어요. 같은 원본 파일을 다시 선택하면 기록을 이어갈 수 있어요.</p><label class="button lime reconnect-label">${icon('plus')}원본 다시 연결<input id="reconnect-original" type="file" accept="video/*,.mp4,.mov,.m4v,.webm,.3gp" data-id="${video.id}"></label></div>`;
      return;
    }
    originalURL = URL.createObjectURL(blob);
    container.innerHTML = `<video controls playsinline preload="metadata" aria-label="${escape(video.title)} 원본 영상"></video><p class="local-playback-error" role="alert" hidden>이 브라우저에서 재생할 수 없는 영상 형식이에요. MP4(H.264) 형식으로 변환해 새 영상으로 등록해 주세요. 원본은 ‘원본 내보내기’로 보관할 수 있어요.</p>`;
    const native = $('video', container);
    native.addEventListener('loadedmetadata', () => {
      const desired = previewTime ?? video.start ?? 0;
      if (desired > 0) native.currentTime = Math.min(desired, Number.isFinite(native.duration) ? Math.max(0, native.duration - .1) : desired);
      if (autoplay) native.play().catch(() => {});
    }, { once: true });
    native.addEventListener('error', () => { if (container.isConnected) $('.local-playback-error', container).hidden = false; });
    native.src = originalURL;
  } catch (err) {
    if (generation === playerGeneration && container.isConnected) { container.classList.add('original-recovery'); container.innerHTML = `<div class="original-missing">${icon('info')}<h3>원본을 불러오지 못했어요.</h3><p>${escape(err.message)}</p><button class="button lime" data-action="play">다시 시도</button></div>`; }
  }
}
function attachPlayer() {
  const video = state.videos.find(v => v.id === selectedVideo);
  if (isOriginal(video) || autoplayNext) { const autoplay = autoplayNext; autoplayNext = false; loadPlayer(autoplay); }
}
function observationList(observations) {
  if (!observations.length) return empty('bookmark', '첫 발견을 남겨보세요', '좋았던 플레이도, 다시 연습하고 싶은 순간도 모두 성장의 힌트예요.');
  return `<div class="observation-list">${[...observations].reverse().map(o => `<article class="observation-item"><button class="time-chip" data-action="seek" data-id="${o.videoId}" data-time="${o.time}">${icon('play')}${formatTime(o.time)}</button><div><div class="observation-tags">${badge(SKILLS.find(s => s.id === o.skill)?.name || '', 'subtle')}${badge(({ strength: '좋았어요', focus: '연습해요', note: '관찰 기록' })[o.type], o.type === 'strength' ? 'green' : o.type === 'focus' ? 'amber' : 'subtle')}<span class="observation-rating">${o.rating ? o.rating + '/5단계' : '점수 없이 기록'}</span></div><p>${escape(o.note)}</p></div><button class="icon-button delete-observation" data-action="delete-observation" data-id="${escape(o.id)}" aria-label="${formatTime(o.time)} 장면 삭제">${icon('trash')}</button></article>`).join('')}</div>`;
}
function reportPage() {
  const data = scores(), observed = data.filter(s => s.value !== null);
  const filtered = state.observations.filter(o => !reportSkill || o.skill === reportSkill);
  return `${sectionHeader('PLAYER INSIGHTS', '나의 가능성을 읽는 시간.', '숫자 하나보다, 그 숫자를 만든 플레이에 집중해요.', `<div class="heading-actions"><button class="button secondary" data-action="demo">${icon('spark')}${demo ? '실제 기록 보기' : '예시 리포트 체험'}</button><button class="button primary" data-action="snapshot" ${!state.observations.some(o => o.rating) || demo ? 'disabled' : ''}>${icon('bookmark')}성장 기록 저장</button></div>`)}
  <div class="report-top-grid"><section class="card"><div class="card-heading"><div><h2>플레이 스파이더맵</h2><p>남색 11번 · U${state.player.age} · ${demo ? '예시 평가' : '직접 기록한 관찰 평가'}</p></div>${badge(demo ? '예시 데이터' : `${state.observations.length}개 근거 장면`, demo ? 'amber' : 'subtle')}</div><div class="report-radar">${radarChart(data, !observed.length)}</div><div class="card-bottom-note">${icon('info')}1~5단계의 관찰 평가이며, 검증된 표준 검사 점수가 아닙니다.</div></section><section class="card skill-breakdown"><div class="card-heading"><div><h2>능력별 살펴보기</h2><p>항목을 선택하면 아래 근거 장면을 볼 수 있어요.</p></div></div><div class="skills-list">${data.map(s => `<button class="skill-row ${reportSkill === s.id ? 'selected' : ''}" data-action="filter-skill" data-id="${s.id}"><span>${s.name}</span><span class="skill-meter"><i style="width:${(s.value || 0) * 20}%"></i></span><strong>${s.value === null ? '<span class="not-observed">관찰 부족</span>' : s.value.toFixed(1) + '<small>/5</small>'}</strong>${icon('chevron')}</button>`).join('')}</div></section></div>
  ${demo ? `<div class="insight-grid"><article class="insight-card strength"><span class="insight-icon">${icon('spark')}</span><span class="eyebrow">SAMPLE STRENGTH</span><h3>동료와 함께 만드는 플레이</h3><p>예시 리포트에서는 협력을 강점으로 설정했어요. 실제 평가에는 반드시 확인한 장면이 연결됩니다.</p>${badge('화면 체험용 설명', 'subtle')}</article><article class="insight-card focus"><span class="insight-icon">${icon('target')}</span><span class="eyebrow">SAMPLE NEXT STEP</span><h3>공을 받기 전, 한 번 더 보기</h3><p>주변 확인을 연습하는 성장 계획의 예시예요. 실제 선수에게 필요한 과제인지는 영상 관찰이 필요해요.</p><button class="text-button" data-action="navigate" data-page="training">훈련 예시 보기 ${icon('arrow')}</button></article></div>` : ''}
  ${!demo && observed.length ? realInsights(data) : ''}
  ${!demo && (state.autoAnalyses || []).length ? autoStatusCard(state.autoAnalyses.at(-1)) : ''}
  ${!demo ? (state.analyses || []).slice(-6).map(analysisResult).join('') : ''}
  <section class="card"><div class="card-heading"><div><h2>${reportSkill ? SKILLS.find(s => s.id === reportSkill).name + ' · ' : ''}평가의 근거</h2><p>직접 확인하고 기록한 장면만 표시해요.</p></div>${reportSkill ? '<button class="text-button" data-action="clear-filter">전체 항목 보기</button>' : '<button class="button secondary small" data-action="navigate" data-page="videos">장면 기록하러 가기 ' + icon('arrow') + '</button>'}</div>${demo ? empty('info', '예시 점수에는 실제 근거 영상을 연결하지 않았어요', '실제 선수의 영상 장면으로 오해하지 않도록 예시와 기록을 분리해요.') : observationList(filtered)}</section>
  <section class="comparison-note"><span class="comparison-icon">${icon('trend')}</span><div><h3>전국 등수보다, 나의 변화부터.</h3><p>현재는 전국 순위와 참여자 백분위를 제공하지 않아요. 비교 가능한 평가 데이터와 검증된 기준이 쌓이면 안내할게요.</p></div>${badge('비교 데이터 수집 전', 'subtle')}</section>`;
}
function realInsights(data) {
  const observed = data.filter(s => s.value !== null);
  const strongest = [...observed].sort((a, b) => b.value - a.value)[0];
  const focus = [...observed].sort((a, b) => a.value - b.value)[0];
  return `<div class="insight-grid"><article class="insight-card strength"><span class="insight-icon">${icon('spark')}</span><span class="eyebrow">OBSERVED PLAY</span><h3>${escape(strongest.name)}, 계속 발견해요.</h3><p>기록한 ${strongest.count}개 평가의 평균은 ${strongest.value.toFixed(1)}/5단계예요. ${escape(strongest.description)}을 다른 경기에서도 살펴보세요.</p>${badge('관찰자의 잠정 평가', 'subtle')}</article><article class="insight-card focus"><span class="insight-icon">${icon('target')}</span><span class="eyebrow">PRACTICE CANDIDATE</span><h3>${escape(focus.name)}, 다음 연습의 후보.</h3><p>관찰한 항목을 기준으로 연습 후보를 제안해요. ${escape(focus.cue)} 관찰하지 못한 항목은 비교에서 제외했어요.</p><button class="text-button" data-action="navigate" data-page="training">연습 계획 살펴보기 ${icon('arrow')}</button></article></div>`;
}
const HABITS = [ ['moon', '충분히 쉬는 시간', '일정한 취침·기상 시간을 함께 정하고, 피곤한 날은 휴식을 우선해요.'], ['leaf', '다양하게, 규칙적으로', '끼니를 거르지 않고 다양한 음식을 먹어요. 임의의 감량이나 보충제보다 기본 식사를 챙겨요.'], ['heart', '실수해도, 다음 플레이', '“괜찮아, 다음에 해보자.” 결과보다 시도와 회복 행동을 이야기해요.'], ['ball', '즐거움을 남기는 훈련', '기존 팀 훈련과 회복 시간을 먼저 확인하고, 추가 과제는 코치와 조절해요.'] ];
function trainingPage() {
  const plan = deriveTrainingPlan(demo ? [] : state.observations);
  const items = plan.weeks[week - 1], done = items.filter((_, i) => state.completed.includes(`week${week}-${i}-${plan.focus}`)).length;
  return `${sectionHeader('SMALL STEPS, REAL GROWTH', '오늘의 연습이, 내일의 플레이로.', '한 번에 많이보다, 작은 목표를 꾸준하게 이어가요.')}
  <div class="plan-notice">${icon('info')}<div><strong>${plan.personalized ? `직접 기록한 ${plan.label} 평가 ${plan.sourceCount}개로 고른 연습 후보예요.` : '시작을 돕는 일반 훈련 예시예요.'}</strong><p>${plan.personalized ? '자동 영상 분석이나 전문 코치의 맞춤 처방은 아닙니다. ' : '아직 이 선수의 관찰 평가가 없어 주변 확인 루틴을 예시로 보여드려요. '}${plan.note}</p></div></div>
  <div class="training-tabs" role="tablist" aria-label="훈련 종류"><button role="tab" aria-selected="${trainingTab === 'skill'}" data-action="training-tab" data-tab="skill" class="${trainingTab === 'skill' ? 'active' : ''}">${icon('target')}4주 플레이 루틴</button><button role="tab" aria-selected="${trainingTab === 'life'}" data-action="training-tab" data-tab="life" class="${trainingTab === 'life' ? 'active' : ''}">${icon('leaf')}몸과 마음의 루틴</button></div>
  ${trainingTab === 'life' ? `<div class="habit-grid">${HABITS.map(([ico, title, text], i) => `<article class="card habit-card"><span class="habit-illustration ${['blue', 'green', 'peach', 'violet'][i]}">${icon(ico)}</span><span class="eyebrow">DAILY HABIT ${String(i + 1).padStart(2, '0')}</span><h2>${title}</h2><p>${text}</p><button class="check-task ${state.completed.includes('habit-' + i) ? 'checked' : ''}" data-action="complete" data-id="habit-${i}" aria-pressed="${state.completed.includes('habit-' + i)}"><span>${icon('check')}</span>${state.completed.includes('habit-' + i) ? '함께 확인했어요' : '함께 확인하기'}</button></article>`).join('')}</div><p class="muted fine-print">일반적인 생활 안내예요. 통증·지속적인 피로·식사나 수면 문제가 있다면 운동을 강요하지 말고 적절한 전문가의 도움을 받아요.</p>` : `<div class="plan-overview"><div><span class="eyebrow">THIS MONTH'S FOCUS</span><h2>${escape(plan.title)}</h2><p>${escape(plan.label)} · 기본 연습 → 선택과 연결 → 경기 적용 → 다시 관찰</p></div><div class="plan-overview-icon">${icon('target')}</div></div><div class="week-selector" role="tablist" aria-label="훈련 주차">${['발견하기', '연결하기', '적용하기', '돌아보기'].map((text, i) => `<button role="tab" aria-selected="${week === i + 1}" class="${week === i + 1 ? 'active' : ''}" data-action="week" data-week="${i + 1}"><span>WEEK 0${i + 1}</span><strong>${text}</strong>${state.completed.filter(id => id.startsWith('week' + (i + 1) + '-') && id.endsWith('-' + plan.focus)).length === 3 ? icon('check') : ''}</button>`).join('')}</div><div class="training-progress"><span>이번 주의 작은 실천</span><div class="progress-track"><i style="width:${done / 3 * 100}%"></i></div><strong>${done}<span> / 3 완료</span></strong></div><div class="training-grid">${items.map((item, i) => { const checked = state.completed.includes(`week${week}-${i}-${plan.focus}`); return `<article class="card training-card ${checked ? 'is-complete' : ''}"><div class="training-card-top"><span class="task-number">0${i + 1}</span>${badge(icon('clock') + item.minutes, 'subtle')}</div><h2>${item.title}</h2><p>${item.detail}</p><div class="success-criterion">${icon('flag')}<span>${item.target}</span></div><button class="check-task ${checked ? 'checked' : ''}" data-action="complete" data-id="week${week}-${i}-${plan.focus}" aria-pressed="${checked}"><span>${icon('check')}</span>${checked ? '실천했어요' : '실천 완료하기'}</button></article>`; }).join('')}</div><div class="coach-note">${icon('heart')}<p><strong>부모님께 드리는 작은 제안</strong> “왜 못했어?” 대신 “오늘 어떤 걸 시도해봤어?”라고 물어봐 주세요.</p></div>`}`;
}
function historyPage() {
  const entries = [...state.snapshots].reverse();
  return `${sectionHeader('YOUR GROWTH STORY', '한 걸음씩 쌓이는, 나의 이야기.', '같은 기준으로 돌아볼 때, 작은 변화가 보이기 시작해요.', `<button class="button secondary" data-action="export">${icon('download')}기록 내보내기</button>`)}<div class="history-intro"><span class="history-large-icon">${icon('trend')}</span><div><span class="eyebrow">PROGRESS OVER PERFECTION</span><h2>완벽한 한 경기보다,<br>어제보다 나아진 한 장면.</h2><p>성장 리포트에서 관찰 평가를 저장하면 여기에 기록됩니다.</p></div><div class="history-stat"><strong>${String(entries.length).padStart(2, '0')}</strong><span>번의 성장 기록</span></div></div>
  ${entries.length ? `<section class="card"><div class="card-heading"><div><h2>성장 타임라인</h2><p>기록 당시의 누적 관찰 평가예요. 독립적인 경기별 표준 평가는 아닙니다.</p></div></div><div class="history-timeline">${entries.map((entry, idx) => `<article class="history-entry"><span class="timeline-marker"></span><div class="history-date">${dateLabel(entry.createdAt)}${idx === 0 ? badge('최근 기록', 'green') : ''}</div><h3>${entry.observationCount}개 장면에서 발견한 나</h3><div class="snapshot-scores">${SKILLS.map((s, i) => `<span>${s.short}<strong>${entry.scores[i] === null ? '관찰 부족' : entry.scores[i].toFixed(1) + '/5'}</strong>${idx < entries.length - 1 && entry.scores[i] !== null && entries[idx + 1].scores[i] !== null ? `<small class="${entry.scores[i] >= entries[idx + 1].scores[i] ? 'positive' : 'muted'}">${entry.scores[i] - entries[idx + 1].scores[i] >= 0 ? '+' : ''}${(entry.scores[i] - entries[idx + 1].scores[i]).toFixed(1)}</small>` : ''}</span>`).join('')}</div></article>`).join('')}</div></section>` : `<section class="card">${empty('trend', '성장의 첫 페이지를 기다리고 있어요', '영상을 보고 장면을 기록한 다음, 성장 리포트에서 첫 기록을 저장해 주세요.', '<button class="button primary" data-action="navigate" data-page="videos">첫 장면 기록하기 ' + icon('arrow') + '</button>')}</section>`}
  <div class="comparison-note">${icon('info')}<p>점수 변화는 영상 조건, 관찰 기회와 기록자의 판단에 영향을 받아요. 숫자와 함께 실제 장면을 확인해 주세요.</p></div>`;
}
function profilePage() {
  return `${sectionHeader('PLAYER PROFILE', '나를 알아가는 첫 페이지.', '성장 단계에 맞게 살펴볼 수 있도록 기본 정보를 기록해요.')}
  <div class="profile-grid"><section class="card profile-identity"><img src="/assets/jersey-11.svg" alt="남색 11번 선수 유니폼"><span class="eyebrow">YOUR NEXT XI</span><h2>${escape(playerName())}</h2><p>남색 유니폼 · 등번호 11</p>${badge('U' + state.player.age + ' · 성장 중인 선수', 'green')}</section><section class="card profile-form-card"><div class="card-heading"><div><h2>선수 기본 정보</h2><p>실명 대신 별명을 사용해도 좋아요.</p></div></div><form id="profile-form"><label>선수 이름 또는 별명<input name="name" maxlength="30" value="${escape(state.player.name)}" placeholder="예: 내일의 11번"></label><div class="form-grid"><label>나이<select name="age">${Array.from({ length: 14 }, (_, i) => i + 5).map(n => `<option value="${n}" ${state.player.age === n ? 'selected' : ''}>${n}세</option>`).join('')}</select></label><label>주 포지션<select name="position">${['미등록', '공격수', '미드필더', '수비수', '여러 포지션'].map(p => `<option ${state.player.position === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label></div><div class="form-grid"><label>유니폼 색상<input value="남색" disabled></label><label>등번호<input value="11" disabled></label></div><label>기존 팀 훈련 횟수<select name="weeklyTraining">${Array.from({ length: 15 }, (_, n) => `<option value="${n}" ${state.player.weeklyTraining === n ? 'selected' : ''}>주 ${n}회</option>`).join('')}</select><span class="field-help">추가 훈련은 기존 일정과 회복 시간을 고려해 조절해요.</span></label><div id="profile-error" class="form-error" role="alert"></div><button class="button primary" type="submit">${icon('check')}선수 정보 저장</button></form></section></div>
  <section class="card workspace-settings"><div><h2>내 기록 관리</h2><p>이 버전은 서버의 한 워크스페이스에 저장됩니다. 로그인·다중 사용자 분리는 아직 연결되지 않았어요.<br>공개 서비스로 배포하기 전에 계정과 접근 권한을 연결해야 합니다.</p></div><div class="heading-actions"><button class="button secondary small" data-action="export">${icon('download')}내보내기</button><button class="button danger small" data-action="reset">기록 초기화</button></div></section>`;
}
function syncMobileMenu() {
  const mobile = matchMedia('(max-width: 720px)').matches;
  const open = mobile && document.body.classList.contains('menu-open');
  const menu = $('.sidebar'), toggle = $('.mobile-menu');
  if (menu) menu.inert = mobile && !open;
  if (toggle) { toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기'); }
}
function closeMobileMenu() { document.body.classList.remove('menu-open'); syncMobileMenu(); }
function navigate(next) { closeMobileMenu(); if (page === next) { render(); return; } location.hash = next; }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('visible'), 3500); }
async function persist(mutator) {
  if (pending) throw new Error('이전 저장이 끝난 뒤 다시 시도해 주세요.');
  pending = true;
  const next = structuredClone(state); mutator(next);
  document.body.classList.add('saving');
  try {
    const response = await fetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '저장하지 못했어요. 다시 시도해 주세요.');
    state = result;
  } finally { pending = false; document.body.classList.remove('saving'); }
}
function openModal(title, subtitle, content, wide = false) {
  modalReturn = document.activeElement;
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-description" tabindex="-1"><div class="modal-heading"><div><span class="eyebrow">NEXT XI WORKSPACE</span><h2 id="modal-title">${title}</h2><p id="modal-description">${subtitle}</p></div><button class="icon-button" data-action="close-modal" aria-label="닫기">${icon('close')}</button></div>${content}</section></div>`;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => ($('input:not([type=checkbox]), textarea, select', $('.modal')) || $('.modal')).focus());
}
function closeModal() { if (analysisBusy) { analysisController?.abort(); return; } if (savingOriginal) { toast('원본을 저장하는 중이에요. 잠시만 기다려 주세요.'); return; } selectionToken++; $('#modal-root').innerHTML = ''; document.body.classList.remove('modal-open'); if (modalReturn?.isConnected) modalReturn.focus(); }
function openAddVideo() {
  selectedMetadataPromise = null; registrationKind = 'file'; selectedOriginal = null; selectedOriginalMeta = null; metadataLoading = false; generatedTitle = ''; selectionToken++;
  openModal('오늘의 경기를, 원본 그대로.', '스마트폰의 사진·파일 앱에서 경기 영상을 선택할 수 있어요.', `<form id="video-form" novalidate><div class="upload-source-tabs" role="tablist" aria-label="영상 등록 방법"><button type="button" role="tab" aria-selected="true" aria-controls="file-upload-panel" data-action="video-source" data-kind="file" class="active">${icon('video')}원본 파일</button><button type="button" role="tab" aria-selected="false" aria-controls="youtube-upload-panel" data-action="video-source" data-kind="youtube">${icon('external')}YouTube 링크</button></div><section id="file-upload-panel" role="tabpanel"><label class="file-picker-area"><span class="file-picker-icon">${icon('plus')}</span><strong>사진·파일에서 영상 선택</strong><span>MP4 · MOV · M4V · WebM · 3GP</span><small>최대 2GB · 기기의 남은 저장 공간 내에서 등록</small><input id="original-file" name="original" type="file" accept="video/*,.mp4,.mov,.m4v,.webm,.3gp" required></label><div id="selected-file" class="selected-file" hidden></div><div class="original-storage-note">${icon('lock')}<p><strong>이 기기에 원본 그대로 저장해요.</strong>클라우드 업로드·기기 간 동기화는 아직 지원하지 않아요. 브라우저 데이터를 지우면 삭제될 수 있으니 원본은 별도로 보관해 주세요.</p></div></section><section id="youtube-upload-panel" role="tabpanel" hidden><label>YouTube 영상 링크<input name="url" type="url" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off"><span class="field-help">일반 영상, 짧은 링크, Shorts 주소를 사용할 수 있어요.</span></label></section><label>영상 이름<input name="title" maxlength="100" placeholder="예: 오늘의 주말 경기" required></label><div class="fixed-player">${icon('target')}분석 대상<strong>남색 유니폼 · 11번</strong></div><label class="consent-label"><input type="checkbox" name="rights" required><span>영상 등록에 필요한 권한을 확인했어요.<small>다른 선수와 보호자의 권리도 함께 확인해 주세요.</small></span></label><div id="original-save-progress" class="original-save-progress" role="status" hidden><span class="loading-spinner"></span><div><strong>원본을 이 기기에 저장하는 중이에요.</strong><p>영상 크기에 따라 시간이 걸릴 수 있어요. 화면을 유지해 주세요.</p></div></div><div class="modal-actions upload-actions"><div id="video-error" class="form-error" role="alert"></div><button type="button" class="button secondary" data-action="close-modal">취소</button><button class="button primary" type="submit">${icon('plus')}원본 영상 등록</button></div></form>`);
}
function setVideoSource(kind) {
  if (savingOriginal) return;
  registrationKind = kind;
  const form = $('#video-form'); if (!form) return;
  $('#file-upload-panel').hidden = kind !== 'file';
  $('#youtube-upload-panel').hidden = kind !== 'youtube';
  $('#original-file').required = kind === 'file';
  $('input[name=url]', form).required = kind === 'youtube';
  form.querySelectorAll('[data-action=video-source]').forEach(el => { const active = el.dataset.kind === kind; el.setAttribute('aria-selected', String(active)); el.classList.toggle('active', active); });
  $('button[type=submit]', form).innerHTML = `${icon('plus')}${kind === 'file' ? '원본 영상 등록' : '영상 등록'}`;
  $('#video-error').textContent = '';
}
async function selectOriginal(file) {
  const token = ++selectionToken;
  selectedOriginal = null; selectedOriginalMeta = null;
  const summary = $('#selected-file'), error = $('#video-error'), form = $('#video-form');
  if (!summary || !error || !form) return;
  error.textContent = ''; summary.hidden = true;
  if (!file) return;
  try {
    validateVideoFile(file);
    selectedOriginal = file; metadataLoading = true;
    const title = $('input[name=title]', form);
    if (!title.value || title.value === generatedTitle) { generatedTitle = file.name.replace(/\.[^.]+$/, '').slice(0, 100); title.value = generatedTitle; }
    summary.hidden = false;
    summary.innerHTML = `${icon('video')}<div><strong>${escape(file.name)}</strong><span>${formatBytes(file.size)} · 영상 정보를 확인하고 있어요.</span></div><span class="loading-spinner"></span>`;
    selectedMetadataPromise = readVideoMetadata(file);
    const meta = await selectedMetadataPromise;
    if (token !== selectionToken || !summary.isConnected) return;
    selectedOriginalMeta = meta;
    summary.innerHTML = `${icon('check')}<div><strong>${escape(file.name)}</strong><span>${formatBytes(file.size)}${meta.duration ? ' · ' + formatTime(meta.duration) : ''}</span><small>권한을 확인한 뒤 아래 ‘원본 영상 등록’을 눌러 주세요.</small>${!meta.playable ? '<small>이 기기에서 재생이 제한될 수 있어요. 호환성이 높은 MP4(H.264)를 권장해요.</small>' : ''}</div>`;
  } catch (err) { if (token === selectionToken && error.isConnected) { selectedOriginal = null; selectedOriginalMeta = null; summary.hidden = true; error.textContent = err.message; } }
  finally { if (token === selectionToken) metadataLoading = false; }
}
function openObservation() {
  const native = $('#video-player video');
  if (native) { previewTime = Math.floor(native.currentTime); native.pause(); }
  if (!state.videos.length) return openAddVideo();
  openModal('한 장면의 발견을 남겨요.', '직접 확인한 행동과 근거를 기록해 주세요. 점수는 선택 사항이에요.', `<form id="observation-form"><div class="form-grid"><label>경기 영상<select name="videoId">${state.videos.map(v => `<option value="${v.id}" ${v.id === selectedVideo ? 'selected' : ''}>${escape(v.title)}</option>`).join('')}</select></label><label>장면 시작 시간<input name="time" placeholder="00:57" value="${formatTime(previewTime ?? state.videos.find(v => v.id === selectedVideo)?.start ?? 0)}" required pattern="[0-9]{1,3}(:[0-5][0-9]){1,2}"></label></div><div class="form-grid"><label>관찰 항목<select name="skill">${SKILLS.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select></label><label>장면 분류<select name="type"><option value="strength">좋았던 플레이</option><option value="focus">연습할 플레이</option><option value="note">관찰 기록</option></select></label></div><label>무엇을 관찰했나요?<textarea name="note" rows="3" maxlength="1500" required placeholder="예: 공을 받기 전에 왼쪽 어깨 너머로 확인한 뒤, 빈 공간으로 첫 터치를 했다."></textarea></label><label>행동 단계 평가 <span class="optional">선택</span><select name="rating"><option value="">점수 없이 장면만 기록</option>${SCALE.map((s, i) => `<option value="${i + 1}">${i + 1}단계 · ${s}</option>`).join('')}</select><span class="field-help">한 장면의 잠정 평가예요. 여러 경기에서 반복 관찰해 주세요.</span></label><div id="observation-error" class="form-error" role="alert"></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">취소</button><button class="button primary" type="submit">${icon('bookmark')}장면 저장</button></div></form>`, true);
}
function analysisResult(entry) {
  const r = entry.result;
  return `<article class="card analysis-result"><div class="analysis-result-heading"><div><span class="eyebrow">AI SCENE FEEDBACK · ${formatTime(entry.start)}–${formatTime(entry.end)}</span><h3>${r.identified ? '이 장면에서 발견한 플레이' : '선수 확인이 어려운 장면이에요'}</h3></div>${badge('AI 초안 · 확인 필요', 'amber')}</div><p class="analysis-summary">${escape(r.summary)}</p>${r.observations.map(o => `<div class="ai-observation"><button class="time-chip" data-action="seek" data-id="${entry.videoId}" data-time="${o.time}">${icon('play')}${formatTime(o.time)}</button><div>${badge(SKILLS.find(s => s.id === o.skill)?.name, 'subtle')} ${badge(({strength:'좋았어요',focus:'연습해요',note:'관찰'})[o.type], o.type === 'focus' ? 'amber' : 'green')}<span class="ai-confidence">확신 ${({low:'낮음',medium:'보통',high:'높음'})[o.confidence]}</span><p>${escape(o.note)}</p></div></div>`).join('')}${r.nextAction ? `<div class="analysis-next"><strong>다음 연습으로 연결해요</strong><p>${escape(r.nextAction)}</p></div>` : ''}<ul class="analysis-limitations">${r.limitations.map(text => `<li>${escape(text)}</li>`).join('')}</ul><div class="analysis-footnote">${escape(entry.model)} · ${dateLabel(entry.createdAt)} · 정지 화면을 보고 만든 참고 의견입니다. 공의 빠른 움직임·정확한 패스 결과는 놓칠 수 있어요. 전체 경기 능력치·전국 순위로 환산하지 않습니다.</div></article>`;
}
const autoStatusLabels = {scanning:'남색 11번을 찾고 있어요',analyzing:'발견한 구간을 분석하고 있어요',completed:'자동 분석 완료',partial:'일부 구간 분석 완료',not_found:'표본에서 남색 11번을 확인하지 못했어요',cancelled:'분석을 중지했어요',failed:'분석을 완료하지 못했어요',interrupted:'중단된 분석을 이어갈 수 있어요'};
const autoJobFor = id => (state.autoAnalyses || []).find(job => job.videoId === id);
const canResumeAuto = job => job && ['partial','cancelled','failed','interrupted'].includes(job.status);
function autoStatusCard(job, summary = false) {
  if (!job) return '';
  const pct = Math.round((job.sampledCount / job.sampleCount * .6 + (job.selectedCount ? job.completedCount / job.selectedCount * .4 : 0)) * 100);
  const complete = ['completed','not_found'].includes(job.status);
  return `<section class="auto-analysis-status ${summary ? 'auto-summary' : ''}" data-auto-status="${job.status}"><div class="auto-status-heading"><span class="auto-symbol">${icon(complete ? 'check' : 'target')}</span><div><span class="eyebrow">AUTOMATIC · NAVY 11</span><h3>${autoStatusLabels[job.status] || '자동 분석'}</h3></div>${badge(`${job.completedCount}개 구간 저장`,complete ? 'green' : 'subtle')}</div><p class="auto-message">${escape(job.message)}</p><div class="auto-status-metrics"><span>전체 영상<strong>${formatTime(job.duration)}</strong></span><span>탐색한 시점<strong>${job.sampledCount} / ${job.sampleCount}</strong></span><span>선수 확인<strong>${job.detectedCount}개 시점</strong></span><span>구간 분석<strong>${job.completedCount} / ${job.selectedCount}</strong></span></div><div class="auto-progress-track" role="progressbar" aria-label="자동 탐색과 구간 분석 진행" aria-valuenow="${complete ? 100 : Math.min(99,pct)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${complete ? 100 : Math.min(99,pct)}%"></span></div><p class="auto-coverage">전체 시간대에서 약 ${Math.round(job.interval * 10) / 10}초 간격으로 표본을 확인합니다. 연속 추적이 아니므로 짧은 플레이나 가려진 등번호를 놓칠 수 있어요. 발견한 구간 중 최대 6개를 분석합니다.</p>${canResumeAuto(job) ? `<button type="button" class="button secondary small" data-action="analyze-video" data-id="${job.videoId}">${icon('play')}중단 지점부터 이어서 분석</button><button type="button" class="text-button auto-restart" data-action="restart-analysis" data-id="${job.videoId}">처음부터 다시 분석</button>` : ''}</section>`;
}
function analysisPanel(video) {
  const entries = (state.analyses || []).filter(a => a.videoId === video.id).slice(-6).sort((a,b) => a.start-b.start);
  const job = autoJobFor(video.id);
  return `<section class="card analysis-panel"><div class="card-heading"><div><span class="eyebrow">AUTOMATIC PLAYER DISCOVERY</span><h2>남색 11번, 앱이 찾아서 분석해요.</h2><p>장면을 고르거나 영상을 일시정지할 필요가 없어요.</p></div><button class="button primary small" data-action="analyze-video" data-id="${video.id}">${icon('spark')}${canResumeAuto(job) ? '자동 분석 이어서 하기' : '남색 11번 자동 분석'}</button></div><p class="analysis-panel-note">영상의 전체 시간대에서 선수를 탐색하고, 등번호가 확인된 구간을 자동으로 분석합니다. 결과는 코치 확인 전 AI 초안이며 전체 능력치 점수와 구분돼요.</p>${autoStatusCard(job)}</section>${entries.map(analysisResult).join('')}`;
}
async function openAnalysis(id, fresh = false) {
  const video = state.videos.find(v => v.id === id);
  if (!isOriginal(video)) throw new Error('이 기능은 이 기기에 저장한 원본 영상에서 사용할 수 있어요.');
  $('#video-player video')?.pause();
  const job = autoJobFor(id), resume = !fresh && canResumeAuto(job);
  openModal('남색 11번의 플레이를, 자동으로.', '영상 탐색부터 구간 선택, 플레이 피드백까지 앱이 진행합니다.', `<div id="analysis-setup" class="analysis-setup" role="status"><span class="loading-spinner"></span>분석 서버 연결을 확인하고 있어요.</div><form id="analysis-form" data-id="${id}" data-fresh="${fresh}" novalidate hidden><div class="fixed-player">${icon('target')}분석 대상<strong>남색 유니폼 · 11번 · U${state.player.age}</strong></div><ol class="auto-workflow"><li><span>01</span><div><strong>영상 전체 시간대 탐색</strong><small>최대 120개 시점을 확인해 선수를 찾습니다.</small></div></li><li><span>02</span><div><strong>분석할 구간 자동 선택</strong><small>등번호가 확인된 시점의 앞뒤를 살펴봅니다.</small></div></li><li><span>03</span><div><strong>플레이와 다음 연습 정리</strong><small>최대 6개 구간의 결과를 하나씩 저장합니다.</small></div></li></ol>${resume ? `<p class="auto-resume-note">이전에 탐색한 ${job.sampledCount}개 시점과 완료한 ${job.completedCount}개 구간에서 이어갑니다.</p>` : ''}<p class="field-help">일정 간격의 표본 탐색이므로 모든 플레이를 찾는 방식은 아닙니다. 영상이 길면 수분 이상 걸릴 수 있으며, 분석 중에는 이 화면을 열어 두세요. OpenAI API 사용료가 발생합니다.</p><label>분석 이용 코드<input name="accessCode" type="password" autocomplete="off" maxlength="200" required><span class="field-help">운영자가 정한 이용 코드입니다. 이 코드와 영상 원본은 결과 기록에 저장하지 않습니다.</span></label><label class="consent-label"><input name="consent" type="checkbox"><span>영상 이용 권한을 확인했으며, 자동 탐색·분석에 필요한 정지 화면을 OpenAI 서비스로 전송하는 데 동의해요.<small>다른 아동이 함께 등장할 수 있습니다. 원본 파일 전체는 전송하지 않으며, 이 동의는 AI 학습용 동의와 별개입니다.</small></span></label><div id="analysis-progress" class="original-save-progress" role="status" hidden><span class="loading-spinner"></span><p></p></div><div id="analysis-live-status"></div><div class="modal-actions upload-actions"><div id="analysis-error" class="form-error" role="alert"></div><button type="button" class="button secondary" data-action="close-modal">닫기</button><button type="submit" class="button primary">${icon('spark')}남색 11번 자동 분석 시작</button></div></form>`, true);
  const setup = $('#analysis-setup'), form = $('#analysis-form');
  const availability = await getAnalysisAvailability();
  if (!setup.isConnected) return;
  if (availability.available) { setup.hidden = true; form.hidden = false; return; }
  const unavailableText = availability.reason === 'invalid_key_format' ? 'Netlify에 등록된 API 키 형식이 올바르지 않습니다. 축약된 키 표시나 따옴표가 아닌, 발급 직후 복사한 전체 키를 SOCCER_AI_API_KEY의 Production 값으로 저장한 뒤 다시 배포해야 합니다.' : availability.reason === 'backend_missing' ? '이 주소에는 분석 서버가 배포되어 있지 않습니다.' : availability.reason === 'missing_credentials' ? '분석 서버에 AI 인증 정보 또는 이용 코드가 설정되지 않았습니다.' : '분석 서버의 연결 상태를 확인하지 못했습니다. 잠시 후 다시 열어 주세요.';
  setup.classList.add('unavailable');
  setup.innerHTML = `${icon('info')}<div><h3>원본은 저장됐지만, 분석 서버 연결을 확인해 주세요.</h3><p>${unavailableText}</p><p>원본 영상과 기존 기록은 이 기기에 보관되어 있습니다.</p><button class="button secondary" data-action="close-modal">확인했어요</button></div>`;
}
async function submitAnalysis(form) {
  if (analysisBusy) return;
  const error = $('#analysis-error'), progress = $('#analysis-progress'), data = new FormData(form);
  error.textContent = '';
  let wakeLock = null;
  const video = state.videos.find(v => v.id === form.dataset.id);
  try {
    if (!data.get('consent')) throw new Error('자동 탐색·분석을 위한 정지 화면 전송에 동의해 주세요.');
    if (!data.get('accessCode')?.trim()) throw new Error('분석 이용 코드를 입력해 주세요.');
    analysisBusy = true; analysisController = new AbortController();
    form.setAttribute('aria-busy', 'true'); progress.hidden = false;
    $('p', progress).textContent = '이 기기의 원본을 확인하고 있어요.';
    form.querySelectorAll('input,select,button[type=submit]').forEach(el => el.disabled = true);
    $('[data-action=close-modal]', form).textContent = '분석 중지';
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    const blob = await getOriginalVideo(video.id);
    if (!blob) throw new Error('이 기기에 원본이 없어요. 영상 화면에서 원본을 다시 연결해 주세요.');
    const previous = autoJobFor(video.id), resume = form.dataset.fresh !== 'true' && canResumeAuto(previous);
    const id = resume ? previous.id : makeId(), createdAt = resume ? previous.createdAt : new Date().toISOString();
    const report = await analyzeOriginalVideo({blob,videoId:video.id,accessCode:data.get('accessCode').trim(),consent:true,signal:analysisController.signal,scanSnapshot:resume ? previous : undefined,onProgress:step => { if (progress.isConnected) $('p', progress).textContent = step.message; },onScan:async update => {
      await persist(s => { s.autoAnalyses ||= []; const record = {id,videoId:video.id,createdAt,updatedAt:new Date().toISOString(),...update}; const index = s.autoAnalyses.findIndex(a => a.videoId === video.id); if (index < 0) s.autoAnalyses.push(record); else s.autoAnalyses[index] = record; });
      if ($('#analysis-live-status')) $('#analysis-live-status').innerHTML = autoStatusCard(autoJobFor(video.id));
    },onClip:async clip => {
      await persist(s => { s.analyses ||= []; const index = s.analyses.findIndex(a => a.videoId === video.id && Math.abs(a.start-clip.start)<.01 && Math.abs(a.end-clip.end)<.01); const record = {id:index<0 ? makeId() : s.analyses[index].id,videoId:video.id,createdAt:new Date().toISOString(),...clip}; if (index < 0) s.analyses.push(record); else s.analyses[index] = record; });
    }});
    analysisBusy = false; analysisController = null; demo = false; closeModal(); selectedVideo = video.id; navigate('videos');
    toast(report.status === 'not_found' ? '표본에서 남색 11번을 확인하지 못해 평가를 보류했어요.' : `${report.completedCount}개 구간의 자동 분석 결과를 저장했어요.`);
  } catch (err) {
    if (err.name === 'AbortError') { analysisBusy = false; analysisController = null; closeModal(); selectedVideo = video?.id; navigate('videos'); toast('분석을 중지했어요. 완료된 결과는 보관됩니다.'); }
    else { const saved = autoJobFor(video?.id)?.completedCount || 0; error.textContent = err.message + (saved ? ` 완료한 ${saved}개 구간의 결과는 보관되어 있어요.` : ''); }
  } finally {
    analysisBusy = false; analysisController = null;
    try { await wakeLock?.release(); } catch {}
    if (form.isConnected) { form.removeAttribute('aria-busy'); progress.hidden = true; form.querySelectorAll('input,select,button').forEach(el => el.disabled = false); $('input[name=accessCode]', form).value = ''; $('[data-action=close-modal]', form).textContent = '닫기'; }
    render();
  }
}
async function actionHandler(event) {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  try {
    if (action === 'navigate') return navigate(target.dataset.page);
    if (action === 'menu') { document.body.classList.toggle('menu-open'); syncMobileMenu(); return; }
    if (action === 'demo') { demo = !demo; reportSkill = null; render(); return; }
    if (action === 'add-video') return openAddVideo();
    if (action === 'analyze-video' || action === 'restart-analysis') { if (analysisBusy) return; return await openAnalysis(target.dataset.id, action === 'restart-analysis'); }
    if (action === 'cancel-analysis') { analysisController?.abort(); return; }
    if (action === 'video-source') return setVideoSource(target.dataset.kind);
    if (action === 'download-original') {
      const video = state.videos.find(v => v.id === target.dataset.id);
      const blob = await getOriginalVideo(target.dataset.id);
      if (!blob) throw new Error('이 브라우저에 원본이 없어요. 영상 화면에서 다시 연결해 주세요.');
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = video.fileName; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return toast('원본 파일 내보내기를 시작했어요.');
    }
    if (action === 'delete-video') return openModal('이 원본 영상을 삭제할까요?', '이 기기의 원본 파일과 해당 영상의 장면 기록을 삭제해요. 사진·파일 앱의 원본과 이전 성장 기록은 유지됩니다.', `<div class="modal-actions"><button class="button secondary" data-action="close-modal">유지하기</button><button class="button danger" data-action="confirm-delete-video" data-id="${target.dataset.id}">원본 영상 삭제</button></div>`);
    if (action === 'confirm-delete-video') {
      const id = target.dataset.id;
      await persist(s => { s.videos = s.videos.filter(v => v.id !== id); s.observations = s.observations.filter(o => o.videoId !== id); s.analyses = (s.analyses || []).filter(a => a.videoId !== id); s.autoAnalyses = (s.autoAnalyses || []).filter(a => a.videoId !== id); });
      closeModal(); selectedVideo = state.videos[0]?.id; previewTime = null; render();
      try { await deleteOriginalVideo(id); toast('영상과 연결된 장면 기록을 삭제했어요.'); }
      catch { toast('목록은 삭제했지만 기기의 원본 정리에 실패했어요. 브라우저 저장소를 확인해 주세요.'); }
      return;
    }
    if (action === 'close-modal') return closeModal();
    if (action === 'open-video') { selectedVideo = target.dataset.id; previewTime = null; return navigate('videos'); }
    if (action === 'play' || action === 'seek') {
      if (action === 'seek') {
        selectedVideo = target.dataset.id; previewTime = Number(target.dataset.time);
        if (page !== 'videos') { autoplayNext = true; navigate('videos'); return; }
        render();
      }
      loadPlayer(); return;
    }
    if (action === 'add-observation') return openObservation();
    if (action === 'delete-observation') {
      openModal('이 장면 기록을 삭제할까요?', '연결된 능력치가 다시 계산됩니다. 이전에 저장한 성장 기록은 유지돼요.', `<div class="modal-actions"><button class="button secondary" data-action="close-modal">유지하기</button><button class="button danger" data-action="confirm-delete" data-id="${escape(target.dataset.id)}">장면 삭제</button></div>`); return;
    }
    if (action === 'confirm-delete') { await persist(s => s.observations = s.observations.filter(o => o.id !== target.dataset.id)); closeModal(); render(); return toast('장면 기록을 삭제했어요.'); }
    if (action === 'filter-skill') { reportSkill = reportSkill === target.dataset.id ? null : target.dataset.id; render(); return; }
    if (action === 'clear-filter') { reportSkill = null; render(); return; }
    if (action === 'week') { week = Number(target.dataset.week); render(); return; }
    if (action === 'training-tab') { trainingTab = target.dataset.tab; render(); return; }
    if (action === 'complete') { const id = target.dataset.id; await persist(s => s.completed = s.completed.includes(id) ? s.completed.filter(v => v !== id) : [...s.completed, id]); render(); return toast(state.completed.includes(id) ? '오늘의 작은 한 걸음을 기록했어요!' : '완료 표시를 해제했어요.'); }
    if (action === 'snapshot') {
      if (demo || !state.observations.some(o => o.rating)) return;
      const values = getScores(state.observations).map(s => s.value);
      const last = state.snapshots.at(-1);
      if (last && JSON.stringify(last.scores) === JSON.stringify(values) && last.observationCount === state.observations.length) return toast('같은 관찰 결과가 이미 저장되어 있어요. 새 장면을 더해 주세요.');
      await persist(s => s.snapshots.push({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), observationCount: s.observations.length, scores: values }));
      render(); return toast('성장의 한 페이지를 저장했어요. 성장 기록에서 확인하세요.');
    }
    if (action === 'export') {
      const blob = new Blob([JSON.stringify({ app: 'NEXT XI', exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'next-xi-growth-record.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return toast('기록을 JSON 파일로 내보냈어요. 원본 영상은 별도로 내보내 주세요.');
    }
    if (action === 'reset') return openModal('개인 기록을 초기화할까요?', '선수 정보, 장면, 훈련 실천과 성장 기록이 삭제돼요. 등록한 경기 영상은 유지됩니다.', `<p class="reset-note">필요한 기록은 먼저 내보내기로 보관해 주세요.</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">취소</button><button class="button danger" data-action="confirm-reset">개인 기록 삭제</button></div>`);
    if (action === 'confirm-reset') { await persist(s => { s.player = { name: '', age: 11, number: 11, kit: '남색', position: '미등록', weeklyTraining: 3 }; s.observations = []; s.analyses = []; s.autoAnalyses = []; s.snapshots = []; s.completed = []; }); demo = false; closeModal(); render(); return toast('개인 기록을 초기화했어요.'); }
    if (action === 'help') return openModal('성장의 다음 장, 이렇게 시작해요.', '남색 11번 선수의 경기에서 작은 발견을 찾아보세요.', `<ol class="guide-list"><li><span>01</span><div><strong>경기 영상 열기</strong><p>원본 파일 또는 유튜브 링크를 등록해요. 원본은 등록한 기기의 브라우저에서 보관·재생됩니다.</p></div></li><li><span>02</span><div><strong>남색 11번 자동 분석 시작</strong><p>원본 영상에서 자동 분석을 누르면 앱이 선수를 탐색하고 분석 구간을 고릅니다. 장면 선택이나 시작 시간 입력은 필요 없어요.</p></div></li><li><span>03</span><div><strong>피드백과 근거 함께 살펴보기</strong><p>앱이 분석한 구간별 강점과 연습할 행동을 확인해요. 스파이더맵은 사람이 직접 기록한 단계 평가를 별도로 표시합니다.</p></div></li><li><span>04</span><div><strong>작게 연습하고, 다시 돌아보기</strong><p>일반 훈련 예시를 코치와 조절하고, 다음 경기의 변화를 기록해요.</p></div></li></ol><div class="modal-actions"><button class="button primary" data-action="close-modal">시작해 볼게요 ${icon('arrow')}</button></div>`);
  } catch (e) { toast(e.message); }
}
document.addEventListener('click', e => {
  if (e.target.closest('.skip-link')) { e.preventDefault(); $('#main')?.focus(); return; }
  if (e.target.closest('.sidebar a[href^="#"]')) closeMobileMenu();
  actionHandler(e);
});
document.addEventListener('click', e => { if (e.target.classList.contains('modal-backdrop')) closeModal(); });
document.addEventListener('keydown', e => {
  const sourceTab = e.target.closest('[data-action=video-source]');
  if (sourceTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.preventDefault(); const kind = e.key === 'Home' ? 'file' : e.key === 'End' ? 'youtube' : sourceTab.dataset.kind === 'file' ? 'youtube' : 'file';
    setVideoSource(kind); $(`[data-action=video-source][data-kind=${kind}]`)?.focus(); return;
  }
  const modal = $('.modal'); if (!modal) { if (e.key === 'Escape') { closeMobileMenu(); $('.mobile-menu')?.focus(); } return; }
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Tab') {
    const els = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select, textarea, a[href]')];
    if (!els.length) { e.preventDefault(); return; }
    const first = els[0], last = els.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
document.addEventListener('change', async e => {
  if (e.target.id === 'original-file') return selectOriginal(e.target.files[0]);
  if (e.target.id === 'reconnect-original') {
    const input = e.target, file = input.files[0];
    if (!file) return;
    try {
      validateVideoFile(file);
      const video = state.videos.find(v => v.id === input.dataset.id);
      if (!video || file.size !== video.size || file.name !== video.fileName) throw new Error('처음 등록했던 것과 이름·크기가 같은 원본을 선택해 주세요. 다른 영상은 새로 등록해 주세요.');
      input.disabled = true; await saveOriginalVideo(video.id, file); loadPlayer(false); toast('원본을 다시 연결했어요. 기존 기록을 이어갈 수 있어요.');
    } catch (err) { toast(err.message); input.disabled = false; input.value = ''; }
  }
});
document.addEventListener('submit', async e => {
  if (e.target.id === 'analysis-form') { e.preventDefault(); await submitAnalysis(e.target); return; }
  if (!['video-form', 'observation-form', 'profile-form'].includes(e.target.id)) return;
  e.preventDefault(); const form = e.target, data = new FormData(form), button = $('button[type=submit]', form); let error = $('[role=alert]', form);
  error.textContent = ''; button.disabled = true;
  try {
    if (form.id === 'video-form') {
      if (!data.get('rights')) throw new Error('영상 등록 권한을 확인해 주세요.');
      const title = data.get('title').trim(); if (!title) throw new Error('영상 이름을 입력해 주세요.');
      if (registrationKind === 'file') {
        if (!selectedOriginal) throw new Error('등록할 원본 영상 파일을 선택해 주세요.');
        const file = selectedOriginal, id = 'local-' + makeId();
        validateVideoFile(file);
        savingOriginal = true;
        form.setAttribute('aria-busy', 'true');
        $('#original-save-progress').hidden = false;
        form.querySelectorAll('input,button').forEach(el => el.disabled = true);
        $('.modal-heading .icon-button').disabled = true;
        try {
          const meta = await selectedMetadataPromise || selectedOriginalMeta || {};
          const record = { id, kind: 'file', title, start: 0, source: '원본 파일', addedAt: new Date().toISOString(), fileName: file.name, size: file.size, mime: file.type, duration: meta.duration && meta.duration <= 86400 ? meta.duration : null, lastModified: file.lastModified };
          await saveOriginalVideo(id, file);
          try { await persist(s => s.videos.unshift(record)); }
          catch (err) { try { await deleteOriginalVideo(id); } catch {} throw err; }
        } finally {
          savingOriginal = false; form.removeAttribute('aria-busy');
          if (form.isConnected) { form.querySelectorAll('input,button').forEach(el => el.disabled = false); $('.modal-heading .icon-button').disabled = false; $('#original-save-progress').hidden = true; }
        }
        selectedVideo = id; previewTime = 0; demo = false; closeModal(); navigate('dashboard');
        toast('원본 영상을 이 기기에 등록했어요. 클라우드로 전송되지 않습니다.');
      } else {
        const id = parseYouTube(data.get('url'));
        if (!id) throw new Error('올바른 YouTube 영상 주소를 입력해 주세요.');
        if (state.videos.some(v => v.id === id)) throw new Error('이미 등록된 영상이에요. 경기 목록에서 확인해 주세요.');
        const u = new URL(data.get('url')); const t = u.searchParams.get('t') || u.searchParams.get('start') || '0';
        let start = /^\d+s?$/.test(t) ? parseInt(t, 10) : /^\d+m\d+s$/.test(t) ? parseInt(t, 10) * 60 + parseInt(t.split('m')[1], 10) : 0;
        start = Math.min(86400, start);
        await persist(s => s.videos.push({ id, title, kind: 'youtube', source: '직접 등록', start, addedAt: new Date().toISOString() }));
        selectedVideo = id; previewTime = null; closeModal(); navigate('videos'); toast('경기 영상을 등록했어요. 남색 11번 선수를 확인해 주세요.');
      }
    } else if (form.id === 'observation-form') {
      const time = parseTimestamp(data.get('time')); if (time === null || time > 86400) throw new Error('시간을 00:57 또는 1:02:30 형식으로 입력해 주세요.');
      const note = data.get('note').trim(); if (!note) throw new Error('직접 관찰한 행동을 입력해 주세요.');
      const observation = { id: crypto.randomUUID(), videoId: data.get('videoId'), time, skill: data.get('skill'), type: data.get('type'), rating: data.get('rating') ? Number(data.get('rating')) : null, note, createdAt: new Date().toISOString() };
      await persist(s => s.observations.push(observation)); demo = false; closeModal(); render(); toast('근거 장면을 저장했어요. 성장 리포트에도 반영됐어요.');
    } else {
      await persist(s => s.player = { ...s.player, name: data.get('name').trim(), age: Number(data.get('age')), position: data.get('position'), weeklyTraining: Number(data.get('weeklyTraining')) });
      render(); toast('선수 정보를 저장했어요.');
    }
  } catch (err) { error.textContent = err.message; } finally { if (button.isConnected) button.disabled = false; }
});
window.addEventListener('beforeunload', event => { if (analysisBusy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('hashchange', () => { page = location.hash.slice(1) || 'dashboard'; closeMobileMenu(); render(); window.scrollTo({ top: 0, behavior: 'instant' }); $('#main').focus({ preventScroll: true }); });
matchMedia('(max-width: 720px)').addEventListener('change', () => { closeMobileMenu(); });
async function init() {
  try { const response = await fetch('/api/workspace'); if (!response.ok) throw new Error(); state = await response.json(); selectedVideo = state.videos[0]?.id; if ((state.autoAnalyses || []).some(job => ['scanning','analyzing'].includes(job.status))) await persist(s => s.autoAnalyses.forEach(job => { if (['scanning','analyzing'].includes(job.status)) { job.status = 'interrupted'; job.updatedAt = new Date().toISOString(); job.message = '화면이 닫혀 분석이 중단됐어요. 완료된 결과는 남아 있으며 이어서 분석할 수 있어요.'; } })); render(); }
  catch { $('#app').innerHTML = `<div class="loading-screen"><span class="brand-symbol">↗</span><h1>성장 공간에 연결하지 못했어요.</h1><p>서버 연결을 확인한 뒤 다시 시도해 주세요.</p><button class="button primary" id="retry">다시 연결</button></div>`; $('#retry').addEventListener('click', init); }
}
init();
