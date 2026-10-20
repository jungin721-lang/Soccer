import { defaults, validateState } from './domain.js';
import { read, save } from './store.js';
import { mergeTraining } from './merge.js';
export class TrainingCloud {
 user=null; available=false; epoch=0; draftRevision=0;
 async api(path,options={}){
  let response;
  try{response=await fetch('/api/v2'+path,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),...options,headers:{'Content-Type':'application/json'}});}
  catch{throw new Error('서버에 연결하지 못했어요. 입력은 유지했어요. 연결 후 다시 저장해 주세요.');}
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data){const error=new Error(data?.error||'서버가 연결된 훈련 앱 주소인지 확인해 주세요.');error.status=response.status;error.code=data?.code;throw error;}
  return data;
 }
 async init(){try{const result=await this.api('/auth/me');this.available=true;this.user=result.user||null;if(this.user)return await this.connect();}catch(error){if(error.status===401){this.available=true;this.user=null;}else this.available=false;}return null;}
 async connect(){
  const epoch=++this.epoch;
  try{const remote=await this.api('/training');if(epoch!==this.epoch)throw new Error('계정 연결이 변경됐어요. 다시 시도해 주세요.');this.verify(remote);const local=await read('account:'+this.user.id);this.draftRevision=local.revision;return {...remote,data:{...validateState(remote.data),draft:local.data.draft}};}
  catch(error){this.user=null;this.epoch++;throw error;}
 }
 verify(remote){if(!this.user||remote.userId!==this.user.id)throw Object.assign(new Error('로그인 계정이 변경됐어요. 다시 로그인해 주세요.'),{status:401});}
 async authenticate(body,register=false){const result=await this.api('/auth/'+(register?'register':'login'),{method:'POST',body:JSON.stringify(body)});this.user=result.user;this.available=true;return this.connect();}
 async localDraft(draft){const cache=defaults();cache.draft=draft;const result=await save(cache,this.draftRevision,'account:'+this.user.id);this.draftRevision=result.revision;}
 async commit(base,desired){
  const epoch=this.epoch;let remote={revision:base.revision,data:validateState(base.data),userId:this.user.id};
  const before=validateState(base.data),after=validateState(desired);
  if(JSON.stringify(before)!==JSON.stringify(after)){
   for(let attempt=0;attempt<3;attempt++){
    remote=await this.api('/training');if(epoch!==this.epoch)throw new Error('계정이 변경돼 저장을 중단했어요.');this.verify(remote);
    // A completed timer has a stable UUID. A lost success response must not
    // create a duplicate or replace the already accepted elapsed time.
    const intent=structuredClone(after),completedId=base.data.draft?.id;
    if(completedId&&!desired.draft){const accepted=remote.data.sessions.find(s=>s.id===completedId);if(accepted)intent.sessions=intent.sessions.map(s=>s.id===completedId?accepted:s);}
    const merged=mergeTraining(before,intent,remote.data);
    try{remote=await this.api('/training',{method:'PUT',body:JSON.stringify({revision:remote.revision,data:merged})});this.verify(remote);break;}
    catch(error){if(error.code!=='revision_conflict'||attempt===2)throw error;}
   }
  }
  if(epoch!==this.epoch)throw new Error('계정 연결이 변경됐어요.');
  // Completed records are already durable on the server even if this device is full.
  let warning=null;try{await this.localDraft(desired.draft);}catch{warning='서버 기록은 저장했지만 이 기기의 타이머 저장에 실패했어요. 새로고침 전 진행 상태를 확인해 주세요.';}
  if(epoch!==this.epoch)throw new Error('계정 연결이 변경돼 화면 갱신을 중단했어요.');
  return {...remote,data:{...validateState(remote.data),draft:desired.draft},warning};
 }
 async refresh(){const epoch=this.epoch,result=await this.api('/training');if(epoch!==this.epoch)return null;this.verify(result);return {...result,data:validateState(result.data)};}
 async logout(){await this.api('/auth/logout',{method:'POST',body:'{}'});this.detach();}
 detach(){this.user=null;this.epoch++;}
}
