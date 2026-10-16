import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAutoScanPlan, selectAutoSegments } from '../public/auto-analysis.js';

test('scan plans cover the entire time span uniformly and disclose the actual long-video interval', () => {
  for (const duration of [1, 4, 36, 59.99, 600, 5400, 86400]) {
    const plan = makeAutoScanPlan(duration);
    assert.ok(plan.sampleCount >= 2 && plan.sampleCount <= 120);
    assert.equal(plan.times.length, plan.sampleCount);
    assert.equal(plan.times[0], 0);
    assert.ok(plan.times.at(-1) < duration && duration - plan.times.at(-1) <= 0.10000001);
    for (let index = 1; index < plan.times.length; index += 1) {
      assert.ok(plan.times[index] > plan.times[index - 1]);
      assert.ok(Math.abs(plan.times[index] - plan.times[index - 1] - plan.interval) < 0.00000001);
    }
    if (plan.sampleCount < 120) assert.ok(plan.interval <= 5);
  }
  const match = makeAutoScanPlan(5400);
  assert.equal(match.sampleCount, 120);
  assert.ok(match.interval > 45 && match.interval < 46);
  for (const invalid of [0, 0.9, NaN, Infinity, -1, 86401, '36']) assert.throws(() => makeAutoScanPlan(invalid));
});

test('automatic clips include early and late evidence with no overlap or manual timestamps', () => {
  const detections = [0, 1, 2, 8, 12, 20, 24, 31.9].map(time => ({ time, confidence: 'high' }));
  const segments = selectAutoSegments(detections, 32);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], { start: 0, end: 12 });
  assert.deepEqual(segments.at(-1), { start: 20, end: 32 });
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    assert.ok(segment.start >= 0 && segment.end <= 32);
    assert.ok(segment.end - segment.start >= 1 && segment.end - segment.start <= 12);
    assert.ok(detections.some(item => item.time >= segment.start && item.time < segment.end));
    if (index) assert.ok(segment.start >= segments[index - 1].end);
  }
});

test('clip selection is bounded and spreads its budget across distant evidence', () => {
  const detections = Array.from({ length: 100 }, (_, index) => ({ time: index * 10 + 0.125, confidence: index % 2 ? 'medium' : 'high' }));
  const segments = selectAutoSegments(detections, 1000);
  assert.equal(segments.length, 6);
  assert.ok(segments[0].start < 1);
  assert.ok(segments.at(-1).end > 990);
  assert.deepEqual(selectAutoSegments([...detections].reverse(), 1000), segments);
  assert.ok(segments.every(item => item.end - item.start <= 12));
  for (let index = 1; index < segments.length; index += 1) assert.ok(segments[index].start >= segments[index - 1].end);
  assert.deepEqual(selectAutoSegments([{ time: 0.9, confidence: 'high' }], 1), [{ start: 0, end: 1 }]);
  assert.deepEqual(selectAutoSegments([{ time: 20, confidence: 'low' }, { time: NaN, confidence: 'high' }, { time: 31, confidence: 'high' }], 30), []);
  assert.deepEqual(selectAutoSegments([], 30), []);
});
