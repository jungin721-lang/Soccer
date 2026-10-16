import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAutoScanPlan, selectAutoSegments } from '../public/auto-analysis.js';

const cloudflare = { provider: 'cloudflare' };

function assertSafeSegments(segments, duration) {
  for (const [index, segment] of segments.entries()) {
    assert.ok(Number.isFinite(segment.start) && Number.isFinite(segment.end));
    assert.ok(segment.start >= 0 && segment.end <= duration);
    assert.ok(segment.end > segment.start && segment.end - segment.start <= 3);
    if (index) assert.ok(segment.start > segments[index - 1].start);
  }
}

test('Cloudflare scans every source second and its final partial second beyond the old frame cap', () => {
  const plan = makeAutoScanPlan(5400, cloudflare);
  assert.equal(plan.interval, 1);
  assert.equal(plan.sampleCount, 5401);
  assert.equal(plan.times.length, plan.sampleCount);
  assert.deepEqual(plan.times.slice(0, 4), [0, 1, 2, 3]);
  assert.deepEqual(plan.times.slice(-3), [5398, 5399, 5399.9]);
  assert.equal(makeAutoScanPlan(5400).sampleCount, 120);

  for (const duration of [1, 1.1, 4.25, 120.1, 86400]) {
    const current = makeAutoScanPlan(duration, cloudflare);
    const lastTime = duration - Math.min(0.1, duration / 10);
    assert.equal(current.interval, 1);
    assert.ok(current.sampleCount <= 86401);
    assert.equal(current.times[0], 0);
    assert.equal(current.times.at(-1), lastTime);
    assert.equal(new Set(current.times).size, current.sampleCount);
    const fullSeconds = current.times.filter(time => Number.isInteger(time));
    assert.deepEqual(fullSeconds, Array.from({ length: Math.floor(lastTime) + 1 }, (_, index) => index));
    for (let index = 1; index < current.times.length; index += 1) {
      assert.ok(current.times[index] > current.times[index - 1]);
      assert.ok(current.times[index] - current.times[index - 1] <= 1);
    }
  }
});

test('Cloudflare retains more than six distant qualifying detections without changing default selection', () => {
  const detections = Array.from({ length: 20 }, (_, index) => ({ time: index * 25 + 1.125, confidence: index % 2 ? 'medium' : 'high' }));
  const segments = selectAutoSegments(detections, 500, cloudflare);
  assert.equal(segments.length, detections.length);
  assert.equal(selectAutoSegments(detections, 500).length, 6);
  assert.deepEqual(selectAutoSegments(detections, 500, 6, cloudflare), segments);
  assert.deepEqual(selectAutoSegments([...detections].reverse(), 500, cloudflare), segments);
  for (const detection of detections) assert.ok(segments.some(segment => segment.start <= detection.time && segment.end >= detection.time));
  assertSafeSegments(segments, 500);
});

test('Cloudflare merges consecutive evidence and splits it into overlapping clips covering the whole padded range', () => {
  const detections = Array.from({ length: 81 }, (_, index) => ({ time: index + 0.125, confidence: 'medium' }));
  const segments = selectAutoSegments(detections, 100, cloudflare);
  assert.ok(segments.length > 6);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1).end, 81.625);
  assertSafeSegments(segments, 100);
  for (let index = 1; index < segments.length; index += 1) {
    assert.ok(Math.abs(segments[index - 1].end - segments[index].start - 1) < 0.000000001);
  }
  for (const detection of detections) assert.ok(segments.some(segment => segment.start <= detection.time && segment.end >= detection.time));
  for (const segment of segments) assert.ok(detections.some(detection => segment.start <= detection.time && segment.end >= detection.time));
});

test('Cloudflare retains every evidence anchor while omitting an unanchored context-only tail', () => {
  const detections = [1.5, 3.7].map(time => ({ time, confidence: 'high' }));
  const segments = selectAutoSegments(detections, 10, cloudflare);
  assert.deepEqual(segments, [{ start: 0, end: 3 }, { start: 2, end: 5 }]);
  for (const detection of detections) assert.ok(segments.some(segment => segment.start <= detection.time && segment.end >= detection.time));
  for (const segment of segments) assert.ok(detections.some(detection => segment.start <= detection.time && segment.end >= detection.time));
});

test('Cloudflare covers a dense full-match scan without dropping later evidence', () => {
  const duration = 5400;
  const detections = makeAutoScanPlan(duration, cloudflare).times.map(time => ({ time, confidence: 'high' }));
  const segments = selectAutoSegments(detections, duration, cloudflare);
  assert.equal(segments.length, 2700);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1).end, duration);
  assertSafeSegments(segments, duration);
  for (let index = 1; index < segments.length; index += 1) assert.equal(segments[index].start, segments[index - 1].end - 1);
  let segmentIndex = 0;
  for (const detection of detections) {
    while (segments[segmentIndex].end < detection.time) segmentIndex += 1;
    assert.ok(segments[segmentIndex].start <= detection.time && segments[segmentIndex].end >= detection.time);
  }
});

test('Cloudflare handles fractional clip bounds and both source boundaries safely', () => {
  for (const duration of [1, 11.9, 12, 12.000000000000002, 32.1, 65540.125, 86400]) {
    const detections = [0, duration / 2, duration].map(time => ({ time, confidence: 'high' }));
    const segments = selectAutoSegments(detections, duration, cloudflare);
    assertSafeSegments(segments, duration);
    for (const detection of detections) assert.ok(segments.some(segment => segment.start <= detection.time && segment.end >= detection.time));
    assert.equal(segments[0].start, 0);
    assert.equal(segments.at(-1).end, duration);
  }
});

test('Cloudflare ignores invalid or low-confidence evidence and rejects invalid source lengths', () => {
  const invalidDetections = [null, {}, { time: NaN, confidence: 'high' }, { time: Infinity, confidence: 'high' }, { time: -1, confidence: 'medium' }, { time: 31, confidence: 'high' }, { time: '10', confidence: 'high' }, { time: 10, confidence: 'low' }, { time: 11, confidence: 'HIGH' }];
  assert.deepEqual(selectAutoSegments(invalidDetections, 30, cloudflare), []);
  for (const invalid of [null, undefined, {}, 'detections']) assert.deepEqual(selectAutoSegments(invalid, 30, cloudflare), []);
  for (const invalid of [0, 0.9, NaN, Infinity, -1, 86401, '36']) {
    assert.throws(() => makeAutoScanPlan(invalid, cloudflare));
    assert.throws(() => selectAutoSegments([], invalid, cloudflare));
  }
});
