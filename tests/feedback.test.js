import test from 'node:test';
import assert from 'node:assert/strict';
import { FEEDBACK_MAX_BYTES, FEEDBACK_LINK_MAX_BYTES, FEEDBACK_SCHEMA, validateFeedbackReport, parseFeedbackReport, parseFeedbackFragment, formatEvidenceTime } from '../public/feedback.js';

// Synthetic validation data; it contains no real player information or review.
function fixture() {
  return {
    schema: FEEDBACK_SCHEMA, id: 'synthetic-review', title: '테스트용 피드백', target: { kit: 'turquoise', number: 1, age: 10 }, reviewedAt: null,
    source: { kind: 'still_frames', durationSeconds: 300, reviewedFrames: 6, confirmedTargetFrames: 2, continuous: false, description: '검증용 합성 자료 설명' },
    summary: '합성 검토 요약',
    observations: [{ id: 'scene-one', time: 10.25, endTime: 11, fact: '관찰 사실', interpretation: '가능한 해석', uncertainty: '확인하지 못한 점' }],
    unobserved: ['화면 밖 움직임'],
    training: [{ id: 'practice-one', title: '합성 연습', reason: '연습 제안의 범위', goal: '확인 가능한 작은 목표', minutes: 5, frequency: '주 1회', equipment: ['공'], steps: [{ label: '첫 단계', minutes: 2, instructions: ['합성 안내 하나'] }, { label: '두 번째 단계', minutes: 3, instructions: ['합성 안내 둘'] }], success: '확인 가능한 성공 기준' }],
    limitations: ['일부 자료의 관찰이며 능력치를 평가하지 않음'], provenance: { kind: 'chat_review', professionalReview: false },
  };
}
const link = report => `#report=${Buffer.from(JSON.stringify(report)).toString('base64url')}`;

test('feedback preserves source bounds, uncertain observations and practical training without inventing a date', () => {
  const input = fixture();
  const report = validateFeedbackReport(input);
  assert.deepEqual(report, input);
  assert.notEqual(report, input);
  assert.notEqual(report.observations[0], input.observations[0]);
  input.training[0].steps[0].instructions[0] = 'changed';
  assert.equal(report.training[0].steps[0].instructions[0], '합성 안내 하나');
  assert.equal(report.reviewedAt, null);
  for (const reviewedAt of ['2026-10-16T00:00:00Z', '2026-10-16T00:00:00.123Z']) {
    assert.equal(validateFeedbackReport({ ...fixture(), reviewedAt }).reviewedAt, reviewedAt);
  }
});

test('feedback rejects incorrect provenance, hidden extras, credentials and ability scores', () => {
  const patches = [
    { schema: 'future-feedback' }, { id: '__proto__' }, { id: 'constructor' }, { id: 'unsafe/id' },
    { token: 'not-a-real-token' }, { abilityScore: 95 }, { html: '<p>extra</p>' },
    { reviewedAt: '2026-02-29T00:00:00Z' }, { reviewedAt: '2026-10-16' }, { reviewedAt: '2026-10-16T24:00:00Z' },
    { provenance: { kind: 'automated', professionalReview: false } },
    { provenance: { kind: 'chat_review', professionalReview: true } },
    { target: { kit: 'constructor', number: 1, age: 10 } },
    { target: { kit: 'navy', number: 0, age: 10 } },
    { target: { kit: 'navy', number: 1, age: 19 } },
  ];
  for (const patch of patches) assert.throws(() => validateFeedbackReport({ ...fixture(), ...patch }));
  const descriptor = fixture(); Object.defineProperty(descriptor, 'unknown', { value: 'hidden', enumerable: false });
  assert.throws(() => validateFeedbackReport(descriptor));
  const arrayExtra = fixture(); Object.defineProperty(arrayExtra.unobserved, '__proto__', { value: 'hidden', enumerable: false });
  assert.throws(() => validateFeedbackReport(arrayExtra));
  const arrayGetter = fixture(); Object.defineProperty(arrayGetter.unobserved, '0', { get() { throw new Error('Array getter must never execute'); } });
  assert.throws(() => validateFeedbackReport(arrayGetter), /피드백 형식/);
  const getter = fixture(); Object.defineProperty(getter, 'title', { get() { throw new Error('Getter must never execute'); } });
  assert.throws(() => validateFeedbackReport(getter), /피드백 형식/);
  const polluted = JSON.stringify(fixture()).replace('"title":', '"__proto__":{"polluted":true},"title":');
  assert.throws(() => parseFeedbackReport(polluted));
  assert.equal({}.polluted, undefined);
  for (const field of Object.keys(fixture())) {
    const missing = fixture(); delete missing[field];
    assert.throws(() => validateFeedbackReport(missing), field);
  }
});

