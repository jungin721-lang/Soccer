import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSession,defaults,elapsed,recordAllowed,validateState,mergeBackup,weekKey,kstDate} from '../public/training/domain.js';
test('Monday Wednesday Sunday AM/PM plans account exactly for all three durations',()=>{
 for(const date of ['2026-10-19','2026-10-21','2026-10-25'])for(const slot of ['am','pm'])for(const minutes of [10,20,30]){
  const plan=buildSession(date,slot,minutes);assert.equal(plan.reduce((n,s)=>n+s.seconds,0),minutes*60);assert.equal(plan[0].id,'warm');assert.equal(plan.at(-1).id,'stretch');assert.ok(plan.some(s=>s.id==='rest'));assert.ok(plan.every(s=>s.seconds>0));
 }
 assert.deepEqual(buildSession('2026-10-20','am',30),[]);
});
test('Sunday, fatigue and existing activities exclude resistance and jumping; pain gives rest',()=>{
 for(const [date,context] of [['2026-10-25',{}],['2026-10-19',{tired:true}],['2026-10-21',{busy:true}]])for(const slot of ['am','pm'])assert.ok(buildSession(date,slot,30,context).every(s=>!['band','plank','wall','rope'].includes(s.id)));
 assert.deepEqual(buildSession('2026-10-21','am',20,{pain:true}).map(s=>s.id),['rest']);
});
test('wall clock elapsed excludes pauses, caps a background interval and ignores backward time',()=>{
 assert.equal(elapsed({limit:10000,accumulated:2000,startedAt:1000},6000),7000);
 assert.equal(elapsed({limit:10000,accumulated:2000,startedAt:null},999999),2000);
 assert.equal(elapsed({limit:10000,accumulated:2000,startedAt:1000},999999),10000);
 assert.equal(elapsed({limit:10000,accumulated:2000,startedAt:1000},0),2000);
});
test('weekly optional record eligibility requires comfortable Wednesday with guardian',()=>{
 const context={guardian:true,comfort:'good',pain:false,busy:false};
 assert.ok(recordAllowed([],'2026-10-21',context));
 for(const patch of [{guardian:false},{comfort:'tired'},{pain:true},{busy:true}])assert.ok(!recordAllowed([],'2026-10-21',{...context,...patch}));
 assert.ok(!recordAllowed([],'2026-10-19',context));assert.ok(!recordAllowed([{date:'2026-10-21'}],'2026-10-21',context));
 assert.equal(weekKey('2026-10-25'),weekKey('2026-10-21'));
 assert.equal(kstDate(new Date('2026-10-20T15:00:00Z')),'2026-10-21');
});
const session=(id='one')=>({id,date:'2026-10-21',slot:'am',mode:10,seconds:60,status:'stopped',checks:['0:0']});
test('backup merge preserves current settings and records, is idempotent and rejects conflicts atomically',()=>{
 const current=defaults(),incoming=defaults();current.sessions=[session()];incoming.sessions=[session(),session('two')];incoming.profile.nickname='다른 별명';
 const merged=mergeBackup(current,incoming);assert.equal(merged.profile.nickname,'희찬');assert.equal(merged.sessions.length,2);assert.equal(mergeBackup(merged,incoming).sessions.length,2);assert.equal(current.sessions.length,1);
 incoming.sessions[0].seconds=70;assert.throws(()=>mergeBackup(current,incoming));assert.equal(current.sessions[0].seconds,60);
});
test('health data needs consent and record limits survive restore',()=>{
 const incoming=defaults();incoming.profile.healthConsent=true;incoming.sessions=[{...session(),health:{comfort:'tired',pain:true}}];
 assert.equal(mergeBackup(defaults(),incoming).sessions[0].health,undefined);
 assert.deepEqual(mergeBackup(defaults(),incoming,{profile:true,health:true}).sessions[0].health,{comfort:'tired',pain:true});
 for(const patch of [{value:21},{date:'2026-10-20'}, {metric:'unknown'}]){const state=defaults();state.records=[{id:'r',date:'2026-10-21',metric:'plank',value:10,...patch}];assert.throws(()=>validateState(state));}
 const invalid=defaults();invalid.sessions=[{...session(),date:'2026-02-30'}];assert.throws(()=>validateState(invalid));
 const double=defaults();double.records=[{id:'a',date:'2026-10-21',metric:'lift',value:1},{id:'b',date:'2026-10-21',metric:'wall',value:10}];assert.throws(()=>validateState(double));
});
