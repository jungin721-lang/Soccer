"""Independent desktop/mobile sessions against a real local server; synthetic data only."""
import ast
import json
import os
from pathlib import Path
import socket
import subprocess
from tempfile import TemporaryDirectory
import time
from urllib.request import urlopen
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
# Reuse the schema-valid synthetic feedback fixture without running its suite.
source = ast.parse((ROOT / 'tests/feedback-browser.py').read_text())
fixture_node = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'fixture')
namespace = {'CANARY': 'SYNTHETIC_SYNC_TEST'}
exec(compile(ast.Module(body=[fixture_node], type_ignores=[]), '<synthetic fixture>', 'exec'), namespace)
report = namespace['fixture']()
PASSWORD = 'Synthetic-Password-2026'

with TemporaryDirectory(prefix='next-xi-sync-') as temporary:
    tmp = Path(temporary)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env = dict(os.environ, PORT=str(port), NEXT_XI_DATA_DIR=str(tmp/'data'))
    for key in ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','OPENAI_API_KEY','SOCCER_AI_API_KEY']:
        env.pop(key, None)
    with (tmp/'server.log').open('w') as log:
        server = subprocess.Popen(['node','server.js'], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            for attempt in range(100):
                try:
                    urlopen(base+'/api/v2/auth/me', timeout=1).close(); break
                except OSError: time.sleep(.1)
            else: raise AssertionError('Server not ready')
            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
                contexts = [browser.new_context(base_url=base, viewport={'width':w,'height':900}, is_mobile=w<500, has_touch=w<500) for w in [1440,390,320]]
                desktop, mobile, outsider = contexts
                def post(context, path, data):
                    return context.request.post(base+'/api/v2'+path, data=data, headers={'Origin':base})
                def register(context,email):
                    response=post(context,'/auth/register',{'email':email,'password':PASSWORD,'guardianName':'합성 보호자','adult':True,'guardianConsent':True})
                    assert response.status==201,response.text()
                def login(context):
                    assert post(context,'/auth/login',{'email':'sync@example.test','password':PASSWORD}).status==200
                register(desktop,'sync@example.test'); login(mobile); register(outsider,'other@example.test')
                d,m,o = [context.new_page() for context in contexts]
                errors=[]
                for page in [d,m,o]:
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(base, wait_until='networkidle')
                def profile(page):
                    page.get_by_role('button',name='선수 설정',exact=True).click()
                    return page.locator('#profile-form')
                def save(form): form.locator('button[type=submit]').click()
                # Real UI edit on desktop must appear on mobile without reload or job changes.
                form=profile(d);form.locator('[name=name]').fill('동기화 선수');save(form)
                expect(m.locator('.player-chip strong')).to_have_text('동기화 선수',timeout=15000)
                # A stale mobile form merges a distinct field, retaining the remote name.
                mf=profile(m);mf.locator('[name=position]').fill('합성 MF')
                df=profile(d);df.locator('[name=name]').fill('다른 기기 변경');save(df)
                save(mf);expect(m.locator('#profile-form')).to_have_count(0)
                record=mobile.request.get(base+'/api/v2/workspace').json()
                assert record['profile']['name']=='다른 기기 변경' and record['profile']['position']=='합성 MF'
                expect(d.locator('#sync-status')).to_contain_text('최신',timeout=15000)
                # Same-field changes must fail visibly and keep the typed input.
                mf=profile(m);mf.locator('[name=name]').fill('충돌한 입력')
                df=profile(d);df.locator('[name=name]').fill('서버 최신 이름');save(df)
                save(mf);expect(m.locator('#toast')).to_contain_text('같은 항목')
                expect(mf.locator('[name=name]')).to_have_value('충돌한 입력')
                assert mobile.request.get(base+'/api/v2/workspace').json()['profile']['name']=='서버 최신 이름'
                m.get_by_role('button',name='닫기',exact=True).click()
                # A failed offline save keeps the input and never reports success.
                mf=profile(m);mf.locator('[name=name]').fill('오프라인 미저장 입력')
                mobile.set_offline(True);save(mf)
                expect(m.locator('#toast')).to_contain_text('서버에 연결하지 못했어요')
                expect(mf.locator('[name=name]')).to_have_value('오프라인 미저장 입력')
                mobile.set_offline(False)
                assert mobile.request.get(base+'/api/v2/workspace').json()['profile']['name']=='서버 최신 이름'
                m.get_by_role('button',name='닫기',exact=True).click()
                # Server-backed practice records automatically refresh the other device's plan.
                m.goto(base+'/#plan', wait_until='networkidle')
                record=desktop.request.get(base+'/api/v2/workspace').json()
                record['practices'].append({'id':str(uuid4()),'date':record['profile']['planStart'],'taskId':'synthetic-task','completed':True,'note':'합성 실천 기록'})
                response=desktop.request.put(base+'/api/v2/workspace',data=record,headers={'Origin':base});assert response.status==200,response.text()
                expect(m.locator('#main')).to_contain_text('최근 기록 1개',timeout=15000)
                # Real original upload, private access from the second account session.
                movie=tmp/'synthetic.mp4'
                subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p',str(movie)],check=True)
                content=movie.read_bytes()
                response=post(desktop,'/uploads',{'rightsConsent':True,'fileName':'synthetic.mp4','title':'합성 동기화 영상','size':len(content),'mime':'video/mp4','target':{'kit':'navy','number':11,'age':11},'context':{}})
                assert response.status==201,response.text()
                upload=response.json()['upload']
                response=desktop.request.put(base+'/api/v2/uploads/'+upload['id'],data=content,headers={'Origin':base,'Upload-Offset':'0','Content-Type':'application/octet-stream'});assert response.status==200,response.text()
                response=post(desktop,'/uploads/'+upload['id']+'/complete',{});assert response.status==200,response.text()
                video=response.json()['workspace']['videos'][0]
                m.goto(base+'/#videos',wait_until='networkidle');expect(m.locator('#main')).to_contain_text('합성 동기화 영상',timeout=15000)
                response=mobile.request.get(base+'/api/v2/media/'+video['id']);assert response.status==200 and response.body()==content
                assert outsider.request.get(base+'/api/v2/media/'+video['id']).status==404
                # Local feedback never uploads until explicitly saved to the account.
                d.goto(base+'/feedback.html',wait_until='networkidle');m.goto(base+'/feedback.html',wait_until='networkidle');o.goto(base+'/feedback.html',wait_until='networkidle')
                d.locator('.paste-details summary').click();d.locator('#feedback-text').fill(json.dumps(report));d.locator('#import-text').click()
                expect(d.locator('#feedback-report h2')).to_have_text(report['title'])
                assert desktop.request.get(base+'/api/v2/feedback').json()['reports']==[]
                d.locator('#save-account-feedback').click()
                expect(d.locator('#account-feedback-status')).to_contain_text('비공개 저장')
                expect(m.locator('#account-feedback-list')).to_contain_text(report['title'],timeout=15000)
                m.locator('#account-feedback-list button').first.click();expect(m.locator('#feedback-report h2')).to_have_text(report['title'])
                expect(o.locator('#account-feedback-list button')).to_have_count(0)
                # Session expiry clears the cloud preview; re-login and reload restores records.
                post(mobile,'/auth/logout',{});m.locator('#refresh-account-feedback').click();expect(m.locator('#feedback-report')).to_be_hidden()
                login(mobile);m.reload(wait_until='networkidle');expect(m.locator('#account-feedback-list')).to_contain_text(report['title'])
                m.goto(base,wait_until='networkidle');expect(m.locator('.player-chip strong')).to_have_text('서버 최신 이름')
                assert len(mobile.request.get(base+'/api/v2/workspace').json()['practices'])==1
                for page in [d,m,o]:
                    size=page.evaluate('({width:innerWidth,content:document.documentElement.scrollWidth})')
                    assert size['content']<=size['width'],size
                assert not errors,errors
                browser.close()
                print('PASS: independent 1440/390/320px account sessions, automatic profile/practice refresh, stale-form merge and conflict preservation, real MP4 cross-session private bytes, explicit feedback upload/automatic sync/isolation, offline input preservation, session expiry, re-login/reload and responsive layout. Synthetic data only; no live AI or Netlify deployment tested.')
        finally:
            server.terminate();server.wait(timeout=10)
