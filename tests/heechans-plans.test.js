import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const sandbox={window:{}};vm.runInNewContext(readFileSync(new URL('../public/heechans/plans.js',import.meta.url),'utf8'),sandbox);
const {plans,exMeta,sessionBudgets}=sandbox.window.heechansPlans;
test('each day moves core to mornings and rope, passing and two kinds of lifting to evenings',()=>{
 for(const day of ['mon','wed','sun']){
  const am=plans[day].am.map(x=>x[0]),pm=plans[day].pm.map(x=>x[0]);
  for(const name of ['밴드 발 뻗기 · 앞 방향','밴드 발 뻗기 · 옆 방향','밴드 발 뻗기 · 뒤 방향','플랭크','데드버그 · 누워서 팔다리','투명의자'])assert.ok(am.includes(name));
  for(const name of ['줄넘기 · 1단 뛰기','줄넘기 · 2단 뛰기','줄넘기 · 한발 뛰기','벽에 논스톱 패스','축구공 리프팅','리프팅 · 조금 높이 차고 이어가기'])assert.ok(pm.includes(name));
  assert.ok(!am.some(x=>x.includes('줄넘기')));assert.ok(!pm.includes('플랭크'));
 }
});
test('Sunday reduces impact and short modes include warm-up, rest and cool-down',()=>{
 assert.match(plans.sun.pm[0][1],/줄 없이.*리듬 걷기/);
 assert.match(plans.sun.am[0][1],/밴드 없이/);
 for(const n of [10,20,30]){const b=sessionBudgets[n];assert.equal(b.warm+b.activity+b.rest+b.cool,n);assert.ok(b.warm>0&&b.rest>0&&b.cool>0);}
});
test('new options include safe alternatives and existing record metadata remains compatible',()=>{
 assert.equal(exMeta['엉덩이 균형 버티기'].unit,'초');
 assert.equal(exMeta['데드버그 · 누워서 팔다리'].unit,'회');
 const pm=plans.mon.pm;
 assert.match(pm.find(x=>x[0]==='축구공 리프팅')[1],/양발.*번갈아/);
 assert.match(pm.find(x=>x[0]==='축구공 리프팅')[1],/한 번 차고 잡/);
 assert.match(pm.find(x=>x[0]==='벽에 논스톱 패스')[1],/창문.*차량.*소음/);
 assert.match(pm.find(x=>x[0]==='리프팅 · 조금 높이 차고 이어가기')[1],/머리 위/);
});
