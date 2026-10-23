import { randomUUID } from 'node:crypto';
import { removeVideoEvidence } from './retention.js';
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fail=(code,message)=>Object.assign(new Error(message),{code});
const completed=job=>job?.status==='completed'&&!job.cancelRequested&&typeof job.result?.identified==='boolean'&&Array.isArray(job.clips)&&(
 job.result.identified===true&&job.stage==='completed'&&job.progress?.status==='completed'&&job.clips.length>0&&job.clips.length<=50000&&(!Number.isInteger(job.progress.selectedCount)||job.progress.selectedCount===job.clips.length)&&(!Number.isInteger(job.progress.completedCount)||job.progress.completedCount===job.clips.length)
 || job.result.identified===false&&job.progress?.status==='not_found'&&job.clips.length===0
);
/** Explicit opt-in for new uploads. Preserve text results; retain no server video bytes. */
export async function finalizeReportOnlyRetention({store,job:requested,signal}){
 if(![requested?.id,requested?.userId,requested?.videoId].every(id=>uuid.test(id||'')))throw fail('retention_invalid_id','영상 정리 대상을 확인하지 못했습니다.');
 const {id,userId,videoId}=requested,key=`jobs/${id}`,owner=randomUUID();let claimed=false;
 const live=async()=>{
  if(signal?.aborted)throw fail('retention_interrupted','영상 정리를 다음 실행에서 이어갑니다.');
  const [user,video,workspace,job]=await Promise.all([store.get(`users/${userId}`),store.get(`videos/${videoId}`),store.get(`workspaces/${userId}`),store.get(key)]);
  if(!user||user.deleting||!video||video.deleting||video.userId!==userId||video.retentionPolicy!=='report_only'||video.status!=='ready'||(video.activeJobId&&video.activeJobId!==id)||!workspace?.videos?.some(v=>v.id===videoId)||!completed(job)||job.userId!==userId||job.videoId!==videoId||(claimed&&job.retention?.leaseOwner!==owner))throw fail('retention_owner_gone','삭제되거나 변경된 영상의 정리를 중단했습니다.');
  for(const clip of job.clips){const analysis=workspace.analyses?.find(a=>a.id===clip.id&&a.videoId===videoId&&a.jobId===id);if(!analysis||analysis.start!==clip.start||analysis.end!==clip.end||JSON.stringify(analysis.result)!==JSON.stringify(clip.result))throw fail('retention_result_missing','텍스트 분석 결과의 저장을 확인하지 못해 영상을 보관합니다.');}
  return {video,workspace,job};
 };
 const touch=async update=>{
  await live();return store.update(key,current=>{
   if(!completed(current)||current.userId!==userId||current.videoId!==videoId||current.retention?.leaseOwner!==owner)throw fail('retention_lease_lost','다른 실행에서 영상 정리를 이어갑니다.');
   return update({...current,retention:{...current.retention,leaseUntil:new Date(Date.now()+120000).toISOString()}});
  });
 };
 const first=await store.get(key);if(!completed(first)||first.retention?.status==='completed')return first;
 try{
  await live();
  await store.update(key,current=>{
   if(!completed(current)||current.userId!==userId||current.videoId!==videoId)throw fail('retention_owner_gone','분석 상태가 바뀌었습니다.');
   if(current.retention?.status==='completed')throw fail('retention_busy','이미 영상 정리가 완료됐습니다.');
   if(current.retention?.leaseOwner&&Date.parse(current.retention.leaseUntil)>Date.now())throw fail('retention_busy','다른 실행에서 영상 정리 중입니다.');
   return {...current,retention:{status:'deleting',leaseOwner:owner,leaseUntil:new Date(Date.now()+120000).toISOString(),errorCode:null,totalBytes:0}};
  });claimed=true;
  await live();await store.update(`videos/${videoId}`,v=>{
   if(!v||v.deleting||v.userId!==userId||(v.activeJobId&&v.activeJobId!==id))throw fail('retention_owner_gone','영상이 변경됐습니다.');
   return {...v,sourceStatus:'deleting_after_analysis',sourceRetentionJobId:id};
  });
  // Deny replay before erasure. No generated MP4 is needed by this policy.
  await live();await store.update(`workspaces/${userId}`,w=>{
   if(!w?.videos?.some(v=>v.id===videoId))throw fail('retention_owner_gone','성장 기록이 삭제됐습니다.');
   return {...w,revision:(w.revision||0)+1,videos:w.videos.map(v=>v.id===videoId?{...v,sourceStatus:'deleting_after_analysis'}:v),analyses:w.analyses.map(a=>a.videoId===videoId?(({evidence,...rest})=>rest)(a):a)};
  });
  for(const blob of await store.list(`media/${userId}/${videoId}/`)){await touch(j=>j);await store.delete(blob);}
  await live();await removeVideoEvidence({store,userId,videoId});
  for(const prefix of [`media/${userId}/${videoId}/`,`evidence-media/${userId}/${videoId}/`,`evidence-owners/${userId}/${videoId}/`])if((await store.list(prefix)).length)throw fail('retention_delete_incomplete','남아 있는 영상 정리를 다음 실행에서 이어갑니다.');
  const deletedAt=(await live()).video.sourceDeletedAt||new Date().toISOString();
  await store.update(`videos/${videoId}`,v=>{
   if(!v||v.deleting||v.userId!==userId||v.sourceRetentionJobId!==id)throw fail('retention_owner_gone','영상이 삭제됐습니다.');
   return {...v,sourceStatus:'deleted_after_analysis',sourceDeletedAt:deletedAt,evidenceBytes:0,chunks:[]};
  });
  await live();await store.update(`workspaces/${userId}`,w=>{
   if(!w?.videos?.some(v=>v.id===videoId))throw fail('retention_owner_gone','성장 기록이 삭제됐습니다.');
   return {...w,revision:(w.revision||0)+1,videos:w.videos.map(v=>v.id===videoId?{...v,sourceStatus:'deleted_after_analysis',sourceDeletedAt:deletedAt,evidenceBytes:0}:v)};
  });
  await live();await store.update(`quotas/storage/${userId}`,q=>{
   if(!q)throw fail('retention_owner_gone','삭제된 계정의 보관 한도를 다시 만들지 않습니다.');
   return {...q,entries:q.entries.map(e=>e.videoId===videoId?{...e,size:0,status:'evidence_only'}:e)};
  });
  return await touch(j=>({...j,clips:j.clips.map(({evidence,...clip})=>clip),retention:{...j.retention,status:'completed',sourceDeletedAt:deletedAt,totalBytes:0,leaseOwner:null,leaseUntil:null,errorCode:null}}));
 }catch(error){
  if(claimed)try{await store.update(key,j=>j?.retention?.leaseOwner===owner?{...j,retention:{...j.retention,status:'pending',errorCode:error.code||'retention_pending',leaseOwner:null,leaseUntil:null}}:j);}catch{}
  throw error;
 }
}
