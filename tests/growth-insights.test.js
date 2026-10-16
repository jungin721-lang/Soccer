import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrowthWorkspace } from '../public/growth-domain.js';
import { buildGrowthInsights } from '../public/growth-insights.js';

const target = { kit: 'navy', number: 11, age: 11 };
const oldId = '11111111-1111-4111-8111-111111111111', newId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const workspace = createGrowthWorkspace();
  workspace.profile = { ...workspace.profile, ...target };
  workspace.videos = [
    { id: oldId, target, title: '첫 경기', addedAt: '2026-10-16T09:00:00Z', context: { matchDate: '2026-10-16', position: '미드필더', minutesPlayed: 30, filming: 'clear', opponentLevel: 'similar' } },
    { id: newId, target, title: '다음 경기', addedAt: '2026-10-23T09:00:00Z', context: { matchDate: '2026-10-23', position: '미드필더', minutesPlayed: 30, filming: 'clear', opponentLevel: 'similar' } },
  ];
  return workspace;
}
function observe(workspace, videoId, skill, type, note, confidence = 'high', identified = true) {
  const index = workspace.analyses.length;
  workspace.analyses.push({ id: `analysis-${index}`, videoId, start: index * 10, end: index * 10 + 10, result: { identified, observations: [{ skill, type, note, confidence, time: index * 10 + 2 }], limitations: ['촬영에서 일부 선수가 가려졌어요.'] } });
}
function practice(date, skill, extra = {}) { return { id: `${date}-${skill}`, date, taskId: `practice-${date}-${skill}`, completed: true, ...extra }; }

test('empty and unvalidated targets return no manufactured scenes or goals', () => {
  assert.deepEqual(buildGrowthInsights(createGrowthWorkspace()), { signals: [], practiceTransfer: [], history: [], nextGoal: null });
  const workspace = fixture(); workspace.videos[1].target = { kit: 'unknown', number: 11, age: 11 };
  assert.deepEqual(buildGrowthInsights(workspace), { signals: [], practiceTransfer: [], history: [], nextGoal: null });
});

test('previous focus and current strength create a related observation, never confirmed improvement', () => {
  const workspace = fixture();
  observe(workspace, oldId, 'scan', 'focus', '공을 받은 다음 주변을 확인했어요.');
  observe(workspace, newId, 'scan', 'strength', '공이 오기 전에 왼쪽을 확인했어요.');
  const before = structuredClone(workspace), result = buildGrowthInsights(workspace);
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].status, 'related_observation');
  assert.equal(result.signals[0].title, '이전 과제와 관련된 강점 장면');
  assert.equal(result.signals[0].previousEvidence[0].videoId, oldId);
  assert.equal(result.signals[0].currentEvidence[0].note, '공이 오기 전에 왼쪽을 확인했어요.');
  assert.match(result.signals[0].caveat, /확정된 향상.*뜻하지/);
  assert.equal(result.nextGoal, null);
  assert.deepEqual(workspace, before);
});

test('mixed strength and repeated focus preserve both source sets without a growth grade', () => {
  const workspace = fixture();
  observe(workspace, oldId, 'touch', 'focus', '첫 터치가 멀어졌어요.');
  observe(workspace, newId, 'touch', 'strength', '공을 발 가까이 놓았어요.');
  observe(workspace, newId, 'touch', 'focus', '압박 상황에서는 공이 멀어졌어요.');
  const result = buildGrowthInsights(workspace);
  assert.deepEqual(result.signals.map(signal => signal.status), ['related_observation', 'repeat_focus']);
  assert.equal(result.nextGoal.detail, '압박 상황에서는 공이 멀어졌어요.');
  assert.equal(Object.hasOwn(result.signals[0], 'score'), false);
  assert.equal(Object.hasOwn(result.signals[0], 'delta'), false);
});

test('unidentified, low confidence, absent and out-of-clip observations do not become evidence', () => {
  const workspace = fixture();
  observe(workspace, oldId, 'pass', 'focus', '패스 강도를 조절할 수 있어요.');
  observe(workspace, newId, 'pass', 'strength', '확신이 낮은 장면', 'low');
  observe(workspace, newId, 'pass', 'focus', '선수를 확인하지 못한 장면', 'high', false);
  observe(workspace, newId, 'pass', 'focus', '구간 밖 장면');
  workspace.analyses.at(-1).result.observations[0].time = 999;
  const result = buildGrowthInsights(workspace);
  assert.equal(result.signals.length, 0); assert.equal(result.nextGoal, null);
  assert.equal(result.history.find(row => row.videoId === newId).counts.pass, 0);
  assert.match(result.history[0].limitations.join(' '), /0은 실패가 아니라/);
});

