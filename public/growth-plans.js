import { SKILLS } from './domain.js';
import { addDays, getWeekday, isDate, kstToday, weekdayLabel, validateTarget } from './growth-domain.js';

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const PRACTICE_MINUTES = 15;
const WEEK_STAGES = ['편한 속도로 순서 익히기', '신호를 보고 방향 고르기', '가벼운 선택을 더하기', '경기 행동과 연결해 돌아보기'];
const SLEEP_SOURCE = { verifiedDate:'2026-10-16', checkedDate:'2026-10-16', screenSource:{title:'AAP · Healthy Sleep Habits',url:'https://www.healthychildren.org/English/healthy-living/sleep/Pages/healthy-sleep-habits-how-many-hours-does-your-child-need.aspx',updatedDate:'2026-08-07',verifiedDate:'2026-10-16'}, title: 'CDC · About Sleep', url: 'https://www.cdc.gov/sleep/about/index.html', detail: '3~5세는 하루 10~13시간, 6~12세는 9~12시간, 13~17세는 8~10시간, 성인은 7시간 이상의 수면을 권장합니다.' };
const GENERAL_NOTE = '아직 영상 근거가 없어 일반 기초 연습을 제안해요. 선수의 약점이나 능력 판정이 아닙니다.';
const LOAD_NOTE = '팀 훈련·경기 날에는 추가 개인 훈련을 넣지 않아요. 놓친 훈련을 다음 날 몰아서 하지 않습니다.';
const clockNumber = (text, fallback) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text || '') ? Number(text.slice(0, 2)) * 60 + Number(text.slice(3)) : fallback;
const clock = value => `${String(Math.floor(((value % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((value % 60) + 60) % 60).padStart(2, '0')}`;
const days = value => [...new Set((Array.isArray(value) ? value : []).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))];
const calendarWeek = date => addDays(date, -((getWeekday(date) + 6) % 7));
const labelFor = skill => SKILLS.find(item => item.id === skill)?.name || '기초 볼 감각';

