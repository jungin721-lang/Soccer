export const SKILLS = [
  { id: 'touch', name: '볼 컨트롤', short: '볼 컨트롤', description: '첫 터치 방향, 압박 속 볼 보호와 다음 동작', cue: '첫 터치가 다음 플레이로 자연스럽게 이어지나요?' },
  { id: 'pass', name: '패스', short: '패스', description: '패스 대상 선택, 정확도, 강도와 타이밍', cue: '동료가 받기 좋은 방향과 강도로 연결하나요?' },
  { id: 'dribble', name: '드리블', short: '드리블', description: '공간 활용, 방향 전환과 돌파 판단', cue: '돌파와 패스 중 상황에 맞는 선택을 하나요?' },
  { id: 'shoot', name: '슈팅', short: '슈팅', description: '슈팅 기회 판단, 준비 동작과 마무리', cue: '좋은 기회에 균형을 유지하며 슈팅하나요?' },
  { id: 'defend', name: '수비', short: '수비', description: '접근 각도, 거리 조절, 위치 선정과 추적', cue: '상대의 전진 경로를 막으며 거리를 조절하나요?' },
  { id: 'scan', name: '주변 확인·판단', short: '경기 이해', description: '공을 받기 전 주변 확인과 선택지 파악', cue: '공을 받기 전에 고개를 돌려 주변을 보나요?' },
  { id: 'move', name: '공 없는 움직임', short: '움직임', description: '패스 지원, 공간 만들기와 공수 전환', cue: '패스 후 다시 도울 수 있는 위치로 움직이나요?' },
  { id: 'team', name: '협력·다음 행동', short: '협력', description: '동료 지원, 의사소통과 실수 후 플레이 참여', cue: '실수 후에도 다음 플레이에 다시 참여하나요?' }
];
export const SCALE = ['도움이 필요해요', '기본 상황에서 시도해요', '기본 상황에서 수행해요', '다양한 상황에서 수행해요', '어려운 상황에서도 반복해요'];
export function parseYouTube(input) {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let id;
    if (host === 'youtu.be') id = u.pathname.split('/')[1];
    else if (['youtube.com', 'm.youtube.com'].includes(host)) {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else if (/^\/(shorts|embed)\//.test(u.pathname)) id = u.pathname.split('/')[2];
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}
export function parseTimestamp(input) {
  const parts = String(input).trim().split(':');
  if (!/^\d{1,3}(:[0-5]\d){1,2}$/.test(String(input).trim())) return null;
  return parts.reduce((total, n) => total * 60 + Number(n), 0);
}
export function formatTime(seconds = 0) {
  const s = Math.max(0, Math.floor(seconds));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export function getScores(observations) {
  return SKILLS.map(skill => {
    const entries = observations.filter(o => o.skill === skill.id && o.rating >= 1 && o.rating <= 5);
    return { ...skill, count: entries.length, value: entries.length ? entries.reduce((s, o) => s + o.rating, 0) / entries.length : null };
  });
}
export function seedState() {
  return { revision: 0, player: { name: '', age: 11, number: 11, kit: '남색', position: '미등록', weeklyTraining: 3 },
    videos: [
      { id: 'arJ6xMRKnbw', title: '남색 11번 · 경기 영상', start: 57, source: '제공한 샘플 영상', addedAt: '2026-10-16T00:00:00.000Z' }
    ], observations: [], completed: [], snapshots: [], analyses: [] };
}
function validVideo(video) {
  if (!video || typeof video.title !== 'string' || video.title.length < 1 || video.title.length > 100 || typeof video.addedAt !== 'string' || !Number.isFinite(Date.parse(video.addedAt))) return false;
  if (video.kind === 'file') {
    return typeof video.id === 'string' && /^local-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(video.id)
      && typeof video.fileName === 'string' && video.fileName.trim().length > 0 && video.fileName.length <= 255
      && Number.isInteger(video.size) && video.size >= 1 && video.size <= 2 * 1024 ** 3
      && typeof video.mime === 'string' && video.mime.length <= 100
      && (video.duration === null || (typeof video.duration === 'number' && Number.isFinite(video.duration) && video.duration > 0 && video.duration <= 86400))
      && Number.isInteger(video.lastModified) && video.lastModified >= 0;
  }
  return (video.kind === undefined || video.kind === 'youtube') && typeof video.id === 'string' && /^[\w-]{11}$/.test(video.id);
}
function cleanVideo(video) {
  const clean = {
    id: video.id, title: video.title,
    start: Number.isSafeInteger(video.start) && video.start >= 0 && video.start <= 86400 ? video.start : 0,
    source: typeof video.source === 'string' ? video.source.slice(0, 100) : video.kind === 'file' ? '원본 파일' : '직접 등록',
    addedAt: video.addedAt,
  };
  if (video.kind === 'file') return { ...clean, kind: 'file', fileName: video.fileName, size: video.size, mime: video.mime, duration: video.duration, lastModified: video.lastModified };
  if (video.kind === 'youtube') clean.kind = 'youtube';
  return clean;
}
function validAnalysis(analysis, videos) {
  if (!analysis || typeof analysis.id !== 'string' || !/^[\w-]{1,80}$/.test(analysis.id)
    || !videos.some(video => video.kind === 'file' && video.id === analysis.videoId)
    || typeof analysis.createdAt !== 'string' || !Number.isFinite(Date.parse(analysis.createdAt))
    || typeof analysis.model !== 'string' || !analysis.model.trim() || analysis.model.length > 100
    || typeof analysis.start !== 'number' || !Number.isFinite(analysis.start) || analysis.start < 0
    || typeof analysis.end !== 'number' || !Number.isFinite(analysis.end) || analysis.end <= analysis.start || analysis.end > analysis.start + 12 || analysis.end > 86400) return false;
  const result = analysis.result;
  if (!result || typeof result.identified !== 'boolean' || typeof result.summary !== 'string' || result.summary.length > 2000
    || !Array.isArray(result.observations) || result.observations.length > 24 || (!result.identified && result.observations.length > 0)
    || !Array.isArray(result.limitations) || result.limitations.length > 10 || result.limitations.some(item => typeof item !== 'string' || item.length > 500)
    || typeof result.nextAction !== 'string' || result.nextAction.length > 1500) return false;
  return result.observations.every(observation => observation && SKILLS.some(skill => skill.id === observation.skill)
    && Number.isInteger(observation.time) && observation.time >= Math.floor(analysis.start) && observation.time <= Math.ceil(analysis.end)
    && typeof observation.note === 'string' && observation.note.trim().length > 0 && observation.note.length <= 1500
    && ['strength', 'focus', 'note'].includes(observation.type) && ['low', 'medium', 'high'].includes(observation.confidence)
    && !Object.hasOwn(observation, 'rating'));
}
function cleanAnalysis(analysis) {
  const result = analysis.result;
  return {
    id: analysis.id, videoId: analysis.videoId, createdAt: analysis.createdAt, model: analysis.model, start: analysis.start, end: analysis.end,
    result: {
      identified: result.identified, summary: result.summary,
      observations: result.observations.map(observation => ({ skill: observation.skill, time: observation.time, note: observation.note, type: observation.type, confidence: observation.confidence })),
      limitations: [...result.limitations], nextAction: result.nextAction,
    },
  };
}
export function validateState(value) {
  if (!value || typeof value !== 'object') throw new Error('저장할 데이터가 올바르지 않습니다.');
  const { player, videos, observations, completed, snapshots } = value;
  const analyses = value.analyses === undefined ? [] : value.analyses;
  if (!player || typeof player.name !== 'string' || player.name.length > 30 || player.number !== 11 || player.kit !== '남색' || !Number.isInteger(player.age) || player.age < 5 || player.age > 18 || typeof player.position !== 'string' || player.position.length > 30 || !Number.isInteger(player.weeklyTraining) || player.weeklyTraining < 0 || player.weeklyTraining > 14) throw new Error('선수 정보를 확인해 주세요. 분석 대상은 남색 11번입니다.');
  if (!Array.isArray(videos) || videos.length > 100 || videos.some(v => !validVideo(v))) throw new Error('영상 정보를 확인해 주세요.');
  if (new Set(videos.map(v => v.id)).size !== videos.length) throw new Error('이미 등록된 영상입니다.');
  if (!Array.isArray(observations) || observations.length > 3000 || observations.some(o => !o || typeof o.id !== 'string' || o.id.length > 80 || !videos.some(v => v.id === o.videoId) || !SKILLS.some(s => s.id === o.skill) || !Number.isInteger(o.time) || o.time < 0 || o.time > 86400 || (o.rating !== null && (!Number.isInteger(o.rating) || o.rating < 1 || o.rating > 5)) || typeof o.note !== 'string' || !o.note.trim() || o.note.length > 1500 || !['strength', 'focus', 'note'].includes(o.type) || !Number.isFinite(Date.parse(o.createdAt)))) throw new Error('장면 기록을 확인해 주세요.');
  if (new Set(observations.map(o => o.id)).size !== observations.length) throw new Error('중복된 장면 기록입니다.');
  if (!Array.isArray(completed) || completed.length > 100 || completed.some(i => typeof i !== 'string' || !/^(week[1-4]-[0-2](?:-(?:touch|pass|dribble|shoot|defend|scan|move|team))?|habit-[0-3])$/.test(i))) throw new Error('훈련 기록을 확인해 주세요.');
  if (!Array.isArray(snapshots) || snapshots.length > 100 || snapshots.some(s => !s || typeof s.id !== 'string' || !Number.isFinite(Date.parse(s.createdAt)) || !Number.isInteger(s.observationCount) || s.observationCount < 1 || !Array.isArray(s.scores) || s.scores.length !== 8 || s.scores.some(n => n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 1 || n > 5)))) throw new Error('성장 기록을 확인해 주세요.');
  if (!Array.isArray(analyses) || analyses.length > 100 || analyses.some(analysis => !validAnalysis(analysis, videos))) throw new Error('AI 분석 기록을 확인해 주세요.');
  if (new Set(analyses.map(analysis => analysis.id)).size !== analyses.length) throw new Error('중복된 AI 분석 기록입니다.');
  return { player: { ...player }, videos: videos.map(cleanVideo), observations: observations.map(o => ({ id: o.id, videoId: o.videoId, skill: o.skill, time: o.time, rating: o.rating, note: o.note, type: o.type, createdAt: o.createdAt })), completed: [...new Set(completed)], snapshots: snapshots.map(s => ({ id: s.id, createdAt: s.createdAt, observationCount: s.observationCount, scores: s.scores })), analyses: analyses.map(cleanAnalysis) };
}
