"""Two independent authenticated devices plus a separate owner, with real local API/SQLite."""
from datetime import datetime,timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import os,socket,subprocess,time
from urllib.request import urlopen
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
PASSWORD='Synthetic-Password-2026'
with TemporaryDirectory(prefix='training-sync-') as temporary:
 tmp=Path(temporary)
 with socket.socket() as listener:
  listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
 base=f'http://127.0.0.1:{port}'
 env=dict(os.environ,PORT=str(port),NEXT_XI_DATA_DIR=str(tmp/'data'))
 for key in ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','OPENAI_API_KEY','SOCCER_AI_API_KEY']:env.pop(key,None)
 with (tmp/'server.log').open('w') as log:
  server=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=log,stderr=log)
  try:
   for attempt in range(100):
    try:urlopen(base+'/api/v2/auth/me',timeout=1).close();break
    except OSError:time.sleep(.1)
   else:raise AssertionError('Server not ready')
   with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    contexts=[browser.new_context(base_url=base,viewport={'width':w,'height':900},timezone_id='Asia/Seoul') for w in [1440,390,320]]
    desktop,mobile,other=contexts
    errors=[]
    pages=[ctx.new_page() for ctx in contexts];d,m,o=pages
    for page in pages:
     page.on('pageerror',lambda error:errors.append(str(error)))
     page.clock.install(time=datetime(2026,10,21,0,0,tzinfo=timezone.utc))
     page.goto(base+'/training/index.html',wait_until='networkidle')
    def nav(page,title):page.get_by_role('link',name=title,exact=True).click()
    def profile(page):return page.locator('#profile-form')
    def submit(form):form.locator('button[type=submit]').click()
    def remote(ctx):
     response=ctx.request.get(base+'/api/v2/training');assert response.status==200,response.text();return response.json()
    def auth(page,email,register=False):
     nav(page,'설정·백업');form=page.locator('#cloud-auth');form.locator('[name=email]').fill(email);form.locator('[name=password]').fill(PASSWORD)
     if register:
      form.locator('[name=register]').check();form.locator('[name=guardianName]').fill('합성 보호자');form.locator('[name=adult]').check()
     submit(form);expect(page.locator('#storage-badge')).to_contain_text('계정 자동 동기화')
    # Start with meaningful device-only records. Login must not silently upload them.
    nav(d,'설정·백업');form=profile(d);form.locator('[name=nickname]').fill('보존할 기기 원본');form.locator('[name=guardian]').check();submit(form)
    expect(d.locator('#notice')).to_contain_text('설정을 이 기기에 저장')
    nav(d,'오늘 연습');d.locator('[data-action=begin]').click();expect(d.locator('#active-title')).to_have_count(1);d.locator('[data-action=stop-session]').click();expect(d.locator('#active-title')).to_have_count(0)
    auth(d,'training-sync@example.test',True)
    assert remote(desktop)['data']['sessions']==[]
    assert d.evaluate("async()=> (await (await import('./store.js')).read()).data.sessions.length")==1
    expect(profile(d).locator('[name=nickname]')).to_have_value('희찬')
    d.locator('details').filter(has=d.locator('#migrate-consent')).locator('summary').click()
    d.locator('#migrate-consent').check();d.locator('#migrate-profile').check();d.locator('[data-action=migrate-local]').click()
    expect(d.locator('#notice')).to_contain_text('기기 원본을 유지')
    assert len(remote(desktop)['data']['sessions'])==1
    assert d.evaluate("async()=> (await (await import('./store.js')).read()).data.profile.nickname")=='보존할 기기 원본'
    auth(m,'training-sync@example.test')
    expect(profile(m).locator('[name=nickname]')).to_have_value('보존할 기기 원본')
    auth(o,'training-other@example.test',True)
    assert remote(other)['data']['sessions']==[]
    # No reload/navigation on mobile: a desktop settings edit must appear automatically.
    form=profile(d);form.locator('[name=nickname]').fill('계정 자동 반영');submit(form)
    expect(m.locator('.brand small')).to_have_text('계정 자동 반영의 다음 한 걸음',timeout=15000)
    # Preserve stale input on a true same-field collision.
    mf=profile(m);mf.locator('[name=nickname]').fill('모바일 충돌 입력')
    df=profile(d);df.locator('[name=nickname]').fill('서버 최신 이름');submit(df)
    expect(d.locator('#notice')).to_contain_text('설정을 계정에 저장')
    submit(mf);expect(m.locator('#notice')).to_contain_text('같은 항목이 다른 기기에서')
    expect(mf.locator('[name=nickname]')).to_have_value('모바일 충돌 입력')
    assert remote(mobile)['data']['profile']['nickname']=='서버 최신 이름'
    m.once('dialog',lambda dialog:dialog.accept());m.locator('[data-action=cloud-refresh]').click();expect(profile(m).locator('[name=nickname]')).to_have_value('서버 최신 이름')
    # Different profile fields from stale snapshots merge safely.
    mf=profile(m);mf.locator('[name=mode]').select_option('20')
    df=profile(d);df.locator('[name=nickname]').fill('서로 다른 항목 병합');submit(df)
    expect(d.locator('#notice')).to_contain_text('설정을 계정에 저장')
    submit(mf);expect(m.locator('#notice')).to_contain_text('설정을 계정에 저장')
    state=remote(mobile)['data'];assert state['profile']['mode']==20 and state['profile']['nickname']=='서로 다른 항목 병합'
    # Both devices run their own timer; completed records converge without replacing lists.
    for page in [d,m]:
     nav(page,'오늘 연습');page.locator('[data-slot=pm]').click();page.locator('[data-action=begin]').click();expect(page.locator('#active-title')).to_have_count(1)
    assert remote(desktop)['data']['draft'] is None
    # Lose a successful PUT response. A retry must recognize the timer UUID,
    # preserve the already stored elapsed time and avoid a duplicate record.
    lost=[False]
    def lose_success(route):
     if route.request.method=='PUT' and not lost[0]:
      response=route.fetch();assert response.status==200;lost[0]=True;route.abort('failed')
     else:route.continue_()
    d.route('**/api/v2/training',lose_success)
    d.locator('[data-action=stop-session]').click();expect(d.locator('#notice')).to_contain_text('서버에 연결하지 못했어요')
    assert len(remote(desktop)['data']['sessions'])==2
    d.unroute('**/api/v2/training',lose_success)
    d.locator('[data-action=stop-session]').click();expect(d.locator('#active-title')).to_have_count(0)
    assert len(remote(desktop)['data']['sessions'])==2
    m.locator('[data-action=stop-session]').click();expect(m.locator('#active-title')).to_have_count(0)
    assert len(remote(desktop)['data']['sessions'])==3
    nav(d,'나의 기록');expect(d.locator('#main')).to_contain_text('3번의 연습·휴식 선택',timeout=15000)
    assert len(remote(other)['data']['sessions'])==0
    # Failed offline writes keep the exact form; reconnect and explicit retry succeeds.
    nav(m,'설정·백업');mf=profile(m);mf.locator('[name=nickname]').fill('오프라인 입력 유지')
    mobile.set_offline(True);submit(mf);expect(m.locator('#notice')).to_contain_text('서버에 연결하지 못했어요');expect(mf.locator('[name=nickname]')).to_have_value('오프라인 입력 유지')
    assert remote(desktop)['data']['profile']['nickname']!='오프라인 입력 유지'
    mobile.set_offline(False);submit(mf);expect(m.locator('#notice')).to_contain_text('설정을 계정에 저장')
    # Server session expiry clears account content and reveals only the original local library.
    response=mobile.request.post(base+'/api/v2/auth/logout',data={},headers={'Origin':base});assert response.status==200
    expect(m.locator('#storage-badge')).to_have_text('◈ 기기 내 저장',timeout=15000)
    expect(profile(m).locator('[name=nickname]')).to_have_value('희찬')
    auth(m,'training-sync@example.test');m.reload(wait_until='networkidle');expect(profile(m).locator('[name=nickname]')).to_have_value('오프라인 입력 유지')
    assert len(remote(mobile)['data']['sessions'])==3
    # Explicit logout preserves the desktop's untouched pre-login local record.
    nav(d,'설정·백업');d.locator('[data-action=cloud-logout]').click();expect(d.locator('#storage-badge')).to_have_text('◈ 기기 내 저장')
    expect(profile(d).locator('[name=nickname]')).to_have_value('보존할 기기 원본')
    nav(d,'나의 기록');expect(d.locator('#main')).to_contain_text('1번의 연습·휴식 선택')
    for page in pages:
     size=page.evaluate('({w:innerWidth,s:document.documentElement.scrollWidth})');assert size['s']<=size['w'],size
    assert not errors,errors
    browser.close()
    print('PASS: independent PC/mobile/other-owner sessions; UI signup/login, no implicit upload, explicit migration preserving originals, automatic settings/history sync, same-field conflict preservation, disjoint field/session merge, per-device timers, offline/lost-response retry without duplicates, expiry/re-login/reload, owner isolation and local logout recovery. Local SQLite API only; production deployment unverified.')
  finally:server.terminate();server.wait(timeout=10)
