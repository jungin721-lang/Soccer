import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrowthWorkspace, validateGrowthWorkspace, validateTarget, validateMatchContext, KIT_OPTIONS, kstToday, isDate, addDays, getWeekday, weekdayLabel, compareMatches } from '../public/growth-domain.js';

const FIRST_VIDEO = '6b1abcb4-8448-42a4-9541-cf50959b75e9';
const SECOND_VIDEO = 'c64330ae-33b3-467e-81c0-cd179982992f';
const video = (overrides = {}) => ({
  id: FIRST_VIDEO, kind: 'server', title: '주말 경기', fileName: 'match.mp4', size: 4096,
  mime: 'video/mp4', addedAt: '2026-10-16T08:00:00.000Z', duration: 1800,
  target: { kit: 'navy', number: 11, age: 11 },
  context: { position: '중앙 미드필더', opponentLevel: 'similar', minutesPlayed: 30, filming: 'clear', matchDate: '2026-10-16' },
  ...overrides,
});
const humanObservation = (overrides = {}) => ({
  id: 'observation-1', videoId: FIRST_VIDEO, skill: 'touch', time: 60, rating: 3,
  note: '받은 공을 다음 동작으로 연결했습니다.', type: 'strength', createdAt: '2026-10-16T08:01:00.000Z', ...overrides,
});
const analysis = (overrides = {}) => ({
  id: 'analysis-1', jobId: 'job-1', videoId: FIRST_VIDEO, createdAt: '2026-10-16T08:02:00.000Z',
  start: 57.25, end: 69.25, model: 'configured-model',
  result: { identified: true, summary: '짧은 구간에서 관찰한 행동입니다.', observations: [{ skill: 'touch', time: 60, note: '공을 받아 동료에게 연결했습니다.', type: 'strength', confidence: 'medium' }], limitations: ['한 장면만으로 능력을 단정할 수 없습니다.'], nextAction: '다음 경기에서도 같은 행동을 확인합니다.' },
  ...overrides,
});
const workspaceWithVideo = () => ({ ...createGrowthWorkspace(), videos: [video()] });

test('new growth workspaces have independent editable profiles and no invented results or consent', () => {
  const state = createGrowthWorkspace(), other = createGrowthWorkspace();
  assert.equal(state.profile.age, 11);
  assert.equal(state.profile.kit, '남색');
  assert.equal(state.profile.planStart, kstToday());
  assert.deepEqual(state.consents, { guardian: false, analysis: false, training: false });
  for (const key of ['videos', 'analyses', 'jobs', 'observations', 'practices', 'checkins', 'scheduleChanges']) assert.deepEqual(state[key], []);
  state.profile.teamDays.push(1);
  state.profile.equipment.push('콘');
  assert.deepEqual(other.profile.teamDays, []);
  assert.deepEqual(other.profile.equipment, ['축구공']);
  assert.deepEqual(validateGrowthWorkspace(other), other);
});

test('KST calendar utilities handle midnight, leap years and weekdays without host timezone dependence', () => {
  assert.equal(kstToday('2026-10-16T14:59:59.000Z'), '2026-10-16');
  assert.equal(kstToday('2026-10-16T15:00:00.000Z'), '2026-10-17');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(getWeekday('2026-10-18'), 0);
  assert.equal(weekdayLabel('2026-10-19'), '월');
  assert.equal(isDate('2026-02-29'), false);
  assert.equal(isDate('2026-02-30'), false);
  assert.equal(isDate('2026-2-01'), false);
  assert.equal(isDate('2026-10-16T00:00:00Z'), false);
  assert.throws(() => addDays('invalid', 1), /날짜/);
  assert.throws(() => addDays('2026-10-16', 0.5), /날짜/);
});

