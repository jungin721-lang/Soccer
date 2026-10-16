import { SKILLS } from './domain.js';

export const KIT_LABELS = Object.freeze({
  navy: '남색', blue: '파랑', sky: '하늘색', teal: '청록', turquoise: '밝은 청록',
  green: '초록', lime: '연두', yellow: '노랑', gold: '금색', orange: '주황',
  red: '빨강', burgundy: '자주', pink: '분홍', purple: '보라', lavender: '연보라',
  white: '흰색', black: '검정', gray: '회색', brown: '갈색', beige: '베이지',
});
export const KIT_OPTIONS = Object.freeze(Object.entries(KIT_LABELS).map(([id, label]) => Object.freeze({ id, label })));
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const RECORD_ID = /^[\w-]{1,80}$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const SKILL_IDS = new Set(SKILLS.map(skill => skill.id));
const fail = message => { throw new Error(message); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const recordId = value => typeof value === 'string' && RECORD_ID.test(value);

export function kstToday(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) fail('날짜를 확인해 주세요.');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function addDays(date, count) {
  if (!isDate(date) || !Number.isSafeInteger(count) || Math.abs(count) > 100000) fail('날짜를 확인해 주세요.');
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + count);
  return result.toISOString().slice(0, 10);
}
export function getWeekday(date) {
  if (!isDate(date)) fail('날짜를 확인해 주세요.');
  return new Date(`${date}T12:00:00.000Z`).getUTCDay();
}
export function weekdayLabel(date) { return ['일', '월', '화', '수', '목', '금', '토'][getWeekday(date)]; }

export function validateTarget(value) {
  if (!object(value)) fail('분석할 선수의 유니폼 색상, 등번호와 나이를 확인해 주세요.');
  if (typeof value.kit !== 'string') fail('분석할 선수의 유니폼 색상을 확인해 주세요.');
  const kit = Object.hasOwn(KIT_LABELS, value.kit) ? value.kit : KIT_OPTIONS.find(option => option.label === value.kit)?.id;
  if (!kit || !integer(value.number, 1, 99) || !integer(value.age, 5, 18)) fail('분석할 선수의 유니폼 색상, 등번호와 나이를 확인해 주세요.');
  return { kit, number: value.number, age: value.age };
}

export function createGrowthWorkspace() {
  return {
    revision: 0,
    profile: {
      name: '', age: 11, kit: '남색', number: 11, position: '미등록', foot: '오른발',
      teamDays: [], matchDays: [], teamMinutes: 60, schoolStart: '08:30', schoolEnd: '15:00',
      wakeTime: '07:00', bedTime: '21:00', space: '작은 실내', equipment: ['축구공'],
      allergies: [], dietaryRestrictions: [], likedFoods: [], schoolLunch: true, helperMinutes: 15,
      planStart: kstToday(), notificationTime: '18:00', notificationsEnabled: false,
      roleView: 'parent', sensitiveConsent: false,
    },
    videos: [], analyses: [], jobs: [], observations: [], practices: [], checkins: [], scheduleChanges: [],
    consents: { guardian: false, analysis: false, training: false },
  };
}

