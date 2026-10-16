import { validateFeedbackReport } from './feedback.js';
import { CLIP_LIMITS } from './video-clips.js';

// These are windows around EXISTING review evidence. This function does not
// discover, identify or track a player in a new video.
export function planTargetClips(value, { leadSeconds = 3, trailSeconds = 5 } = {}) {
  const report = validateFeedbackReport(value);
  if (report.source.confirmedTargetFrames < 1) throw new Error('등번호가 확인된 근거 장면이 없어 대상 구간을 만들 수 없어요. 새로운 선수를 자동으로 찾는 기능은 아닙니다.');
  if (![leadSeconds, trailSeconds].every(n => Number.isFinite(n) && n >= 0 && n <= 10) || leadSeconds + trailSeconds <= 0) {
    throw new Error('근거 장면 앞뒤의 시간 설정을 확인해 주세요.');
  }
  const windows = report.observations.map(o => ({
    start: Math.max(0, o.time - leadSeconds),
    end: Math.min(report.source.durationSeconds, (o.endTime ?? o.time) + trailSeconds),
  })).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const window of windows) {
    const prior = merged.at(-1);
    if (prior && window.start <= prior.end + 1e-6) prior.end = Math.max(prior.end, window.end);
    else merged.push({ ...window });
  }
  const result = [], maximum = CLIP_LIMITS.chunkSeconds + CLIP_LIMITS.overlapSeconds;
  for (const window of merged) {
    let start = window.start;
    while (start < window.end) {
      const end = Math.min(window.end, start + maximum);
      result.push({ index: result.length + 1, start, end, duration: end - start });
      if (end >= window.end) break;
      start = end - CLIP_LIMITS.overlapSeconds;
    }
  }
  return result;
}
