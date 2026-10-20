import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../public/training/domain.js';
import { mergeTraining } from '../public/training/merge.js';
const session=id=>({id,date:'2026-10-21',slot:'am',mode:10,seconds:10,status:'stopped',checks:[]});
test('training sync merges independent session additions and different profile fields',()=>{
 const base=defaults(),desired=defaults(),latest=defaults();desired.profile.nickname='A';desired.sessions=[session('a')];latest.profile.mode=20;latest.sessions=[session('b')];
 const merged=mergeTraining(base,desired,latest);assert.equal(merged.profile.nickname,'A');assert.equal(merged.profile.mode,20);assert.deepEqual(merged.sessions.map(s=>s.id),['b','a']);assert.equal(base.sessions.length,0);
});
test('same setting conflicts, while unchanged stale lists retain remote records',()=>{
 const base=defaults(),desired=defaults(),latest=defaults();desired.profile.nickname='A';latest.profile.nickname='B';assert.throws(()=>mergeTraining(base,desired,latest),{code:'training_conflict'});
 desired.profile.nickname='희찬';latest.sessions=[session('b')];assert.deepEqual(mergeTraining(base,desired,latest).sessions,latest.sessions);
});
test('concurrent weekly records cannot bypass one-record-per-week validation',()=>{
 const base=defaults(),desired=defaults(),latest=defaults();desired.records=[{id:'a',date:'2026-10-21',metric:'lift',value:5}];latest.records=[{id:'b',date:'2026-10-21',metric:'plank',value:10}];assert.throws(()=>mergeTraining(base,desired,latest));
});
test('remote consent withdrawal strips incoming health instead of resurrecting it',()=>{
 const base=defaults();base.profile.healthConsent=true;const desired=structuredClone(base),latest=defaults();desired.sessions=[{...session('a'),health:{comfort:'tired',pain:true}}];const merged=mergeTraining(base,desired,latest);assert.equal(merged.profile.healthConsent,false);assert.equal(merged.sessions[0].health,undefined);
});

test('logout while local timer persistence is pending cannot return the old account data',async()=>{
 const {TrainingCloud}=await import('../public/training/cloud.js');
 const cloud=new TrainingCloud();cloud.user={id:'owner'};cloud.epoch=1;
 cloud.localDraft=async()=>{cloud.detach();};
 await assert.rejects(cloud.commit({revision:1,data:defaults()},defaults()),/계정 연결이 변경/);
 assert.equal(cloud.user,null);
});