test('completed practice dates are after the previous match and never after the current match', () => {
  const workspace = fixture();
  observe(workspace, newId, 'scan', 'note', '받기 전 주변을 확인한 장면이에요.', 'medium');
  workspace.practices = [practice('2026-10-16', 'scan'), practice('2026-10-17', 'scan'), practice('2026-10-23', 'scan'), practice('2026-10-24', 'scan'), practice('2026-10-20', 'scan', { completed: false }), practice('2026-10-21', 'scan', { taskId: 'unrelated-task' })];
  workspace.practices.push({ ...workspace.practices[1], id: 'duplicate' });
  const transfer = buildGrowthInsights(workspace).practiceTransfer;
  assert.equal(transfer.length, 1); assert.equal(transfer[0].practiceCount, 2);
  assert.equal(transfer[0].status, 'related_observation');
  assert.equal(transfer[0].evidence[0].note, '받기 전 주변을 확인한 장면이에요.');
  assert.match(transfer[0].caveat, /경기 당일.*선후/);
  assert.match(transfer[0].caveat, /연습 때문에.*뜻은 아닙니다/);
});

test('unobserved practice is not failure and unrelated or changed targets are not paired', () => {
  const workspace = fixture();
  workspace.practices = [practice('2026-10-20', 'shoot')];
  let result = buildGrowthInsights(workspace);
  assert.equal(result.practiceTransfer[0].status, 'not_observed');
  assert.deepEqual(result.practiceTransfer[0].evidence, []);
  assert.match(result.practiceTransfer[0].caveat, /장면이 없다고 실패한 것도 아닙니다/);
  workspace.profile.number = 7;
  assert.deepEqual(buildGrowthInsights(workspace).practiceTransfer, []);
  workspace.videos[0].target = { kit: 'white', number: 11, age: 11 };
  observe(workspace, oldId, 'scan', 'focus', '다른 선수의 과제');
  observe(workspace, newId, 'scan', 'strength', '현재 선수의 강점');
  result = buildGrowthInsights(workspace);
  assert.equal(result.signals.length, 0); assert.equal(result.history.length, 1);
});

test('history has eight descriptive skill counts, source limitations and no ability values', () => {
  const workspace = fixture();
  observe(workspace, oldId, 'pass', 'focus', '패스 관찰');
  observe(workspace, newId, 'pass', 'strength', '다음 패스 관찰');
  workspace.analyses.push(structuredClone({ ...workspace.analyses[1], id: 'duplicate-analysis' }));
  const result = buildGrowthInsights(workspace);
  assert.deepEqual(result.history.map(row => row.date), ['2026-10-23', '2026-10-16']);
  assert.equal(Object.keys(result.history[0].counts).length, 8);
  assert.equal(result.history[0].counts.pass, 1, 'duplicate source descriptions do not inflate counts');
  assert.ok(result.history[0].limitations.includes('촬영에서 일부 선수가 가려졌어요.'));
  assert.equal(Object.hasOwn(result.history[0], 'value'), false);
  assert.equal(Object.hasOwn(result.history[0], 'score'), false);
});

test('next goal uses a real current medium/high focus note and preserves context uncertainty', () => {
  const workspace = fixture();
  workspace.videos[1].context.filming = 'limited';
  observe(workspace, oldId, 'defend', 'focus', '이전 수비 과제');
  observe(workspace, newId, 'defend', 'focus', '상대에게 곧바로 접근해 뒤 공간이 열렸어요.', 'medium');
  const result = buildGrowthInsights(workspace);
  assert.equal(result.nextGoal.skill, 'defend');
  assert.equal(result.nextGoal.detail, workspace.analyses[1].result.observations[0].note);
  assert.equal(result.nextGoal.evidence[0].videoId, newId);
  assert.equal(result.signals[0].status, 'repeat_focus');
  assert.match(result.signals[0].caveat, /촬영 조건/);
  workspace.videos[1].context.matchDate = '2026-10-15';
  workspace.practices = [practice('2026-10-20', 'defend')];
  assert.deepEqual(buildGrowthInsights(workspace).practiceTransfer, []);
});
