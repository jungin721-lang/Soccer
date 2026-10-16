"""Browser integration: real server/account/MP4 storage; no AI credentials or invented analysis.

Run with: python tests/growth-browser.py
Requires installed Chromium, Playwright and FFmpeg. All data is temporary.
Only one upload response is interrupted to exercise the UI's resumable retry.
"""
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
import base64
import json
import os
import socket
import subprocess
import time
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / '.test-results'
ARTIFACTS.mkdir(exist_ok=True)


def workspace(page):
    response = page.request.get('/api/v2/workspace')
    assert response.status == 200, response.status
    return response.json()


def no_overflow(page, context):
    sizes = page.evaluate('({viewport: innerWidth, content: document.documentElement.scrollWidth})')
    assert sizes['content'] <= sizes['viewport'], f'{context}: {sizes}'


def wait_video(locator, expression, timeout=12):
    # Playwright's wait_for_function polls with eval inside the page and violates
    # the application's intentional no-unsafe-eval CSP. CDP evaluation of a
    # supplied function checks the actual video without weakening that policy.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if locator.evaluate(expression):
            return
        time.sleep(0.05)
    raise AssertionError('Video did not reach expected state: ' + expression)


def navigate(page, route):
    page.locator(f'.bottom-nav a[href="#{route}"]').click()
    expect(page.locator(f'.bottom-nav a[href="#{route}"]')).to_have_attribute('aria-current', 'page')
    no_overflow(page, route)


def register(page, email):
    page.locator('[data-action="auth-mode"][data-mode="register"]').click()
    form = page.locator('#auth-form')
    form.locator('[name=guardianName]').fill('테스트 보호자')
    form.locator('[name=email]').fill(email)
    form.locator('[name=password]').fill('Browser-Test-Password-2026')
    form.locator('[name=adult]').check()
    form.locator('[name=guardianConsent]').check()
    form.locator('button[type=submit]').click()
    expect(page.locator('#profile-form')).to_be_visible()


def install_legacy_fixture(page, movie):
    """Create genuine v1 localStorage + IndexedDB data, including a missing blob."""
    return page.evaluate('''async ({bytes, size}) => {
      const {seedState, validateState} = await import('/domain.js');
      const {saveOriginalVideo} = await import('/media-store.js');
      const state = seedState();
      state.player.name = '이전 브라우저 11번';
      const localId = 'local-' + crypto.randomUUID(), missingId = 'local-' + crypto.randomUUID();
      const addedAt = '2026-10-14T01:00:00.000Z';
      const original = {id:localId,kind:'file',title:'이전 기록 · 실제 원본',fileName:'이전의 경기.mp4',size,mime:'video/mp4',duration:4,lastModified:1791939600000,start:0,source:'원본 파일',addedAt};
      state.videos = [original,{...original,id:missingId,title:'이전 기록 · 원본 없음',fileName:'다른 경기.mp4'},state.videos[0]];
      state.observations = [{id:'legacy-first-touch',videoId:localId,skill:'touch',time:1,rating:4,note:'이전 브라우저의 수동 관찰 · 아직 검증하지 않은 첫 터치',type:'strength',createdAt:addedAt},
                            {id:'legacy-missing-pass',videoId:missingId,skill:'pass',time:2,rating:2,note:'원본이 없어도 보존할 이전 수동 메모',type:'focus',createdAt:addedAt}];
      state.completed = ['week1-0-touch','habit-0'];
      state.snapshots = [{id:'legacy-snapshot',createdAt:addedAt,observationCount:2,scores:[4,2,null,null,null,null,null,null]}];
      validateState(state);
      const decoded = Uint8Array.from(atob(bytes),c=>c.charCodeAt(0));
      await saveOriginalVideo(localId,new File([decoded],original.fileName,{type:'video/mp4',lastModified:original.lastModified}));
      localStorage.setItem('next-xi-standalone-v1',JSON.stringify(state));
      return {localId,missingId,serialized:JSON.stringify(state)};
    }''', {'bytes': base64.b64encode(movie.read_bytes()).decode(), 'size': movie.stat().st_size})