test('target validation supports all configured colors and does not lock players to number eleven', () => {
  for (const kit of KIT_OPTIONS) {
    assert.deepEqual(validateTarget({ kit: kit.id, number: 99, age: 18 }), { kit: kit.id, number: 99, age: 18 });
    assert.equal(validateTarget({ kit: kit.label, number: 7, age: 9 }).kit, kit.id);
  }
  const state = validateGrowthWorkspace({ profile: { kit: 'red', number: 7, age: 10, position: '윙어' } });
  assert.equal(state.profile.number, 7);
  assert.equal(state.profile.kit, 'red');
  assert.equal(state.profile.position, '윙어');
  assert.equal(state.profile.schoolStart, '08:30');
  for (const target of [{ kit: 'unknown', number: 11, age: 11 }, { kit: 'navy', number: 0, age: 11 }, { kit: 'navy', number: '11', age: 11 }, { kit: 'navy', number: 11, age: 4 }, { kit: {}, number: 11, age: 11 }]) assert.throws(() => validateTarget(target), /선수/);
});

test('profile schedules and lifestyle settings are bounded and health details do not imply consent', () => {
  const state = validateGrowthWorkspace({ profile: { teamDays: [5, 1, 1], matchDays: [0], allergies: ['견과류'], likedFoods: ['두부'], foot: '왼발' } });
  assert.deepEqual(state.profile.teamDays, [1, 5]);
  assert.deepEqual(state.profile.allergies, ['견과류']);
  assert.equal(state.profile.sensitiveConsent, false);
  assert.deepEqual(state.consents, { guardian: false, analysis: false, training: false });
  for (const change of [{ teamDays: [7] }, { matchDays: ['1'] }, { teamMinutes: 241 }, { helperMinutes: -1 }, { wakeTime: '25:00' }, { bedTime: '9:00' }, { planStart: '2026-02-30' }, { notificationsEnabled: 'yes' }, { roleView: 'admin' }, { allergies: [''] }, { likedFoods: Array(31).fill('밥') }]) assert.throws(() => validateGrowthWorkspace({ profile: change }));
  for (const consents of [null, { guardian: 'true' }, { training: 1 }]) assert.throws(() => validateGrowthWorkspace({ consents }), /동의/);
  assert.deepEqual(validateGrowthWorkspace({ consents: { guardian: true, analysis: true } }).consents, { guardian: true, analysis: true, training: false });
});

test('server video metadata is sanitized and context defaults remain explicitly unknown', () => {
  const state = workspaceWithVideo();
  Object.assign(state.videos[0], { ownerId: 'private-owner', storageKey: 'private/path', token: 'secret', data: 'bytes', url: 'file:///private' });
  const clean = validateGrowthWorkspace(state).videos[0];
  for (const key of ['ownerId', 'storageKey', 'token', 'data', 'url']) assert.equal(Object.hasOwn(clean, key), false);
  assert.equal(clean.id, FIRST_VIDEO);
  assert.equal(clean.target.kit, 'navy');
  assert.deepEqual(validateMatchContext({}, { matchDate: '2026-10-16' }), { position: '미등록', opponentLevel: 'unknown', minutesPlayed: null, filming: 'unknown', matchDate: '2026-10-16' });
  state.videos[0].target.kit = '남색';
  assert.equal(validateGrowthWorkspace(state).videos[0].target.kit, 'navy');
});

test('video references, source metadata and context cannot bypass validation', () => {
  for (const change of [{ id: 'local-video' }, { id: [FIRST_VIDEO] }, { kind: 'file' }, { size: 0 }, { size: 2 * 1024 ** 3 + 1 }, { duration: 0 }, { duration: Infinity }, { duration: '1800' }, { target: { kit: 'navy', number: 100, age: 11 } }, { context: { filming: 'excellent' } }, { context: { minutesPlayed: -1 } }]) {
    const state = workspaceWithVideo();
    Object.assign(state.videos[0], change);
    assert.throws(() => validateGrowthWorkspace(state));
  }
  const state = workspaceWithVideo();
  state.videos.push(video());
  assert.throws(() => validateGrowthWorkspace(state), /중복된 영상/);
});

