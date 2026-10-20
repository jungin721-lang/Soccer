"""Static app regression: real IndexedDB, timer clock, backup files, no external writes."""
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
RESULTS=ROOT/'.test-results'/'training'
RESULTS.mkdir(parents=True,exist_ok=True)
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=os.environ.get('TRAINING_SITE_DIR',str(ROOT/'public'/'training'))))
thread=Thread(target=server.serve_forever,daemon=True);thread.start()
base=f'http://127.0.0.1:{server.server_port}'
try:
 with TemporaryDirectory(prefix='training-browser-') as tmp, sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  for width in [320,390,1440]:
   context=browser.new_context(viewport={'width':width,'height':900},accept_downloads=True,timezone_id='Asia/Seoul')
   errors=[];violations=[]
   def protect(route):
    request=route.request
    if not request.url.startswith(base+'/') or request.method not in ['GET','HEAD']:
     violations.append(request.url);route.abort()
    else: route.continue_()
   context.route('**/*',protect)
   page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   page.clock.install(time=datetime(2026,10,21,0,0,tzinfo=timezone.utc))
   page.goto(base,wait_until='networkidle')
   expect(page.locator('h1')).to_contain_text('희찬')
   expect(page.locator('#main')).to_contain_text('설정·백업에서 로그인하면')
   def nav(name):page.get_by_role('link',name=name,exact=True).click()
   def no_overflow():
    sizes=page.evaluate('({w:innerWidth,s:document.documentElement.scrollWidth})');assert sizes['s']<=sizes['w'],sizes
   nav('설정·백업')
   form=page.locator('#profile-form');form.locator('[name=nickname]').fill('희찬 테스트');form.locator('[name=guardian]').check();form.locator('button[type=submit]').click()
   expect(page.locator('#notice')).to_contain_text('설정을 이 기기에 저장')
   nav('오늘 연습');expect(page.locator('h1')).to_contain_text('희찬 테스트')
   page.locator('#session-mode').select_option('20')
   page.locator('[data-action=begin]').click()
   expect(page.locator('#active-title')).to_have_text('몸 깨우기')
   expect(page.locator('#timer')).to_have_text('03:00')
   page.locator('[data-action=toggle-timer]').click();expect(page.locator('[data-action=toggle-timer]')).to_have_text('일시정지');page.clock.run_for(3000)
   assert page.locator('#timer').inner_text() in ['02:58','02:57','02:56'],page.locator('#timer').inner_text()
   page.locator('[data-action=toggle-timer]').click();expect(page.locator('[data-action=toggle-timer]')).to_have_text('시작·재개');paused=page.locator('#timer').inner_text();page.clock.run_for(4000);expect(page.locator('#timer')).to_have_text(paused)
   page.locator('[data-action=toggle-timer]').click();expect(page.locator('[data-action=toggle-timer]')).to_have_text('일시정지');page.clock.run_for(2000)
   page.reload(wait_until='networkidle');expect(page.locator('#active-title')).to_have_text('몸 깨우기')
   assert page.locator('#timer').inner_text() < paused
   page.locator('[data-action=next-stage]').click();expect(page.locator('#active-title')).to_have_text('밴드 · 앞·옆·뒤')
   expect(page.locator('[data-stage-check]')).to_have_count(6)
   page.locator('[data-stage-check]').first.check()
   page.locator('.player [data-action=detail]').click();expect(page.locator('#exercise-dialog')).to_be_visible();expect(page.locator('#exercise-content')).to_contain_text('문고리·가구에 묶지');page.get_by_role('button',name='운동 안내 닫기').click()
   page.locator('[data-action=toggle-timer]').click();expect(page.locator('[data-action=toggle-timer]')).to_have_text('일시정지')
   nav('동작 배우기');page.clock.fast_forward(300000);nav('오늘 연습')
   expect(page.locator('#timer')).to_have_text('00:00');expect(page.locator('#active-title')).to_have_text('밴드 · 앞·옆·뒤')
   expect(page.locator('#timer-state')).to_contain_text('자동으로 다음 운동을 시작하지 않아요')
   page.locator('[data-action=stop-session]').click();expect(page.locator('#active-title')).to_have_count(0)
   nav('나의 기록');expect(page.locator('.history-row').first).to_contain_text('중단·휴식 선택')
   assert not page.locator('.history-row').first.inner_text().find('통증')>=0
   rf=page.locator('#record-form');rf.locator('[name=metric]').select_option('plank');rf.locator('[name=value]').fill('10');rf.locator('[name=guardian]').check();rf.locator('button[type=submit]').click();expect(page.locator('#notice')).to_contain_text('개인 참고 기록을 저장')
   rf=page.locator('#record-form');rf.locator('[name=value]').fill('12');rf.locator('[name=guardian]').check();rf.locator('button[type=submit]').click();expect(page.locator('#notice')).to_contain_text('주 1회')
   nav('설정·백업')
   with page.expect_download() as info:page.locator('[data-action=export]').click()
   file=Path(tmp)/f'backup-{width}.json';info.value.save_as(file);backup=json.loads(file.read_text())
   assert len(backup['sessions'])==1 and len(backup['records'])==1 and backup['draft'] is None
   assert 'health' not in backup['sessions'][0]
   # Consent applies only to new sensitive entries; revocation clears previously saved entries.
   form=page.locator('#profile-form');form.locator('[name=healthConsent]').check();form.locator('button[type=submit]').click()
   nav('오늘 연습');page.locator('[data-slot=pm]').click();page.locator('#pain').check();page.locator('[data-action=begin]').click()
   nav('나의 기록');expect(page.locator('.history-row').nth(1)).to_contain_text('통증 있음')
   nav('설정·백업');form=page.locator('#profile-form');form.locator('[name=healthConsent]').uncheck();form.locator('button[type=submit]').click()
   nav('나의 기록');assert '통증 있음' not in page.locator('#main').inner_text()
   # Invalid restore must leave old data untouched.
   nav('설정·백업');bad=Path(tmp)/'bad.json';bad.write_text('{"version":999}')
   page.locator('#backup-file').set_input_files(str(bad));expect(page.locator('#notice')).to_contain_text('백업 형식이 맞지')
   # Reset only this test browser, then exercise genuine file restore and repeatability.
   page.once('dialog',lambda dialog:dialog.accept());page.locator('[data-action=delete-all]').click();expect(page.locator('[name=nickname]')).to_have_value('희찬')
   page.locator('#backup-file').set_input_files(str(file));expect(page.locator('#import-preview')).to_contain_text('연습 1개')
   page.locator('#import-profile').check();page.locator('[data-action=import]').click();expect(page.locator('[name=nickname]')).to_have_value('희찬 테스트')
   page.locator('#backup-file').set_input_files(str(file));page.locator('[data-action=import]').click()
   nav('나의 기록');expect(page.locator('#main')).to_contain_text('1번의 연습·휴식 선택')
   page.reload(wait_until='networkidle');expect(page.locator('#main')).to_contain_text('1번의 연습·휴식 선택')
   nav('오늘 연습');page.locator('#session-date').fill('2026-10-25');expect(page.locator('#main')).to_contain_text('일요일은 기술·가동성 중심')
   page.locator('[data-action=begin]').click();expect(page.locator('#notice')).to_contain_text('오늘 날짜에서만')
   # Screenshots document each viewport after restore; no personal data.
   page.locator('#session-date').fill('2026-10-21');no_overflow();page.screenshot(path=str(RESULTS/f'today-{width}.png'),full_page=True)
   for tab in ['동작 배우기','나의 기록','설정·백업']:
    nav(tab);no_overflow()
   # Actual two-tab CAS: a stale settings form must preserve its input and never overwrite.
   if width==1440:
    second=context.new_page();second.on('pageerror',lambda e:errors.append(str(e)))
    second.clock.install(time=datetime(2026,10,21,0,0,tzinfo=timezone.utc))
    second.goto(base+'/#settings',wait_until='networkidle')
    second.locator('[name=nickname]').fill('오래 열린 탭')
    page.locator('[name=nickname]').fill('먼저 저장한 탭');page.locator('#profile-form button[type=submit]').click()
    expect(page.locator('#notice')).to_contain_text('설정을 이 기기에 저장')
    second.locator('#profile-form button[type=submit]').click();expect(second.locator('#notice')).to_contain_text('다른 탭에서 기록이 바뀌었어요')
    expect(second.locator('[name=nickname]')).to_have_value('오래 열린 탭')
    page.reload(wait_until='networkidle');expect(page.locator('[name=nickname]')).to_have_value('먼저 저장한 탭')
    second.close()
   assert not violations,violations
   assert not errors,errors
   context.close()
   print(f'PASS {width}px: genuine IndexedDB persistence, paused/resumed/reloaded/background timer, band checks and guide, stop, weekly record gate, health consent/revocation, JSON export/invalid restore/merge/reload, rest-day preview and responsive routes; zero third-party/write requests or page errors')
  browser.close()
finally:
 server.shutdown();server.server_close()
