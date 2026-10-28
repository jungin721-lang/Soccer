"""Exercise the real styles with a visible, interactive public Netlify badge fixture."""
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT/'public')))
Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  for width,height in [(320,640),(390,844),(900,700),(1024,768),(1280,800)]:
   context=browser.new_context(viewport={'width':width,'height':height})
   page=context.new_page();page.goto(base+'/index.html',wait_until='networkidle')
   page.evaluate('''() => {
    document.querySelector('#app').innerHTML='<div class="main-shell"><main class="page"><h1>Spacing fixture</h1><div style="height:1200px"></div><button id="last-control" class="button">마지막 기록 저장</button></main></div><nav class="bottom-nav">'+['오늘','경기','성장','계획','내 공간'].map(s=>'<a href="#">'+s+'</a>').join('')+'</nav>';
    const toast=document.querySelector('#toast');toast.className='toast visible';toast.textContent='저장 확인';
   }''')
   before=page.evaluate('getComputedStyle(document.body).paddingBottom')
   page.evaluate('''() => {const frame=document.createElement('iframe');frame.id='nl-badge-frame';frame.title='Powered by Netlify';frame.style.cssText='position:fixed;bottom:0;right:0;width:216px;height:92px;border:0;z-index:2147483645';frame.srcdoc='<button>Powered by Netlify</button>';document.body.append(frame);}''')
   badge=page.locator('#nl-badge-frame');expect(badge).to_be_visible();badge_box=badge.bounding_box()
   assert page.evaluate('parseFloat(getComputedStyle(document.body).paddingBottom)')>=112
   nav=page.locator('.bottom-nav')
   if nav.is_visible():
    n=nav.bounding_box();assert n['y']+n['height']<=badge_box['y'],(width,n,badge_box)
    for link in nav.locator('a').all():link.click()
   toast=page.locator('#toast').bounding_box();assert toast['y']+toast['height']<=badge_box['y'],(width,toast,badge_box)
   page.evaluate('window.scrollTo(0,document.documentElement.scrollHeight)')
   last=page.locator('#last-control').bounding_box();assert last['y']+last['height']<=badge_box['y'],(width,last,badge_box)
   page.locator('#last-control').click()
   page.evaluate('''() => {document.body.classList.add('modal-open');document.querySelector('#modal-root').innerHTML='<div class="modal-overlay"><section class="modal"><div class="modal-body"><h2>확인 창</h2><button class="button" id="modal-action">확인</button></div></section></div>';}''')
   modal=page.locator('.modal').bounding_box();assert modal['y']+modal['height']<=badge_box['y'],(width,modal,badge_box)
   page.locator('#modal-action').click()
   page.frame_locator('#nl-badge-frame').get_by_role('button',name='Powered by Netlify').click()
   assert page.frame_locator('#nl-badge-frame').locator('button').evaluate('el=>el===document.activeElement')
   page.evaluate("document.querySelector('#modal-root').innerHTML='';document.body.classList.remove('modal-open');document.querySelector('#nl-badge-frame').remove()")
   assert page.evaluate('getComputedStyle(document.body).paddingBottom')==before
   # The independently exported training guide includes its own clearance asset.
   page.goto(base+'/training/index.html',wait_until='networkidle')
   page.evaluate('''() => {const f=document.createElement('iframe');f.id='nl-badge-frame';f.style.cssText='position:fixed;right:0;bottom:0;width:216px;height:92px;border:0;z-index:2147483645';document.body.append(f);document.querySelector('#notice').textContent='기록 저장 확인';}''')
   b=page.locator('#nl-badge-frame').bounding_box();notice=page.locator('#notice').bounding_box();assert notice['y']+notice['height']<=b['y']
   page.get_by_role('link',name='동작 배우기',exact=True).click();page.locator('[data-action=detail]').first.click()
   dialog=page.locator('#exercise-dialog').bounding_box();assert dialog['y']+dialog['height']<=b['y'],(width,dialog,b)
   page.get_by_role('button',name='운동 안내 닫기').click()
   sizes=page.evaluate('({w:innerWidth,s:document.documentElement.scrollWidth})');assert sizes['s']<=sizes['w'],sizes
   context.close();print(f'PASS {width}x{height}: content, mobile navigation, toasts and dialogs clear visible/clickable badge; original spacing returns when badge is absent.')
  # Exercise the real training UI after rotating to a short landscape viewport
  # and increasing inherited text size. The iframe fixture is never hidden.
  for width,height in [(640,320),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height})
   page=context.new_page();page.goto(base+'/training/index.html#guide',wait_until='networkidle')
   page.evaluate('''() => {
    document.documentElement.style.setProperty('font-size','24px','important');
    const f=document.createElement('iframe');f.id='nl-badge-frame';f.title='Powered by Netlify';
    f.style.cssText='position:fixed;right:0;bottom:0;width:216px;height:92px;border:0;z-index:2147483645';
    document.body.append(f);
   }''')
   badge=page.locator('#nl-badge-frame').bounding_box()
   button=page.locator('[data-action=detail]').last;button.scroll_into_view_if_needed()
   box=button.bounding_box();assert box['y']+box['height']<=badge['y'],(width,box,badge)
   button.click();dialog=page.locator('#exercise-dialog').bounding_box()
   assert dialog['y']+dialog['height']<=badge['y'],(width,dialog,badge)
   page.get_by_role('button',name='운동 안내 닫기').click()
   page.get_by_role('button',name='나가기',exact=True).first.click()
   exit_dialog=page.locator('#exit-dialog');expect(exit_dialog).to_be_visible()
   box=exit_dialog.bounding_box();assert box['y']+box['height']<=badge['y'],(width,box,badge)
   exit_dialog.get_by_role('button',name='취소').click()
   sizes=page.evaluate('({w:innerWidth,s:document.documentElement.scrollWidth})');assert sizes['s']<=sizes['w'],sizes
   context.close();print(f'PASS {width}x{height}: landscape and larger text keep the last exercise control and dialog above the badge.')
  browser.close()
finally:server.shutdown();server.server_close()
