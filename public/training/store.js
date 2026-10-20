import { defaults, validateState, exercises, scheduled, validDate } from './domain.js';
const NAME='next-step-training-v1';
let connection;
function db(){return connection ||= new Promise((resolve,reject)=>{const r=indexedDB.open(NAME,1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('기기 저장소를 열지 못했어요. 일반 브라우저 모드와 저장 공간을 확인해 주세요.'));});}
function restore(row){
 if(!row)return {revision:0,data:defaults()};
 const data=validateState(row.data),d=row.data.draft;
 if(d){
  if(!validDate(d.date)||!scheduled(d.date)||!['am','pm'].includes(d.slot)||![10,20,30].includes(d.mode)||!Array.isArray(d.plan)||!d.plan.length||d.plan.length>10||d.plan.some(s=>!exercises.some(e=>e.id===s.id)||!Number.isInteger(s.seconds)||s.seconds<1)||d.plan.reduce((n,s)=>n+s.seconds,0)!==d.mode*60||!Number.isInteger(d.index)||d.index<0||d.index>=d.plan.length||!Array.isArray(d.checks)||d.checks.length>100||d.checks.some(v=>typeof v!=='string'||v.length>100)||!Number.isFinite(d.finished)||d.finished<0||d.finished>d.mode*60000||!d.timer||!Number.isFinite(d.timer.accumulated)||d.timer.accumulated<0||d.timer.limit!==d.plan[d.index].seconds*1000||d.timer.accumulated>d.timer.limit||!(d.timer.startedAt===null||Number.isFinite(d.timer.startedAt)))throw new Error('진행 중 연습 데이터가 손상됐어요. JSON 백업을 보관하고 저장소 복구를 확인해 주세요.');
  data.draft={id:typeof d.id==='string'?d.id.slice(0,100):`legacy:${d.date}:${d.slot}`,date:d.date,slot:d.slot,mode:d.mode,plan:d.plan.map(s=>({id:s.id,seconds:s.seconds,...(s.label?{label:String(s.label).slice(0,100)}:{})})),index:d.index,checks:[...d.checks],finished:d.finished,timer:{...d.timer}};
 }
 return {revision:row.revision,data};
}
export async function read(key='main'){const database=await db();return new Promise((resolve,reject)=>{const r=database.transaction('state').objectStore('state').get(key);r.onsuccess=()=>{try{resolve(restore(r.result));}catch(e){reject(e);}};r.onerror=()=>reject(r.error);});}
export async function save(data,revision,key='main'){const database=await db();return new Promise((resolve,reject)=>{
 const tx=database.transaction('state','readwrite'),store=tx.objectStore('state');let failure,result;
 const r=store.get(key);r.onsuccess=()=>{try{const current=restore(r.result);if(current.revision!==revision)throw new Error('다른 탭에서 기록이 바뀌었어요. 입력을 따로 보관한 뒤 새로고침해 주세요. 덮어쓰지 않았어요.');result={revision:revision+1,data};restore(result);store.put(result,key);}catch(e){failure=e;tx.abort();}};
 tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||new Error('저장하지 못했어요. 저장 공간과 브라우저 설정을 확인해 주세요.'));tx.onerror=()=>{};
});}
