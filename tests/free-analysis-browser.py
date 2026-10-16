"""Mobile free-analysis UI and private evidence integration, with synthetic media only.

No AI credentials are used and no live model request is made. The account,
resumable upload, private media/evidence reads, and profile save use the real
local server. Completed analysis/evidence records are explicitly synthetic
SQLite fixtures; provider readiness/check/job responses are labeled mocks.
Retention lifecycle and real provider accuracy are not asserted by this test.
"""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
from uuid import uuid4
import json
import os
import socket
import sqlite3
import subprocess
import time

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / '.test-results'
ARTIFACTS.mkdir(exist_ok=True)


def no_overflow(page, label):
    widths = page.evaluate('({viewport:innerWidth,content:document.documentElement.scrollWidth})')
    assert widths['content'] <= widths['viewport'], (label, widths)


def register(page, email):
    page.goto('/', wait_until='networkidle')
    page.locator('[data-action="auth-mode"][data-mode="register"]').click()
    form = page.locator('#auth-form')
    form.locator('[name=guardianName]').fill('합성 테스트 보호자')
    form.locator('[name=email]').fill(email)
    form.locator('[name=password]').fill('Synthetic-Free-Flow-2026')
    form.locator('[name=adult]').check()
    form.locator('[name=guardianConsent]').check()
    form.locator('button[type=submit]').click()
    expect(page.locator('#profile-form')).to_be_visible()
    page.get_by_role('button', name='닫기', exact=True).click()


def fixture_records(data_dir, user_id, original, movie):
    """Seed a completed synthetic report, not an AI run or retention execution."""
    now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    video_id, job_id = str(uuid4()), str(uuid4())
    metadata = dict(original, id=video_id, title='합성 테스트 경기 · 원본 정리 상태',
                    duration=400, sourceStatus='deleted_after_analysis',
                    retentionPolicy='delete_after_analysis', sourceDeletedAt=now,
                    addedAt='2026-10-14T01:00:00.000Z',
                    context=dict(original['context'], matchDate='2026-10-14'))
    video = dict(metadata, userId=user_id, status='ready', chunks=[], chunkSize=2 * 1024 ** 2)
    db = sqlite3.connect(data_dir / 'growth.sqlite')
    def get(key):
        return json.loads(db.execute('SELECT value FROM entries WHERE key=?', (key,)).fetchone()[0])
    def put(key, value, binary=False):
        db.execute('INSERT OR REPLACE INTO entries(key,kind,value) VALUES(?,?,?)',
                   (key, 'binary' if binary else 'json', value if binary else json.dumps(value)))
    workspace = get('workspaces/' + user_id)
    analyses, evidence_ids = [], []
    media = movie.read_bytes()
    for index in range(25):
        analysis_id, evidence_id = str(uuid4()), str(uuid4())
        start = 100 + index * 8
        evidence = dict(id=evidence_id, start=start, end=start + 4, mime='video/mp4', size=len(media))
        key = f'evidence-media/{user_id}/{video_id}/{evidence_id}'
        result = dict(identified=True, summary=f'합성 UI 테스트 구간 {index + 1} · 실제 선수 평가 아님',
                      observations=[dict(skill='move', time=start + 1, note='합성 표시 확인용 관찰이며 실제 플레이가 아닙니다.', type='focus', confidence='medium')],
                      limitations=['합성 테스트 데이터입니다. AI 정확도 검증에 사용할 수 없습니다.'], nextAction='실제 선수 평가로 해석하지 마세요.')
        analyses.append(dict(id=analysis_id, jobId=job_id, videoId=video_id, createdAt=now,
                             start=start, end=start + 4, model='synthetic-test-no-ai', result=result, evidence=evidence))
        put('evidence/' + evidence_id, dict(evidence, userId=user_id, videoId=video_id,
            jobId=job_id, analysisId=analysis_id, sha256=sha256(media).hexdigest(), key=key, createdAt=now))
        put(key, media, binary=True)
        put(f'evidence-owners/{user_id}/{video_id}/{evidence_id}', dict(id=evidence_id))
        evidence_ids.append(evidence_id)
    metadata['evidenceBytes'] = len(media) * 25
    video['evidenceBytes'] = metadata['evidenceBytes']
    workspace['videos'].append(metadata)
    workspace['analyses'] = analyses
    workspace['consents']['analysis'] = True
    workspace['revision'] += 1
    put('videos/' + video_id, video)
    put('workspaces/' + user_id, workspace)
    put('jobs/' + job_id, dict(id=job_id, videoId=video_id, userId=user_id, target=metadata['target'],
        context=metadata['context'], createdAt=now, updatedAt=now, provider='cloudflare', status='completed',
        stage='completed', progress=dict(duration=400, interval=1, sampledCount=401, sampleCount=401,
        completedCount=25, selectedCount=25), attempt=1, clips=[]))
    legacy_id = str(uuid4())
    put('jobs/' + legacy_id, dict(id=legacy_id, videoId=original['id'], userId=user_id,
        target=original['target'], context=original['context'], createdAt=now, updatedAt=now,
        provider='openai', status='failed', stage='failed', progress={}, attempt=1,
        error=dict(code='analysis_quota_exceeded', message='합성 테스트 과거 제공자 오류'), clips=[]))
    db.commit()
    db.close()
    return video_id, evidence_ids, media


