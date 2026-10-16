import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrowthWorkspace, addDays, getWeekday } from '../public/growth-domain.js';
import { buildFourWeekPlan, buildDayRoutine, deriveGrowthPriorities } from '../public/growth-plans.js';

const start = '2026-10-19'; // Monday, explicit KST calendar date.
test('additional practices yield to insufficient sleep or a school day without time for recovery', () => {
  const workspace = createGrowthWorkspace();
  workspace.profile.planStart = start;
  workspace.profile.bedTime = '23:00';
  workspace.profile.wakeTime = '06:00';
  assert.equal(buildFourWeekPlan(workspace).filter(day => day.task).length, 0);
  workspace.profile.bedTime = '21:00';
  workspace.profile.wakeTime = '07:00';
  workspace.profile.schoolEnd = '20:00';
  const plan = buildFourWeekPlan(workspace);
  assert.equal(plan.filter(day => day.task && day.dayOfWeek >= 1 && day.dayOfWeek <= 5).length, 0);
});
function fixture() {
  const workspace = createGrowthWorkspace();
  workspace.profile.planStart = start;
  return workspace;
}
function evidence(workspace, skill = 'scan', extra = {}) {
  workspace.videos = [{ id: 'video-a', target: { kit: '남색', number: 11, age: 11 } }];
  workspace.analyses = [{ videoId: 'video-a', result: { identified: true, observations: [{ skill, type: 'focus', confidence: 'high', time: 4, note: '공을 받은 뒤 확인해 선택이 늦어졌어요.', ...extra }] } }];
  return workspace;
}
function weekGroups(plan) {
  const groups = new Map();
  for (const day of plan) {
    const monday = addDays(day.date, -((getWeekday(day.date) + 6) % 7));
    const group = groups.get(monday) || [];
    group.push(day); groups.set(monday, group);
  }
  return [...groups.values()];
}

test('four-week dates are consecutive, KST labels are correct, and generation is pure', () => {
  const workspace = fixture();
  const before = structuredClone(workspace);
  const plan = buildFourWeekPlan(workspace);
  assert.equal(plan.length, 28);
  assert.equal(plan[0].date, start);
  assert.equal(plan[0].weekday, '월');
  assert.equal(plan[27].date, '2026-11-15');
  assert.equal(plan[27].weekday, '일');
  assert.deepEqual(plan.map(day => day.date), Array.from({ length: 28 }, (_, i) => addDays(start, i)));
  assert.deepEqual(workspace, before);
  assert.equal(buildFourWeekPlan(workspace, { startDate: '2026-12-31' })[1].date, '2027-01-01');
});

test('without evidence the plan states a general assumption and never diagnoses scanning weakness', () => {
  const plan = buildFourWeekPlan(fixture());
  const sessions = plan.filter(day => day.task);
  assert.equal(sessions.length, 8);
  for (const day of sessions) {
    assert.equal(day.personalized, false);
    assert.equal(day.task.generalAssumption, true);
    assert.equal(day.task.evidence.length, 0);
    assert.match(day.task.reason, /일반 기초/);
    assert.match(day.task.reason, /약점.*아닙니다/);
    assert.equal(day.task.skill, 'touch');
  }
});

test('only identified, target-matching medium/high focus evidence chooses personalized priorities', () => {
  const workspace = evidence(fixture(), 'pass');
  workspace.analyses.push(
    { videoId: 'video-a', result: { identified: false, observations: [{ skill: 'shoot', type: 'focus', confidence: 'high' }] } },
    { videoId: 'video-a', result: { identified: true, observations: [{ skill: 'shoot', type: 'focus', confidence: 'low' }, { skill: 'defend', type: 'strength', confidence: 'high' }] } },
    { videoId: 'missing-video', result: { identified: true, observations: [{ skill: 'scan', type: 'focus', confidence: 'high' }] } },
  );
  workspace.videos.push({ id: 'other-player', target: { kit: '흰색', number: 3, age: 11 } });
  workspace.analyses.push({ videoId: 'other-player', result: { identified: true, observations: [{ skill: 'scan', type: 'focus', confidence: 'high' }] } });
  const priorities = deriveGrowthPriorities(workspace);
  assert.deepEqual(priorities.map(item => item.skill), ['pass']);
  const task = buildFourWeekPlan(workspace).find(day => day.task).task;
  assert.equal(task.skill, 'pass');
  assert.equal(task.personalized, true);
  assert.equal(task.evidence[0].videoId, 'video-a');
  assert.match(task.reason, /1개 관찰/);
});

test('human focus evidence works without pretending an unobserved skill has a low score', () => {
  const workspace = fixture();
  workspace.videos = [{ id: 'human-video' }];
  workspace.observations = [{ videoId: 'human-video', skill: 'touch', type: 'strength', rating: 4 }, { videoId: 'human-video', skill: 'defend', type: 'focus', rating: null, note: '수비 위치를 기록했어요.' }];
  assert.deepEqual(deriveGrowthPriorities(workspace).map(item => item.skill), ['defend']);
  assert.equal(buildFourWeekPlan(workspace).find(day => day.task).task.skill, 'defend');
});

