// General guidance: source-body checks do not constitute clinical menu review.
export const nutritionContentVersion = "2026-10-16.2";
export const nutritionReviewStatus = Object.freeze({"contentVersion": "2026-10-16.2", "sourceVerification": "partial", "scope": "11세 전후 유소년의 일반 식사·수분·수면 안내", "individualClinicalReview": "not_reviewed", "reviewer": null, "reviewedDate": null});
export const nutritionSources = [
  {
    "id": "myplate-kids",
    "organization": "USDA MyPlate",
    "title": "Healthy Eating for Kids",
    "url": "https://www.myplate.gov/life-stages/kids",
    "supports": "다양한 식품군 안내의 추가 참고 후보",
    "publishedDate": null,
    "updatedDate": null,
    "checkedDate": "2026-10-16",
    "verifiedDate": null,
    "status": "unverified",
    "error": "proxy_tunnel_403",
    "verificationNote": "2026-10-16 재요청에서도 네트워크 프록시가 403으로 연결을 거부해 공식 본문을 확인하지 못했습니다. 확인된 식품군 안내는 아래 AAP 자료를 사용합니다."
  },
  {
    "id": "cdc-sleep",
    "organization": "CDC",
    "title": "About Sleep",
    "url": "https://www.cdc.gov/sleep/about/index.html",
    "supports": "6~12세의 하루 9~12시간 수면과 일정한 취침·기상",
    "publishedDate": null,
    "updatedDate": null,
    "checkedDate": "2026-10-16",
    "verifiedDate": "2026-10-16",
    "status": "verified",
    "httpStatus": 200,
    "retrievedAt": "2026-10-16T15:30:13.871508+09:00",
    "bodySha256": "fc86bbe162acc8b4619cd9643aad742a21559dd42ba0abda6923ce8625df98a1",
    "claims": [
      {
        "id": "sleep-school-age",
        "text": "6~12세 수면 권고는 하루 9~12시간입니다.",
        "quote": "School age 6–12 years 9–12 hours"
      },
      {
        "id": "sleep-consistency",
        "text": "취침·기상 시간을 일정하게 유지합니다.",
        "quote": "Going to bed and getting up at the same time every day."
      }
    ],
    "verificationNote": "공식 본문을 직접 읽고 아래 제한된 주장과 일치하는 내용을 확인했습니다. 이 앱의 메뉴 전체나 개인별 처방에 대한 전문가 검수를 뜻하지 않습니다.",
    "pageDate": "2024-05-15",
    "pageDateLabel": "페이지 표시일"
  },
  {
    "id": "aap-sleep",
    "organization": "AAP · HealthyChildren",
    "title": "Healthy Sleep Habits: How Many Hours Does Your Child Need?",
    "url": "https://www.healthychildren.org/English/healthy-living/sleep/Pages/healthy-sleep-habits-how-many-hours-does-your-child-need.aspx",
    "supports": "취침 최소 60분 전 화면 끄기",
    "publishedDate": null,
    "updatedDate": "2026-08-07",
    "checkedDate": "2026-10-16",
    "verifiedDate": "2026-10-16",
    "status": "verified",
    "httpStatus": 200,
    "retrievedAt": "2026-10-16T15:31:16.495793+09:00",
    "bodySha256": "4027064ef453743b44f5b18d4fdcc20e0cf4d302ed55c61deffb792d978ca734",
    "claims": [
      {
        "id": "screen-winddown",
        "text": "취침 최소 60분 전에 화면을 끕니다.",
        "quote": "turn off all screens at least 60 minutes/1 hour before bedtime."
      }
    ],
    "verificationNote": "공식 본문을 직접 읽고 아래 제한된 주장과 일치하는 내용을 확인했습니다. 이 앱의 메뉴 전체나 개인별 처방에 대한 전문가 검수를 뜻하지 않습니다."
  },
  {
    "id": "aap-water",
    "organization": "AAP · HealthyChildren",
    "title": "Choose Water for Healthy Hydration",
    "url": "https://www.healthychildren.org/English/healthy-living/nutrition/Pages/Choose-Water-for-Healthy-Hydration.aspx",
    "supports": "식사와 간식에 물, 활동 전·중·후 수분 섭취 기회",
    "publishedDate": null,
    "updatedDate": "2024-07-26",
    "checkedDate": "2026-10-16",
    "verifiedDate": "2026-10-16",
    "status": "verified",
    "httpStatus": 200,
    "retrievedAt": "2026-10-16T15:30:13.871508+09:00",
    "bodySha256": "448534d2c8a5b44119ea52fc926f60f500df324ebefe4fc7e632cd90686f9dd8",
    "claims": [
      {
        "id": "water-meals",
        "text": "식사·간식 때 물을 제공하고 외출 때 물병을 준비합니다.",
        "quote": "Serve water with meals and snacks, and take those extra few minutes to pack the water bottles"
      },
      {
        "id": "water-activity",
        "text": "운동 전·중·후 물을 마실 기회를 마련합니다.",
        "quote": "drinks water before, during and after practices or games."
      }
    ],
    "verificationNote": "공식 본문을 직접 읽고 아래 제한된 주장과 일치하는 내용을 확인했습니다. 이 앱의 메뉴 전체나 개인별 처방에 대한 전문가 검수를 뜻하지 않습니다.",
    "limitation": "본문의 수분량 수치를 개인별 정량 처방으로 가져오지 않습니다."
  },
  {
    "id": "aap-food-choices",
    "organization": "AAP · HealthyChildren",
    "title": "Healthy Food Choices for Your Family",
    "url": "https://www.healthychildren.org/English/ages-stages/gradeschool/nutrition/Pages/Making-Healthy-Food-Choices.aspx",
    "supports": "주식·단백질 식품·채소·과일·유제품 등 다양한 식품군",
    "publishedDate": null,
    "updatedDate": "2021-03-04",
    "checkedDate": "2026-10-16",
    "verifiedDate": "2026-10-16",
    "status": "verified",
    "httpStatus": 200,
    "retrievedAt": "2026-10-16T15:32:04.410708+09:00",
    "bodySha256": "19fc2b4f8355f06b32aa2e30441a93902d142dd97287488c4ea2251f857ff6c7",
    "claims": [
      {
        "id": "food-variety",
        "text": "여러 식품군의 음식을 다양하게 선택합니다.",
        "quote": "Your child should consume a variety of foods from the five major food groups."
      }
    ],
    "verificationNote": "공식 본문을 직접 읽고 아래 제한된 주장과 일치하는 내용을 확인했습니다. 이 앱의 메뉴 전체나 개인별 처방에 대한 전문가 검수를 뜻하지 않습니다.",
    "limitation": "2021년 표시 문서입니다. 본문의 정량 제공 횟수·칼로리는 앱에 적용하지 않았으며 최신 영양 표준 전체를 검증한 뜻이 아닙니다."
  },
  {
    "id": "aap-appetite",
    "organization": "AAP · HealthyChildren",
    "title": "Monitoring What Your Child Eats",
    "url": "https://www.healthychildren.org/English/ages-stages/gradeschool/nutrition/Pages/Monitoring-What-Your-Child-Eats.aspx",
    "supports": "보호자가 음식 선택을 돕고 아이의 먹는 양·식욕 차이를 존중하는 일반 원칙",
    "publishedDate": null,
    "updatedDate": "2009-11-03",
    "checkedDate": "2026-10-16",
    "verifiedDate": "2026-10-16",
    "status": "verified",
    "httpStatus": 200,
    "retrievedAt": "2026-10-16T15:32:04.410708+09:00",
    "bodySha256": "6f1fe588b8edc936f774ec85858a41ef3949d675ef12f39da95b2a44d83097f2",
    "claims": [
      {
        "id": "appetite-respect",
        "text": "아이마다 먹는 양이 달라 성인 분량을 일률적으로 요구하지 않습니다.",
        "quote": "the child is in the best position to decide how much to eat."
      }
    ],
    "verificationNote": "공식 본문을 직접 읽고 아래 제한된 주장과 일치하는 내용을 확인했습니다. 이 앱의 메뉴 전체나 개인별 처방에 대한 전문가 검수를 뜻하지 않습니다.",
    "limitation": "개정 표시가 2009년인 오래된 자료입니다. 식욕 존중 원칙에만 참고하며 질환·성장 문제나 최신 개인 영양 처방의 근거로 사용하지 않습니다."
  },
  {
    "id": "nih-calcium",
    "organization": "NIH · Office of Dietary Supplements",
    "title": "Calcium — Consumer",
    "url": "https://ods.od.nih.gov/factsheets/Calcium-Consumer/",
    "supports": "칼슘 공급원에 대한 추가 참고 후보",
    "publishedDate": null,
    "updatedDate": null,
    "checkedDate": "2026-10-16",
    "verifiedDate": null,
    "status": "unverified",
    "httpStatus": 403,
    "error": "http_403",
    "verificationNote": "2026-10-16 Consumer·Health Professional 공식 경로가 HTTP 403을 반환해 본문을 확인하지 못했습니다. 보충제·용량·개별 칼슘 처방의 근거로 사용하지 않습니다."
  },
  {
    "id": "fda-allergy",
    "organization": "FDA",
    "title": "Food Allergies",
    "url": "https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies",
    "supports": "성분 표시 확인과 제조 중 알레르겐 교차 접촉의 개념",
    "publishedDate": null,
    "updatedDate": null,
    "checkedDate": "2026-10-16",
    "verifiedDate": "2026-10-16",
    "status": "verified",
    "httpStatus": 200,
    "retrievedAt": "2026-10-16T15:32:04.410708+09:00",
    "bodySha256": "0d551641ab3999ad6afb7b349fa3a0ca308a301bc240bf819d6f4d07fd99bf6f",
    "claims": [
      {
        "id": "allergen-labels",
        "text": "포장 식품의 원재료·알레르기 표시를 확인합니다.",
        "quote": "requiring companies to list ingredients on packaged foods and beverages."
      },
      {
        "id": "allergen-cross-contact",
        "text": "재료 제외만으로 알레르겐 교차 접촉을 배제할 수 없습니다.",
        "quote": "allergen cross-contact (the inadvertent introduction of a major food allergen into a product)"
      }
    ],
    "verificationNote": "공식 본문을 직접 읽고 아래 제한된 주장과 일치하는 내용을 확인했습니다. 이 앱의 메뉴 전체나 개인별 처방에 대한 전문가 검수를 뜻하지 않습니다.",
    "pageDate": "2026-03-11",
    "pageDateLabel": "Content current as of",
    "limitation": "미국 FDA 안내입니다. 대한민국 표시법 준수나 개별 제품·조리 환경의 안전 인증을 뜻하지 않습니다."
  }
];