const EXERCISES = {
  touch: {
    title: '첫 터치로 작은 문 옆에 공 놓기', equipment: ['축구공', '양말 표식 4개'], space: '미끄럽지 않은 2×3m 공간',
    setup: '양말 두 개씩을 60cm 간격의 문으로 놓아요. 왼쪽·오른쪽 문은 1m 떨어뜨리고, 공이 굴러가도 사람·물건과 부딪히지 않게 해요.',
    main: ['발바닥으로 공을 30cm 앞에 굴린 뒤 발 안쪽으로 멈춰요. 몸에서 한 걸음 이내에 두고 왼발·오른발을 번갈아 써요.', '패스를 받는다고 생각하며 공을 굴리고, 왼쪽 문 옆으로 첫 터치한 뒤 멈춰요. 다음에는 오른쪽으로 바꿔요.', '공을 놓기 전 갈 방향을 보고, 첫 터치 뒤 두 걸음 이동해 다음 패스 자세로 서요. 빠르게 하기보다 균형을 확인해요.'],
    mistakes: [{ mistake: '첫 터치가 멀리 튀어요.', fix: '굴리는 힘과 터치 크기를 줄이고 한 걸음 안에서 다시 시작해요.' }, { mistake: '공만 보느라 몸이 굳어요.', fix: '공이 오기 전 목표 표식을 한 번 보고 무릎을 편하게 굽혀요.' }],
    solo: '파트너가 없으면 직접 공을 굴려 받아요. 불규칙한 패스를 받는 훈련을 대신하는 것은 아니에요.',
    parent: '처음 2분만 표식 간격을 함께 정하고 “다음에 움직이기 편했어?”라고 물어요. 매번 자세를 고쳐 말하지 않아요.',
    success: '마지막 10번 중 공을 한 걸음 안에 놓은 횟수와 편했던 방향을 적어요. 횟수 달성보다 첫날과의 변화를 봐요.',
    easier: '문을 넓히고 공을 더 느리게 굴려요.', harder: '같은 시간 안에서 고개를 들어 목표를 확인한 뒤 방향을 골라요. 속도·횟수는 늘리지 않아요.',
  },
  pass: {
    title: '작은 문으로 받기 편한 패스 보내기', equipment: ['축구공', '양말 표식 2개'], space: '2×4m의 안전한 공간',
    setup: '표식 두 개를 80cm 간격으로 놓고 2m 뒤에 서요. 실내에서는 강하게 차지 말고 바닥으로 부드럽게 굴려요.',
    main: ['지지 발을 문 쪽으로 놓고 발 안쪽으로 공을 굴려 문 사이로 보내요. 공을 멈춘 다음 매번 자세를 새로 잡아요.', '파트너가 있으면 2~3m 거리에서 발 앞에 멈출 정도의 힘으로 보내요. 혼자면 문 뒤의 정지 구역에 공을 멈추는 것을 목표로 해요.', '패스 전 목표를 보고, 패스 뒤 받을 자리로 두 걸음 움직여요. 공을 찾으러 뛰지 않고 천천히 돌아와 다시 해요.'],
    mistakes: [{ mistake: '공이 옆으로 새요.', fix: '지지 발과 발 안쪽이 문을 향하는지 먼저 확인해요.' }, { mistake: '힘이 너무 세요.', fix: '거리를 줄이고 발을 크게 휘두르지 않아요. 파트너에게 편한 힘인지 물어요.' }],
    solo: '공이 멈출 작은 구역을 정해 패스 강도를 확인해요. 안전한 벽 사용이 허락된 경우에만 벽 패스를 해요.',
    parent: '가능하면 3분 동안 받아주고 “어느 패스가 받기 편했어?”라고 서로 말해요. 성공 횟수로 다른 아이와 비교하지 않아요.',
    success: '10번 중 문을 통과한 횟수와 편한 강도로 멈춘 횟수를 따로 적어요.',
    easier: '문을 1m로 넓히거나 거리를 1m 줄여요.', harder: '시간은 그대로 두고, 패스 전에 받을 위치를 확인한 뒤 다른 발로도 천천히 시도해요.',
  },
  dribble: {
    title: '천천히 공을 지키며 빈 문 찾기', equipment: ['축구공', '양말 표식 4개'], space: '2×3m의 안전한 공간',
    setup: '좌우에 80cm 폭의 문을 만들어요. 뛰지 않고 걸어서 방향을 바꿀 수 있게 주변을 비워요.',
    main: ['걸으면서 발 안쪽·바깥쪽으로 작은 터치를 해요. 두세 번 움직인 뒤 발바닥으로 공을 멈춰요.', '출발 전 왼쪽·오른쪽 문을 보고 하나를 정해 통과해요. 공이 한 걸음보다 멀어지면 멈추고 터치를 줄여요.', '문 앞에서 방향을 한 번 바꿔 반대 문으로 이동해요. 파트너가 있으면 멀리 서서 손으로 닫힌 문을 알려줘요.'],
    mistakes: [{ mistake: '발이 공을 쫓아가요.', fix: '보폭과 터치를 줄이고 걸어서 해요.' }, { mistake: '고개를 계속 숙여요.', fix: '공을 멈춘 뒤 목표를 보고 다시 움직여요. 움직이며 보기로 천천히 연결해요.' }],
    solo: '각 문에 색이나 번호를 붙여 출발 전 고르고 말해요. 혼자 정한 신호는 실제 상대 판단 연습과 다르다는 점을 기억해요.',
    parent: '2~3분만 문을 가리켜주되 몸으로 길을 막거나 공을 빼앗지 않아요.',
    success: '속도 대신 목표 문까지 공을 가까이 유지한 3번을 기억하고 선택 이유를 말해요.',
    easier: '문 하나와 직선 이동부터 해요.', harder: '같은 시간 안에서 출발 직전에 문을 정하고, 막힌 길이면 멈춘 뒤 다른 쪽을 골라요.',
  },
  shoot: {
    title: '목표를 보고 균형 있게 마무리하기', equipment: ['축구공', '표식 2개'], space: '사람이 없는 안전한 야외와 고정된 목표물',
    setup: '주변 출입과 골대 고정 상태를 보호자가 확인해요. 3m 앞에 넓은 목표를 정해요. 실내에서는 슈팅 대신 문으로 공 굴리기를 해요.',
    main: ['공 없이 지지 발을 목표 쪽에 놓고 차는 발을 작게 움직인 뒤 두 발로 균형을 잡아요. 뛰거나 세게 차지 않아요.', '멈춘 공을 목표로 부드럽게 보내요. 차기 전에 목표를 보고, 차고 나서 몸이 넘어가지 않는지 확인해요.', '공을 30cm 굴려 첫 터치로 준비한 뒤 목표로 보내요. 공을 가지러 갈 때 다른 사람의 슈팅이 끝났는지 확인해요.'],
    mistakes: [{ mistake: '힘을 주다 균형을 잃어요.', fix: '힘을 낮추고 차고 난 뒤 편하게 서는 동작부터 다시 해요.' }, { mistake: '목표를 보지 않고 차요.', fix: '공이 멈췄을 때 목표를 먼저 확인하고 시작해요.' }],
    solo: '보호자가 안전을 확인한 야외에서만 해요. 적당한 공간이 없으면 패스 문 통과 연습으로 대체하고 강한 슈팅을 하지 않아요.',
    parent: '공을 회수할 순서를 정해주고 힘보다 안전한 방향과 균형을 칭찬해요.',
    success: '골 수보다 목표를 먼저 보고 균형 있게 마친 시도 3개를 골라요.',
    easier: '정지한 공과 넓은 목표를 사용해요.', harder: '시간과 힘은 그대로 두고 첫 터치 후 목표를 확인하는 순서를 더해요.',
  },
  defend: {
    title: '달려들지 않고 전진 길 지키기', equipment: ['표식 3개'], space: '미끄럽지 않은 2×3m 공간',
    setup: '뒤에 지킬 문을 만들고 1.5m 앞에 출발 표식을 놓아요. 태클·몸싸움 없이 걸어서만 진행해요.',
    main: ['무릎을 편하게 굽히고 작은 옆걸음으로 왼쪽·오른쪽 표식 사이를 이동해요. 발을 크게 교차하지 않아요.', '상대가 있다고 생각하며 문과 출발 표식 사이에 서요. 한쪽으로 두 걸음 갔다가 상대와 문 사이로 돌아와요.', '파트너가 있으면 1.5m 떨어져 천천히 걷고 문을 지키는 사람이 함께 움직여요. 공을 빼앗으려 발을 뻗지 않아요.'],
    mistakes: [{ mistake: '너무 가까이 달려들어요.', fix: '한 번 멈춘 뒤 팔을 뻗어도 닿지 않을 거리를 만들어요.' }, { mistake: '공만 따라가 뒤 문을 놓쳐요.', fix: '자신·상대·문 위치를 번갈아 확인해요.' }],
    solo: '표식을 상대 위치로 생각하며 문과 표식 사이로 이동해요. 실제 상대 대응 연습은 팀 훈련에서 확인해요.',
    parent: '천천히 걷는 상대 역할만 해요. 속임 동작으로 이기려 하거나 접촉하지 않아요.',
    success: '문 앞 위치를 유지한 순간 3개와 거리가 어려웠던 순간 하나를 말해요.',
    easier: '공 없이 좌우 한 걸음부터 해요.', harder: '같은 시간 동안 파트너가 방향을 불규칙하게 바꾸되 걷는 속도와 안전 거리를 유지해요.',
  },
  scan: {
    title: '받기 전 보고, 공을 멈춘 뒤 선택하기', equipment: ['축구공', '색이 다른 표식 2개'], space: '2×3m의 미끄럽지 않은 공간',
    setup: '왼쪽 뒤와 오른쪽 뒤에 색이 다른 양말을 두어요. 목을 과하게 돌리지 않고 어깨 너머로 확인할 위치를 정해요.',
    main: ['공을 발 앞에 멈추고 왼쪽 어깨 너머 표식 색을 말한 뒤 공을 30cm 굴려 멈춰요. 다음에는 오른쪽을 확인해요.', '주변 확인 → 공 보기 → 첫 터치 순서로 이어가요. 공이 멀어지면 멈춰서 다시 시작해요.', '부모가 있으면 공을 느리게 굴려주기 전에 표식을 하나 들어줘요. 색을 말한 뒤 공을 받아 같은 쪽 빈 공간에 놓아요.'],
    mistakes: [{ mistake: '확인하다 공을 놓쳐요.', fix: '공의 속도와 확인 범위를 줄여요. 멈춘 공에서 순서를 먼저 익혀요.' }, { mistake: '고개만 돌리고 무엇을 봤는지 몰라요.', fix: '색 하나나 빈 공간 하나를 말하고 나서 받아요.' }],
    solo: '양쪽 표식을 번갈아 확인하며 순서를 익혀요. 혼자 하는 규칙 연습은 실제 경기 판단을 측정하지 않아요.',
    parent: '3분만 느린 공과 색 신호를 보내요. “왜 못 봤어?” 대신 “어느 쪽이 보였어?”라고 물어요.',
    success: '마지막 10번 중 받기 전에 색을 확인한 횟수를 적어요. 고개 돌린 횟수만으로 경기 판단력을 단정하지 않아요.',
    easier: '공을 멈춘 상태에서 한쪽 표식만 확인해요.', harder: '같은 시간 안에서 색을 본 뒤 첫 터치 방향을 고르는 동작을 연결해요.',
  },
  move: {
    title: '패스한 뒤 다시 받을 자리 만들기', equipment: ['축구공', '표식 3개'], space: '2×3m의 안전한 공간',
    setup: '표식 세 개로 삼각형을 만들어요. 중앙에는 가상의 수비 표식을 두고 공과 자신 사이 길을 확인해요.',
    main: ['표식에서 공을 부드럽게 굴려 보낸 뒤 옆 표식으로 두 걸음 움직여 다시 받을 자세로 서요.', '중앙 수비 표식 뒤에 숨지 않도록 좌우로 한 걸음 옮겨 공과 내 발 사이 길이 보이게 해요.', '파트너가 있으면 패스 후 서로 다른 표식으로 이동하고 다시 연결해요. 같은 곳에 몰리면 멈추고 거리를 넓혀요.'],
    mistakes: [{ mistake: '패스한 자리에 계속 서 있어요.', fix: '패스 뒤 한 번 목표 위치를 보고 두 걸음 움직이는 순서를 말해요.' }, { mistake: '공 쪽으로만 다가가요.', fix: '공과 자신 사이 길이 열리는 옆 공간도 찾아요.' }],
    solo: '공을 굴려 놓고 빈자리로 이동한 뒤 공과 표식 사이의 길을 확인해요. 실제 동료의 선택은 팀 훈련에서 연결해요.',
    parent: '받아줄 때 “어디에 있으면 다시 줄 수 있을까?”라고 묻고 아이가 자리를 고르게 해요.',
    success: '패스 뒤 다시 받을 자리를 만든 시도 3개와 그 자리를 고른 이유를 말해요.',
    easier: '공 없이 표식 사이 걷기부터 해요.', harder: '시간은 그대로 두고 파트너 위치가 바뀔 때 다른 받을 각도를 골라요.',
  },
  team: {
    title: '도움 신호와 실수 뒤 다음 행동 정하기', equipment: ['축구공', '표식 2개'], space: '2×3m의 안전한 공간',
    setup: '“여기”, “천천히”처럼 서로 이해하는 짧은 신호 하나를 정해요. 실수하면 할 행동도 “멈추고 다시 받을 자리로”처럼 정해요.',
    main: ['파트너가 있으면 이름이나 방향 신호를 한 번 보내고 부드럽게 공을 주고받아요. 혼자라면 신호를 말한 뒤 공을 굴리고 다시 받아요.', '일부러 실패를 만들지 말고 공을 놓쳤을 때 숨을 편하게 내쉰 뒤 “다음 공”이라고 말하고 자리로 돌아와요.', '끝나기 전 서로 도움 된 신호 하나를 말해요. 경기에서 실수 뒤 할 수 있는 행동을 아이가 하나 골라요.'],
    mistakes: [{ mistake: '실수 뒤 자신을 나쁘게 말해요.', fix: '평가 대신 “이번 공은 멀었네, 다음엔 작게”처럼 행동을 표현해요.' }, { mistake: '부모가 신호를 계속 지시해요.', fix: '아이가 정한 신호를 사용하고 잠깐 기다려요.' }],
    solo: '멈추기 → 숨 내쉬기 → 다음 받을 자리로 이동 순서를 연습해요. 조용한 행동만으로 성격이나 멘탈을 평가하지 않아요.',
    parent: '“왜 실수했어?” 대신 “다음 공에서는 어떤 행동을 해볼래?”라고 물어요. 답을 정해주지 않아요.',
    success: '실수를 없애는 대신 다음 행동으로 돌아온 순간 하나와 도움이 된 말 하나를 적어요.',
    easier: '공 없이 다음 행동 문장과 위치 이동만 해요.', harder: '같은 시간에 파트너와 신호를 주고받고 서로 도움이 된 행동을 구체적으로 말해요.',
  },
};