def blocked_quota_ui(page, base):
    """A clearly labeled read-only blocked-job fixture; no provider call is made."""
    video = workspace(page)['videos'][-1]
    now = datetime.now(timezone.utc)
    stamp = now.isoformat().replace('+00:00', 'Z')
    job = {'id': str(uuid4()), 'videoId': video['id'], 'status': 'blocked', 'stage': 'quota',
           'createdAt': stamp, 'updatedAt': stamp, 'target': video['target'], 'context': video['context'],
           'progress': {'message': '테스트 자료 · 결제 한도 확인 대기'}, 'attempt': 1,
           'retryAt': (now + timedelta(minutes=30)).isoformat().replace('+00:00', 'Z'),
           'error': {'code': 'analysis_quota_exceeded', 'message': '테스트 요청은 보관되며 다음 확인 시각 이후 자동으로 이어집니다.'}}

    def blocked_jobs(route):
        if route.request.method == 'GET':
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'jobs': [job]}))
        else:
            route.continue_()

    page.route('**/api/v2/jobs', blocked_jobs)
    page.goto(base + '/#videos')
    page.reload(wait_until='networkidle')
    card = page.locator('.video-card').filter(has_text=video['title'])
    expect(card).to_contain_text('서비스 복구 대기')
    expect(card).to_contain_text('서비스가 복구되면 자동으로')
    expect(card.locator('[data-action=job-status]')).to_be_enabled()
    expect(card.locator('[data-action=analyze]')).to_have_count(0)
    card.locator('[data-action=job-status]').click()
    expect(page.locator('[role=dialog] [data-action=cancel-job]')).to_be_enabled()
    expect(page.locator('[role=dialog] input')).to_have_count(0)
    expect(page.get_by_role('dialog')).to_contain_text('자동')
    expect(page.get_by_role('dialog')).to_contain_text('다음 연결 확인')
    no_overflow(page, 'blocked analysis status')
    page.screenshot(path=str(ARTIFACTS / 'growth-quota-fixture-mobile.png'))
    page.get_by_role('button', name='닫기', exact=True).click()
    page.unroute('**/api/v2/jobs', blocked_jobs)
    page.reload(wait_until='networkidle')