test('qualitative AI results round trip separately from rated human evidence and strip transient fields', () => {
  const state = workspaceWithVideo();
  const item = analysis();
  item.frames = ['data:image/jpeg;base64,not-persisted'];
  item.result.private = 'not-persisted';
  item.result.observations[0].extra = 'not-persisted';
  state.analyses.push(item);
  const clean = validateGrowthWorkspace(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(clean.observations, []);
  assert.equal(clean.analyses[0].jobId, 'job-1');
  assert.equal(Object.hasOwn(clean.analyses[0], 'frames'), false);
  assert.equal(Object.hasOwn(clean.analyses[0].result, 'private'), false);
  assert.equal(Object.hasOwn(clean.analyses[0].result.observations[0], 'extra'), false);
  assert.deepEqual(validateGrowthWorkspace(JSON.parse(JSON.stringify(clean))), clean);
  state.analyses[0].result.observations[0].rating = 5;
  assert.throws(() => validateGrowthWorkspace(state), /AI 관찰/);
});

test('AI results require a real source, a bounded clip and actual identification before observations', () => {
  const changes = [{ videoId: SECOND_VIDEO }, { jobId: '' }, { start: -1 }, { end: 70 }, { end: Infinity }, { model: '' }];
  for (const change of changes) {
    const state = workspaceWithVideo();
    state.analyses.push(analysis(change));
    assert.throws(() => validateGrowthWorkspace(state), /AI 분석/);
  }
  const state = workspaceWithVideo();
  state.analyses.push(analysis());
  state.analyses[0].result.identified = false;
  assert.throws(() => validateGrowthWorkspace(state), /AI 분석/);
  state.analyses[0].result.observations = [];
  assert.equal(validateGrowthWorkspace(state).analyses[0].result.identified, false);
});

test('human observations require bounded ratings and known source videos', () => {
  for (const change of [{ videoId: SECOND_VIDEO }, { rating: 0 }, { rating: 6 }, { rating: '4' }, { time: -1 }, { skill: 'future-potential' }, { type: 'diagnosis' }]) {
    const state = workspaceWithVideo();
    state.observations.push(humanObservation(change));
    assert.throws(() => validateGrowthWorkspace(state), /장면/);
  }
  const state = workspaceWithVideo();
  state.observations.push(humanObservation({ rating: null }));
  assert.equal(validateGrowthWorkspace(state).observations[0].rating, null);
});

test('practice, wellbeing and rescheduling records survive a sanitized round trip', () => {
  const state = workspaceWithVideo();
  state.practices.push({ id: 'practice-1', date: '2026-10-17', taskId: 'touch-1', completed: true, note: '재미있었어요.', ignored: true });
  state.checkins.push({ date: '2026-10-17', sleepQuality: 'good', fatigue: 'normal', mood: 'okay', pain: false, notes: '오늘 느낌' });
  state.scheduleChanges.push({ taskId: 'touch-1', originalDate: '2026-10-17', date: '2026-10-18', private: true });
  const clean = validateGrowthWorkspace(state);
  assert.equal(Object.hasOwn(clean.practices[0], 'ignored'), false);
  assert.equal(Object.hasOwn(clean.scheduleChanges[0], 'private'), false);
  assert.deepEqual(validateGrowthWorkspace(JSON.parse(JSON.stringify(clean))), clean);
  state.checkins.push({ ...state.checkins[0] });
  assert.throws(() => validateGrowthWorkspace(state), /중복된 상태/);
});

test('job metadata excludes private identities, credentials and results stored separately by the backend', () => {
  const state = workspaceWithVideo();
  state.jobs.push({ id: 'job-1', videoId: FIRST_VIDEO, status: 'running', stage: 'scanning', createdAt: '2026-10-16T08:01:00.000Z', updatedAt: '2026-10-16T08:02:00.000Z', progress: { sampledCount: 4, sampleCount: 10, image: 'raw-image' }, error: null, result: { token: 'private' }, target: video().target, context: video().context, attempt: 1, userId: 'private', tokenHash: 'private' });
  const job = validateGrowthWorkspace(state).jobs[0];
  for (const key of ['userId', 'tokenHash', 'result']) assert.equal(Object.hasOwn(job, key), false);
  assert.equal(Object.hasOwn(job.progress, 'image'), false);
  assert.equal(job.progress.sampledCount, 4);
});

function comparisonWorkspace() {
  const state = createGrowthWorkspace();
  state.videos = [video(), video({ id: SECOND_VIDEO, addedAt: '2026-10-23T08:00:00.000Z', context: { ...video().context, matchDate: '2026-10-23' } })];
  state.observations = [
    ...[2, 3, 4].map((rating, index) => humanObservation({ id: `previous-${index}`, rating, time: 60 + index })),
    ...[3, 4, 5].map((rating, index) => humanObservation({ id: `current-${index}`, videoId: SECOND_VIDEO, rating, time: 80 + index })),
  ];
  return state;
}

test('match comparison requires three human-rated observations per skill and links both evidence sets', () => {
  const result = compareMatches(validateGrowthWorkspace(comparisonWorkspace()));
  assert.equal(result.status, 'ready');
  assert.equal(result.previous.id, FIRST_VIDEO);
  assert.equal(result.current.id, SECOND_VIDEO);
  const touch = result.skills.find(skill => skill.skill === 'touch');
  assert.equal(touch.previous.value, 3);
  assert.equal(touch.current.value, 4);
  assert.equal(touch.delta, 1);
  assert.equal(touch.previous.evidence.length, 3);
  assert.equal(touch.current.evidence[0].videoId, SECOND_VIDEO);
  assert.equal(result.skills.find(skill => skill.skill === 'pass').delta, null);
  assert.equal(result.skills.find(skill => skill.skill === 'pass').status, 'insufficient');
});

test('AI observation counts remain descriptive and cannot create a numeric growth score', () => {
  const state = comparisonWorkspace();
  state.observations.pop();
  state.analyses.push(analysis(), analysis({ id: 'analysis-2', videoId: SECOND_VIDEO }));
  const result = compareMatches(validateGrowthWorkspace(state));
  assert.equal(result.status, 'insufficient');
  assert.equal(result.skills.find(skill => skill.skill === 'touch').delta, null);
  assert.equal(result.qualitative.previous.strengths, 1);
  assert.equal(result.qualitative.current.strengths, 1);
  assert.equal(result.qualitative.current.evidence[0].videoId, SECOND_VIDEO);
});

test('different positions, minutes, filming or opponent conditions withhold numeric deltas', () => {
  for (const change of [{ position: '윙어' }, { position: '미등록' }, { minutesPlayed: null }, { minutesPlayed: 5 }, { minutesPlayed: 60 }, { filming: 'limited' }, { filming: 'unknown' }, { opponentLevel: 'unknown' }, { opponentLevel: 'stronger' }]) {
    const state = comparisonWorkspace();
    Object.assign(state.videos[1].context, change);
    const result = compareMatches(validateGrowthWorkspace(state));
    assert.equal(result.status, 'incomparable', JSON.stringify(change));
    assert.ok(result.contextReasons.length > 0);
    assert.equal(result.skills.find(skill => skill.skill === 'touch').delta, null);
    assert.equal(result.skills.find(skill => skill.skill === 'touch').current.count, 3);
  }
});

test('comparison does not pair different targets and finds the most recent matching target', () => {
  const state = comparisonWorkspace();
  state.videos[1].target.number = 7;
  assert.equal(compareMatches(state).status, 'insufficient');
  assert.equal(compareMatches(state).previous, null);
  state.videos[1].target.number = 11;
  state.videos[0].target.kit = '남색';
  assert.equal(compareMatches(state).previous.id, FIRST_VIDEO);
  assert.equal(compareMatches(createGrowthWorkspace()).current, null);
});

 test('previous match is chosen by the played date even when an older match is uploaded later', () => {
  const target={kit:'navy',number:11,age:11};
  const workspace=createGrowthWorkspace();
  workspace.videos=[{id:'old-upload-late',target,addedAt:'2026-10-16T04:00:00Z',context:{matchDate:'2026-10-01'}},{id:'actual-current',target,addedAt:'2026-10-15T04:00:00Z',context:{matchDate:'2026-10-14'}}];
  const comparison=compareMatches(workspace);
  assert.equal(comparison.current.id,'actual-current');
  assert.equal(comparison.previous.id,'old-upload-late');
});