function matchingVideo(workspace, videoId) {
  const video = (workspace.videos || []).find(item => item.id === videoId);
  if (!video) return false;
  if (!video.target) return true; // Earlier human records did not contain a target snapshot.
  try {
    const a = validateTarget(video.target), b = validateTarget(workspace.profile || workspace.player);
    return a.kit === b.kit && a.number === b.number && a.age === b.age;
  } catch { return false; }
}

/** Only observed focus evidence chooses a practice. No absent skill is scored. */
export function deriveGrowthPriorities(workspace = {}) {
  const buckets = new Map();
  const add = (entry, source, videoId) => {
    if (!SKILLS.some(skill => skill.id === entry.skill)) return;
    const item = buckets.get(entry.skill) || { skill: entry.skill, label: labelFor(entry.skill), sourceCount: 0, weight: 0, evidence: [] };
    item.sourceCount++; item.weight += source === 'human' ? 2 : entry.confidence === 'high' ? 1.5 : 1;
    item.evidence.push({ source, videoId, time: entry.time ?? null, note: entry.note || '직접 기록한 행동 평가', confidence: entry.confidence || 'human' });
    buckets.set(entry.skill, item);
  };
  for (const entry of workspace.observations || []) {
    if (matchingVideo(workspace, entry.videoId) && (entry.type === 'focus' || (typeof entry.rating === 'number' && entry.rating >= 1 && entry.rating <= 2))) add(entry, 'human', entry.videoId);
  }
  for (const analysis of workspace.analyses || []) {
    if (!analysis.result?.identified || !matchingVideo(workspace, analysis.videoId)) continue;
    for (const entry of analysis.result.observations || []) {
      if (entry.type === 'focus' && ['medium', 'high'].includes(entry.confidence)) add(entry, 'ai', analysis.videoId);
    }
  }
  return [...buckets.values()].sort((a, b) => b.weight - a.weight || SKILLS.findIndex(skill => skill.id === a.skill) - SKILLS.findIndex(skill => skill.id === b.skill));
}

