"""Session clock and recovery with real IndexedDB and browser clock."""
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT/'public'/'training')))
Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in (320,390,1440):
   ctx=browser.new_context(viewport={'width':width,'height':800});page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.clock.install(time=datetime(2026,10,21,0,0,tzinfo=timezone.utc));page.clock.pause_at(datetime(2026,10,21,0,0,tzinfo=timezone.utc));page.goto(base,wait_until='networkidle')
   page.get_by_role('link',name='설정·백업',exact=True).click();page.locator('[name=guardian]').check();page.locator('#profile-form button').click();expect(page.locator('#notice')).to_contain_text('설정을 이 기기에 저장')
   page.get_by_role('link',name='오늘 연습',exact=True).click();page.locator('[data-action=begin]').click();page.locator('[data-action=toggle-timer]').click();expect(page.locator('[data-action=toggle-timer]')).to_have_text('일시정지')
   page.clock.fast_forward(500000);page.locator('[data-action=toggle-timer]').click();expect(page.locator('[data-action=toggle-timer]')).to_have_text('재개');page.clock.fast_forward(20000);page.locator('[data-action=toggle-timer]').click();expect(page.locator('[data-action=toggle-timer]')).to_have_text('일시정지');page.clock.fast_forward(250000)
   page.locator('[data-action=exit-app]').click();expect(page.locator('#exit-dialog')).to_be_visible();page.clock.fast_forward(5000);page.locator('[data-action=cancel-exit]').click();expect(page.locator('#session-time')).to_have_text('12:35')
   page.locator('[data-action=exit-app]').click();page.locator('[data-action=confirm-exit]').click();expect(page.locator('#main')).to_contain_text('훈련 앱을 나왔어요');page.locator('[data-action=return-app]').click();page.get_by_role('link',name='나의 기록',exact=True).click();expect(page.locator('.history-row').first).to_contain_text('12:35')
   page.reload(wait_until='networkidle');expect(page.locator('.history-row').first).to_contain_text('12:35')
   page.get_by_role('link',name='오늘 연습',exact=True).click();page.locator('[data-slot=pm]').click();page.locator('[data-action=begin]').click();page.locator('[data-action=toggle-timer]').click();expect(page.locator('[data-action=toggle-timer]')).to_have_text('일시정지');page.clock.fast_forward(1800000);expect(page.locator('#goal-controls')).to_be_visible();page.locator('[data-action=goal-continue]').click();expect(page.locator('#goal-controls')).to_be_hidden();page.clock.fast_forward(5000)
   page.reload(wait_until='networkidle');expect(page.locator('#recovery-seconds')).to_be_visible();page.locator('#recovery-seconds').fill('1805');page.locator('[data-action=recover-finish]').click();page.get_by_role('link',name='나의 기록',exact=True).click();expect(page.locator('#main')).to_contain_text('30:05');assert page.locator('.history-row').count()==2
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert not errors,errors
   ctx.close();print('PASS',width,'pause, resume, early finish, exit cancel, 30min goal, continuing, reload recovery, dedup')
  # Another tab modifies the IndexedDB revision while an exit is pending.
  ctx=browser.new_context();page=ctx.new_page();page.clock.install(time=datetime(2026,10,21,0,0,tzinfo=timezone.utc));page.clock.pause_at(datetime(2026,10,21,0,0,tzinfo=timezone.utc));page.goto(base,wait_until='networkidle')
  page.get_by_role('link',name='설정·백업',exact=True).click();page.locator('[name=guardian]').check();page.locator('#profile-form button').click();expect(page.locator('#notice')).to_contain_text('설정을 이 기기에 저장')
  page.get_by_role('link',name='오늘 연습',exact=True).click();page.locator('[data-action=begin]').click();page.locator('[data-action=toggle-timer]').click();expect(page.locator('[data-action=toggle-timer]')).to_have_text('일시정지');page.clock.fast_forward(10000)
  other=ctx.new_page();other.goto(base+'/#settings',wait_until='networkidle');other.locator('[name=nickname]').fill('보호자 확인');other.locator('#profile-form button').click();expect(other.locator('#notice')).to_contain_text('설정을 이 기기에 저장')
  page.locator('[data-action=exit-app]').click();page.locator('[data-action=confirm-exit]').click();expect(page.locator('#exit-dialog')).to_be_visible();expect(page.locator('#exit-error')).to_contain_text('다른 탭에서 기록이 바뀌었어요')
  page.locator('[data-action=cancel-exit]').click();page.reload(wait_until='networkidle');expect(page.locator('#recovery-seconds')).to_be_visible();page.locator('#recovery-seconds').fill('10');page.locator('[data-action=recover-finish]').click();page.get_by_role('link',name='나의 기록',exact=True).click();expect(page.locator('.history-row').first).to_contain_text('00:10');assert page.locator('.history-row').count()==1
  ctx.close();print('PASS conflict: exit error remains visible, persisted draft restored, retry creates one record')
  browser.close()
finally:
 server.shutdown();server.server_close()