test('team and match days get no extra individual work; every full week reserves two rest days', () => {
  const workspace = evidence(fixture());
  workspace.profile.teamDays = [2, 4]; workspace.profile.matchDays = [6]; workspace.profile.teamMinutes = 75;
  const plan = buildFourWeekPlan(workspace);
  for (const day of plan) {
    if ([2, 4].includes(day.dayOfWeek)) { assert.equal(day.kind, 'team'); assert.equal(day.task, null); assert.equal(day.minutes, 75); }
    if (day.dayOfWeek === 6) { assert.equal(day.kind, 'match'); assert.equal(day.task, null); }
  }
  for (const group of weekGroups(plan)) {
    assert.ok(group.filter(day => day.kind === 'rest').length >= 2);
    assert.ok(group.filter(day => day.kind === 'individual').length <= 3);
  }
  assert.equal(plan.find(day => day.dayOfWeek === 0).kind, 'rest');
  assert.equal(plan.find(day => day.dayOfWeek === 5).kind, 'rest');
});

test('an already crowded team calendar adds no training and visibly flags insufficient rest', () => {
  const workspace = fixture();
  workspace.profile.teamDays = [1, 2, 3, 4, 5]; workspace.profile.matchDays = [6];
  const plan = buildFourWeekPlan(workspace);
  assert.equal(plan.filter(day => day.kind === 'individual').length, 0);
  assert.ok(plan.every(day => day.loadWarning));
  assert.match(plan[0].reason, /휴식일이 부족/);
});

test('four-week progression changes quality while detailed work/rest minutes remain fixed', () => {
  const workspace = evidence(fixture(), 'dribble');
  const tasks = buildFourWeekPlan(workspace).filter(day => day.task).map(day => day.task);
  for (const task of tasks) {
    assert.equal(task.minutes, 15);
    assert.equal([...task.warmup, ...task.main, ...task.cooldown].reduce((sum, block) => sum + block.minutes, 0), task.minutes);
    assert.equal(task.main.length, 3);
    assert.ok(task.main.every(block => block.sets === 2 && block.reps && /30초/.test(block.rest)));
    assert.ok(task.steps.length >= 5 && task.mistakes.length >= 2);
    for (const key of ['solo', 'parent', 'success', 'easier', 'harder', 'stopRule']) assert.ok(task[key].length > 10, key);
  }
  assert.notEqual(tasks.find(task => task.week === 1).stage, tasks.find(task => task.week === 4).stage);
  assert.ok(tasks.every(task => task.steps.at(-1).includes('다음 날 보충하지')));
});

test('all eight skills offer complete steps and small indoor shooting uses low-force alternatives', () => {
  for (const skill of ['touch', 'pass', 'dribble', 'shoot', 'defend', 'scan', 'move', 'team']) {
    const task = buildFourWeekPlan(evidence(fixture(), skill)).find(day => day.task).task;
    assert.equal(task.skill, skill);
    assert.ok(task.equipment.length && task.space && task.setup);
    if (skill === 'shoot') assert.match(task.main[1].text, /강도 훈련은 하지 않아요/);
  }
  const workspace = evidence(fixture(), 'scan');
  workspace.profile.equipment = []; workspace.profile.helperMinutes = 0;
  const task = buildFourWeekPlan(workspace).find(day => day.task).task;
  assert.match(task.title, /공 없는/);
  assert.match(task.reason, /공이 장비 목록에 없어/);
  assert.match(task.solo, /공·파트너 없이/);
  assert.match(task.parent, /혼자 연습/);
});

test('pain and fatigue override scheduled work and never create catch-up tasks', () => {
  const workspace = fixture();
  workspace.profile.teamDays = [2];
  const baseline = buildFourWeekPlan(workspace);
  const individual = baseline.find(day => day.kind === 'individual');
  const team = baseline.find(day => day.kind === 'team');
  workspace.checkins = [{ date: individual.date, fatigue: 'tired' }, { date: team.date, pain: true }];
  const plan = buildFourWeekPlan(workspace);
  for (const date of [individual.date, team.date]) {
    const day = plan.find(item => item.date === date);
    assert.equal(day.kind, 'rest'); assert.equal(day.minutes, 0); assert.equal(day.task, null);
  }
  assert.match(plan.find(day => day.date === team.date).reason, /통증/);
  assert.equal(plan.filter(day => day.task).length, baseline.filter(day => day.task).length - 1);
  assert.match(plan.find(day => day.date === individual.date).reason, /보충하지/);
});

test('poor sleep skips additional personal practice but does not silently rewrite a team schedule', () => {
  const workspace = fixture();
  workspace.profile.teamDays = [2];
  const before = buildFourWeekPlan(workspace);
  const first = before.find(day => day.kind === 'individual');
  const team = before.find(day => day.kind === 'team');
  workspace.checkins = [{ date: first.date, sleepQuality: 'poor' }, { date: team.date, sleepQuality: 'poor' }];
  const plan = buildFourWeekPlan(workspace);
  assert.equal(plan.find(day => day.date === first.date).kind, 'rest');
  assert.equal(plan.find(day => day.date === team.date).kind, 'team');
});