function makeTask(profile, date, week, session, priority) {
  const skill = priority?.skill || 'touch';
  const base = EXERCISES[skill];
  const general = !priority;
  const indoor = /실내|방|거실/.test(profile.space || '작은 실내');
  const noPartner = Number(profile.helperMinutes ?? 15) < 3;
  const hasBall = !Array.isArray(profile.equipment) || profile.equipment.some(item => /공|ball/i.test(item));
  let title = general ? '일반 기초 · 공과 친해지는 15분' : base.title;
  let reason = general ? GENERAL_NOTE : `${labelFor(skill)}에서 확인한 ${priority.sourceCount}개 관찰을 연습 목표로 연결했어요. 영상에서 확인된 행동에 대한 제안이며 진단·전체 능력 판정이 아닙니다.`;
  const quality = week === 1 ? '편안한 속도와 작은 동작으로 순서만 익혀요.' : week === 2 ? '시간과 횟수는 그대로 두고, 터치 전에 목표를 한 번 확인해요.' : week === 3 ? '동작이 편할 때만 방향을 하나 선택해요. 어려우면 첫 주 방식으로 돌아가요.' : '시간을 늘리지 않고 가장 편해진 동작을 반복해요. 마지막에는 경기에서 시도할 행동 하나를 말해요.';
  const mainTexts = [...base.main];
  if (skill === 'shoot' && indoor) {
    mainTexts[0] = '안전한 실내에서는 강하게 차지 않아요. 공 없이 지지 발 방향과 차고 난 뒤 균형을 확인해요.';
    mainTexts[1] = '표식 문을 향해 발 안쪽으로 공을 부드럽게 굴려요. 슈팅 강도 훈련은 하지 않아요.';
    mainTexts[2] = '작은 첫 터치 뒤 목표를 보고 문으로 공을 굴려요. 야외 슈팅 연습을 대체하는 제한된 동작 연습입니다.';
  }
  if (!hasBall && skill !== 'defend') {
    title = '공 없는 기초 움직임 · 15분';
    reason += ' 공이 장비 목록에 없어 공 없는 동작으로 바꿨어요. 실제 볼 기술 연습과 동일한 효과를 주장하지 않습니다.';
    mainTexts.splice(0, 3,
      '공 없이 편하게 서서 왼쪽·오른쪽을 확인하고 두 걸음 이동해 균형을 잡아요.',
      '양말 표식 두 개 사이를 걸으며 갈 곳을 먼저 보고 방향을 바꿔요. 뛰거나 점프하지 않아요.',
      '공이 있다고 생각하며 주변 확인 → 작은 첫 동작 → 다음 위치로 이동 순서를 천천히 이어가요.');
  }
  return {
    id: `practice-${date}-${skill}`, title, skill, reason, minutes: PRACTICE_MINUTES,
    week, session, stage: WEEK_STAGES[week - 1], personalized: !general, generalAssumption: general,
    evidence: priority?.evidence || [], equipment: hasBall || skill === 'defend' ? [...base.equipment] : ['양말 표식 2개'], space: profile.space || base.space,
    setup: hasBall || skill === 'defend' ? base.setup : '바닥에 양말 두 개를 놓고 걸어서 두 걸음 이동할 공간을 비워요. 공과 파트너는 없어도 돼요.',
    warmup: [{ minutes: 1, text: '주변의 물건·미끄러운 바닥·통행을 확인하고 물과 필요한 도구를 준비해요.' }, { minutes: 1, text: '편하게 걸으며 발목과 어깨를 작은 범위로 움직여요. 아픈 동작은 하지 않아요.' }, { minutes: 1, text: hasBall ? '공을 발바닥으로 가볍게 멈추고 좌우로 굴려요. 숨이 편한 속도를 유지해요.' : '공 없이 발목을 편하게 움직이고 작은 옆걸음을 해요. 숨이 편한 속도를 유지해요.' }],
    main: mainTexts.map((text, index) => ({ minutes: 3, text: `${text} ${index === session % 3 ? quality : ''}`.trim(), sets: 2, reps: skill === 'team' ? '편안한 시도 3회' : '천천히 5회', rest: '세트 사이 30초, 남은 시간은 준비·물·동작 확인' })),
    cooldown: [{ minutes: 1, text: '공을 정리하고 천천히 걸으며 숨을 편하게 해요.' }, { minutes: 1, text: '물을 마시고 땀을 닦아요. 불편하거나 아픈 곳이 생겼는지 보호자에게 말해요.' }, { minutes: 1, text: '시도한 행동 하나와 다음에 편하게 바꿀 점 하나를 말하거나 기록해요.' }],
    steps: [`준비: ${hasBall || skill === 'defend' ? base.setup : '공 없이 양말 표식 두 개와 걸어서 이동할 공간을 준비해요.'}`, ...mainTexts.map((text, index) => `${index + 1}단계 · 3분: ${text}`), `이번 주: ${quality}`, '15분이 되면 끝내요. 못 채운 횟수와 놓친 날은 다음 날 보충하지 않아요.'],
    mistakes: !hasBall && skill !== 'defend' ? [{ mistake: '공이 없어서 동작을 빠르게 채우려 해요.', fix: '횟수 대신 주변 확인과 균형에 집중하고 걸어서 해요.' }, { mistake: '이 동작을 실제 볼 기술 평가로 생각해요.', fix: '공 없는 일반 움직임 연습이에요. 볼 기술은 공이 있을 때 별도로 관찰해요.' }] : base.mistakes.map(item => ({ ...item })), solo: hasBall || skill === 'defend' ? base.solo : '공·파트너 없이 걸어서 이동해요. 표식이 없으면 바닥의 안전한 위치 두 곳을 정해요.',
    parent: noPartner ? '혼자 연습하도록 설정되어 있어요. 보호자는 시작 전 공간만 확인하고, 파트너가 필요한 부분은 혼자 버전으로 진행해요.' : base.parent,
    success: hasBall || skill === 'defend' ? base.success : '갈 곳을 먼저 보고 균형 있게 멈춘 순간 3개를 기억해요. 공 없는 연습을 볼 기술 점수로 바꾸지 않아요.', easier: hasBall || skill === 'defend' ? base.easier : '제자리에서 목표를 보고 한 걸음 이동해요.', harder: hasBall || skill === 'defend' ? base.harder : '같은 시간 안에서 이동할 위치를 하나 더 골라요. 속도와 횟수는 늘리지 않아요.',
    stopRule: '통증·어지러움·심한 피로가 있으면 즉시 멈추고 보호자에게 알려요. 계속되거나 심하면 의료진에게 확인해요.',
  };
}

