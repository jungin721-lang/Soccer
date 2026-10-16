import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeekMeals, getDailyMeals, nutritionSources } from '../public/growth-nutrition.js';

const profile = {age: 11, allergies: [], dietaryRestrictions: [], likedFoods: [], schoolLunch: false};

test('seven dated meal cards cross month and year correctly without a timezone shift', () => {
  const plan = buildWeekMeals(profile, {startDate: '2026-12-29'});
  assert.equal(plan.startDate, '2026-12-29');
  assert.equal(plan.endDate, '2027-01-04');
  assert.deepEqual(plan.days.map(day => day.weekday), ['화요일', '수요일', '목요일', '금요일', '토요일', '일요일', '월요일']);
  for (const day of plan.days) {
    assert.equal(day.meals.length, 4);
    for (const meal of day.meals) {
      for (const key of ['when', 'title', 'role', 'prep']) assert.ok(meal[key], key);
      assert.ok(meal.items.length >= 2);
      assert.ok(Array.isArray(meal.alternatives));
    }
  }
  assert.ok(plan.shoppingList.length >= 4);
  assert.equal(getDailyMeals(profile, '2026-10-16').date, '2026-10-16');
});

test('English and Korean allergen labels remove every corresponding ingredient from all meals', () => {
  const all = ['milk', 'egg', 'wheat', 'soy', 'peanut', 'tree-nut', 'fish', 'shellfish'];
  for (const allergies of [all, ['우유', '달걀', '밀', '대두', '땅콩', '견과류', '생선', '새우']]) {
    const plan = buildWeekMeals({...profile, allergies}, {startDate: '2026-10-16'});
    assert.equal(plan.requiresProfessional, false);
    assert.equal(plan.allergyLabels.length, 8);
    const ingredients = plan.days.flatMap(day => day.meals.flatMap(meal => meal.ingredients));
    assert.ok(ingredients.length > 0);
    assert.ok(ingredients.every(item => item.allergens.every(allergen => !all.includes(allergen))));
    assert.ok(!ingredients.some(item => /두부|달걀|우유|요거트|생선/.test(item.label)));
    assert.match(plan.notices.join(' '), /교차 접촉/);
  }
});

test('allergy exclusions override preferences and vegetarian or vegan choices remain compatible', () => {
  const plan = buildWeekMeals({...profile, allergies: ['egg', 'milk'], dietaryRestrictions: ['비건'], likedFoods: ['달걀', '닭고기']}, {startDate: '2026-10-16'});
  const ingredients = plan.days.flatMap(day => day.meals.flatMap(meal => meal.ingredients));
  assert.ok(ingredients.length > 0);
  assert.ok(!ingredients.some(item => /고기|달걀|생선|우유|요거트/.test(item.label)));
  const vegetarian = buildWeekMeals({...profile, dietaryRestrictions: ['채식']}, {startDate: '2026-10-16'});
  assert.ok(!vegetarian.days.flatMap(day => day.meals.flatMap(meal => meal.items)).some(item => /고기|생선/.test(item)));
});

test('liked basic foods affect the initial choices while invalid training times are not presented as facts', () => {
  const plan = buildWeekMeals({...profile, allergies: ['없음'], likedFoods: ['고구마', '사과', '두부'], trainingTime: '99:99'}, {startDate: '2026-10-16'});
  assert.equal(plan.requiresProfessional, false);
  assert.ok(plan.days[0].breakfast.items.some(item => item.includes('고구마')));
  assert.ok(plan.days[0].breakfast.items.some(item => item.includes('사과')));
  assert.ok(plan.days[0].breakfast.items.some(item => item.includes('두부')));
  assert.ok(!plan.trainingTiming.title.includes('99:99'));
});

test('unrecognized allergies, treatment diets and severe allergies do not generate a medical menu', () => {
  for (const overrides of [{allergies: ['토마토']}, {dietaryRestrictions: ['신장질환 치료식']}, {severeAllergies: true}, {medicalDiet: true}]) {
    const plan = buildWeekMeals({...profile, ...overrides}, {startDate: '2026-10-16'});
    assert.equal(plan.requiresProfessional, true);
    assert.ok(plan.days.every(day => day.meals.every(meal => meal.items.length === 0)));
    assert.equal(plan.shoppingList.length, 0);
    assert.match(plan.notices.join(' '), /전문가/);
  }
});

test('school lunch is not invented; weekdays show the school verification and weekends stay concrete', () => {
  const plan = buildWeekMeals({...profile, schoolLunch: true}, {startDate: '2026-10-16'});
  for (const day of plan.days) {
    if (['토요일', '일요일'].includes(day.weekday)) assert.ok(day.lunch.items.length > 0);
    else {
      assert.equal(day.lunch.items.length, 0);
      assert.match(day.lunch.prep, /당일 메뉴와 알레르기/);
      assert.ok(day.lunch.complement);
    }
  }
});

test('missing inputs are explicit and invalid dates use a real seven-day fallback', () => {
  const plan = buildWeekMeals({}, {startDate: '2026-02-30'});
  assert.equal(plan.days.length, 7);
  assert.match(plan.assumptions.join(' '), /알레르기 정보/);
  assert.match(plan.assumptions.join(' '), /시작 날짜/);
  assert.match(plan.assumptions.join(' '), /급식 여부/);
  assert.ok(!Number.isNaN(Date.parse(plan.startDate)));
  assert.ok(buildWeekMeals(null).days.length === 7);
});

test('plan contains general timing and hydration without calorie or supplement prescriptions', () => {
  const plan = buildWeekMeals({...profile, trainingTime: '17:30'}, {startDate: '2026-10-16'});
  assert.match(plan.trainingTiming.title, /17:30/);
  assert.ok(plan.trainingTiming.before && plan.trainingTiming.after);
  assert.ok(plan.hydration.items.length >= 3);
  assert.ok(plan.schoolLunchComplements.length && plan.convenienceEating.length);
  assert.ok(!/\d+\s*(?:kcal|칼로리|ml|mL)/.test(JSON.stringify(plan)));
});

test('source registry never presents blocked attempts as verified research or professional review', () => {
  assert.ok(nutritionSources.some(source => source.organization.includes('CDC')));
  assert.ok(nutritionSources.some(source => source.organization.includes('AAP')));
  assert.ok(nutritionSources.some(source => source.organization.includes('MyPlate')));
  assert.ok(nutritionSources.some(source => source.organization.includes('NIH')));
  for (const source of nutritionSources) {
    assert.equal(source.verifiedDate, null);
    assert.equal(source.status, 'unverified');
    assert.equal(source.checkedDate, '2026-10-16');
    assert.match(source.verificationNote, /403/);
    assert.match(source.url, /^https:\/\//);
  }
});