const allergyRules = [
  ['milk', '우유', ['milk', 'dairy', '우유', '유제품']],
  ['egg', '달걀', ['egg', 'eggs', '달걀', '계란', '난류']],
  ['wheat', '밀', ['wheat', '밀', '밀가루']],
  ['soy', '대두', ['soy', 'soya', 'soybean', '대두', '콩']],
  ['peanut', '땅콩', ['peanut', 'peanuts', '땅콩']],
  ['tree-nut', '견과류', ['tree-nut', 'tree nuts', 'treenut', '견과류', '아몬드', '호두', '캐슈넛', '잣']],
  ['fish', '생선', ['fish', '생선', '어류', '고등어', '연어', '대구']],
  ['shellfish', '갑각류·조개류', ['shellfish', '갑각류', '조개류', '갑각류·조개류', '새우', '게', '조개', '해산물']],
];
const compact = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').map(compact).filter(Boolean) : [];
const food = (id, label, category, allergens = [], animal = false) => ({ id, label, category, allergens, animal });
const foods = {
  rice: food('rice', '밥', '주식'), potato: food('potato', '찐 감자', '주식'), sweetPotato: food('sweetPotato', '찐 고구마', '주식'), corn: food('corn', '삶은 옥수수', '주식'),
  chicken: food('chicken', '양념 없이 익힌 닭고기', '단백질', [], true), beef: food('beef', '양념 없이 익힌 소고기', '단백질', [], true), pork: food('pork', '양념 없이 익힌 돼지고기', '단백질', [], true),
  egg: food('egg', '완전히 익힌 달걀', '단백질', ['egg'], true), tofu: food('tofu', '원재료를 확인한 두부', '단백질', ['soy']), fish: food('fish', '가시를 제거해 익힌 흰살생선', '단백질', ['fish'], true), lentil: food('lentil', '충분히 익힌 렌틸콩', '단백질'),
  carrot: food('carrot', '익힌 당근', '채소'), broccoli: food('broccoli', '데친 브로콜리', '채소'), cucumber: food('cucumber', '씻은 오이', '채소'), cabbage: food('cabbage', '익힌 양배추', '채소'), zucchini: food('zucchini', '익힌 애호박', '채소'),
  banana: food('banana', '바나나', '과일'), apple: food('apple', '씻은 사과', '과일'), orange: food('orange', '귤', '과일'), pear: food('pear', '씻은 배', '과일'),
  milk: food('milk', '우유', '칼슘 식품', ['milk'], true), yogurt: food('yogurt', '원재료를 확인한 무가당 플레인 요거트', '칼슘 식품', ['milk'], true),
};
const weekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
const safeDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
};
const koreaToday = () => new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());