function sleepInfo(profile) {
  const age = Number(profile.age ?? 11), bed = clockNumber(profile.bedTime, 1260), wake = clockNumber(profile.wakeTime, 420);
  const hours = ((wake - bed + 1440) % 1440) / 60;
  const min = age <= 5 ? 10 : age <= 12 ? 9 : age <= 17 ? 8 : 7, max = age <= 5 ? 13 : age <= 12 ? 12 : age <= 17 ? 10 : 24;
  return { bedtime: clock(bed), wakeTime: clock(wake), hours, min, max, target: age >= 18 ? '7시간 이상' : `${min}~${max}시간`, withinTarget: hours >= min && hours <= max, source: { ...SLEEP_SOURCE }, note: hours >= min && hours <= max ? '설정한 취침·기상 시간은 연령별 권장 범위 안에 있어요. 실제 수면과 컨디션은 달라질 수 있어요.' : '설정한 취침·기상 시간으로는 권장 수면 범위를 벗어나요. 늦은 추가 훈련보다 수면 시간을 먼저 확보해요.' };
}

function mentalGuidance(day, checkin) {
  const resting = day.kind === 'rest';
  return {
    title: resting ? '쉬는 날도 성장하는 날이에요.' : '결과보다 오늘 해볼 행동 하나',
    child: checkin?.mood === 'low' ? '오늘 힘들었던 점을 말해도 괜찮아. 연습을 쉬거나 더 쉽게 바꿀 수 있어.' : resting ? '오늘 쉰다고 뒤처지는 건 아니야. 몸이 편해지는 일을 하나 골라보자.' : '오늘은 무엇을 한 번 시도해볼까? 실수하면 숨을 내쉬고 다음 행동 하나를 해보자.',
    parent: resting ? '“쉬어도 괜찮아. 오늘 몸은 어때?”라고 묻고 밀린 연습을 요구하지 않아요.' : '“잘했어?”보다 “어떤 시도를 해봤어?”라고 물어요. 아이가 답한 뒤 “그때 무엇이 보였어?”라고 한 번만 이어 물어요.',
    afterMistake: '멈추기 → 편하게 숨 내쉬기 → “다음 공”처럼 짧은 말 → 다시 도울 위치로 이동하기.',
    boundary: '영상이나 조용한 모습으로 성격·의지·정신건강을 판정하지 않아요. 걱정이 이어지면 보호자와 전문 도움을 구해요.',
  };
}

