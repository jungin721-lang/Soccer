import test from 'node:test';
import assert from 'node:assert/strict';
import { SKILLS } from '../public/domain.js';
import { deriveTrainingPlan } from '../public/plans.js';

const observation = (skill, rating) => ({ skill, rating });

test('no evidence gives a clearly non-personalized four-week starter plan', () => {
  const plan = deriveTrainingPlan([]);
  assert.equal(plan.focus, 'scan');
  assert.equal(plan.personalized, false);
  assert.equal(plan.sourceCount, 0);
  assert.equal(plan.title, '공을 받기 전, 한 번 더 보기.');
  assert.equal(plan.weeks.length, 4);
  for (const week of plan.weeks) {
    assert.equal(week.length, 3);
    for (const item of week) {
      for (const field of ['title', 'detail', 'minutes', 'target']) assert.ok(typeof item[field] === 'string' && item[field].length > 0, field);
    }
  }
  assert.match(plan.note, /팀 훈련/);
  assert.match(plan.note, /조절/);
});

test('unscored scene records never imply personalized weaknesses', () => {
  const plan = deriveTrainingPlan([observation('pass', null), observation('touch', null)]);
  assert.equal(plan.focus, 'scan');
  assert.equal(plan.personalized, false);
  assert.equal(plan.sourceCount, 0);
});

test('actual passing evidence yields a passing plan instead of the scanning default', () => {
  const plan = deriveTrainingPlan([observation('pass', 2), observation('pass', 3)]);
  assert.equal(plan.focus, 'pass');
  assert.equal(plan.label, '패스');
  assert.equal(plan.personalized, true);
  assert.equal(plan.sourceCount, 2);
  assert.match(plan.title, /패스/);
  assert.match(plan.weeks[0][0].title, /패스/);
  assert.match(plan.weeks[3][0].detail, /방향, 강도, 타이밍/);
});

test('unobserved skills and null ratings cannot override the lowest rated skill', () => {
  const plan = deriveTrainingPlan([
    observation('scan', null),
    observation('touch', 5),
    observation('pass', null),
    observation('pass', 2),
    observation('pass', 4),
    observation('dribble', 4),
  ]);
  assert.equal(plan.focus, 'pass');
  assert.equal(plan.sourceCount, 2);
  assert.equal(plan.personalized, true);
});

test('equal observed scores choose deterministically in the evaluation skill order', () => {
  const first = deriveTrainingPlan([observation('pass', 2), observation('touch', 2)]);
  const reversed = deriveTrainingPlan([observation('touch', 2), observation('pass', 2)]);
  assert.equal(first.focus, 'touch');
  assert.equal(reversed.focus, first.focus);
  assert.deepEqual(first.weeks, reversed.weeks);
});

test('every observed skill has an actual authored progression with its own focus', () => {
  const titles = new Set();
  for (const skill of SKILLS) {
    const plan = deriveTrainingPlan([observation(skill.id, 3)]);
    assert.equal(plan.focus, skill.id);
    assert.equal(plan.label, skill.name);
    assert.equal(plan.sourceCount, 1);
    assert.equal(plan.personalized, true);
    assert.equal(plan.weeks.length, 4);
    assert.ok(plan.weeks.every(week => week.length === 3));
    assert.notEqual(plan.weeks[0][0].title, plan.weeks[3][0].title, 'progresses from a practice task to a match review');
    titles.add(plan.title);
  }
  assert.equal(titles.size, SKILLS.length, 'each focus has a distinct title');
});

test('plan generation does not mutate evidence or share mutable exercise objects', () => {
  const evidence = [observation('pass', 2)];
  const original = structuredClone(evidence);
  const first = deriveTrainingPlan(evidence);
  first.weeks[0][0].title = 'changed';
  assert.deepEqual(evidence, original);
  assert.notEqual(deriveTrainingPlan(evidence).weeks[0][0].title, 'changed');
});
