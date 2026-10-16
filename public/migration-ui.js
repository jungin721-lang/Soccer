import { kstToday } from './growth-domain.js';
import { inspectLegacyWorkspace, getLegacyOriginal, buildLegacyImportArchive } from './legacy-migration.js';

/** Explicit, resumable import. Old device data is never overwritten or deleted. */
export function createMigrationUI({ api, getWorkspace, getUser, getImports, reload, render, openModal, closeModal, toast, esc, bytes, button, evidenceButton, setUploading, shouldStop }) {
  let inspection = inspectLegacyWorkspace();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const message = text => { const el=document.querySelector('#legacy-progress'); if(el)el.innerHTML=text; };
  function banner() {
    inspection=inspectLegacyWorkspace();
    if(!inspection.available)return inspection.warnings.length?`<details class="card"><summary>이전 기기 기록 읽기 안내</summary><p>${esc(inspection.warnings.join(' '))}</p></details>`:'';
    return `<section class="card legacy-banner"><div class="card-head"><h2>이 기기의 이전 기록을 찾았어요</h2><span class="badge neutral">기록 이전</span></div><p class="muted">원본 ${inspection.videos.length}개 · 장면 ${inspection.recordCounts.observations}개 · 이전 AI 기록 ${inspection.recordCounts.analyses}개. 같은 파일을 다시 고를 필요 없이 비공개 계정으로 가져올 수 있어요.</p>${button('이전 영상·기록 가져오기','legacy-open','secondary')}</section>`;
  }
  function archives() {
    const rows=getImports();if(!rows.length)return '';
    return `<section class="card"><div class="card-head"><h2>가져온 이전 기록</h2><span class="badge neutral">검토 전 보관 자료</span></div><p class="source-note">과거 점수와 AI 해석을 현재 능력 평가로 합치지 않습니다. 원본을 가져오면 새 서버 분석을 받을 수 있어요.</p>${rows.map(row=>`<div class="skill-row"><div><strong>${esc(row.title||'이전 브라우저 성장 기록')}</strong><small class="muted">${esc(row.label)} · ${new Date(row.createdAt).toLocaleDateString('ko-KR')}</small></div>${button('기록 열기','legacy-view','secondary',`data-id="${row.id}"`)}</div>`).join('')}</section>`;
  }
  function modal() {
    inspection=inspectLegacyWorkspace();
    if(!inspection.available)throw new Error(inspection.warnings[0]||'이 브라우저에서 이전 기록을 찾지 못했어요.');
    openModal('이전 영상과 기록 가져오기',`<p>이전 성장 기록을 먼저 비공개로 보관하고, 선택한 원본을 이 기기에서 찾아 서버로 옮겨요.</p><p class="source-note">이전 자료는 삭제하지 않습니다. 원본이 없는 경우에도 장면 설명·과거 분석·실천 기록은 보관할 수 있어요.</p><form id="legacy-import-form"><fieldset><legend>가져올 원본 영상</legend>${inspection.videos.length?inspection.videos.map(v=>`<label class="check-row"><input type="checkbox" name="legacyVideo" value="${esc(v.id)}" checked><span>${esc(v.title)}<small class="muted">${esc(v.fileName)} · ${bytes(v.size)} · 이전 ${esc(inspection.player.kit)} ${inspection.player.number}번</small></span></label>`).join(''):'<p class="muted">이전 기록에는 기기 원본이 없습니다. 링크와 기록만 보관합니다.</p>'}</fieldset><label class="check-row"><input type="checkbox" name="importConsent" required> 이전 기록을 현재 계정에 비공개로 보관하는 데 동의합니다.</label><label class="check-row"><input type="checkbox" name="rightsConsent"> 선택한 원본의 업로드·분석 권한과 필요한 보호자 동의를 확보했습니다. 원본을 옮길 때 필요해요.</label><label class="check-row"><input type="checkbox" name="analysisConsent"> 가져온 원본을 자동 분석하고 필요한 표본 이미지를 OpenAI API로 전송하는 데 동의합니다. 선택하지 않으면 원본만 보관해요.</label><details><summary>이전 점수와 기록은 어떻게 표시하나요?</summary><p>이전 자료는 ‘서버 검증 안 됨’으로 표시합니다. 과거 점수와 AI 해석을 새 경기의 확정된 능력치로 사용하지 않습니다. 현재 선수 설정도 자동으로 바꾸지 않아요.</p><p>유튜브 링크는 보관하지만 링크에서 원본 파일을 내려받지는 않습니다. 원본은 같은 주소·기기·브라우저의 저장소에서 찾습니다.</p></details><div id="legacy-progress" role="status" aria-live="polite"></div><button type="submit" class="button primary full">선택한 자료 가져오기</button></form>`);
  }
  async function archiveDetail(id) {
    const {import:record}=await api('/imports/'+id);const data=record.archive,map=new Map(record.idMap.map(item=>[item.oldId,item.newId]));
    openModal('이전 성장 기록',`<span class="badge warn">${esc(record.label)}</span><p class="source-note">이전 기기에서 가져온 기록입니다. 현재 서버 분석 결과와 별도로 보관합니다.</p><h3>경기와 원본 연결</h3>${data.videos.map(v=>`<div class="observation"><strong>${esc(v.title)}</strong>${map.has(v.id)?`<div>${evidenceButton({videoId:map.get(v.id),time:0},'가져온 원본 재생')}</div>`:v.kind==='file'?'<p class="muted">원본을 아직 가져오지 않았어요.</p>':`<p><a href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener noreferrer">이전 유튜브 영상 열기 ↗</a></p>`}</div>`).join('')}<h3>이전 장면 기록 · ${data.observations.length}개</h3>${data.observations.map(o=>`<article class="observation"><p>${esc(o.note)}</p><small class="muted">이전 기록 · 과거 입력 점수 ${o.rating===null?'없음':`${o.rating}/5`} · 재검토 전</small>${map.has(o.videoId)?`<div>${evidenceButton({videoId:map.get(o.videoId),time:o.time})}</div>`:''}</article>`).join('')}<details><summary>이전 AI 해석 · ${data.analyses.length}개</summary>${data.analyses.map(a=>`<p>${esc(a.result.summary)}</p><small class="muted">이전 브라우저 기록 · 현재 서버가 검증한 결과가 아닙니다.</small>`).join('')}</details><p class="muted">실천·습관 ${data.completed.length}개 · 성장 스냅샷 ${data.snapshots.length}개 · 이전 분석 진행 기록 ${data.autoAnalyses.length}개</p><div class="button-row">${button('이전 기록 JSON 다운로드','legacy-download','secondary',`data-id="${id}"`)}${button('보관 자료 삭제','legacy-delete','danger',`data-id="${id}"`)}</div>`);
  }
  async function uploadOriginal(file,video,progress) {
    const key=`next-xi-legacy-upload-${getUser().id}-${video.id}`;let upload;
    try{const old=JSON.parse(localStorage.getItem(key));if(old?.id)({upload}=await api('/uploads/'+old.id));}catch{}
    if(!upload){const p=inspection.player;({upload}=await api('/uploads',{method:'POST',body:JSON.stringify({rightsConsent:true,fileName:file.name,size:file.size,mime:file.type||'video/mp4',title:video.title,target:{kit:p.kit,number:p.number,age:p.age},context:{position:p.position,matchDate:kstToday(video.addedAt),opponentLevel:'unknown',minutesPlayed:null,filming:'unknown'}})}));localStorage.setItem(key,JSON.stringify({id:upload.id}));}
    if(upload.status==='completed'){const complete=await api(`/uploads/${upload.id}/complete`,{method:'POST',body:'{}'});return complete.video;}
    let offset=upload.offset;
    if(offset>0){const result=await api('/uploads/'+upload.id,{method:'PUT',headers:{'Content-Type':'application/octet-stream','Upload-Offset':'0'},body:file.slice(0,Math.min(file.size,upload.chunkSize))});offset=result.upload.offset;}
    while(offset<file.size){if(shouldStop())throw new Error('이전을 멈췄어요. 다시 가져오기를 누르면 저장된 지점부터 이어갑니다.');let done=false;for(let retry=0;retry<4&&!done;retry++){try{const result=await api('/uploads/'+upload.id,{method:'PUT',headers:{'Content-Type':'application/octet-stream','Upload-Offset':String(offset)},body:file.slice(offset,Math.min(file.size,offset+upload.chunkSize))});offset=result.upload.offset;done=true;}catch(error){if(error.status&&error.status<500&&error.status!==409)throw error;if(retry===3)throw error;await wait(600*(retry+1));const latest=await api('/uploads/'+upload.id);offset=latest.upload.offset;}}progress(offset,file.size);}
    const complete=await api(`/uploads/${upload.id}/complete`,{method:'POST',body:'{}'});return complete.video;
  }
  async function submit(form) {
    const data=new FormData(form),selected=data.getAll('legacyVideo');if(!data.has('importConsent'))throw new Error('이전 기록 보관 동의를 확인해 주세요.');if(selected.length&&!data.has('rightsConsent'))throw new Error('원본을 옮기려면 업로드 권한과 보호자 동의를 확인해 주세요.');
    const payload=buildLegacyImportArchive({}, {inspection});const archiveBody=map=>JSON.stringify({archive:payload.archive,videoMap:map,importConsent:true,title:'이전 브라우저 성장 기록'});
    const submitButton=form.querySelector('button[type=submit]');submitButton.disabled=true;setUploading(true);const warnings=[];let transferred=0,analyzed=0;
    try {
      const first=await api('/imports',{method:'POST',body:archiveBody([])});const detail=await api('/imports/'+first.import.id);let map=detail.import.idMap;
      message('<div class="notice">이전 기록 보관 완료. 선택한 원본을 확인하고 있어요.</div>');
      for(const id of selected){if(shouldStop())break;const old=inspection.videos.find(v=>v.id===id);const existing=map.find(m=>m.oldId===id);if(existing&&getWorkspace().videos.some(v=>v.id===existing.newId))continue;
        try{const file=await getLegacyOriginal(old);message(`<p><strong>${esc(old.title)}</strong> 원본을 옮기고 있어요.</p><div class="progress"><span style="width:0%"></span></div>${button('이전 중단','stop-upload','quiet')}`);const video=await uploadOriginal(file,old,(offset,total)=>message(`<p><strong>${esc(old.title)}</strong> · ${Math.round(offset/total*100)}%</p><div class="progress"><span style="width:${Math.round(offset/total*100)}%"></span></div>${button('이전 중단','stop-upload','quiet')}`));map=[...map.filter(m=>m.oldId!==id),{oldId:id,newId:video.id}];await api('/imports',{method:'POST',body:archiveBody(map)});try{localStorage.removeItem(`next-xi-legacy-upload-${getUser().id}-${id}`);}catch{}transferred++;if(data.has('analysisConsent')){try{await api('/jobs',{method:'POST',body:JSON.stringify({videoId:video.id,analysisConsent:true})});analyzed++;}catch(error){warnings.push(`${old.title}: 원본은 저장했지만 분석은 대기합니다. ${error.message}`);}}}catch(error){warnings.push(`${old.title}: ${error.message}`);}
      }
      if(shouldStop())warnings.push('요청에 따라 이전을 멈췄어요. 이미 보관한 기록과 원본은 유지됩니다.');
      await reload();setUploading(false);closeModal();render();openModal('이전 기록을 보관했어요',`<div class="notice">성장 기록 비공개 보관 · 원본 ${transferred}개 추가 · 분석 신청 ${analyzed}개</div><p>과거 점수와 해석은 별도의 보관 자료로 표시합니다. 기기에 남아 있던 기록과 원본은 삭제하지 않았어요.</p>${warnings.length?`<h3>계속 확인할 원본</h3><ul>${warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul><p class="source-note">원본이 없는 파일도 기록은 보관했습니다. 같은 브라우저에 원본이 있는 경우 다시 가져오기로 이어갈 수 있어요.</p>`:''}<div class="button-row">${button('보관한 기록 보기','legacy-view','primary',`data-id="${first.import.id}"`)}</div>`);
    } finally{setUploading(false);if(submitButton.isConnected)submitButton.disabled=false;}
  }
  async function action(name,element) {
    if(name==='legacy-open')return modal();
    if(name==='legacy-view')return archiveDetail(element.dataset.id);
    if(name==='legacy-download'){const {import:record}=await api('/imports/'+element.dataset.id);const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='NEXT-XI-이전기록.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
    if(name==='legacy-delete')return openModal('이전 보관 자료를 삭제할까요?','<p>서버에 보관한 이전 기록만 삭제합니다. 가져온 원본 영상은 경기 목록에서 별도로 삭제할 수 있어요.</p>',button('보관 자료 삭제','legacy-confirm-delete','danger',`data-id="${element.dataset.id}"`));
    if(name==='legacy-confirm-delete'){await api('/imports/'+element.dataset.id,{method:'DELETE'});await reload();closeModal();render();toast('이전 보관 자료를 삭제했어요.');}
  }
  return { banner, archives, action, submit };
}
