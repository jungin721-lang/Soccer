"""New PLAY NOTE UI: real account/upload/private media; no successful AI is simulated."""
from pathlib import Path
from tempfile import TemporaryDirectory
import os,socket,subprocess,time,json
from urllib.request import urlopen
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
with TemporaryDirectory(prefix='play-note-') as tmpdir:
 tmp=Path(tmpdir)
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 base=f'http://127.0.0.1:{port}'
 env=dict(os.environ,PORT=str(port),NEXT_XI_DATA_DIR=str(tmp/'data'))
 for name in ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','OPENAI_API_KEY','SOCCER_AI_API_KEY']:env.pop(name,None)
 with (tmp/'server.log').open('w') as log:
  server=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=log,stderr=log)
  try:
   for _ in range(100):
    try:urlopen(base+'/api/v2/auth/me',timeout=1).close();break
    except OSError:time.sleep(.1)
   else:raise AssertionError('Server unavailable')
   movie=tmp/'synthetic.mp4'
   subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=30','-t','4','-c:v','libx264','-b:v','10M','-pix_fmt','yuv420p','-movflags','+faststart',str(movie)],check=True)
   assert movie.stat().st_size>2*1024**2
   with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    contexts=[browser.new_context(base_url=base,viewport={'width':w,'height':844},accept_downloads=True) for w in [390,1280,320]]
    d,m,o=[c.new_page() for c in contexts];errors=[]
    for page in [d,m,o]:page.on('pageerror',lambda error:errors.append(str(error)));page.goto(base+'/match-review/index.html',wait_until='networkidle')
    def auth(page,email,create=False):
     if create:page.locator('[data-action=auth-mode]').click()
     f=page.locator('#auth-form');f.locator('[name=email]').fill(email);f.locator('[name=password]').fill('Synthetic-Password-2026')
     if create:f.locator('[name=guardianName]').fill('합성 보호자');f.locator('[name=adult]').check()
     f.locator('button[type=submit]').click();expect(page.locator('#upload-form')).to_be_visible()
    auth(d,'review-owner@example.test',True);auth(m,'review-owner@example.test');auth(o,'review-other@example.test',True)
    expect(d.locator('#upload-form button[type=submit]')).to_be_disabled()
    expect(d.locator('#main')).to_contain_text('missing_credentials')
    # Only the CLIENT readiness display is a labeled fixture, to exercise uploading.
    # Actual server credentials remain missing and queueing must fail honestly.
    def ready(route):route.fulfill(status=200,content_type='application/json',body=json.dumps({'provider':'cloudflare','freeOnly':True,'available':True,'configured':True,'liveVerified':False}))
    d.route('**/api/v2/status',ready);d.locator('[data-action=refresh]').click();expect(d.locator('#upload-form button[type=submit]')).to_be_enabled()
    form=d.locator('#upload-form');form.locator('[name=video]').set_input_files(str(movie));expect(d.locator('#file-info')).to_contain_text('브라우저 재생 확인')
    form.locator('[name=title]').fill('합성 원본 업로드 검증');form.locator('[name=kit]').select_option('teal');form.locator('[name=number]').fill('17')
    for name in ['rights','analysis','deletion']:form.locator('[name='+name+']').check()
    lost=[False];offsets=[]
    def interrupt(route):
     if route.request.method=='PUT':
      offsets.append(int(route.request.headers['upload-offset']))
      if not lost[0]:
       response=route.fetch();assert response.status==200;lost[0]=True;route.abort('failed');return
     route.continue_()
    d.route('**/api/v2/uploads/*',interrupt)
    form.locator('button[type=submit]').click();expect(d.locator('#notice')).to_contain_text('서버에 연결하지 못했어요')
    current=contexts[0].request.get(base+'/api/v2/uploads').json()['uploads'];assert len(current)==1 and current[0]['offset']==2*1024**2
    form.locator('button[type=submit]').click();expect(d.locator('.job')).to_have_count(1,timeout=15000)
    expect(d.locator('#notice')).to_contain_text('인증 설정')
    assert offsets[0]==0 and offsets[1]==2*1024**2,offsets
    record=contexts[0].request.get(base+'/api/v2/workspace').json()['videos'][0]
    assert record['retentionPolicy']=='report_only' and record['target']['number']==17 and record['target']['kit']=='teal'
    assert contexts[0].request.get(base+'/api/v2/jobs').json()['jobs']==[]
    expect(d.locator('.result')).to_have_count(0)
    expect(m.locator('.job')).to_have_count(1,timeout=15000)
    url=base+'/api/v2/media/'+record['id'];original=movie.read_bytes()
    for offset in range(0,len(original),1024**2):
     end=min(len(original)-1,offset+1024**2-1);response=contexts[1].request.get(url,headers={'Range':f'bytes={offset}-{end}'});assert response.status==206 and response.body()==original[offset:end+1]
    assert contexts[2].request.get(url).status==404
    expect(o.locator('.job')).to_have_count(0)
    for page in [d,m,o]:
     size=page.evaluate('({w:innerWidth,s:document.documentElement.scrollWidth})');assert size['s']<=size['w'],size
    (ROOT/'.test-results').mkdir(exist_ok=True);d.screenshot(path=str(ROOT/'.test-results/review-mobile.png'),full_page=True)
    d.once('dialog',lambda dialog:dialog.accept());d.locator('[data-action=delete]').click();expect(d.locator('.job')).to_have_count(0)
    expect(m.locator('.job')).to_have_count(0,timeout=15000)
    assert contexts[0].request.get(url).status==404
    # Labeled render-only fixtures verify feedback/limitations/training after video erasure.
    # These responses are not persisted and are not a live AI result.
    state=contexts[0].request.get(base+'/api/v2/workspace').json()
    deleted=dict(record,sourceStatus='deleted_after_analysis',sourceDeletedAt='2026-10-23T00:00:00.000Z',evidenceBytes=0)
    state['videos']=[deleted]
    observation={'identified':True,'summary':'합성 결과 화면 검증','observations':[{'skill':'pass','time':1,'note':'합성 관찰 테스트','type':'focus','confidence':'medium'}],'limitations':['합성 자료이며 실제 경기 분석이 아닙니다.'],'nextAction':'합성 다음 시도'}
    state['analyses']=[{'id':'synthetic-clip','jobId':'synthetic-job','videoId':record['id'],'start':0,'end':2,'createdAt':'2026-10-23T00:00:00.000Z','model':'synthetic-render-only','result':observation}]
    job={'id':'synthetic-job','videoId':record['id'],'createdAt':'2026-10-23T00:00:00.000Z','status':'completed','result':{'identified':True,'summary':'합성 결과 화면 검증'},'progress':{}}
    d.route('**/api/v2/workspace',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(state)))
    d.route('**/api/v2/jobs',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps({'jobs':[job]})))
    d.locator('[data-action=refresh]').click();expect(d.locator('.result')).to_contain_text('합성 관찰 테스트')
    expect(d.locator('.result')).to_contain_text('합성 다음 시도');expect(d.locator('.result')).to_contain_text('확인하지 못한 내용')
    expect(d.locator('.job')).to_contain_text('영상 삭제 완료');expect(d.locator('.job video')).to_have_count(0)
    assert '[{' not in d.locator('.result').inner_text()
    assert not errors,errors
    browser.close();print('PASS: separate PLAY NOTE interface, real guardian accounts, missing-provider upload gate, real MP4/chunk resume after lost response, correct kit/number, report-only opt-in, honest failed AI queue/no fabricated result, same-account private bytes/history, other-owner denial, deletion and 320/390/1280 layouts. Client-ready display was mocked only for upload testing; no live AI success claimed.')
  finally:server.terminate();server.wait(timeout=10)
