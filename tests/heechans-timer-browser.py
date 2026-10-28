from datetime import datetime,timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright,expect
import json
ROOT=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT/'public')))
Thread(target=server.serve_forever,daemon=True).start();url=f'http://127.0.0.1:{server.server_port}/heechans/'
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in (320,390,1440):
   ctx=browser.new_context(viewport={'width':width,'height':800});page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   old={'settings':{'name':'희찬'},'records':[{'id':'old','name':'플랭크','value':10,'date':'2026-09-30','week':'2026-09-28','session':'2026-09-30_wed_am'}],'sessions':[]}
   page.clock.install(time=datetime(2026,10,28,1,0,tzinfo=timezone.utc));page.clock.pause_at(datetime(2026,10,28,1,0,tzinfo=timezone.utc));page.goto(url,wait_until='networkidle');page.evaluate("v=>localStorage.setItem('heechans-football-growth-v1',JSON.stringify(v))",old);page.reload(wait_until='networkidle')
   page.locator('[data-view=training]').click();page.locator('#allSessions .session').nth(2).locator('button').click();expect(page.locator('#workoutExercises')).to_contain_text('플랭크');assert '줄넘기' not in page.locator('#workoutExercises').inner_text()
   page.locator('#workoutExercises input[type=checkbox]').first.check();page.locator('#timerStart').click();page.clock.fast_forward(500000);page.locator('#timerStart').click();page.clock.fast_forward(20000);page.locator('#timerStart').click();page.clock.fast_forward(250000)
   page.locator('#exitFromWorkout').click();page.clock.fast_forward(5000);page.locator('#exitCancel').click();expect(page.locator('#sessionElapsed')).to_have_text('12:35')
   page.locator('#exitFromWorkout').click();page.locator('#exitConfirm').click();expect(page.locator('#exitScreen')).to_be_visible();data=page.evaluate("JSON.parse(localStorage.getItem('heechans-football-growth-v1'))");assert data['sessions'][0]['seconds']==755 and len(data['sessions'][0]['completedItems'])==1 and data['records'][0]['id']=='old',data
   page.locator('#exitReturn').click();page.locator('[data-view=records]').click();expect(page.locator('#recordList')).to_contain_text('12:35');page.reload(wait_until='networkidle');assert page.evaluate("JSON.parse(localStorage.getItem('heechans-football-growth-v1')).sessions.length")==1
   page.locator('[data-view=training]').click();page.locator('#allSessions .session').nth(3).locator('button').click();page.locator('#timerStart').click();page.clock.fast_forward(1800000);expect(page.locator('#goalNotice')).to_be_visible();page.locator('#goalContinue').click();page.clock.fast_forward(5000);page.reload(wait_until='networkidle');expect(page.locator('#recoveryControls')).to_be_visible();page.locator('#recoverySeconds').fill('1805');page.locator('#recoveryFinish').click();data=page.evaluate("JSON.parse(localStorage.getItem('heechans-football-growth-v1'))");assert data['sessions'][0]['seconds']==1805 and len(data['sessions'])==2,data
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert not errors,errors
   ctx.close();print('PASS',width,'original records preserved, schedule, elapsed, pause, exit cancel, goal, recovery')
  ctx=browser.new_context();page=ctx.new_page();page.clock.install(time=datetime(2026,10,28,1,0,tzinfo=timezone.utc));page.clock.pause_at(datetime(2026,10,28,1,0,tzinfo=timezone.utc));page.goto(url,wait_until='networkidle');page.locator('[data-view=training]').click();page.locator('#allSessions .session').nth(2).locator('button').click();page.locator('#timerStart').click();page.clock.fast_forward(10000)
  page.evaluate("""() => {const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.endsWith('-active-session'))throw new DOMException('저장 공간이 부족해요','QuotaExceededError');return original.call(this,k,v)}}""")
  page.locator('#exitFromWorkout').click();page.locator('#exitConfirm').click();expect(page.locator('#exitDialog')).to_be_visible();expect(page.locator('#exitError')).to_contain_text('저장하지 못했어요');assert page.evaluate("localStorage.getItem('heechans-football-growth-v1')") is None
  ctx.close();print('PASS storage failure: exit remains open and original data is not overwritten')
  browser.close()
finally:server.shutdown();server.server_close()