function stringList(value, maxCount = 30, maxLength = 80) {
  if (!Array.isArray(value) || value.length > maxCount || value.some(item => !text(item, maxLength, 1))) fail('선수 설정의 목록을 확인해 주세요.');
  return [...new Set(value)];
}
function weekDays(value) {
  if (!Array.isArray(value) || value.length > 7 || value.some(day => !integer(day, 0, 6))) fail('훈련·경기 요일을 확인해 주세요.');
  return [...new Set(value)].sort((a, b) => a - b);
}
function cleanProfile(value, defaults) {
  if (!object(value)) fail('선수 설정을 확인해 주세요.');
  const profile = { ...defaults, ...value };
  validateTarget(profile);
  if (!text(profile.name, 40) || !text(profile.position, 40, 1) || !['오른발', '왼발', '양발'].includes(profile.foot)
    || !integer(profile.teamMinutes, 0, 240) || !integer(profile.helperMinutes, 0, 120)
    || !text(profile.space, 80, 1) || !isDate(profile.planStart)
    || !['schoolStart', 'schoolEnd', 'wakeTime', 'bedTime', 'notificationTime'].every(key => typeof profile[key] === 'string' && CLOCK.test(profile[key]))
    || !['schoolLunch', 'notificationsEnabled', 'sensitiveConsent'].every(key => typeof profile[key] === 'boolean')
    || !['parent', 'player', 'coach', 'scout'].includes(profile.roleView)) fail('선수 설정과 생활 시간을 확인해 주세요.');
  return {
    name: profile.name, age: profile.age, kit: profile.kit, number: profile.number, position: profile.position, foot: profile.foot,
    teamDays: weekDays(profile.teamDays), matchDays: weekDays(profile.matchDays), teamMinutes: profile.teamMinutes,
    schoolStart: profile.schoolStart, schoolEnd: profile.schoolEnd, wakeTime: profile.wakeTime, bedTime: profile.bedTime,
    space: profile.space, equipment: stringList(profile.equipment), allergies: stringList(profile.allergies),
    dietaryRestrictions: stringList(profile.dietaryRestrictions), likedFoods: stringList(profile.likedFoods),
    schoolLunch: profile.schoolLunch, helperMinutes: profile.helperMinutes, planStart: profile.planStart,
    notificationTime: profile.notificationTime, notificationsEnabled: profile.notificationsEnabled,
    roleView: profile.roleView, sensitiveConsent: profile.sensitiveConsent,
  };
}
export function validateMatchContext(value = {}, fallback = {}) {
  if (!object(value)) fail('경기 정보를 확인해 주세요.');
  const context = { position: '미등록', opponentLevel: 'unknown', minutesPlayed: null, filming: 'unknown', matchDate: kstToday(), ...fallback, ...value };
  if (!text(context.position, 40, 1) || !['unknown', 'similar', 'stronger', 'weaker'].includes(context.opponentLevel)
    || !(context.minutesPlayed === null || (finite(context.minutesPlayed) && context.minutesPlayed >= 0 && context.minutesPlayed <= 240))
    || !['unknown', 'clear', 'limited'].includes(context.filming) || !isDate(context.matchDate)) fail('경기 정보를 확인해 주세요.');
  return { position: context.position, opponentLevel: context.opponentLevel, minutesPlayed: context.minutesPlayed, filming: context.filming, matchDate: context.matchDate };
}
function cleanVideo(value) {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || value.kind !== 'server'
    || !text(value.title, 100, 1) || !text(value.fileName, 255, 1) || !integer(value.size, 1, 2 * 1024 ** 3)
    || !text(value.mime, 100) || !timestamp(value.addedAt)
    || !(value.duration === null || (finite(value.duration) && value.duration > 0 && value.duration <= 86400))) fail('원본 영상 정보를 확인해 주세요.');
  return {
    id: value.id, title: value.title, fileName: value.fileName, size: value.size, mime: value.mime, kind: 'server',
    addedAt: value.addedAt, duration: value.duration, target: validateTarget(value.target),
    context: validateMatchContext(value.context, { matchDate: kstToday(value.addedAt) }),
  };
}
function cleanQualitativeResult(result, start, end) {
  if (!object(result) || typeof result.identified !== 'boolean' || !text(result.summary, 2000)
    || !Array.isArray(result.observations) || result.observations.length > 24 || (!result.identified && result.observations.length)
    || !Array.isArray(result.limitations) || result.limitations.length > 10 || result.limitations.some(item => !text(item, 500))
    || !text(result.nextAction, 1500)) fail('AI 분석 결과를 확인해 주세요.');
  const observations = result.observations.map(observation => {
    if (!object(observation) || !SKILL_IDS.has(observation.skill) || !integer(observation.time, Math.floor(start), Math.ceil(end))
      || !text(observation.note, 1500, 1) || !['strength', 'focus', 'note'].includes(observation.type)
      || !['low', 'medium', 'high'].includes(observation.confidence) || Object.hasOwn(observation, 'rating')) fail('AI 관찰 기록을 확인해 주세요.');
    return { skill: observation.skill, time: observation.time, note: observation.note, type: observation.type, confidence: observation.confidence };
  });
  return { identified: result.identified, summary: result.summary, observations, limitations: [...result.limitations], nextAction: result.nextAction };
}
function cleanAnalysis(value, videos) {
  if (!object(value) || !recordId(value.id) || !recordId(value.jobId) || !videos.some(video => video.id === value.videoId)
    || !timestamp(value.createdAt) || !finite(value.start) || value.start < 0 || !finite(value.end) || value.end <= value.start
    || value.end > 86400 || value.end > value.start + 12 || !text(value.model, 100, 1)) fail('AI 분석 기록을 확인해 주세요.');
  return { id: value.id, jobId: value.jobId, videoId: value.videoId, createdAt: value.createdAt, start: value.start, end: value.end, model: value.model, result: cleanQualitativeResult(value.result, value.start, value.end) };
}
function cleanObservation(value, videos) {
  if (!object(value) || !recordId(value.id) || !videos.some(video => video.id === value.videoId) || !SKILL_IDS.has(value.skill)
    || !integer(value.time, 0, 86400) || !(value.rating === null || integer(value.rating, 1, 5)) || !text(value.note, 1500, 1)
    || !['strength', 'focus', 'note'].includes(value.type) || !timestamp(value.createdAt)) fail('장면 기록을 확인해 주세요.');
  return { id: value.id, videoId: value.videoId, skill: value.skill, time: value.time, rating: value.rating, note: value.note, type: value.type, createdAt: value.createdAt };
}
function cleanJob(value, videos) {
  if (!object(value) || !recordId(value.id) || !videos.some(video => video.id === value.videoId)
    || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(value.status)
    || !text(value.stage, 100) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || !integer(value.attempt ?? 0, 0, 100)) fail('분석 작업 정보를 확인해 주세요.');
  const progress = {};
  if (value.progress !== undefined && !object(value.progress)) fail('분석 진행 정보를 확인해 주세요.');
  for (const key of ['sampleCount', 'sampledCount', 'detectedCount', 'selectedCount', 'completedCount']) {
    if (value.progress?.[key] !== undefined) {
      if (!integer(value.progress[key], 0, 10000)) fail('분석 진행 정보를 확인해 주세요.');
      progress[key] = value.progress[key];
    }
  }
  if (value.progress?.message !== undefined) {
    if (!text(value.progress.message, 1500)) fail('분석 진행 정보를 확인해 주세요.');
    progress.message = value.progress.message;
  }
  let error = null;
  if (value.error != null) {
    if (!object(value.error) || !text(value.error.code, 80, 1) || !text(value.error.message, 1500)) fail('분석 작업 오류 정보를 확인해 주세요.');
    error = { code: value.error.code, message: value.error.message };
  }
  return { id: value.id, videoId: value.videoId, status: value.status, stage: value.stage, createdAt: value.createdAt, updatedAt: value.updatedAt, progress, error, target: validateTarget(value.target), context: validateMatchContext(value.context), attempt: value.attempt ?? 0 };
}
function collection(value, field, max, clean) {
  const list = value[field] === undefined ? [] : value[field];
  if (!Array.isArray(list) || list.length > max) fail(`${field} 기록 수를 확인해 주세요.`);
  return list.map(clean);
}
function unique(list, key, label) {
  if (new Set(list.map(key)).size !== list.length) fail(`중복된 ${label} 기록입니다.`);
}
export function validateGrowthWorkspace(value) {
  if (!object(value)) fail('저장할 성장 기록이 올바르지 않습니다.');
  const defaults = createGrowthWorkspace();
  if (!integer(value.revision ?? 0, 0, Number.MAX_SAFE_INTEGER)) fail('저장 버전을 확인해 주세요.');
  const profile = cleanProfile(value.profile === undefined ? {} : value.profile, defaults.profile);
  const videos = collection(value, 'videos', 100, cleanVideo);
  unique(videos, video => video.id, '영상');
  const analyses = collection(value, 'analyses', 600, item => cleanAnalysis(item, videos));
  const jobs = collection(value, 'jobs', 100, item => cleanJob(item, videos));
  const observations = collection(value, 'observations', 10000, item => cleanObservation(item, videos));
  const practices = collection(value, 'practices', 3650, item => {
    if (!object(item) || !recordId(item.id) || !isDate(item.date) || !text(item.taskId, 120, 1) || typeof item.completed !== 'boolean' || !text(item.note ?? '', 500)) fail('훈련 실천 기록을 확인해 주세요.');
    return { id: item.id, date: item.date, taskId: item.taskId, completed: item.completed, note: item.note ?? '' };
  });
  const checkins = collection(value, 'checkins', 730, item => {
    if (!object(item) || !isDate(item.date) || ![null, 'good', 'okay', 'poor'].includes(item.sleepQuality ?? null)
      || ![null, 'fresh', 'normal', 'tired'].includes(item.fatigue ?? null) || ![null, 'good', 'okay', 'low'].includes(item.mood ?? null)
      || typeof (item.pain ?? false) !== 'boolean' || !text(item.notes ?? '', 500)) fail('오늘의 상태 기록을 확인해 주세요.');
    return { date: item.date, sleepQuality: item.sleepQuality ?? null, fatigue: item.fatigue ?? null, mood: item.mood ?? null, pain: item.pain ?? false, notes: item.notes ?? '' };
  });
  const scheduleChanges = collection(value, 'scheduleChanges', 3650, item => {
    if (!object(item) || !text(item.taskId, 120, 1) || !isDate(item.originalDate) || !isDate(item.date)) fail('변경한 훈련 날짜를 확인해 주세요.');
    return { taskId: item.taskId, originalDate: item.originalDate, date: item.date };
  });
  for (const [items, label] of [[analyses, '분석'], [jobs, '작업'], [observations, '장면'], [practices, '실천']]) unique(items, item => item.id, label);
  unique(checkins, item => item.date, '상태');
  unique(scheduleChanges, item => `${item.taskId}:${item.originalDate}`, '일정 변경');
  const consents = { ...defaults.consents, ...(value.consents === undefined ? {} : value.consents) };
  if ((value.consents !== undefined && !object(value.consents)) || !['guardian', 'analysis', 'training'].every(key => typeof consents[key] === 'boolean')) fail('보호자·영상 분석·AI 모델 학습 동의 설정을 확인해 주세요.');
  return { revision: value.revision ?? 0, profile, videos, analyses, jobs, observations, practices, checkins, scheduleChanges, consents: { guardian: consents.guardian, analysis: consents.analysis, training: consents.training } };
}