with TemporaryDirectory(prefix='next-xi-free-browser-') as temporary:
    temporary = Path(temporary)
    movie = temporary / '합성경기.mp4'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'testsrc2=size=320x180:rate=15', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', str(movie)], check=True)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ)
    for name in list(env):
        if name.startswith('CLOUDFLARE_') or name in ['SOCCER_AI_API_KEY', 'OPENAI_API_KEY', 'SOCCER_ANALYSIS_ACCESS_CODE']:
            env.pop(name, None)
    env.update(PORT=str(port), NEXT_XI_DATA_DIR=str(temporary / 'data'), SOCCER_AI_PROVIDER='cloudflare')
    base = f'http://127.0.0.1:{port}'
    with (temporary / 'server.log').open('w+') as logs:
        server = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=logs, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                if server.poll() is not None:
                    logs.seek(0)
                    raise AssertionError('Local server exited: ' + logs.read()[-2000:])
                try:
                    with urlopen(base + '/api/v2/auth/me', timeout=1):
                        break
                except (HTTPError, URLError, TimeoutError):
                    time.sleep(.1)
            else:
                raise AssertionError('Local server was not ready')
            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
                context = browser.new_context(base_url=base, viewport=dict(width=390, height=844), is_mobile=True, has_touch=True, timezone_id='Asia/Seoul')
                context.set_default_timeout(12000)
                page = context.new_page()
                errors, requests = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('request', lambda request: requests.append((request.method, request.url, request.post_data)))
                register(page, 'free-owner@example.test')
                expect(page.locator('.analysis-service-card')).to_contain_text('연결을 준비 중')
                page.locator('[data-action=upload]').first.click()
                form = page.locator('#upload-form')
                form.locator('input[type=file]').set_input_files(str(movie))
                form.locator('[name=rights]').check()
                consent = form.locator('[name=analysisConsent]')
                if consent.count():
                    consent.check()
                expect(form).not_to_contain_text('OpenAI')
                expect(form.locator('button[type=submit]')).to_contain_text('원본 비공개 저장')
                form.locator('button[type=submit]').click()
                expect(page.get_by_role('dialog')).to_contain_text('아직 분석은 시작하지 않았습니다')
                assert not [r for r in requests if r[0] == 'POST' and r[1].endswith('/jobs')]
                original_workspace = page.request.get('/api/v2/workspace').json()
                original = original_workspace['videos'][0]
                assert page.request.get('/api/v2/media/' + original['id']).status == 200
                page.get_by_role('button', name='닫기', exact=True).click()
                owner = page.request.get('/api/v2/auth/me').json()['user']
                video_id, evidence_ids, media = fixture_records(temporary / 'data', owner['id'], original, movie)
                evidence_url = '/api/v2/evidence/' + evidence_ids[0]
                actual = page.request.get(evidence_url, headers={'Range': 'bytes=0-31'})
                assert actual.status == 206 and actual.body() == media[:32]
                assert actual.headers['cache-control'] == 'private, no-store'
                anonymous = browser.new_context(base_url=base)
                assert anonymous.request.get(evidence_url).status == 404
                other = browser.new_context(base_url=base)
                other_page = other.new_page()
                register(other_page, 'free-other@example.test')
                assert other.request.get(evidence_url).status == 404
                other.close()
                anonymous.close()
                readiness = dict(provider='cloudflare', freeOnly=True, configured=True, available=True, liveVerified=False, reason='ready')
                checks, new_jobs, saved = [], [], []
                def status_route(route):
                    route.fulfill(json=readiness)
                def check_route(route):
                    checks.append(route.request.post_data)
                    readiness['liveVerified'] = True
                    route.fulfill(json={'available': True, 'verified': True})
                def jobs_route(route):
                    if route.request.method == 'POST':
                        new_jobs.append(json.loads(route.request.post_data))
                        route.fulfill(status=202, json={'job': {'id': str(uuid4()), 'status': 'queued'}})
                    else:
                        route.continue_()
                def workspace_route(route):
                    if route.request.method == 'PUT':
                        saved.append(json.loads(route.request.post_data))
                    route.continue_()
                page.route('**/api/v2/status', status_route)
                page.route('**/api/v2/analysis/check', check_route)
                page.route('**/api/v2/jobs', jobs_route)
                page.route('**/api/v2/workspace', workspace_route)
                page.reload(wait_until='networkidle')
                expect(page.locator('.analysis-service-card')).to_contain_text('응답 확인 대기')
                page.locator('[data-action=check-free-analysis]').click()
                expect(page.locator('.analysis-service-card')).to_contain_text('무료 분석 연결 확인')
                assert checks == ['{}']
                for width in [390, 320]:
                    page.set_viewport_size(dict(width=width, height=844))
                    page.goto('/#videos', wait_until='networkidle')
                    removed_card = page.locator('.video-card').filter(has=page.locator(f'[data-video-id="{video_id}"]'))
                    expect(removed_card).to_contain_text('큰 원본은 자동 삭제했어요')
                    assert '/evidence/' in removed_card.locator('video').get_attribute('src')
                    removed_card.locator('[data-video-id]').click()
                    expect(page.locator('.report-context')).to_contain_text('합성 테스트 경기')
                    expect(page.locator('.evidence-card')).to_have_count(20)
                    page.locator('[data-action=more-analysis]').click()
                    expect(page.locator('.evidence-card')).to_have_count(25)
                    page.locator('.evidence-card [data-action=evidence]').first.click()
                    player = page.locator('#evidence-video')
                    expect(player).to_have_attribute('src', evidence_url + '#t=1')
                    for _ in range(100):
                        if player.evaluate('(v)=>v.readyState>=2&&v.currentTime>=.95'):
                            break
                        time.sleep(.05)
                    else:
                        raise AssertionError('Evidence did not seek/play')
                    player.evaluate('(v)=>v.pause()')
                    assert player.evaluate('(v)=>v.duration') >= 3.9
                    assert 1 <= player.evaluate('(v)=>v.currentTime') < 3
                    expect(page.get_by_role('dialog')).to_contain_text('원본 01:41')
                    expect(page.locator('#evidence-error')).to_be_hidden()
                    no_overflow(page, f'evidence {width}')
                    assert page.get_by_role('button', name='닫기', exact=True).bounding_box()['height'] >= 44
                    page.get_by_role('button', name='닫기', exact=True).click()
                    no_overflow(page, f'growth {width}')
                    page.screenshot(path=str(ARTIFACTS / f'free-analysis-synthetic-{width}.png'))
                assert not [r for r in requests if '/api/v2/media/' + video_id in r[1]]
                page.goto('/#videos', wait_until='networkidle')
                active_card = page.locator('.video-card').filter(has=page.locator(f'[data-action=analyze][data-id="{original["id"]}"]'))
                active_card.locator('[data-action=analyze]').click()
                expect(page.get_by_role('dialog')).to_contain_text('Cloudflare Workers AI')
                assert not new_jobs
                page.locator('#analysis-agree').check()
                page.locator('[data-action=confirm-analysis]').click()
                expect(page.get_by_role('dialog')).to_have_count(0)
                assert new_jobs == [dict(videoId=original['id'], analysisConsent=True, provider='cloudflare')]
                page.locator('.avatar').click()
                page.locator('#profile-form [name=name]').fill('합성 테스트 별명')
                page.locator('#profile-form button[type=submit]').click()
                expect(page.get_by_role('dialog')).to_have_count(0)
                assert len(saved) == 1 and not {'videos', 'analyses', 'jobs'}.intersection(saved[0])
                preserved = page.request.get('/api/v2/workspace').json()
                assert len(preserved['analyses']) == 25 and len(preserved['videos']) == 2
                readiness.update(available=False, reason='provider_quota', liveVerified=False, retryAt='2026-10-17T00:00:00.000Z')
                page.reload(wait_until='networkidle')
                expect(page.locator('.analysis-service-card')).to_contain_text('오전 9시')
                expect(page.locator('.analysis-service-card')).to_contain_text('유료 분석으로 전환하지 않아요')
                no_overflow(page, 'quota 320')
                assert not [r for r in requests if not r[1].startswith(base)]
                assert not errors, errors
                context.close()
                browser.close()
                print('PASS: real synthetic source upload with missing credentials preserves source without jobs; real private evidence Range/playback/anonymous and other-owner 404; 390/320 mobile original-deleted UI, relative seek, 20+5 report pagination, fresh Cloudflare consent for legacy failure, synthetic-only check payload, server-owned records omitted from profile save, quota waiting and no external requests. No live AI or actual-player accuracy test.')
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
