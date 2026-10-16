import { SKILLS } from './domain.js';
import { compareMatches, isDate, kstToday, validateTarget } from './growth-domain.js';

const ids = new Set(SKILLS.map(skill => skill.id));
const label = skill => SKILLS.find(item => item.id === skill)?.name || skill;
const validTarget = value => { try { return validateTarget(value); } catch { return null; } };
const sameTarget = (a, b) => {
  const first = validTarget(a), second = validTarget(b);
  return Boolean(first && second && first.kit === second.kit && first.number === second.number && first.age === second.age);
};
const observationCaveat = '같은 항목의 관찰을 연결한 것이며 동일한 세부 기술·확정된 향상·훈련의 효과를 뜻하지 않습니다. 관찰 수는 능력 점수가 아니고, 장면이 없다고 실패한 것도 아닙니다.';
const identityCaveat = '같은 유니폼 색상·등번호·연령으로 지정한 자료이며 실제 인물의 동일성을 인증한 것은 아닙니다.';
const dateOf = video => {
  if (isDate(video?.context?.matchDate)) return video.context.matchDate;
  try { return kstToday(video.addedAt); } catch { return null; }
};

function cleanEvidence(entries, workspace, video) {
  if (!video) return [];
  const seen = new Set();
  return (entries || []).filter(entry => {
    if (entry.videoId !== video.id || !ids.has(entry.skill) || !['strength', 'focus', 'note'].includes(entry.type)
      || !['medium', 'high'].includes(entry.confidence) || typeof entry.note !== 'string' || !entry.note.trim()
      || !Number.isFinite(entry.time) || entry.time < 0) return false;
    const analysis = (workspace.analyses || []).find(item => item.id === entry.analysisId && item.videoId === video.id);
    if (!analysis?.result?.identified || !Number.isFinite(analysis.start) || !Number.isFinite(analysis.end)
      || entry.time < analysis.start || entry.time > analysis.end) return false;
    const key = JSON.stringify([entry.videoId, entry.skill, entry.time, entry.type, entry.note]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(entry => ({ analysisId: entry.analysisId, videoId: entry.videoId, skill: entry.skill, time: entry.time, note: entry.note, type: entry.type, confidence: entry.confidence }));
}

function evidenceForVideo(workspace, video) {
  const entries = (workspace.analyses || []).filter(analysis => analysis.videoId === video.id && analysis.result?.identified)
    .flatMap(analysis => (analysis.result.observations || []).map(entry => ({ ...entry, analysisId: analysis.id, videoId: video.id })));
  return cleanEvidence(entries, workspace, video);
}

function practiceSkill(taskId) {
  const match = /^practice-(\d{4}-\d{2}-\d{2})-(touch|pass|dribble|shoot|defend|scan|move|team)$/.exec(taskId || '');
  return match && isDate(match[1]) ? match[2] : null;
}

/** Evidence links only. Never converts AI observations or practice counts to grades. */
export function buildGrowthInsights(workspace = {}) {
  const safe = { ...workspace, videos: Array.isArray(workspace.videos) ? workspace.videos : [], analyses: Array.isArray(workspace.analyses) ? workspace.analyses : [], observations: Array.isArray(workspace.observations) ? workspace.observations : [] };
  const comparison = compareMatches(safe);
  const current = comparison.current;
  if (!current || !validTarget(current.target)) return { signals: [], practiceTransfer: [], history: [], nextGoal: null };
  const previous = comparison.previous && sameTarget(current.target, comparison.previous.target) ? comparison.previous : null;
  const before = cleanEvidence(comparison.qualitative.previous.evidence, safe, previous);
  const after = cleanEvidence(comparison.qualitative.current.evidence, safe, current);
  const context = comparison.contextReasons.length ? ` 경기 조건의 차이도 있어요: ${comparison.contextReasons.join(' ')}` : '';
  const caveat = `${observationCaveat} ${identityCaveat}${context}`;
  const signals = [];
  for (const { id: skill } of SKILLS) {
    const previousEvidence = before.filter(entry => entry.skill === skill && entry.type === 'focus');
    if (!previousEvidence.length) continue;
    const strengths = after.filter(entry => entry.skill === skill && entry.type === 'strength');
    const focuses = after.filter(entry => entry.skill === skill && entry.type === 'focus');
    if (strengths.length) signals.push({ skill, title: '이전 과제와 관련된 강점 장면', previousEvidence, currentEvidence: strengths, status: 'related_observation', caveat });
    if (focuses.length) signals.push({ skill, title: '다음 경기에서도 살펴볼 과제', previousEvidence, currentEvidence: focuses, status: 'repeat_focus', caveat });
  }
  const practiceTransfer = [];
  const previousDate = previous && isDate(previous.context?.matchDate) ? previous.context.matchDate : null;
  const currentDate = isDate(current.context?.matchDate) ? current.context.matchDate : null;
  // Practices have no target identity snapshot. Do not connect them when the
  // current profile is set to a different kit/number/age, or dates are unknown.
  if (previousDate && currentDate && previousDate < currentDate && sameTarget(workspace.profile, current.target)) {
    const grouped = new Map(), seen = new Set();
    for (const practice of Array.isArray(workspace.practices) ? workspace.practices : []) {
      const skill = practiceSkill(practice.taskId);
      if (!skill || practice.completed !== true || !isDate(practice.date) || practice.date <= previousDate || practice.date > currentDate) continue;
      const key = `${practice.taskId}:${practice.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      grouped.set(skill, (grouped.get(skill) || 0) + 1);
    }
    for (const { id: skill } of SKILLS) {
      const practiceCount = grouped.get(skill) || 0;
      if (!practiceCount) continue;
      const evidence = after.filter(entry => entry.skill === skill);
      practiceTransfer.push({ skill, practiceCount, evidence,
        status: evidence.length ? 'related_observation' : 'not_observed',
        title: evidence.length ? `${label(skill)} 연습 기록과 관련된 경기 장면` : `${label(skill)} 연습 뒤 경기 근거를 더 기다려요`,
        caveat: `${caveat} 실천은 이전 경기 다음 날부터 이번 경기 날짜까지의 완료 기록입니다. 날짜만 기록되어 경기 당일의 연습·경기 선후는 확인할 수 없어요. 같은 항목이라는 연결일 뿐 정확히 그 기술을 썼거나 연습 때문에 달라졌다는 뜻은 아닙니다.`,
      });
    }
  }
  const history = safe.videos.filter(video => sameTarget(video.target, current.target))
    .filter(video => dateOf(video)).sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || String(b.addedAt).localeCompare(String(a.addedAt)))
    .map(video => {
      const evidence = evidenceForVideo(safe, video);
      const counts = Object.fromEntries(SKILLS.map(({ id }) => [id, evidence.filter(entry => entry.skill === id).length]));
      const limitations = [...new Set(safe.analyses.filter(analysis => analysis.videoId === video.id)
        .flatMap(analysis => Array.isArray(analysis.result?.limitations) ? analysis.result.limitations : []).filter(item => typeof item === 'string' && item.trim()))];
      limitations.push('표시한 수는 보통·높은 확신의 정성 관찰 수이며 능력치나 성장 점수가 아닙니다. 0은 실패가 아니라 해당 근거가 없다는 뜻입니다.');
      if (!isDate(video.context?.matchDate)) limitations.push('경기 날짜가 없어 한국 시간의 업로드 날짜로 표시합니다.');
      limitations.push(identityCaveat);
      return { videoId: video.id, date: dateOf(video), title: video.title || '경기 영상', counts, limitations };
    });
  const currentFocus = after.filter(entry => entry.type === 'focus');
  const candidates = SKILLS.map(({ id: skill }) => ({ skill, evidence: currentFocus.filter(entry => entry.skill === skill) }))
    .filter(item => item.evidence.length).sort((a, b) => b.evidence.length - a.evidence.length);
  const selected = candidates[0];
  const nextGoal = selected ? {
    skill: selected.skill, title: `${label(selected.skill)} · 다음 경기에서 다시 살펴볼 행동`,
    detail: [...selected.evidence].sort((a, b) => Number(b.confidence === 'high') - Number(a.confidence === 'high'))[0].note,
    evidence: selected.evidence,
  } : null;
  return { signals, practiceTransfer, history, nextGoal };
}