/** Timed school/day-off routine. Meal slots contain no nutritional prescription. */
export function buildDayRoutine(profile = {}, day = {}, checkin = null) {
  const date = isDate(day.date) ? day.date : kstToday();
  const schoolDay = getWeekday(date) >= 1 && getWeekday(date) <= 5;
  const wake = clockNumber(profile.wakeTime, 420), bed = clockNumber(profile.bedTime, 1260);
  const schoolStart = clockNumber(profile.schoolStart, 510), schoolEnd = clockNumber(profile.schoolEnd, 900);
  const winddown = Math.max(wake + 60, bed - 60), items = [];
  const add = (start, minutes, kind, title, detail) => { if (minutes > 0) items.push({ time: clock(start), end: clock(start + minutes), minutes, kind, title, detail }); };
  add(wake, 10, 'hygiene', '기상·물·몸 상태 확인', '커튼을 열고 화장실에 다녀와요. 수면·피로·통증을 확인하고 불편하면 보호자에게 말해요.');
  add(wake + 15, 20, 'meal', '아침 식사', '편하게 앉아 식사해요. 구체적인 식단은 오늘의 식사 카드에서 확인해요.');
  add(wake + 35, 15, 'hygiene', '양치·세수·옷 입기', '양치하고 활동하기 편한 옷을 입어요. 필요한 물과 준비물을 확인해요.');
  let freeStart;
  if (schoolDay) {
    const travel = Math.max(wake + 50, schoolStart - 30);
    add(travel, Math.min(30, Math.max(0, schoolStart - travel)), 'travel', '등교 준비·이동', '실제 이동 시간에 맞춰 조절해요. 식사·수면을 줄여 서두르지 않아요.');
    if (schoolEnd > schoolStart) {
      const lunch = Math.max(schoolStart, Math.min(720, schoolEnd - 30));
      add(schoolStart, lunch - schoolStart, 'school', '학교 수업·쉬는 시간', '체육과 쉬는 시간의 활동도 오늘 운동량에 포함돼요.');
      add(lunch, Math.min(30, schoolEnd - lunch), 'meal', '점심 식사', profile.schoolLunch === false ? '준비한 점심을 먹고 물을 마셔요.' : '학교 급식과 실제 학교 시간표를 우선해요. 식단 카드는 급식을 대체하지 않아요.');
      add(lunch + 30, schoolEnd - lunch - 30, 'school', '오후 수업', '앉아 있는 사이에는 학교가 허용하는 쉬는 시간에 편하게 움직여요.');
    }
    add(schoolEnd, 30, 'travel', '하교·가방 정리', '손을 씻고 잠깐 쉬어요. 집에 오는 실제 시간에 맞춰 조절해요.');
    freeStart = schoolEnd + 30;
    add(freeStart, 15, 'meal', '방과 후 간식·물', '배고픔과 다음 식사 시간을 살펴 준비한 간식을 먹어요.');
    add(freeStart + 15, 30, 'play', '자유 놀이·쉬는 시간', '오늘 하고 싶은 편안한 놀이를 골라요. 추가 운동 과제가 아니에요.');
    add(freeStart + 45, 30, 'school', '숙제·읽기', '해야 할 것을 작게 나누고, 더 오래 필요하면 가족과 실제 일정에 맞춰요.');
    freeStart += 75;
  } else {
    add(Math.max(wake + 60, 540), 40, 'play', '자유 놀이·가족 시간', '자전거·산책·공놀이 등 하고 싶은 것을 골라요. 휴식일에는 훈련 의무로 바꾸지 않아요.');
    add(720, 30, 'meal', '점심 식사', '가족 일정에 맞춰 규칙적으로 먹어요.');
    add(780, 30, 'school', '읽기·만들기·숙제', '축구 외에 즐기는 일에도 시간을 써요.');
    add(870, 15, 'meal', '간식·물', '배고프면 준비한 간식을 먹고, 필요 없으면 억지로 먹지 않아요.');
    freeStart = 930;
  }
  const trainingMinutes = Math.max(0, Number(day.minutes) || 0);
  const proposed = day.kind === 'match' && !schoolDay ? 600 : Math.max(freeStart + 15, 990);
  const latest = winddown - 60 - trainingMinutes;
  const availableStart = day.kind === 'match' && !schoolDay ? wake + 90 : freeStart;
  let trainingStart = Math.max(availableStart, Math.min(proposed, latest));
  const notes = [LOAD_NOTE, '생활 시간표는 입력한 학교·취침 시간에 맞춘 예시입니다. 실제 학교·팀 일정이 우선이며, 완료하지 못한 항목은 벌점이 없어요.'];
  if (trainingMinutes && trainingStart + trainingMinutes + 45 <= winddown) {
    add(trainingStart - 10, 10, 'preparation', '운동 준비', '장소·신발·공을 확인하고 물을 준비해요. 팀·경기 준비운동은 담당 코치 지도를 따라요.');
    add(trainingStart, trainingMinutes, 'training', day.title || '오늘의 운동', day.kind === 'individual' ? '준비운동·휴식·정리운동을 포함한 총 시간이에요. 오늘 과제 카드의 순서대로 진행해요.' : '등록한 팀 일정입니다. 출전 시간·실제 강도는 팀 계획에 따르며 추가 개인 연습을 붙이지 않아요.');
    add(trainingStart + trainingMinutes, 10, 'hygiene', '물·정리·씻기', '천천히 숨을 고르고 물을 마셔요. 땀을 닦고 씻은 뒤 마른 옷으로 갈아입어요.');
  } else if (trainingMinutes) {
    trainingStart = null;
    notes.push('입력한 학교·취침 시간 사이에 운동과 회복 시간을 충분히 넣기 어려워요. 늦은 추가 개인 훈련은 생략하고 팀 시간과 취침 시간을 먼저 조절해요.');
  } else {
    add(Math.min(Math.max(freeStart + 15, 990), winddown - 90), 20, 'rest', '편안한 휴식·자유 시간', checkin?.pain ? '통증이 있는 동작을 피하고 보호자에게 알려요. 쉬는 동안 훈련을 보충하지 않아요.' : '쉬거나 편한 놀이를 골라요. 걷기도 피곤하면 하지 않아도 괜찮아요.');
  }
  const dinner = Math.min(Math.max(1080, trainingStart === null ? 1080 : trainingStart + trainingMinutes + 20), winddown - 30);
  add(dinner, 30, 'meal', '저녁 식사', '가족과 편하게 식사해요. 경기 결과나 몸무게로 식사를 제한하지 않아요.');
  const familyStart = Math.max(dinner + 30, winddown - 20);
  if (familyStart < winddown) add(familyStart, Math.min(20, winddown - familyStart), 'family', '가족 대화·내일 준비', '시도한 행동 하나를 듣고, 가방·운동복·물통을 준비해요. 성적을 따지는 시간이 아니에요.');
  add(winddown, Math.max(0, bed - winddown), 'winddown', '화면 끄기·양치·편안한 취침 준비', '취침 60분 전부터 영상·게임 화면을 내려놓고 조명을 낮춰요. 책 읽기나 조용한 대화를 골라요.');
  const sleep = sleepInfo(profile);
  add(bed, Math.round(sleep.hours * 60), 'sleep', '취침', '정해둔 시간에 편하게 누워요. 잠이 잘 오지 않는 날이 이어지면 보호자와 이야기해요.');
  if (!sleep.withinTarget) notes.push(sleep.note);
  const mental = mentalGuidance(day, checkin);
  const habits = [
    { id: `habit-${date}-checkin`, time: clock(wake), title: '몸 상태부터 확인', minutes: 2, detail: '잘 잤는지·피곤한지·아픈 곳이 있는지 기록해요. 통증이나 심한 피로가 있으면 훈련 대신 쉬어요.' },
    { id: `habit-${date}-mental`, time: clock(Math.min(dinner + 30, winddown)), title: '아이의 말로 한 줄 돌아보기', minutes: 3, detail: `${mental.child} 부모: ${mental.parent}` },
    { id: `habit-${date}-screen`, time: clock(winddown), title: '잠들기 60분 전 화면 내려놓기', minutes: 1, detail: '알람을 맞춘 뒤 화면을 보관할 자리를 정해요. 실패한 날을 혼내기보다 다음 날 다시 시도해요.' },
    { id: `habit-${date}-sleep`, time: clock(bed), title: `${sleep.target} 수면 시간 확보`, minutes: 0, detail: `설정한 수면 기회 ${sleep.hours}시간. ${sleep.note}` },
  ];
  return { date, schoolDay, sleep, items: items.sort((a, b) => a.kind === 'sleep' ? 1 : b.kind === 'sleep' ? -1 : a.time.localeCompare(b.time)), habits, mental, notes, trainingStart: trainingStart === null ? null : clock(trainingStart) };
}

