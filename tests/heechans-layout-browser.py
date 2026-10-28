"""Exercise the original app layout with a clickable Netlify badge fixture."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT/'public')))
Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width,height in [(320,640),(390,844),(640,320),(844,390),(1440,900)]:
   ctx=browser.new_context(viewport={'width':width,'height':height});page=ctx.new_page()
   page.goto(base+'/heechans/index.html',wait_until='networkidle')
   page.evaluate('''() => {
    if(innerWidth>500&&innerHeight<500) document.documentElement.style.setProperty('font-size','24px','important');
    const f=document.createElement('iframe');f.id='nl-badge-frame';f.title='Powered by Netlify';
    f.style.cssText='position:fixed;right:0;bottom:0;width:216px;height:92px;border:0;z-index:2147483645';
    f.srcdoc='<button>Powered by Netlify</button>';document.body.append(f);
    document.querySelector('#workoutOverlay').classList.add('show');
    document.querySelector('#workoutExercises').innerHTML='<div style="height:650px"></div><button id="lastControl" class="secondary">저장</button>';
   }''')
   badge=page.locator('#nl-badge-frame').bounding_box()
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   for sel in ['#timerStart','#lastControl','#exitFromWorkout','#finishSession']:
    button=page.locator(sel);button.scroll_into_view_if_needed();box=button.bounding_box()
    assert box['y']+box['height']<=badge['y'],(width,height,sel,box,badge)
   page.evaluate('document.querySelector("#workoutOverlay").classList.remove("show"); document.querySelector("#exitDialog").showModal()')
   dialog=page.locator('#exitDialog');expect(dialog).to_be_visible();box=dialog.bounding_box()
   assert box['y']+box['height']<=badge['y'],(width,height,box,badge)
   page.locator('#exitCancel').click()
   page.frame_locator('#nl-badge-frame').get_by_role('button',name='Powered by Netlify').click()
   ctx.close();print(f'PASS {width}x{height}: controls and exit dialog clear visible badge fixture')
  browser.close()
finally:server.shutdown();server.server_close()
