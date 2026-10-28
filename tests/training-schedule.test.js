import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSession,exercise} from '../public/training/domain.js';

test('each scheduled day offers correctly ordered morning and evening exercises with rest within the selected duration',()=>{
 for(const date of ['2026-10-19','2026-10-21','2026-10-25'])for(const mode of [10,20,30])for(const slot of ['am','pm']){
  const plan=buildSession(date,slot,mode), ids=plan.map(s=>s.id), light=date==='2026-10-25';
  assert.equal(plan.reduce((total,s)=>total+s.seconds,0),mode*60);
  assert.equal(ids[0],'warm');assert.equal(ids.at(-1),'stretch');assert.ok(ids.includes('rest'));
  for(const id of slot==='am'?[light?'band-light':'band',light?'plank-light':'plank','deadbug',light?'wall-light':'wall']:[light?'rope-light':'rope','pass','lift','lift-high'])assert.ok(ids.includes(id),`${date} ${slot} ${mode}: ${id}`);
  assert.ok(plan.every(s=>exercise(s.id)&&s.seconds>0));
 }
});
test('fatigue and busy days use gentler alternatives, and pain offers rest only',()=>{
 for(const context of [{tired:true},{busy:true}]){
  const am=buildSession('2026-10-19','am',30,context).map(s=>s.id);
  const pm=buildSession('2026-10-19','pm',30,context).map(s=>s.id);
  assert.ok(am.includes('band-light')&&am.includes('plank-light')&&am.includes('wall-light'));
  assert.ok(pm.includes('rope-light'));
 }
 assert.deepEqual(buildSession('2026-10-19','am',30,{pain:true}).map(s=>s.id),['rest']);
});
test('basic lifting explicitly practices alternating feet, with catch and bounce as easier options',()=>{
 const lift=exercise('lift');
 assert.match(lift.title,/양발/);
 assert.match(lift.steps.join(' '),/왼발과 오른발을 번갈아/);
 assert.match(lift.easy,/차고 잡기/);
 assert.match(lift.easy,/한 번 튀긴/);
});