function plannedWeekdays(profile) {
  const team = days(profile.teamDays), match = days(profile.matchDays);
  const occupied = new Set([...team, ...match]);
  const free = DAYS.filter(day => !occupied.has(day));
  // Reserve the day after a match first, then a second recovery day.
  const restOrder = [...new Set([...match.map(day => (day + 1) % 7), ...match.map(day => (day + 6) % 7), 0, 4, 6, 2, 1, 3, 5])].filter(day => free.includes(day));
  const reserved = new Set(restOrder.slice(0, 2));
  let candidates = [1, 3, 5, 2, 4, 6, 0].filter(day => free.includes(day) && !reserved.has(day));
  const max = occupied.size === 0 ? 2 : 3;
  candidates = candidates.slice(0, Math.min(max, Math.max(0, free.length - 2)));
  return { team, match, individual: candidates, insufficientRest: free.length < 2, assumed: !occupied.size };
}

function shouldRest(checkin) { return Boolean(checkin?.pain || checkin?.fatigue === 'tired'); }
function restReason(checkin) { return checkin?.pain ? '통증을 기록했어요. 오늘 운동은 쉬고 보호자에게 알려요. 심하거나 계속되면 의료진에게 확인해요.' : '피로가 높다고 기록했어요. 오늘은 쉬고 회복해요. 밀린 훈련은 다음 날 보충하지 않아요.'; }

