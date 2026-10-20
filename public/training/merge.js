import { validateState } from './domain.js';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const conflict=()=>{throw Object.assign(new Error('같은 항목이 다른 기기에서 바뀌었어요. 입력은 유지했어요. 내용을 따로 보관하고 최신 기록을 불러온 뒤 다시 저장해 주세요.'),{code:'training_conflict'});};
export function mergeTraining(base,desired,latest){
 base=validateState(base);desired=validateState(desired);latest=validateState(latest);
 const result=structuredClone(latest);
 for(const key of Object.keys(desired.profile)){
  const before=base.profile[key],after=desired.profile[key],current=latest.profile[key];
  if(same(before,after))continue;
  if(!same(before,current)&&!same(after,current))conflict();
  result.profile[key]=after;
 }
 for(const field of ['sessions','records']){
  const before=new Map(base[field].map(r=>[r.id,r])),after=new Map(desired[field].map(r=>[r.id,r])),current=new Map(latest[field].map(r=>[r.id,r]));
  for(const id of new Set([...before.keys(),...after.keys()])){
   const b=before.get(id),a=after.get(id),c=current.get(id);
   if(same(b,a))continue;
   if(!same(b,c)&&!same(a,c))conflict();
   if(a)current.set(id,a);else current.delete(id);
  }
  result[field]=[...current.values()];
 }
 try{return validateState(result);}catch{throw new Error('다른 기기의 기록과 합칠 수 없어요. 같은 주의 참고 기록 또는 저장 한도를 확인해 주세요. 기존 기록은 덮어쓰지 않았어요.');}
}
