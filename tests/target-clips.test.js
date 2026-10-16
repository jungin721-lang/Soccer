import test from 'node:test';
import assert from 'node:assert/strict';
import { planTargetClips } from '../public/target-clips.js';

function report(times, durationSeconds = 300) {
  return { schema: 'next-xi-feedback/v1', id: 'synthetic-target-review', title: '합성 근거 시간 검사', target: { kit: 'navy', number: 1, age: 10 }, reviewedAt: null,
    source: { kind: 'still_frames', durationSeconds, reviewedFrames: 6, confirmedTargetFrames: 2, continuous: false, description: '합성 정지화면의 시각' }, summary: '실제 선수 분석이 아닌 합성 검사',
    observations: times.map((time, i) => ({ id: `scene-${i}`, ...(Array.isArray(time) ? { time: time[0], endTime: time[1] } : { time }), fact: '합성 사실', interpretation: '합성 해석', uncertainty: '확인 불가' })),
    unobserved: ['전체 경기'], training: [{ id: 'task', title: '기초 과제', goal: '작은 목표', reason: '일반 연습', minutes: 2, frequency: '주 1회', equipment: [], steps: [{ label: '연습', minutes: 2, instructions: ['합성 안내'] }], success: '완료 확인' }], limitations: ['식별이나 추적을 실행하지 않음'], provenance: { kind: 'chat_review', professionalReview: false } };
}

test('target clips use reviewed evidence rather than minute boundaries and preserve the caller', () => {
  const source = report([17.903, [101.536, 102.72]], 501.801), before = structuredClone(source);
  const clips = planTargetClips(source);
  assert.equal(clips.length, 2);
  assert.deepEqual(clips.map(c => [c.index, c.start, c.end]), [[1, 14.902999999999999, 22.903], [2, 98.536, 107.72]]);
  assert.ok(clips.every(c => c.duration < 10));
  assert.deepEqual(source, before);
});

test('nearby evidence windows merge and source boundaries remain bounded', () => {
  assert.deepEqual(planTargetClips(report([298, 1, [10, 12], 6])), [
    { index: 1, start: 0, end: 17, duration: 17 },
    { index: 2, start: 295, end: 300, duration: 5 },
  ]);
});

test('a long reviewed interval is split only to obey encoder limits without gaps', () => {
  const clips = planTargetClips(report([[0, 200]]));
  assert.equal(clips[0].start, 0);
  assert.equal(clips.at(-1).end, 205);
  assert.ok(clips.every(c => c.duration > 0 && c.duration <= 65));
  for (let i = 1; i < clips.length; i++) assert.equal(clips[i].start, clips[i - 1].end - 5);
});

test('unconfirmed identity and invalid evidence cannot silently become whole-video clips', () => {
  const source = report([10]); source.source.confirmedTargetFrames = 0;
  assert.throws(() => planTargetClips(source), /확인된 근거/);
  for (const patch of [{ leadSeconds: -1 }, { trailSeconds: Infinity }, { leadSeconds: 0, trailSeconds: 0 }, { leadSeconds: 11 }]) {
    assert.throws(() => planTargetClips(report([10]), patch));
  }
  const invalid = report([301]); assert.throws(() => planTargetClips(invalid));
});