/** Pure, dated plan: does not alter practices, checkins, or schedule changes. */
export function buildFourWeekPlan(workspace = {}, { startDate } = {}) {
  const profile = workspace.profile || workspace.player || {};
  const start = isDate(startDate) ? startDate : isDate(profile.planStart) ? profile.planStart : kstToday();
  const planDays = plannedWeekdays(profile), priorities = deriveGrowthPriorities(workspace).slice(0, 2);
  const plan = Array.from({ length: 28 }, (_, index) => {
    const date = addDays(start, index), dayOfWeek = getWeekday(date), week = Math.floor(index / 7) + 1;
    const checkin = (workspace.checkins || []).find(item => item.date === date) || null;
    let kind = planDays.match.includes(dayOfWeek) ? 'match' : planDays.team.includes(dayOfWeek) ? 'team' : planDays.individual.includes(dayOfWeek) ? 'individual' : 'rest';
    const originalKind = kind;
    if (shouldRest(checkin) || (kind === 'individual' && checkin?.sleepQuality === 'poor')) kind = 'rest';
    const session = planDays.individual.indexOf(dayOfWeek);
    const priority = priorities.length ? priorities[Math.max(0, session) % priorities.length] : null;
    const task = kind === 'individual' ? makeTask(profile, date, week, Math.max(0, session), priority) : null;
    const teamMinutes = Math.max(0, Math.min(240, Number(profile.teamMinutes ?? 60) || 0));
    const title = kind === 'individual' ? task.title : kind === 'team' ? '팀 훈련 · 개인 추가 훈련 없음' : kind === 'match' ? '경기 · 개인 추가 훈련 없음' : '회복과 자유 시간';
    let reason = shouldRest(checkin) ? restReason(checkin) : originalKind === 'individual' && checkin?.sleepQuality === 'poor' ? '잠을 잘 못 잤다고 기록했어요. 추가 개인 훈련을 쉬고 오늘 밤 수면을 먼저 챙겨요.' : kind === 'individual' ? task.reason : kind === 'rest' ? '정해둔 회복일이에요. 쉬는 날도 계획의 일부이며 보충 훈련을 하지 않아요.' : '기존 팀·경기 일정이 우선입니다. 이 날에는 개인 훈련을 추가하지 않아요.';
    if (planDays.assumed) reason += ' 팀·경기 요일이 미등록이라 주 2회 15분의 일반 일정으로 가정했어요. 기존 일정과 겹치면 개인 연습을 생략해요.';
    if (planDays.insufficientRest) reason += ' 현재 등록 일정에는 주 2일의 운동 휴식일이 부족해요. 추가 연습 없이 코치와 기존 훈련량을 조절해요.';
    return { date, weekday: weekdayLabel(date), dayOfWeek, week, kind, originalKind, title, minutes: kind === 'individual' ? task.minutes : kind === 'team' || kind === 'match' ? teamMinutes : 0, reason, task, personalized: Boolean(task?.personalized), generalAssumption: Boolean(task?.generalAssumption || planDays.assumed), sourceCount: priority?.sourceCount || 0, checkin, loadWarning: planDays.insufficientRest, completed: false, habits: [] };
  });
  for (const change of workspace.scheduleChanges || []) {
    const origin = plan.find(day => day.task && (day.task.id === change.taskId || (!change.taskId && day.date === change.originalDate)));
    if (!origin || !isDate(change.date) || change.date === origin.date) continue;
    const target = plan.find(day => day.date === change.date);
    let invalid = !target || target.kind !== 'rest' || shouldRest(target.checkin) || target.checkin?.sleepQuality === 'poor';
    if (!invalid) {
      const weekDays = plan.filter(day => calendarWeek(day.date) === calendarWeek(target.date));
      const personal = weekDays.filter(day => day.kind === 'individual' && day !== origin).length;
      const rest = weekDays.filter(day => day.kind === 'rest' && day !== target).length + (weekDays.includes(origin) ? 1 : 0);
      invalid = personal >= 3 || (weekDays.length === 7 && rest < 2);
    }
    if (invalid) { origin.moveNote = '선택한 날은 팀·경기·다른 연습이 있거나 휴식일이 부족해 옮기지 않았어요. 두 과제를 합치지 않습니다.'; continue; }
    const task = origin.task, originalDate = origin.originalDate || origin.date;
    Object.assign(target, { kind: 'individual', title: task.title, task, minutes: task.minutes, originalDate, moved: true, personalized: task.personalized, generalAssumption: task.generalAssumption, sourceCount: task.evidence.length, reason: `${originalDate}의 연습을 옮겼어요. ${task.reason} 놓친 횟수를 더하지 않고 15분만 진행해요.` });
    Object.assign(origin, { kind: 'rest', title: '일정을 옮긴 날 · 편하게 쉬어요', task: null, minutes: 0, movedTo: target.date, reason: `${target.date}로 연습을 옮겼어요. 오늘은 추가 훈련 없이 쉬어요.`, completed: false });
  }
  for (const day of plan) {
    day.completed = Boolean(day.task && (workspace.practices || []).some(item => item.taskId === day.task.id && item.completed === true));
    day.routine = buildDayRoutine(profile, day, day.checkin);
    const sleep = sleepInfo(profile);
    if (day.kind === 'individual' && (day.routine.trainingStart === null || sleep.hours < sleep.min)) {
      Object.assign(day, { kind: 'rest', title: '생활 시간과 회복을 먼저 챙겨요', minutes: 0, task: null, completed: false,
        reason: sleep.hours < sleep.min ? '설정한 취침·기상 시간의 수면 기회가 연령별 일반 권고보다 짧아요. 추가 개인 훈련보다 수면 시간을 먼저 확보해요.' : '학교·취침 시간 사이에 훈련과 회복을 넣을 여유가 부족해요. 오늘 추가 개인 훈련은 생략하고 가족 일정에 맞춰 쉬어요.' });
      day.routine = buildDayRoutine(profile, day, day.checkin);
    }
    day.habits = day.routine.habits;
  }
  return plan;
}