function preferences(profile = {}) {
  const allergies = strings(profile.allergies).filter(value => !['none', '없음', '알레르기 없음'].includes(value));
  const restrictions = strings(profile.dietaryRestrictions);
  const excluded = new Set();
  const unknown = [];
  for (const allergy of allergies) {
    const rule = allergyRules.find(([id, label, aliases]) => id === allergy || compact(label) === allergy || aliases.includes(allergy));
    if (rule) excluded.add(rule[0]); else unknown.push(allergy);
  }
  const vegan = restrictions.some(value => /^(vegan|비건|완전 채식|완전채식)$/.test(value));
  const vegetarian = vegan || restrictions.some(value => /^(vegetarian|채식|채식주의|락토오보)$/.test(value));
  if (restrictions.some(value => /gluten|글루텐/.test(value))) excluded.add('wheat');
  if (restrictions.some(value => /lactose|유당|유제품 제외|우유 제외/.test(value))) excluded.add('milk');
  const noPork = restrictions.some(value => /pork|돼지|할랄|halal/.test(value));
  const noBeef = restrictions.some(value => /beef|소고기 제외|쇠고기 제외/.test(value));
  const knownRestriction = value => /^(vegan|비건|완전 채식|완전채식|vegetarian|채식|채식주의|락토오보|없음|none|일반식)$/.test(value) || /gluten|글루텐|lactose|유당|유제품 제외|우유 제외|pork|돼지|할랄|halal|beef|소고기 제외|쇠고기 제외/.test(value);
  const medical = profile.severeAllergies === true || profile.medicalDiet === true || restrictions.some(value => !knownRestriction(value));
  const requiresProfessional = medical || unknown.length > 0;
  const allowed = item => !item.allergens.some(id => excluded.has(id)) && !(vegan && item.animal) && !(vegetarian && ['chicken', 'beef', 'pork', 'fish'].includes(item.id)) && !(noPork && item.id === 'pork') && !(noBeef && item.id === 'beef') && !(excluded.has('soy') && item.id === 'lentil');
  return { allergies, restrictions, excluded, unknown, vegan, vegetarian, noPork, noBeef, requiresProfessional, allowed, liked: strings(profile.likedFoods), schoolLunch: profile.schoolLunch === true };
}

