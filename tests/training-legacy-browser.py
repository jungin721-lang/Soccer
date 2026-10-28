"""Legacy timer migration and previously accepted record recovery."""
from datetime import datetime,timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright,expect
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(Path(__file__).resolve().parents[1]/'public'/'training')));Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for accepted in (False,True):
   ctx=browser.new_context();page=ctx.new_page();claims=[];profile={'nickname':'희찬','mode':30,'guardian':True,'healthConsent':False};old={'id':'legacy:2026-10-21:am','date':'2026-10-21','slot':'am','mode':10,'seconds':20,'status':'stopped','checks':[]};state={'version':1,'profile':profile,'sessions':[old] if accepted else [],'records':[],'draft':None};revision=[0];enabled=[False]
   def route(r):
    req=r.request
    if not enabled[0]:r.fulfill(status=401,json={'error':'not signed in'});return
    if req.url.endswith('/auth/me'):r.fulfill(json={'user':{'id':'u1','email':'guardian@example.test'}});return
    if req.url.endswith('/training/session-lock'):
     data=req.post_data_json;claims.append(data);r.fulfill(json={'userId':'u1','locks':[]});return
    if req.url.endswith('/training'):
     if req.method=='PUT':
      body=req.post_data_json;state.update(body['data']);revision[0]+=1
     r.fulfill(json={'userId':'u1','revision':revision[0],'data':state});return
    r.fulfill(status=404,json={'error':'not found'})
   ctx.route('**/api/v2/**',route);page.clock.install(time=datetime(2026,10,21,0,0,tzinfo=timezone.utc));page.goto(base,wait_until='networkidle')
   page.evaluate('''async profile=>{const db=await new Promise((ok,fail)=>{const r=indexedDB.open('next-step-training-v1',1);r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error)}); const draft={date:'2026-10-21',slot:'am',mode:10,plan:[{id:'warm',seconds:600}],index:0,checks:[],finished:0,timer:{limit:600000,accumulated:10000,startedAt:Date.now()}};const data={version:1,profile,sessions:[],records:[],draft};await new Promise((ok,fail)=>{const tx=db.transaction('state','readwrite');tx.objectStore('state').put({revision:0,data},'account:u1');tx.oncomplete=ok;tx.onerror=()=>fail(tx.error)});db.close()}''',profile)
   enabled[0]=True;page.reload(wait_until='networkidle')
   if accepted:
    expect(page.locator('[data-action=close-saved-legacy]')).to_be_visible();page.locator('[data-action=close-saved-legacy]').click();expect(page.locator('#notice')).to_contain_text('기록을 보존');assert not claims;assert state['sessions']==[old]
   else:
    expect(page.locator('#recovery-seconds')).to_be_visible();page.locator('#recovery-seconds').fill('20');page.locator('[data-action=recover-resume]').click();expect(page.locator('[data-action=toggle-timer]')).to_have_text('일시정지');assert len(claims)==1 and claims[0]['action']=='claim' and len(claims[0]['id'])==36 and claims[0]['id']!=old['id'];page.locator('[data-action=stop-session]').click();expect(page.locator('#active-title')).to_have_count(0);assert len(state['sessions'])==1 and state['sessions'][0]['id']==claims[0]['id'];assert claims[-1]['action']=='release'
   ctx.close();print('PASS legacy recovery accepted=',accepted)
  browser.close()
finally:server.shutdown();server.server_close()