test('feedback evidence must stay in its stated source range with separate facts, interpretation and uncertainty', () => {
  for (const sourcePatch of [
    { durationSeconds: 0 }, { durationSeconds: Infinity }, { durationSeconds: 86401 },
    { reviewedFrames: 0 }, { reviewedFrames: 10001 }, { confirmedTargetFrames: 7 },
    { continuous: true }, { kind: 'full_match' },
  ]) {
    const report = fixture(); Object.assign(report.source, sourcePatch);
    assert.throws(() => validateFeedbackReport(report));
  }
  for (const observationPatch of [
    { time: -1 }, { time: 301 }, { time: NaN }, { endTime: 301 }, { endTime: 9 },
    { fact: '' }, { interpretation: '' }, { uncertainty: '' }, { score: 90 },
  ]) {
    const report = fixture(); Object.assign(report.observations[0], observationPatch);
    assert.throws(() => validateFeedbackReport(report));
  }
  const duplicate = fixture(); duplicate.observations.push({ ...duplicate.observations[0] });
  assert.throws(() => validateFeedbackReport(duplicate));
});

test('training requires concrete instructions, bounded time, frequency and success criteria', () => {
  for (const patch of [
    { goal: '' }, { success: '' }, { frequency: '' }, { equipment: [''] }, { steps: [] },
    { minutes: 0 }, { minutes: 91 }, { minutes: 6 },
    { steps: [{ label: '단계', minutes: 5, instructions: [] }] },
    { steps: [{ label: '단계', minutes: -5, instructions: ['안내'] }] },
  ]) {
    const report = fixture(); Object.assign(report.training[0], patch);
    assert.throws(() => validateFeedbackReport(report));
  }
  const report = fixture(); report.training[0].equipment = [];
  assert.deepEqual(validateFeedbackReport(report).training[0].equipment, []);
});

test('JSON import is byte bounded and preserves HTML-like prose solely as plain data', () => {
  const report = fixture(); report.summary = '<img src=x onerror=alert(1)> & <script>bad()</script>';
  assert.equal(parseFeedbackReport(JSON.stringify(report)).summary, report.summary);
  for (const input of ['', ' ', 'not json', '{}', '[]', null, ' '.repeat(FEEDBACK_MAX_BYTES + 1)]) assert.throws(() => parseFeedbackReport(input));
  const multibyte = '한'.repeat(Math.ceil(FEEDBACK_MAX_BYTES / 3));
  assert.throws(() => parseFeedbackReport(`{"text":"${multibyte}"}`), /1MiB/);
  report.title = 'bad\u0000text'; assert.throws(() => validateFeedbackReport(report));
  report.title = 'a'.repeat(201); assert.throws(() => validateFeedbackReport(report));
});

test('private review links decode UTF-8 data with a stricter size cap and reject malformed encoding', () => {
  const report = fixture(); report.title = '링크 · 한국어 ⚽';
  assert.deepEqual(parseFeedbackFragment(link(report)), report);
  for (const input of ['', '#foo=abc', '#report=', '#report=a', '#report=!!!', '#report=YWJj', '#report=__8', '#report=YWJj=', '#report=' + 'a'.repeat(Math.ceil(FEEDBACK_LINK_MAX_BYTES * 4 / 3) + 1)]) assert.throws(() => parseFeedbackFragment(input));
  const wrong = fixture(); wrong.provenance.professionalReview = true;
  assert.throws(() => parseFeedbackFragment(link(wrong)));
});

test('evidence clocks retain fractional source timestamps without creating a review date', () => {
  assert.equal(formatEvidenceTime(0), '00:00');
  assert.equal(formatEvidenceTime(10.25), '00:10.250');
  assert.equal(formatEvidenceTime(3723.1), '62:03.100');
});