function meal(when, title, ingredients, role, prep, alternatives) {
  return { when, title, items: ingredients.map(item => item.label), role, prep, alternatives: alternatives.map(item => item.label), ingredients: ingredients.map(item => ({id: item.id, label: item.label, category: item.category, allergens: [...item.allergens]})) };
}

function trainingAdvice(profile) {
  const time = typeof profile.trainingTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(profile.trainingTime) ? profile.trainingTime : null;
  return {
    title: time ? `${time} 훈련이 있는 날에는 이렇게 조절해요` : '훈련이 있는 날에만 적용해요',
    before: '훈련 직전 큰 식사를 몰아 먹지 않아요. 소화할 여유가 있을 때 평소 식사를 하고, 출출하면 익숙한 주식이나 과일을 가볍게 선택해요.',
    after: '훈련 뒤에는 무리하게 버티지 말고, 다음 식사에서 주식·단백질 식품·채소를 함께 먹어요. 식사까지 시간이 길면 아래 간식을 활용해요.',
    note: '훈련 시각·강도와 개인 소화 상태가 달라 정확한 섭취 시각이나 양을 일률적으로 정하지 않아요.',
  };
}

export function buildWeekMeals(profile = {}, { startDate } = {}) {
  if (!profile || typeof profile !== 'object') profile = {};
  const first = safeDate(startDate) || safeDate(koreaToday());
  const pref = preferences(profile);
  const assumptions = [];
  if (!Array.isArray(profile.allergies)) assumptions.push('알레르기 정보가 없어 일반 식사 예시를 보여드려요. 알레르기 없음이 확인된 것은 아니에요.');
  if (!Array.isArray(profile.dietaryRestrictions)) assumptions.push('치료식·식이 제한 정보가 입력되지 않았어요.');
  if (!Array.isArray(profile.likedFoods) || profile.likedFoods.length === 0) assumptions.push('선호 음식 정보가 없어 다양한 기본 식품을 번갈아 배치했어요.');
  if (typeof profile.schoolLunch !== 'boolean') assumptions.push('급식 여부가 없어 집에서 준비하는 점심 예시를 보여드려요.');
  if (!profile.trainingTime) assumptions.push('훈련 시간이 없어 식사 시간을 고정하지 않았어요. 훈련 안내는 실제 훈련이 있는 날에만 적용해요.');
  if (startDate !== undefined && !safeDate(startDate)) assumptions.push('시작 날짜를 읽을 수 없어 한국 날짜 기준 오늘부터 구성했어요.');
  const age = Number(profile.age);
  if (!Number.isInteger(age) || age < 5 || age > 18) assumptions.push('나이가 없거나 범위를 벗어나 유소년 공통 식사 틀을 사용했어요.');

  const proteins = ['chicken', 'tofu', 'egg', 'beef', 'fish', 'lentil', 'pork'].map(id => foods[id]).filter(pref.allowed);
  const score = item => pref.liked.some(like => item.label.includes(like) || like.includes(item.label.replace(/.*익힌 |.*확인한 /g, '')) || item.id === like) ? -1 : 0;
  proteins.sort((a, b) => score(a) - score(b));
  const staples = ['rice', 'potato', 'sweetPotato', 'corn'].map(id => foods[id]).filter(pref.allowed).sort((a, b) => score(a) - score(b));
  const vegetables = ['broccoli', 'carrot', 'cabbage', 'zucchini', 'cucumber'].map(id => foods[id]).filter(pref.allowed).sort((a, b) => score(a) - score(b));
  const fruits = ['banana', 'apple', 'orange', 'pear'].map(id => foods[id]).filter(pref.allowed).sort((a, b) => score(a) - score(b));
  const dairy = ['yogurt', 'milk'].map(id => foods[id]).filter(pref.allowed).sort((a, b) => score(a) - score(b));
  const pick = (list, i) => list[((i % list.length) + list.length) % list.length];
  const trainingTiming = trainingAdvice(profile);
  const days = Array.from({length: 7}, (_, i) => {
    const date = new Date(first); date.setUTCDate(first.getUTCDate() + i);
    const weekday = weekdays[date.getUTCDay()];
    const stamp = date.toISOString().slice(0, 10);
    const day = { date: stamp, weekday, label: `${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일 ${weekday}`, trainingTiming };
    if (pref.requiresProfessional || proteins.length === 0) {
      for (const [key, when] of [['breakfast', '아침'], ['lunch', '점심'], ['dinner', '저녁'], ['snack', '필요할 때 간식']]) {
        day[key] = {when, title: '개별 식사 확인이 먼저예요', items: [], role: '기존에 안전하게 먹어온 식사를 보호자와 확인해요.', prep: '중증 알레르기·치료식·인식하지 못한 제한 조건은 자동 식단을 제안하지 않아요. 담당 의료진·영양 전문가의 기존 지침을 따라요.', alternatives: [], ingredients: []};
      }
    } else {
      const p = pick(proteins, i), p2 = pick(proteins, i + 2), p3 = pick(proteins, i + 4);
      const v = pick(vegetables, i), v2 = pick(vegetables, i + 1), fruit = pick(fruits, i);
      const breakfastItems = [pick(staples, i), p, fruit];
      day.breakfast = meal('아침 · 등교 전 여유 있게', `${breakfastItems[0].label}과 ${p.label}`, breakfastItems, '밤사이 공복을 마치고 오전 활동에 쓸 에너지와 단백질을 함께 챙겨요.', '전날 주식을 준비하고 고기·달걀은 충분히 익혀요. 입맛이 적으면 편하게 먹을 수 있는 만큼 나눠요.', [pick(staples, i + 1), pick(fruits, i + 1)]);
      const lunchItems = [foods.rice, p2, v];
      const school = pref.schoolLunch && date.getUTCDay() >= 1 && date.getUTCDay() <= 5;
      day.lunch = meal('점심 · 학교 또는 집', school ? '학교 급식 · 당일 식단표 확인' : `밥·${p2.label}·${v.label}`, school ? [] : lunchItems, '주식·단백질 식품·채소를 골고루 먹는 기회로 삼아요.', school ? '학교의 당일 메뉴와 알레르기 표시를 보호자·영양교사와 확인해요. 이 앱은 실제 급식 메뉴를 알지 못해요. 확인되지 않은 메뉴를 안전하다고 판단하지 않아요.' : '간장·육수·소스 없이 기본 재료로 조리해요. 양념을 더할 때는 모든 성분과 알레르기 표시를 확인해요.', school ? [] : [pick(staples, i + 2), pick(vegetables, i + 2)]);
      if (school) day.lunch.complement = '급식에서 부족했던 식품군을 저녁에 보완해요. 먹은 양을 벌충하려고 억지로 먹이지 않아요.';
      day.dinner = meal('저녁 · 가족 일정에 맞춰', `밥·${p3.label}·${v2.label}`, [foods.rice, p3, v2, fruit], '활동 후 회복과 다음 날 성장을 위해 다양한 식품군을 이어가요.', '식사량은 배고픔과 포만감에 맞춰 조절해요. 고기·생선은 충분히 익히고 뼈·가시를 확인해요.', [pick(staples, i + 3), pick(vegetables, i + 3)]);
      const snackProtein = dairy.length ? pick(dairy, i) : pick(proteins, i + 1);
      day.snack = meal('간식 · 출출하거나 식사 간격이 길 때', `${fruit.label}와 ${snackProtein.label}`, [fruit, snackProtein], '식사를 대신하기보다 긴 식사 간격을 편안하게 연결해요.', '훈련 직전에는 소화가 편한 익숙한 음식으로 조절해요. 유제품·익힌 식품은 냉장 보관하고 이동 때 보냉해요.', [pick(staples, i + 1), pick(fruits, i + 2)]);
    }
    day.meals = [day.breakfast, day.lunch, day.dinner, day.snack];
    return day;
  });
  const shopping = new Map();
  for (const day of days) for (const item of day.meals.flatMap(item => item.ingredients)) {
    if (!shopping.has(item.category)) shopping.set(item.category, new Set());
    shopping.get(item.category).add(item.label);
  }
  const excludedLabels = allergyRules.filter(([id]) => pref.excluded.has(id)).map(([, label]) => label);
  const notices = [
    '성장기 일반 식사 예시예요. 칼로리 제한·체중 감량·보충제·에너지 음료를 제안하지 않아요. 식사량은 배고픔·포만감과 기존 지침에 맞춰 조절해요.',
    '개별 의료·영양 처방이나 전문가가 검토한 맞춤 식단이 아니에요. 지속적인 피로, 성장·식사 문제, 만성질환이나 중증 알레르기는 적절한 전문가와 상의해요.',
    '포장 제품·양념·육수·학교 급식은 숨은 성분과 교차 접촉을 확인해요. 같은 제조시설·조리도구 정보까지 보호자가 확인하며, 앱이 알레르기 안전을 보장하지 않아요.',
    '수면·수분·다양한 식품군·성분 표시 안내는 확인한 공식 본문에 연결했어요. 문서별 표시일과 확인 범위가 다르고, 미확인 자료도 있으니 아래 출처 상태를 함께 봐 주세요.',
  ];
  if (excludedLabels.length) notices.unshift(`입력한 ${excludedLabels.join('·')} 성분이 들어가는 기본 재료를 제외했어요. 대체 식품의 원재료·교차 접촉도 확인해야 해요.`);
  if (!dairy.length && !pref.requiresProfessional) notices.push('우유·유제품을 제외한 경우 칼슘 공급을 따로 살펴봐야 해요. 식물성 음료는 제품마다 영양 구성이 달라 같은 식품으로 간주하지 않으며, 안전한 공급원은 보호자·영양 전문가와 정해요.');
  if (pref.noPork) notices.push('돼지고기를 제외했지만 할랄 인증이나 개별 종교 규칙을 검증한 식단은 아니에요.');
  if (pref.requiresProfessional) notices.unshift('입력된 제한 조건은 자동 식사 제안 범위를 벗어나 구체적인 메뉴를 생성하지 않았어요. 기존에 확인된 식사 지침을 담당 전문가와 검토해요.');
  if (pref.unknown.length) notices.unshift(`자동 분류하지 못한 알레르기: ${pref.unknown.join(', ')}. 이를 알레르기 없음으로 취급하지 않았어요.`);
  return {
    startDate: days[0].date, endDate: days[6].date, days,
    shoppingList: [...shopping].map(([category, items]) => ({category, items: [...items]})),
    trainingTiming,
    hydration: {title: '물은 하루 동안, 훈련 중에도 규칙적으로', items: ['등교·식사·훈련 전후에 물을 마실 기회를 만들고 물병을 준비해요.', '더운 날과 활동량이 많은 날에는 자주 쉬며 수분 상태를 확인해요. 개인에게 정확한 mL를 일률적으로 처방하지 않아요.', '어지럼·심한 두통·구역감·비정상적인 무기력 등이 있으면 활동을 멈추고 보호자·의료진의 도움을 받아요.', '갈증을 참거나 한꺼번에 과하게 마시도록 강요하지 않아요.']},
    schoolLunchComplements: ['급식 메뉴는 앱이 자동으로 알 수 없어요. 학교가 제공하는 당일 식단과 알레르기 정보를 먼저 확인해요.', '단백질 식품·채소·과일 중 덜 먹은 식품군을 저녁이나 간식에서 편하게 보완해요.', '알레르기나 치료식이 있으면 학교 영양교사와 대체식·조리도구 분리 방식을 미리 정해요.'],
    convenienceEating: ['외식·편의점에서는 원재료·양념·육수·알레르기 표시와 교차 접촉을 확인할 수 있는 메뉴만 선택해요.', '확인이 어려운 조리식품은 안전하다고 추정하지 말고 집에서 준비한 확인된 음식과 물을 활용해요.', '가능한 한 주식과 단백질 식품을 함께 고르고, 과일·채소는 가능한 식사에서 이어가요. 브랜드나 특정 제품의 안전을 보장하지 않아요.'],
    assumptions, notices, sources: nutritionSources.map(source => structuredClone(source)), contentVersion: nutritionContentVersion, reviewStatus: { ...nutritionReviewStatus }, requiresProfessional: pref.requiresProfessional,
    allergyLabels: excludedLabels, profileSummary: {age: Number.isInteger(age) ? age : null, schoolLunch: pref.schoolLunch, vegetarian: pref.vegetarian, vegan: pref.vegan},
  };
}

export function getDailyMeals(profile = {}, date) {
  return buildWeekMeals(profile, {startDate: date}).days[0];
}
