// Planning uses only timestamps and detections. It never scores a player or
// assumes that unsampled time has been observed.
export function makeAutoScanPlan(duration, options = {}) {
  if (!Number.isFinite(duration) || duration < 1 || duration > 86400) {
    throw new Error('자동 분석은 1초 이상, 24시간 이하의 원본 영상에서 이용할 수 있습니다.');
  }
  const lastTime = Math.max(0, duration - Math.min(0.1, duration / 10));
  if (options?.provider === 'cloudflare') {
    // This provider examines each source second. Keep the final partial second
    // too, without representing the endpoint as another full-second interval.
    const times = Array.from({ length: Math.floor(lastTime) + 1 }, (_, index) => index);
    if (times.at(-1) !== lastTime) times.push(lastTime);
    return { duration, sampleCount: times.length, interval: 1, times };
  }
  const sampleCount = Math.min(120, Math.max(2, Math.ceil(lastTime / 5) + 1));
  const interval = lastTime / (sampleCount - 1);
  const times = Array.from({ length: sampleCount }, (_, index) => index === sampleCount - 1 ? lastTime : index * interval);
  return { duration, sampleCount, interval, times };
}

export function selectAutoSegments(detections, duration, maximum = 6, options = {}) {
  makeAutoScanPlan(duration);
  if (maximum && typeof maximum === 'object' && !Array.isArray(maximum)) {
    options = maximum;
    maximum = 6;
  }
  if (options?.provider === 'cloudflare') return selectCloudflareSegments(detections, duration);
  if (!Array.isArray(detections) || !Number.isInteger(maximum) || maximum < 1 || maximum > 6) return [];
  const length = Math.min(12, duration);
  const candidates = detections.filter(item => item && Number.isFinite(item.time) && item.time >= 0 && item.time <= duration && ['medium', 'high'].includes(item.confidence)).map(item => {
    const start = Math.max(0, Math.min(duration - length, item.time - length / 2));
    let end = Math.min(duration, start + length);
    // Avoid an IEEE-754 subtraction of 12.000000000000002 at fractional times.
    if (end - start > 12) end -= 0.000001;
    return { start, end, time: item.time, confidence: item.confidence };
  }).sort((a, b) => a.start - b.start || Number(b.confidence === 'high') - Number(a.confidence === 'high'));
  const unique = candidates.filter((item, index) => index === 0 || Math.abs(item.start - candidates[index - 1].start) > 0.001);
  const selected = [];
  const compatible = item => selected.every(other => item.start >= other.end || item.end <= other.start);
  while (selected.length < maximum) {
    const remaining = unique.filter(compatible);
    if (!remaining.length) break;
    // Begin with the earliest visible evidence, then cover the most distant
    // remaining evidence. This prevents six adjacent detections using the budget.
    let next = remaining[0];
    if (selected.length) {
      const distance = item => Math.min(...selected.map(other => Math.abs((item.start + item.end) / 2 - (other.start + other.end) / 2)));
      next = remaining.reduce((best, item) => {
        const difference = distance(item) - distance(best);
        if (difference > 0.000001 || (Math.abs(difference) <= 0.000001 && item.confidence === 'high' && best.confidence !== 'high')) return item;
        return best;
      });
    }
    selected.push(next);
  }
  return selected.sort((a, b) => a.start - b.start).map(({ start, end }) => ({ start, end }));
}

function selectCloudflareSegments(detections, duration) {
  if (!Array.isArray(detections)) return [];
  const length = Math.min(3, duration);
  const qualifying = detections.filter(item => item && Number.isFinite(item.time) && item.time >= 0 && item.time <= duration && ['medium', 'high'].includes(item.confidence));
  const ranges = qualifying.map(item => {
    const start = Math.max(0, Math.min(duration - length, item.time - length / 2));
    return { start, end: Math.min(duration, start + length) };
  }).sort((a, b) => a.start - b.start || a.end - b.end);

  // The full qualifying evidence determines the output. Merge its padded
  // ranges first, so neighboring events are covered continuously.
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }

  const segments = [];
  for (const range of merged) {
    let start = range.start;
    while (range.end - start > 3) {
      let end = start + 3;
      // Four JPEGs can review at most three source seconds at roughly 1 fps.
      // Keep that strict bound despite floating-point addition; overlap by 1s.
      if (end - start > 3) end -= Number.EPSILON * Math.max(1, Math.abs(end));
      segments.push({ start, end });
      start = end - 1;
    }
    segments.push({ start, end: range.end });
  }
  // A short context-only tail can follow the final anchor after splitting.
  // Omit that context, while retaining every window with confirmed evidence.
  const times = qualifying.map(item => item.time).sort((a, b) => a - b);
  let evidenceIndex = 0;
  return segments.filter(segment => {
    while (evidenceIndex < times.length && times[evidenceIndex] < segment.start) evidenceIndex += 1;
    return evidenceIndex < times.length && times[evidenceIndex] <= segment.end;
  });
}