const sameTarget = (first, second) => {
  try {
    const a = validateTarget(first), b = validateTarget(second);
    return a.kit === b.kit && a.number === b.number && a.age === b.age;
  } catch { return false; }
};
function contextIssues(previous, current) {
  const before = previous.context || {}, after = current.context || {}, reasons = [];
  if (!before.position || before.position === '미등록' || !after.position || after.position === '미등록') reasons.push('두 경기의 포지션을 확인해야 합니다.');
  else if (before.position !== after.position) reasons.push('포지션이 달라 같은 조건으로 비교하기 어렵습니다.');
  if (!finite(before.minutesPlayed) || !finite(after.minutesPlayed) || Math.min(before.minutesPlayed, after.minutesPlayed) < 10) reasons.push('두 경기 모두 10분 이상의 출전 시간 정보가 필요합니다.');
  else if (Math.min(before.minutesPlayed, after.minutesPlayed) / Math.max(before.minutesPlayed, after.minutesPlayed) < 2 / 3) reasons.push('출전 시간 차이가 커 직접 비교하기 어렵습니다.');
  if (before.filming !== 'clear' || after.filming !== 'clear') reasons.push('두 경기 모두 선수를 분명하게 확인할 수 있는 촬영 조건이 필요합니다.');
  if (!before.opponentLevel || !after.opponentLevel || before.opponentLevel === 'unknown' || after.opponentLevel === 'unknown') reasons.push('두 경기의 상대 수준 정보가 필요합니다.');
  else if (before.opponentLevel !== after.opponentLevel) reasons.push('상대 수준이 달라 직접 비교하기 어렵습니다.');
  return reasons;
}
function evidenceFor(workspace, videoId, skill) {
  const observations = videoId ? (workspace.observations || []).filter(item => item.videoId === videoId && item.skill === skill && integer(item.rating, 1, 5)) : [];
  return {
    count: observations.length,
    value: observations.length ? observations.reduce((sum, item) => sum + item.rating, 0) / observations.length : null,
    evidence: observations.map(item => ({ id: item.id, videoId: item.videoId, time: item.time, note: item.note, type: item.type })),
  };
}
function qualitativeFor(workspace, videoId) {
  const counts = { strengths: 0, focuses: 0, notes: 0, total: 0, evidence: [] };
  if (!videoId) return counts;
  for (const analysis of workspace.analyses || []) {
    if (analysis.videoId !== videoId || !analysis.result?.identified) continue;
    for (const observation of analysis.result.observations || []) {
      const key = { strength: 'strengths', focus: 'focuses', note: 'notes' }[observation.type];
      if (key) {
        counts[key]++; counts.total++;
        counts.evidence.push({ analysisId: analysis.id, videoId, skill: observation.skill, time: observation.time, note: observation.note, type: observation.type, confidence: observation.confidence });
      }
    }
  }
  return counts;
}
export function compareMatches(workspace) {
  const videos = [...(workspace.videos || [])].filter(video => timestamp(video.addedAt)).sort((a, b) => {
    const first = isDate(a.context?.matchDate) ? a.context.matchDate : kstToday(a.addedAt);
    const second = isDate(b.context?.matchDate) ? b.context.matchDate : kstToday(b.addedAt);
    return second.localeCompare(first) || Date.parse(b.addedAt) - Date.parse(a.addedAt);
  });
  const current = videos[0] || null;
  const previous = current ? videos.slice(1).find(video => sameTarget(current.target, video.target)) || null : null;
  const contextReasons = current && previous ? contextIssues(previous, current) : [];
  const comparable = !!current && !!previous && contextReasons.length === 0;
  const skills = SKILLS.map(skill => {
    const before = evidenceFor(workspace, previous?.id, skill.id), after = evidenceFor(workspace, current?.id, skill.id);
    const status = !previous || before.count < 3 || after.count < 3 ? 'insufficient' : comparable ? 'ready' : 'incomparable';
    return { skill: skill.id, name: skill.name, status, previous: before, current: after, delta: status === 'ready' ? after.value - before.value : null };
  });
  const status = !previous ? 'insufficient' : !comparable ? 'incomparable' : skills.some(skill => skill.status === 'ready') ? 'ready' : 'insufficient';
  const reason = !current ? '경기 영상을 등록하면 이전 경기와의 변화를 확인할 수 있습니다.'
    : !previous ? '같은 유니폼 색상·등번호·연령의 경기 두 개가 필요합니다.'
      : !comparable ? contextReasons.join(' ')
        : status === 'insufficient' ? '항목별로 각 경기에서 사람이 평가한 근거 장면이 3개 이상 필요합니다.'
          : '비슷한 경기 조건에서 사람이 평가한 장면의 변화를 비교합니다. AI 관찰 수의 차이는 성장 점수가 아닙니다.';
  return { status, reason, previous, current, comparable, contextReasons, skills, qualitative: { previous: qualitativeFor(workspace, previous?.id), current: qualitativeFor(workspace, current?.id) } };
}