def migrate_legacy_ui(page, movie, base):
    legacy = install_legacy_fixture(page, movie)
    initial = workspace(page)
    chooser_events, chunk_requests = [], []
    on_chooser = lambda chooser: chooser_events.append(chooser)
    on_request = lambda request: chunk_requests.append(request.url) if request.method == 'PUT' and '/api/v2/uploads/' in request.url else None
    page.on('filechooser', on_chooser)
    page.on('request', on_request)
    mapping_failure = {'injected': False}

    def interrupt_first_mapping(route):
        if route.request.method == 'POST':
            payload = route.request.post_data_json
            mappings = payload.get('videoMap', [])
            if mappings and not mapping_failure['injected']:
                mapping_failure['injected'] = True
                route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': '테스트: 원본 저장 뒤 기록 연결 일시 중단'}))
                return
        route.continue_()

    page.route('**/api/v2/imports', interrupt_first_mapping)
    page.goto(base + '/#videos')
    page.reload(wait_until='networkidle')
    expect(page.locator('.legacy-banner')).to_contain_text('이 기기의 이전 기록을 찾았어요')
    page.locator('[data-action=legacy-open]').click()
    form = page.locator('#legacy-import-form')
    expect(form.locator('[name=legacyVideo]')).to_have_count(2)
    form.locator('[name=importConsent]').check()
    form.locator('[name=rightsConsent]').check()
    expect(form.locator('[name=analysisConsent]')).not_to_be_checked()
    form.locator('button[type=submit]').click()
    expect(page.locator('#modal-title')).to_have_text('이전 기록을 보관했어요', timeout=20000)
    expect(page.get_by_role('dialog')).to_contain_text('원본 저장 뒤 기록 연결 일시 중단')
    assert mapping_failure['injected'], 'the test must fail a mapping request after successful original completion'
    assert len(workspace(page)['videos']) == len(initial['videos']) + 1
    first_records = page.request.get('/api/v2/imports').json()['imports']
    assert len(first_records) == 1 and first_records[0]['mappedVideos'] == 0
    chunks_after_completion = len(chunk_requests)
    assert chunks_after_completion >= 1
    page.get_by_role('button', name='닫기', exact=True).click()

    # Completion succeeded but its archive mapping failed. After a reload the
    # original must be reused rather than uploaded or added to the account again.
    page.reload(wait_until='networkidle')
    page.locator('[data-action=legacy-open]').click()
    form = page.locator('#legacy-import-form')
    form.locator('[name=importConsent]').check()
    form.locator('[name=rightsConsent]').check()
    form.locator('button[type=submit]').click()
    expect(page.locator('#modal-title')).to_have_text('이전 기록을 보관했어요', timeout=20000)
    assert len(chunk_requests) == chunks_after_completion, 'mapping recovery must not retransmit a completed original'
    assert len(workspace(page)['videos']) == len(initial['videos']) + 1, 'mapping recovery must not create a duplicate video'
    expect(page.get_by_role('dialog')).to_contain_text('원본 1개 추가')
    expect(page.get_by_role('dialog')).to_contain_text('분석 신청 0개')
    expect(page.get_by_role('dialog')).to_contain_text('이전 기록 · 원본 없음')
    expect(page.get_by_role('dialog')).to_contain_text('이 기기에 이전 원본이 없습니다')
    assert not chooser_events, 'legacy file must transfer directly from IndexedDB without a file picker'
    records = page.request.get('/api/v2/imports').json()['imports']
    assert len(records) == 1
    record = records[0]
    assert record['source'] == 'legacy_browser_unverified'
    assert record['mappedVideos'] == 1
    assert record['counts']['videos'] == 3 and record['counts']['observations'] == 2
    assert record['counts']['completed'] == 2 and record['counts']['snapshots'] == 1
    detail = page.request.get('/api/v2/imports/' + record['id']).json()['import']
    assert detail['idMap'][0]['oldId'] == legacy['localId']
    assert detail['archive']['observations'][0]['rating'] == 4
    assert any(item['id'] == legacy['missingId'] for item in detail['archive']['videos'])
    mapped_id = detail['idMap'][0]['newId']
    current = workspace(page)
    assert len(current['videos']) == len(initial['videos']) + 1
    migrated_video = next(item for item in current['videos'] if item['id'] == mapped_id)
    assert migrated_video['target'] == {'kit': 'navy', 'number': 11, 'age': 11}, 'old target must not become the current teal 17 player'
    assert current['profile']['kit'] == 'teal' and current['profile']['number'] == 17
    assert current['observations'] == initial['observations'] and current['analyses'] == initial['analyses'], 'archived scores must not become validated active scores or AI'
    assert page.request.get('/api/v2/media/' + mapped_id).body() == movie.read_bytes()
    assert page.evaluate('localStorage.getItem("next-xi-standalone-v1")') == legacy['serialized']
    assert page.evaluate('''async id => {const {getOriginalVideo}=await import('/media-store.js');return (await getOriginalVideo(id))?.size}''', legacy['localId']) == movie.stat().st_size

    page.locator('[data-action=legacy-view]').click()
    expect(page.get_by_role('dialog')).to_contain_text('이전 기기에서 가져온 기록입니다')
    expect(page.get_by_role('dialog')).not_to_contain_text('legacy_browser_unverified')
    expect(page.get_by_role('dialog')).to_contain_text('서버 검증 안 됨')
    expect(page.get_by_role('dialog')).to_contain_text('원본을 아직 가져오지 않았어요')
    expect(page.get_by_role('dialog')).to_contain_text('원본이 없어도 보존할 이전 수동 메모')
    expect(page.get_by_role('dialog')).to_contain_text('과거 입력 점수 4/5')
    page.locator('[role=dialog] [data-action=evidence]').first.click()
    player = page.locator('#evidence-video')
    wait_video(player, '(v) => v.readyState >= 2')
    assert mapped_id in player.get_attribute('src')
    player.evaluate('(v) => v.pause()')
    page.get_by_role('button', name='닫기', exact=True).click()
    expect(page.locator('#modal-title')).to_have_text('이전 성장 기록')
    no_overflow(page, 'legacy archive mobile')
    page.screenshot(path=str(ARTIFACTS / 'growth-migration-mobile.png'))
    page.get_by_role('button', name='닫기', exact=True).click()

    # A second explicit import must skip the transferred file and deduplicate its archive.
    page.reload(wait_until='networkidle')
    previous_chunks = len(chunk_requests)
    page.locator('[data-action=legacy-open]').click()
    form = page.locator('#legacy-import-form')
    form.locator('[name=importConsent]').check()
    form.locator('[name=rightsConsent]').check()
    form.locator('button[type=submit]').click()
    expect(page.locator('#modal-title')).to_have_text('이전 기록을 보관했어요', timeout=20000)
    expect(page.get_by_role('dialog')).to_contain_text('원본 0개 추가')
    assert len(chunk_requests) == previous_chunks
    assert len(page.request.get('/api/v2/imports').json()['imports']) == 1
    assert len(workspace(page)['videos']) == len(current['videos'])
    page.get_by_role('button', name='닫기', exact=True).click()

    # Corruption is surfaced without clearing local originals or the server archive.
    broken = '{broken legacy JSON'
    page.evaluate('(raw) => localStorage.setItem("next-xi-standalone-v1",raw)', broken)
    page.reload(wait_until='networkidle')
    page.get_by_text('이전 기기 기록 읽기 안내', exact=True).click()
    expect(page.locator('#main')).to_contain_text('이전 기록이 손상됐거나')
    assert page.evaluate('localStorage.getItem("next-xi-standalone-v1")') == broken
    assert len(page.request.get('/api/v2/imports').json()['imports']) == 1
    page.evaluate('(raw) => localStorage.setItem("next-xi-standalone-v1",raw)', legacy['serialized'])
    page.remove_listener('filechooser', on_chooser)
    page.remove_listener('request', on_request)
    page.unroute('**/api/v2/imports', interrupt_first_mapping)
    return {'archiveId': record['id'], 'mappedId': mapped_id, **legacy}