test('moving practice preserves identity/completion and leaves an origin rest placeholder', () => {
  const workspace = fixture();
  const before = buildFourWeekPlan(workspace);
  const origin = before.find(day => day.kind === 'individual');
  const target = before.find(day => day.kind === 'rest' && day.week === origin.week);
  workspace.practices = [{ id: 'done-1', taskId: origin.task.id, date: origin.date, completed: true, note: '실제 기록' }];
  workspace.scheduleChanges = [{ taskId: origin.task.id, originalDate: origin.date, date: target.date }];
  const saved = structuredClone(workspace.practices);
  const plan = buildFourWeekPlan(workspace);
  const from = plan.find(day => day.date === origin.date), to = plan.find(day => day.date === target.date);
  assert.equal(from.kind, 'rest'); assert.equal(from.task, null); assert.equal(from.movedTo, target.date);
  assert.equal(to.kind, 'individual'); assert.equal(to.task.id, origin.task.id); assert.equal(to.minutes, 15);
  assert.equal(to.originalDate, origin.date); assert.equal(to.completed, true);
  assert.deepEqual(workspace.practices, saved);
  for (const group of weekGroups(plan)) assert.ok(group.filter(day => day.kind === 'rest').length >= 2);
});

test('moves onto team, match, occupied, or painful days never double up work', () => {
  for (const destination of ['team', 'match', 'individual', 'pain']) {
    const workspace = fixture();
    workspace.profile.teamDays = [2]; workspace.profile.matchDays = [6];
    const before = buildFourWeekPlan(workspace), origin = before.find(day => day.kind === 'individual');
    const target = before.find(day => destination === 'pain' ? day.kind === 'rest' : day.kind === destination && day !== origin);
    if (destination === 'pain') workspace.checkins = [{ date: target.date, pain: true }];
    workspace.scheduleChanges = [{ taskId: origin.task.id, originalDate: origin.date, date: target.date }];
    const plan = buildFourWeekPlan(workspace);
    assert.equal(plan.find(day => day.date === origin.date).task.id, origin.task.id);
    assert.match(plan.find(day => day.date === origin.date).moveNote, /옮기지 않았어요/);
    assert.ok(plan.every(day => !day.task || day.minutes === 15));
  }
});

test('moving a fourth practice into another calendar week is rejected', () => {
  const workspace = fixture();
  workspace.profile.teamDays = [4]; // Four free slots minus two rest days => three sessions.
  const before = buildFourWeekPlan(workspace);
  const origin = before.find(day => day.kind === 'individual' && day.week === 1);
  const target = before.find(day => day.kind === 'rest' && day.week === 2);
  workspace.scheduleChanges = [{ taskId: origin.task.id, originalDate: origin.date, date: target.date }];
  const plan = buildFourWeekPlan(workspace);
  assert.match(plan.find(day => day.date === origin.date).moveNote, /옮기지/);
  assert.ok(weekGroups(plan).every(group => group.filter(day => day.task).length <= 3));
});

test('routine includes school, meals, play, hygiene, family, and a 10-hour sleep opportunity', () => {
  const workspace = fixture();
  const day = buildFourWeekPlan(workspace)[0], routine = day.routine;
  assert.equal(routine.sleep.hours, 10);
  assert.equal(routine.sleep.target, '9~12시간');
  assert.equal(routine.sleep.withinTarget, true);
  assert.match(routine.sleep.source.url, /cdc\.gov/);
  for (const kind of ['school', 'meal', 'play', 'hygiene', 'family', 'winddown', 'sleep', 'training']) assert.ok(routine.items.some(item => item.kind === kind), kind);
  const winddown = routine.items.find(item => item.kind === 'winddown');
  assert.equal(winddown.time, '20:00'); assert.equal(winddown.end, '21:00');
  const exercise = routine.items.find(item => item.kind === 'training');
  assert.equal(exercise.minutes, day.task.minutes);
  assert.ok(routine.items.some(item => item.kind === 'hygiene' && /씻기/.test(item.title)));
  assert.ok(routine.habits.some(item => /화면/.test(item.title)));
  assert.match(routine.mental.parent, /어떤 시도/);
  assert.match(routine.mental.boundary, /성격.*판정하지/);
});

test('weekend routine omits school and warns when entered sleep times are insufficient', () => {
  const workspace = fixture();
  workspace.profile.bedTime = '23:30'; workspace.profile.wakeTime = '06:30';
  const routine = buildDayRoutine(workspace.profile, { date: '2026-10-25', kind: 'rest', minutes: 0 }, { mood: 'low', fatigue: 'tired' });
  assert.equal(routine.schoolDay, false);
  assert.equal(routine.sleep.hours, 7); assert.equal(routine.sleep.withinTarget, false);
  assert.ok(!routine.items.some(item => item.kind === 'school' && /수업/.test(item.title)));
  assert.match(routine.notes.join(' '), /권장 수면/);
  assert.match(routine.mental.child, /쉬거나 더 쉽게/);
  assert.match(routine.mental.parent, /밀린 연습을 요구하지/);
});
