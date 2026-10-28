export const VERSION = 1;
export const kstDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit' }).format(now);
export const weekday = date => new Date(date+'T12:00:00+09:00').getUTCDay();
export const scheduled = date => [0,1,3].includes(weekday(date));
export const defaults = () => ({version:VERSION,profile:{nickname:'희찬',mode:30,guardian:false,healthConsent:false},sessions:[],records:[],draft:null});
const make = (id,title,kind,dose,steps,easy,mistake,stop,diagram) => ({id,title,kind,dose,steps,easy,mistake,stop,diagram});
export const exercises = [
 make('warm','몸 깨우기','준비','제자리 걷기와 작은 관절 움직임. 숨이 편안한 속도.', ['주변 물건을 치우고 물을 준비해요.','천천히 걷고 팔을 흔들어요.','발목을 작게 움직이고 무릎을 부드럽게 굽혀요.'], '의자 옆에서 작은 움직임부터 해요.', '처음부터 빠르게 뛰거나 목을 크게 돌리지 않아요.','통증·어지럼·숨쉬기 어려움이 있으면 멈추고 보호자에게 알려요.','warm'),
 make('band','밴드 · 앞·옆·뒤','저항','가장 가벼운 밴드. 방향별 좌우 각 5회 × 1세트부터. 방향 사이 30~60초 쉬기. 이 횟수는 앱 작성 초안이에요.', ['보호자가 밴드 손상과 미끄럽지 않은 바닥을 확인해요.','낮은 저항의 짧은 루프를 두 발목 바로 위에 걸어요. 피부·관절이 불편하면 사용하지 않아요.','움직이지 않는 튼튼한 지지대를 양손으로 잡아요. 밴드를 문고리·가구에 묶지 않아요.','서 있는 다리는 편하게, 움직일 발을 앞→옆→뒤로 아주 조금 보내고 천천히 돌아와요.','왼발과 오른발 모두 수행해요. 몸통을 기울이지 않고 호흡해요.'], '밴드 없이 발끝을 앞·옆·뒤로 짚기부터 해요.', '허리를 젖히거나 반동으로 세게 벌리지 않아요. 스트레칭이 아닌 저항 운동이에요.','관절 통증·저림·밴드 미끄러짐·몸통 흔들림이 있으면 중단해요.','band'),
 make('plank','무릎 플랭크','코어','편안한 자세 10초 × 2회, 사이 30~60초 쉬기. 매번 최장시간을 측정하지 않아요.', ['매트에서 팔꿈치를 어깨 아래에 둬요.','무릎을 바닥에 대고 머리부터 무릎까지 편하게 정렬해요.','배에 가볍게 힘을 주고 평소처럼 숨 쉬어요.','자세가 흐트러지기 전에 무릎과 배를 내려 쉬어요.'], '벽에 손을 대고 짧게 버티기부터 해요.', '허리를 처지게 하거나 숨을 참지 않아요.','허리가 처짐·허리나 어깨 통증·숨 참기가 생기면 즉시 타이머를 끝내요.','plank'),
 make('deadbug','누워서 팔다리 · 데드버그','코어','좌우 각 4회 × 1세트. 천천히 움직이고 필요할 때 쉬기.', ['등을 대고 누워 무릎을 굽혀요. 허리는 편안한 위치에 둬요.','팔을 천장 쪽으로 들고 한쪽 발뒤꿈치를 바닥으로 가볍게 내려요.','몸통이 흔들리지 않는 작은 범위에서 좌우를 바꿔요.','익숙해지면 반대 팔을 조금 움직여요.'], '팔은 내려놓고 한 발씩 발뒤꿈치만 움직여요.', '엉덩이만 대고 버티기나 허리를 과하게 띄우지 않아요.','허리 통증·불편함·호흡을 참는 모습이 있으면 멈춰요.','deadbug'),
 make('wall','얕은 투명의자','하체','편안한 얕은 각도로 10초 × 2회. 사이 30~60초 쉬기.', ['미끄럽지 않은 신발과 벽을 확인해요.','등을 벽에 대고 발을 조금 앞으로 옮겨요.','깊게 앉지 않고 편한 범위에서 살짝 내려가요.','무릎과 발끝 방향을 맞추고 호흡해요.'], '의자에서 양손 도움을 받아 일어나고 앉아요.', '무릎을 안쪽으로 모으거나 직각까지 억지로 내려가지 않아요.','무릎 통증·떨림으로 자세를 지키기 어려움·어지럼이 있으면 일어나 쉬어요.','wall'),
 make('rope','줄넘기 · 리듬과 착지','리듬','기본 1단 20초 × 2회부터, 사이 40~60초 걷기. 이 시간 안에 쉬는 것도 괜찮아요.', ['머리 위와 주변 공간, 바닥과 신발을 확인해요.','작게 뛰고 무릎을 부드럽게 하여 조용히 착지해요.','좌우 한발 뛰기는 기본 착지가 안정된 경우에만 각 5회 이하로 짧게 연습해요.','2단 뛰기는 기본 동작을 지도자가 확인한 뒤 선택해요. 앱은 반복 2단을 기본 과제로 주지 않아요.'], '줄 없이 발뒤꿈치 들기와 리듬 걷기로 바꿔요.', '높이 뛰기·딱딱한 바닥·연속 기록 경쟁을 피하고 총 점프량을 늘리지 않아요.','발목·무릎 통증이나 착지 흔들림이 생기면 중단해요.','rope'),
 make('lift','기본 리프팅 · 양발로 이어가기','기술','왼발과 오른발을 번갈아 공을 가볍게 차며 이어가요. 짧게 연습한 뒤 30~60초 쉬고, 공을 놓쳐도 다시 시작해요.', ['깨질 물건 없는 공간에서 부드러운 공을 사용해요.','공을 낮게 띄우고 발등으로 부드럽게 차요.','왼발과 오른발을 번갈아 사용하며 편한 만큼 이어가요.','공을 놓치면 쉬었다가 다시 시작해요.'], '한 번 차고 잡기 또는 바닥에 한 번 튀긴 뒤 차기부터 연습해요.', '같은 발만 쓰거나 공을 너무 세게 차지 않아요.','통증·주변 사람이나 물건과 충돌 위험이 있으면 멈춰요.','lift'),
 make('pass','벽에 논스톱 패스','기술','좌우 각 5번의 부드러운 패스부터 하고 30~60초 쉬어요. 짧은 시간표에서는 몇 번만 해도 좋아요.', ['보호자가 허용한 벽과 미끄럽지 않은 바닥, 부드러운 공을 준비해요.','주변 사람·창문·차량을 살피고 소음도 확인해요.','벽 가까이 서서 약한 힘으로 패스하고 돌아오는 공을 받아요.','편해지면 공을 멈추지 않고 가볍게 다시 보내며 왼발과 오른발을 번갈아 써요.'], '돌아오는 공을 멈추고 준비한 뒤 패스해요.', '멀리서 강하게 차거나 발 하나만 계속 사용하지 않아요.', '통증이 생기거나 사람·물건과 부딪힐 위험이 있으면 멈춰요.','pass'),
 make('lift-high','리프팅 · 조금 높이 차고 이어가기','기술','기본 리프팅이 편할 때 선택해요. 양발 각 2~3번 시도 후 30~60초 쉬어요.', ['머리 위와 주변에 충분한 공간이 있는지 보호자와 확인해요.','양발로 기본 리프팅을 편하게 이어가요.','공을 평소보다 조금만 높여 차고 눈으로 따라가요.','공을 받아 다시 가볍게 차며 균형을 유지하고 양발을 번갈아 써요.'], '공을 조금 띄운 뒤 잡고 다시 시작해요.', '높이 경쟁이나 실내 천장을 향한 강한 킥을 하지 않아요.', '통증·어지럼·주변과 충돌 위험이 있거나 균형이 흔들리면 멈춰요.','lift'),
 make('band-light','밴드 대신 발끝 짚기','가동성','지지대를 잡고 밴드 없이 좌우 앞·옆·뒤를 1~3회씩 가볍게 짚은 뒤 쉬어요.', ['보호자와 바닥과 튼튼한 지지대를 확인해요.','지지대를 잡고 발을 앞·옆·뒤로 조금씩 짚어요.','반대쪽 발도 같은 범위로 움직여요.'], '편한 방향만 골라 한 번씩 짚어요.', '몸통을 기울이거나 반동을 주지 않아요.', '관절 통증이나 균형 흔들림이 생기면 멈춰요.','bandLight'),
 make('plank-light','플랭크 대신 벽 짚기','가동성','벽에 손을 가볍게 대고 편안히 5초 정도 서기 1~2회. 사이에 충분히 쉬어요.', ['벽을 마주 보고 두 손을 벽에 대요.','몸을 길게 세우고 편하게 숨 쉬어요.','짧게 연습한 뒤 쉬어요.'], '편하게 서서 벽에 손만 대요.', '숨을 참거나 허리를 젖히지 않아요.', '통증이나 어지럼이 있으면 멈춰요.','plankLight'),
 make('wall-light','투명의자 대신 의자 앉기','가동성','안정된 의자에서 손을 짚고 1~3번 천천히 앉았다 일어난 뒤 충분히 쉬어요.', ['움직이지 않는 의자를 보호자와 확인해요.','양손으로 지지하며 편한 범위에서 앉았다 일어나요.'], '의자에 앉아서 다리를 가볍게 움직여요.', '깊이 앉거나 무릎을 억지로 굽히지 않아요.', '무릎 통증이나 균형 문제가 있으면 멈춰요.','wallLight'),
 make('rope-light','줄넘기 대신 리듬 걷기','가동성','줄 없이 20초 정도 가볍게 걷고 40~60초 쉬어요. 점프하지 않아도 좋아요.', ['미끄럽지 않은 바닥과 주변을 확인해요.','줄 없이 제자리에서 가볍게 걸으며 양발 리듬을 느껴요.'], '앉아서 발끝을 번갈아 움직여요.', '높이 뛰거나 기록을 경쟁하지 않아요.', '발목·무릎 통증이나 균형 문제가 있으면 멈춰요.','warm'),
 make('stretch','편안한 정리 스트레칭','정리','종아리·허벅지 앞·엉덩이·가슴을 편하게 각 10~15초. 반동 없이 좌우 번갈아 해요.', ['벽을 짚고 한 발을 뒤로 보내 뒤꿈치를 바닥에 둬요.','지지대를 잡고 발목을 가볍게 잡아 허벅지 앞을 늘려요. 균형이 어려우면 생략해요.','누워 한쪽 무릎을 가슴 쪽으로 편안하게 당겨 엉덩이를 풀어요.','손을 뒤에서 무리하게 잡지 말고 팔을 옆으로 살짝 열어 가슴을 편하게 펴요.'], '작은 범위에서 움직이고 늘어나지 않아도 편안함을 확인해요.', '반동·강한 당김·다른 사람이 누르기는 하지 않아요.','통증·저림이 있으면 멈춰요. 키를 직접 늘리는 동작이 아니에요.','stretch'),
 make('rest','물 마시고 쉬기','휴식','앉거나 편하게 걷고 물을 마실 기회를 가져요. 남은 시간을 운동으로 채우지 않아도 돼요.', ['어깨 힘을 풀고 편하게 호흡해요.','물과 휴식을 선택해요.','지금 편안한지 보호자와 이야기해요.'], '오늘은 여기서 끝내도 괜찮아요.', '쉬는 시간에 추가 운동을 하지 않아요.','통증·어지럼·흉통·호흡 곤란은 즉시 중단하고 보호자에게 알리세요. 심한 증상은 의료 도움을 받으세요.','rest')
];
export const exercise = id => exercises.find(row=>row.id===id);
export function buildSession(date, slot, minutes, context={}) {
 if(!scheduled(date)) return [];
 if(![10,20,30].includes(minutes)||!['am','pm'].includes(slot)) throw new Error('시간표 설정을 확인해 주세요.');
 const light=weekday(date)===0 || context.tired || context.busy;
 if(context.pain) return [{id:'rest',seconds:minutes*60,label:'통증이 있는 날 · 운동 대신 보호자와 상태 확인'}];
 // Short modes are opportunities to sample, not a demand to finish every repetition.
 const ids=slot==='am'
  ? ['warm',light?'band-light':'band','rest',light?'plank-light':'plank','deadbug',light?'wall-light':'wall','rest','rest','stretch']
  : ['warm',light?'rope-light':'rope','rest','pass','lift','lift-high','rest','stretch'];
 const durations=slot==='am'
  ? {10:[120,45,60,45,45,45,60,60,120],20:[180,120,120,90,90,90,120,210,180],30:[180,240,180,180,180,180,240,180,240]}
  : {10:[120,30,90,60,60,30,90,120],20:[180,90,120,180,180,90,180,180],30:[180,180,180,300,300,180,300,180]};
 return ids.map((id,i)=>({id,seconds:durations[minutes][i]}));
}
export function weekKey(date) {
 const d=new Date(date+'T12:00:00+09:00');d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);
}
export function recordAllowed(records,date,context) {
 return context.guardian && context.comfort==='good' && !context.pain && !context.busy && weekday(date)===3 && !records.some(r=>weekKey(r.date)===weekKey(date));
}
export function elapsed(timer, now=Date.now()) {return Math.min(timer.limit,Math.max(0,timer.accumulated+(timer.startedAt===null?0:Math.max(0,now-timer.startedAt))));}
export const validDate = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export function validateState(value) {
 const fail=()=>{throw new Error('백업 형식이 맞지 않아요. 기존 기록은 변경하지 않았어요.');};
 if(!value||value.version!==VERSION||!value.profile||!Array.isArray(value.sessions)||!Array.isArray(value.records)||value.sessions.length>3000||value.records.length>1000)fail();
 const p=value.profile;
 if(typeof p.nickname!=='string'||!p.nickname.trim()||p.nickname.length>24||![10,20,30].includes(p.mode)||typeof p.guardian!=='boolean'||typeof p.healthConsent!=='boolean')fail();
 const clean={version:VERSION,profile:{nickname:p.nickname.trim(),mode:p.mode,guardian:p.guardian,healthConsent:p.healthConsent},sessions:[],records:[],draft:null};
 const ids=new Set();
 for(const s of value.sessions){
  if(!s||typeof s.id!=='string'||s.id.length>100||ids.has(s.id)||!validDate(s.date)||!scheduled(s.date)||!['am','pm'].includes(s.slot)||![10,20,30].includes(s.mode)||!Number.isFinite(s.seconds)||s.seconds<0||s.seconds>86400||!['completed','stopped'].includes(s.status)||!Array.isArray(s.checks)||s.checks.length>100||s.checks.some(c=>typeof c!=='string'||c.length>100))fail();
  ids.add(s.id);const row={id:s.id,date:s.date,slot:s.slot,mode:s.mode,seconds:s.seconds,status:s.status,checks:[...new Set(s.checks)]};
  if(s.completedItems!==undefined){if(!Array.isArray(s.completedItems)||s.completedItems.length>100||s.completedItems.some(v=>typeof v!=='string'||v.length>160))fail();row.completedItems=[...s.completedItems];}
  if(p.healthConsent && s.health){if(!['good','okay','tired'].includes(s.health.comfort)||typeof s.health.pain!=='boolean')fail();row.health={comfort:s.health.comfort,pain:s.health.pain};}
  clean.sessions.push(row);
 }
 const weeks=new Set();
 for(const r of value.records){
  if(!r||typeof r.id!=='string'||r.id.length>100||ids.has(r.id)||!validDate(r.date)||weekday(r.date)!==3||!['plank','wall','rope-basic','rope-single','rope-double','lift'].includes(r.metric)||!Number.isInteger(r.value)||r.value<1||r.value>(['plank','wall'].includes(r.metric)?20:500)||weeks.has(weekKey(r.date)))fail();
  ids.add(r.id);weeks.add(weekKey(r.date));clean.records.push({id:r.id,date:r.date,metric:r.metric,value:r.value});
 }
 return clean;
}
export function mergeBackup(current, incoming, {profile=false,health=false}={}) {
 const source=validateState(incoming), result=structuredClone(current);
 if(profile)result.profile={...source.profile,healthConsent:health&&source.profile.healthConsent};
 if(!health)for(const s of source.sessions)delete s.health;
 for(const field of ['sessions','records'])for(const row of source[field]){
  const previous=result[field].find(s=>s.id===row.id);
  const comparable=structuredClone(previous);if(comparable&&!health)delete comparable.health;
  if(previous && JSON.stringify(comparable)!==JSON.stringify(row))throw new Error('같은 ID의 다른 기록이 있어 가져오기를 중단했어요. 기존 기록은 그대로예요.');
  if(!previous)result[field].push(row);
 }
 if(!result.profile.healthConsent)for(const s of result.sessions)delete s.health;
 const checked=validateState(result);checked.draft=current.draft;return checked;
}