def populated_report(page, movie, base):
    """Mock only read-only analysis data; both private media files are really uploaded.

    These labeled observations are UI fixtures, not AI-quality validation or real
    feedback on the generated color-pattern MP4.
    """
    current = workspace(page)
    today = current['profile']['planStart']
    before = (date.fromisoformat(today) - timedelta(days=2)).isoformat()
    yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    origin = {'Origin': base}
    response = page.request.post('/api/v2/uploads', data={
        'fileName': movie.name, 'size': movie.stat().st_size, 'mime': 'video/mp4',
        'title': '테스트 자료 · 이번 경기', 'rightsConsent': True,
        'target': {'kit': 'teal', 'number': 17, 'age': 11},
        'context': {'matchDate': today, 'position': '미드필더', 'minutesPlayed': 4, 'opponentLevel': 'similar', 'filming': 'clear'},
    }, headers=origin)
    assert response.status == 201, response.text()
    upload = response.json()['upload']
    response = page.request.put('/api/v2/uploads/' + upload['id'], data=movie.read_bytes(), headers={**origin, 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0'})
    assert response.status == 200, response.text()
    response = page.request.post('/api/v2/uploads/' + upload['id'] + '/complete', data={}, headers=origin)
    assert response.status == 200, response.text()
    fixture = response.json()['workspace']
    old_video, new_video = fixture['videos'][0], fixture['videos'][1]
    old_video.update(title='테스트 자료 · 직전 경기', addedAt=before + 'T01:00:00.000Z', duration=4)
    old_video['context']['matchDate'] = before
    new_video.update(title='테스트 자료 · 이번 경기', addedAt=today + 'T01:00:00.000Z', duration=4)
    new_video['context']['matchDate'] = today
    old_note = '테스트 자료: 이전 경기에서 패스 전 동료 위치 확인이 늦었던 장면'
    new_note = '테스트 자료: 이번 경기에서 동료를 확인하고 패스로 연결한 장면'
    move_note = '테스트 자료: 패스 뒤 다음 지원 위치를 찾는 연습 후보'

    def analysis(video, observations):
        return {'id': str(uuid4()), 'videoId': video['id'], 'start': 0, 'end': 4,
                'createdAt': video['addedAt'], 'model': 'browser-test-fixture',
                'result': {'identified': True, 'summary': '브라우저 검증용 정성 관찰 예시',
                           'observations': observations, 'limitations': ['테스트용 입력이며 실제 선수 평가가 아닙니다.'],
                           'nextAction': '실제 경기 근거를 추가로 관찰합니다.'}}

    fixture['analyses'] = [
        analysis(old_video, [{'skill': 'pass', 'time': 1, 'type': 'focus', 'confidence': 'high', 'note': old_note}]),
        analysis(new_video, [{'skill': 'pass', 'time': 2, 'type': 'strength', 'confidence': 'high', 'note': new_note},
                             {'skill': 'move', 'time': 3, 'type': 'focus', 'confidence': 'medium', 'note': move_note}]),
    ]
    fixture['observations'] = []
    fixture['checkins'] = []
    fixture['practices'] = [{'id': str(uuid4()), 'date': yesterday, 'taskId': f'practice-{yesterday}-pass', 'completed': True, 'note': '테스트용 패스 연습 기록'}]

    def fixture_workspace(route):
        if route.request.method == 'GET':
            route.fulfill(status=200, content_type='application/json', body=json.dumps(fixture))
        else:
            route.continue_()

    def fixture_jobs(route):
        if route.request.method == 'GET':
            route.fulfill(status=200, content_type='application/json', body='{"jobs":[]}')
        else:
            route.continue_()

    page.route('**/api/v2/workspace', fixture_workspace)
    page.route('**/api/v2/jobs', fixture_jobs)
    page.goto(base + '/#growth', wait_until='networkidle')
    page.reload(wait_until='networkidle')
    expect(page.locator('.evidence-card')).to_have_count(1)
    expect(page.locator('.evidence-card')).to_contain_text(new_note)
    expect(page.locator('.evidence-card')).to_contain_text('코치 검토 전')
    expect(page.locator('.evidence-card')).to_contain_text('신뢰도 높음')
    expect(page.locator('.comparison-videos')).to_contain_text(old_video['title'])
    expect(page.locator('.comparison-videos')).to_contain_text(new_video['title'])
    expect(page.get_by_role('heading', name='이전 과제, 이번 경기에서는')).to_be_visible()
    expect(page.get_by_role('heading', name='해 본 연습이 경기에도 보였을까요?')).to_be_visible()
    expect(page.locator('table tbody tr')).to_have_count(2)
    expect(page.locator('.radar-chart circle')).to_have_count(0)
    assert old_note in page.locator('#main').inner_text()
    assert new_note in page.locator('#main').inner_text()
    page.get_by_text('실천과 관찰의 연결 기준', exact=True).click()
    expect(page.locator('#main')).to_contain_text('연습 때문에 달라졌다는 뜻은 아닙니다')
    for width in [390, 320]:
        page.set_viewport_size({'width': width, 'height': 844})
        no_overflow(page, f'populated report and history {width}px')
    page.set_viewport_size({'width': 390, 'height': 844})
    current_button = page.locator('.evidence-card [data-action=evidence]').first
    assert current_button.get_attribute('data-video') == new_video['id']
    current_button.click()
    player = page.locator('#evidence-video')
    expect(player).to_be_visible()
    wait_video(player, '(v) => v.readyState >= 2')
    assert new_video['id'] in player.get_attribute('src')
    wait_video(player, '(v) => v.currentTime >= 2')
    player.evaluate('(v) => v.pause()')
    assert 2 <= player.evaluate('(v) => v.currentTime') <= 3.8
    page.get_by_role('button', name='닫기', exact=True).click()
    page.locator('.comparison-videos [data-action=evidence]').first.click()
    assert old_video['id'] in page.locator('#evidence-video').get_attribute('src')
    page.get_by_role('button', name='닫기', exact=True).click()

    navigate(page, 'plan')
    page.locator('.calendar-day').filter(has=page.locator('.calendar-dot.individual')).first.click()
    page.locator('[data-action=task]').click()
    note = '아직 저장하지 않은 테스트 메모가 장면을 보고 돌아와도 남아야 해요.'
    page.locator('#practice-form [name=note]').fill(note)
    task_title = page.locator('#modal-title').inner_text()
    page.get_by_text('이 훈련을 추천한 장면', exact=True).click()
    page.locator('[role=dialog] [data-action=evidence]').first.click()
    expect(page.locator('#evidence-video')).to_be_visible()
    page.get_by_role('button', name='닫기', exact=True).click()
    expect(page.locator('#modal-title')).to_have_text(task_title)
    expect(page.locator('#practice-form [name=note]')).to_have_value(note)
    expect(page.locator('.step-list')).to_have_count(3)
    page.get_by_role('button', name='닫기', exact=True).click()
    navigate(page, 'growth')
    page.evaluate('window.scrollTo(0, 0)')
    page.screenshot(path=str(ARTIFACTS / 'growth-report-fixture-mobile.png'))
    page.unroute('**/api/v2/workspace', fixture_workspace)
    page.unroute('**/api/v2/jobs', fixture_jobs)
    page.reload(wait_until='networkidle')


with TemporaryDirectory(prefix='next-xi-growth-browser-') as temporary:
    temporary = Path(temporary)
    movie = temporary / '오늘의 경기.mp4'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(movie)], check=True)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ)
    for key in ['SOCCER_AI_API_KEY', 'OPENAI_API_KEY', 'SOCCER_ANALYSIS_ACCESS_CODE']:
        env.pop(key, None)
    env.update(PORT=str(port), NEXT_XI_DATA_DIR=str(temporary / 'data'))
    base = f'http://127.0.0.1:{port}'
    with (temporary / 'server.log').open('w+') as logs:
        server = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=logs, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                if server.poll() is not None:
                    logs.seek(0)
                    raise AssertionError('Server exited: ' + logs.read()[-3000:])
                try:
                    with urlopen(base + '/api/v2/auth/me', timeout=1) as ready:
                        if ready.status == 200:
                            break
                except (HTTPError, URLError, TimeoutError):
                    time.sleep(0.15)
            else:
                raise AssertionError('Growth server did not become ready')

            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
                context = browser.new_context(base_url=base, viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, accept_downloads=True, timezone_id='Asia/Seoul')
                context.set_default_timeout(12000)
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(base, wait_until='networkidle')
                no_overflow(page, 'mobile signup')
                register(page, 'guardian-browser@example.test')
                form = page.locator('#profile-form')
                form.locator('[name=name]').fill('내일의 17번')
                form.locator('[name=number]').fill('17')
                form.locator('[name=kit]').select_option('teal')
                form.locator('[name=position]').fill('미드필더')
                form.locator('[name=schoolStart]').fill('08:20')
                form.locator('[name=schoolEnd]').fill('15:40')
                form.locator('[name=teamDays][value="1"]').check()
                form.locator('[name=teamDays][value="3"]').check()
                form.locator('[name=matchDays][value="0"]').check()
                form.locator('[name=sensitiveConsent]').check()
                form.locator('[name=allergies]').fill('우유, 달걀, 땅콩')
                form.locator('[name=likedFoods]').fill('고구마, 사과')
                form.locator('[name=schoolLunch]').check()
                # Exercises the editable player view contract, not only the default parent value.
                form.locator('[name=roleView]').select_option('player')
                form.locator('button[type=submit]').click()
                expect(page.get_by_role('dialog')).to_have_count(0)
                saved = workspace(page)
                assert saved['profile']['number'] == 17
                assert saved['profile']['schoolEnd'] == '15:40'
                assert saved['profile']['allergies'] == ['우유', '달걀', '땅콩']
                assert saved['profile']['roleView'] == 'player'
                assert saved['profile']['teamDays'] == [1, 3]

                # Every primary page remains reachable and has no horizontal overflow.
                for width in [390, 320]:
                    page.set_viewport_size({'width': width, 'height': 844})
                    for route in ['today', 'videos', 'growth', 'plan', 'more']:
                        navigate(page, route)
                page.set_viewport_size({'width': 390, 'height': 844})
                navigate(page, 'more')
                page.locator('[data-action=meals]').click()
                expect(page.locator('.meal-day')).to_have_count(7)
                meals = page.locator('.meal-card')
                assert meals.count() == 28
                menu_names = meals.locator('h3').all_text_contents()
                assert not any(any(allergen in title for allergen in ['우유', '달걀', '요거트', '땅콩']) for title in menu_names)
                page.get_by_text('참고 자료와 검토 상태', exact=True).click()
                expect(page.locator('[role=dialog] small').filter(has_text='본문 확인 2026-10-16')).to_have_count(6)
                expect(page.locator('[role=dialog] small').filter(has_text='최신 본문 미확인')).to_have_count(2)
                expect(page.get_by_role('dialog')).to_contain_text('개별 검토를 받지 않았습니다')
                no_overflow(page, '7-day food guide')
                page.get_by_role('button', name='닫기', exact=True).click()

                # A real 4-second H.264 MP4 is uploaded to the server, with one transient interruption.
                navigate(page, 'videos')
                page.locator('[data-action=upload]').first.click()
                form = page.locator('#upload-form')
                form.locator('#video-file').set_input_files(str(movie))
                form.locator('[name=title]').fill('실제 MP4 · 청록 17번')
                form.locator('[name=kit]').select_option('teal')
                form.locator('[name=number]').fill('17')
                form.locator('[name=minutesPlayed]').fill('4')
                options = form.locator('[name=opponentLevel] option').evaluate_all('(options) => options.map(o => ({value:o.value,text:o.textContent}))')
                assert any(option['value'] == 'similar' for option in options), f'opponentLevel options: {options}'
                form.locator('[name=opponentLevel]').select_option('similar')
                form.locator('[name=filming]').select_option('clear')
                form.locator('[name=rights]').check()
                form.locator('[name=analysisConsent]').check()
                no_overflow(page, 'mobile original upload')
                chunk_attempts = []

                def interrupt_first_chunk(route):
                    if route.request.method != 'PUT':
                        route.continue_()
                        return
                    chunk_attempts.append(route.request.url)
                    if len(chunk_attempts) == 1:
                        route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': '일시적인 테스트 연결 중단'}))
                    else:
                        route.continue_()

                page.route('**/api/v2/uploads/*', interrupt_first_chunk)
                form.locator('button[type=submit]').click()
                # Missing credentials must leave the saved original usable, with honest analysis status.
                expect(page.locator('#modal-title')).to_have_text('원본은 안전하게 저장했어요', timeout=20000)
                expect(page.get_by_role('dialog')).to_contain_text('업로드는 완료')
                page.get_by_role('button', name='닫기', exact=True).click()
                expect(page.locator('.video-card')).to_have_count(1)
                assert len(chunk_attempts) >= 2, 'upload did not retry the interrupted chunk'
                saved = workspace(page)
                assert len(saved['videos']) == 1
                video = saved['videos'][0]
                assert video['target']['number'] == 17 and video['target']['kit'] == 'teal'
                assert video['context']['minutesPlayed'] == 4
                media = page.request.get('/api/v2/media/' + video['id'])
                assert media.status == 200 and media.body() == movie.read_bytes(), 'server must retain original bytes'
                native = page.locator('.video-card video')
                wait_video(native, '(v) => v.readyState >= 2')
                assert native.evaluate('(v) => v.videoWidth') == 320
                native.evaluate('(v) => {v.currentTime=2; return v.play()}')
                wait_video(native, '(v) => v.currentTime >= 2')
                native.evaluate('(v) => v.pause()')
                assert page.request.get('/api/v2/jobs').json()['jobs'] == []
                assert not saved['analyses'] and not saved['observations'], 'missing key must not produce fake feedback'
                page.screenshot(path=str(ARTIFACTS / 'growth-mobile-upload.png'), full_page=True)

                # An interrupted connection and a page reload retain the account and remote original.
                context.set_offline(True)
                context.set_offline(False)
                page.reload(wait_until='networkidle')
                expect(page.locator('.video-card')).to_have_count(1)
                assert workspace(page)['videos'][0]['id'] == video['id']

                navigate(page, 'plan')
                first_week = page.locator('.calendar-day').first.get_attribute('data-date')
                page.locator('[data-action=week][data-week="1"]').click()
                assert page.locator('.calendar-day').first.get_attribute('data-date') != first_week
                page.locator('[data-action=week][data-week="0"]').click()
                personal = page.locator('.calendar-day').filter(has=page.locator('.calendar-dot.individual')).first
                assert personal.count(), 'a personal practice day should exist in the first week'
                practice_date = personal.get_attribute('data-date')
                personal.click()
                page.locator('[data-action=task]').click()
                expect(page.locator('#practice-form')).to_be_visible()
                expect(page.locator('.step-list')).to_have_count(3)
                form = page.locator('#practice-form')
                form.locator('[name=completed]').check()
                form.locator('[name=note]').fill('작은 공간에서 편안하게 연습했어요.')
                form.locator('button[type=submit]').click()
                expect(page.get_by_role('dialog')).to_have_count(0)
                assert workspace(page)['practices'][0]['completed']
                form = page.locator('#checkin-form')
                form.locator('[name=sleepQuality]').select_option('poor')
                form.locator('[name=fatigue]').select_option('tired')
                form.locator('[name=mood]').select_option('okay')
                form.locator('[name=pain]').check()
                form.locator('button[type=submit]').click()
                expect(page.locator('.day-card')).to_contain_text('회복')
                saved = workspace(page)
                assert any(item['date'] == practice_date and item['pain'] for item in saved['checkins'])
                page.locator('[data-action=routine]').click()
                expect(page.locator('.timeline-item')).not_to_have_count(0)
                no_overflow(page, 'daily recovery routine')
                page.get_by_role('button', name='닫기', exact=True).click()

                navigate(page, 'more')
                page.locator('[data-action=privacy]').click()
                with page.expect_download() as download:
                    page.locator('[data-action=export-data]').click()
                export = temporary / 'export.json'
                download.value.save_as(str(export))
                exported = json.loads(export.read_text())
                assert exported['profile']['allergies'] == ['우유', '달걀', '땅콩']
                assert exported['videos'][0]['id'] == video['id']
                page.get_by_role('button', name='닫기', exact=True).click()
                page.locator('[data-action=logout]').click()
                expect(page.locator('#auth-form')).to_be_visible()
                form = page.locator('#auth-form')
                form.locator('[name=email]').fill('guardian-browser@example.test')
                form.locator('[name=password]').fill('Browser-Test-Password-2026')
                form.locator('button[type=submit]').click()
                expect(page.locator('.app-shell')).to_be_visible()
                assert workspace(page)['videos'][0]['id'] == video['id']
                page.set_viewport_size({'width': 1440, 'height': 1000})
                page.goto(base + '/#today', wait_until='networkidle')
                page.evaluate('window.scrollTo(0, 0)')
                no_overflow(page, 'desktop dashboard')
                page.screenshot(path=str(ARTIFACTS / 'growth-desktop.png'), full_page=True)
                page.set_viewport_size({'width': 390, 'height': 844})
                page.evaluate('window.scrollTo(0, 0)')
                page.screenshot(path=str(ARTIFACTS / 'growth-mobile.png'))

                populated_report(page, movie, base)
                blocked_quota_ui(page, base)
                legacy = migrate_legacy_ui(page, movie, base)

                other = browser.new_context(base_url=base, viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
                other_page = other.new_page()
                other_page.goto(base)
                assert other_page.request.get('/api/v2/media/' + video['id']).status == 404
                register(other_page, 'other-browser@example.test')
                other_page.get_by_role('button', name='닫기', exact=True).click()
                assert workspace(other_page)['videos'] == []
                assert other_page.request.get('/api/v2/media/' + video['id']).status == 404
                assert other_page.request.get('/api/v2/imports').json()['imports'] == []
                assert other_page.request.get('/api/v2/imports/' + legacy['archiveId']).status == 404
                other.close()
                navigate(page, 'videos')
                page.reload(wait_until='networkidle')
                page.locator('[data-action=delete-video][data-id="' + legacy['mappedId'] + '"]').click()
                page.locator('[data-action=confirm-delete-video]').click()
                expect(page.get_by_role('dialog')).to_have_count(0)
                assert page.request.get('/api/v2/media/' + legacy['mappedId']).status == 404
                assert page.request.get('/api/v2/imports').json()['imports'] == []
                assert page.evaluate('localStorage.getItem("next-xi-standalone-v1")') == legacy['serialized']
                assert not errors, errors
                context.close()
                browser.close()
                print('PASS: real guardian accounts, 320/390 mobile routes, food exclusions with 6 verified/2 unverified source labels, real MP4 upload/retry/private bytes/playback, missing-credential honesty, reconnect/calendar/practice/pain/routine/export/login/account isolation; labeled mock-analysis comparison/history/transfer and nested modal restoration; blocked quota waiting/cancel UI; actual IndexedDB migration without picker, old player identity, missing blob archive, manual-score separation, deduplication, corruption preservation, archive privacy and linked deletion cleanup. No browser errors. AI accuracy was not tested.')
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
