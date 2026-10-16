"""Automatic original-video workflow in Chromium; external AI responses mocked.

A real 36-second H.264 video is decoded and sampled by the production client.
These tests validate orchestration and honest state handling, not live AI
accuracy, target recognition, provider billing, or deployed credentials.
"""
import base64
import json
import subprocess
import tempfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
STATE_KEY = 'next-xi-standalone-v1'


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


subprocess.run(['node', 'scripts/export-standalone.js'], cwd=ROOT, check=True)
with tempfile.TemporaryDirectory(prefix='next-xi-auto-analysis-test-') as temporary:
    movie = Path(temporary) / '자동 분석 검증 경기.mp4'
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'testsrc2=size=320x180:rate=5', '-t', '36', '-c:v', 'libx264',
        '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', str(movie),
    ], check=True)
    server = ThreadingHTTPServer(
        ('127.0.0.1', 0),
        partial(QuietHandler, directory=str(ROOT / '.artifacts/site')),
    )
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path='/usr/bin/chromium', headless=True,
                args=['--no-sandbox'],
            )
            page = browser.new_page(
                viewport={'width': 390, 'height': 844},
                is_mobile=True, has_touch=True,
            )
            errors, all_posts, held_routes = [], [], []
            run = {'kind': 'success', 'posts': [], 'clip_count': 0}
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('https://i.ytimg.com/**', lambda route: route.abort())

            def analysis_api(route):
                if route.request.method == 'GET':
                    if run['kind'] == 'missing':
                        route.fulfill(status=404, content_type='text/html', body='Not found')
                    elif run['kind'] == 'invalid_key':
                        route.fulfill(json={'available': False, 'reason': 'invalid_key_format'})
                    else:
                        route.fulfill(json={'available': True, 'reason': 'ready'})
                    return
                assert route.request.method == 'POST'
                payload = route.request.post_data_json
                all_posts.append(payload)
                run['posts'].append(payload)
                provider_errors = {
                    'permission_denied': (503, 'analysis_permission_denied'),
                    'quota_exceeded': (429, 'analysis_quota_exceeded'),
                    'model_unavailable': (503, 'analysis_model_unavailable'),
                }
                if run['kind'] in provider_errors:
                    status, code = provider_errors[run['kind']]
                    route.fulfill(status=status, json={'code': code})
                    return
                if run['kind'] == 'credentials_rejected':
                    route.fulfill(status=503, json={'code': 'analysis_credentials_rejected'})
                    return
                if run['kind'] == 'unauthorized':
                    route.fulfill(status=401, json={'error': 'invalid_access_code'})
                    return
                if payload.get('mode') == 'discover':
                    frames = payload['frames']
                    detections = [] if run['kind'] == 'not_found' else [{
                        'time': frame['time'], 'confidence': 'high',
                        'reason': '브라우저 테스트에서 지정한 탐색 후보입니다.',
                    } for frame in [frames[0], frames[-1]]]
                    route.fulfill(json={
                        'mode': 'discover', 'detections': detections,
                        'summary': '브라우저 검증용 자동 탐색 응답',
                        'limitations': ['실제 선수 식별 정확도는 검증하지 않았습니다.'],
                        'model': 'test-model',
                    })
                    return
                run['clip_count'] += 1
                if run['kind'] == 'partial' and run['clip_count'] == 2:
                    route.fulfill(status=502, json={'error': 'test_provider_failure'})
                    return
                if run['kind'] == 'cancel':
                    held_routes.append(route)
                    return
                route.fulfill(json={
                    'model': 'test-model',
                    'result': {
                        'identified': True,
                        'summary': f'자동 분석 검증 · {run["kind"]} · 구간 {run["clip_count"]}',
                        'observations': [{
                            'skill': 'move', 'time': int(payload['start']) + 1,
                            'note': '실제 선수 평가가 아닌 브라우저 흐름 검증용 장면 설명',
                            'type': 'focus', 'confidence': 'medium',
                        }],
                        'limitations': ['테스트 응답이며 실제 선수 평가 아님'],
                        'nextAction': '코치와 확인할 검증용 다음 행동',
                    },
                })

            page.route('**/api/analysis', analysis_api)
            page.goto(f'http://127.0.0.1:{server.server_port}', wait_until='networkidle')

            def state():
                return page.evaluate('key => JSON.parse(localStorage.getItem(key))', STATE_KEY)

            def new_run(kind):
                run.update(kind=kind, posts=[], clip_count=0)

            def open_analysis():
                page.locator('[data-action=analyze-video]').first.tap()
                expect(page.locator('#analysis-form')).to_be_visible()
                assert page.locator('#analysis-form').evaluate('(form) => form.noValidate')
                assert page.locator('#analysis-form [name=start], #analysis-form [name=length]').count() == 0

            def start_analysis(kind):
                new_run(kind)
                open_analysis()
                page.locator('input[name=accessCode]').fill('automatic-browser-pilot')
                page.locator('input[name=consent]').check()
                page.get_by_role('button', name='남색 11번 자동 분석 시작', exact=True).tap()

            def wait_job(status):
                page.wait_for_function('''([key, status]) => {
                    const value = JSON.parse(localStorage.getItem(key));
                    return value?.autoAnalyses?.some(job => job.status === status);
                }''', arg=[STATE_KEY, status], timeout=60000)
                return state()['autoAnalyses'][0]

            def close_if_open():
                if page.locator('#analysis-form').count():
                    page.locator('#analysis-form .modal-actions [data-action=close-modal]').tap()

            # Selecting an original does not silently consent to a paid AI call.
            page.locator('.mobile-nav-item[data-page=videos]').tap()
            page.get_by_role('button', name='영상 등록', exact=True).tap()
            page.locator('#original-file').set_input_files(str(movie))
            page.locator('input[name=rights]').check()
            page.get_by_role('button', name='원본 영상 등록', exact=True).tap()
            expect(page.get_by_role('dialog')).to_have_count(0)
            expect(page.locator('.upload-receipt')).to_contain_text('저장 완료')
            original_id = state()['videos'][0]['id']
            assert 35.9 <= state()['videos'][0]['duration'] <= 36.1
            assert all_posts == []

            # A static host without functions must not masquerade as an analysis
            # server or send private frames to an unknown/fallback route.
            new_run('missing')
            page.locator('[data-action=analyze-video]').first.tap()
            expect(page.locator('#analysis-setup.unavailable')).to_contain_text('분석 서버 연결')
            expect(page.locator('#analysis-setup')).to_contain_text('배포되어 있지 않습니다')
            expect(page.locator('#analysis-form')).to_be_hidden()
            assert all_posts == []
            page.screenshot(path='/tmp/next-xi-auto-analysis-unavailable.png', full_page=True)
            page.get_by_role('button', name='확인했어요', exact=True).tap()

            new_run('invalid_key')
            page.locator('[data-action=analyze-video]').first.tap()
            expect(page.locator('#analysis-setup.unavailable')).to_contain_text('API 키 형식')
            expect(page.locator('#analysis-form')).to_be_hidden()
            assert all_posts == []
            page.get_by_role('button', name='확인했어요', exact=True).tap()

            # Consent and the pilot access code are checked by app validation
            # before sampling or network use, with errors near the submit action.
            new_run('success')
            open_analysis()
            page.get_by_role('button', name='남색 11번 자동 분석 시작', exact=True).tap()
            expect(page.locator('#analysis-error')).to_contain_text('동의')
            expect(page.locator('#analysis-error')).to_be_in_viewport()
            page.locator('input[name=consent]').check()
            page.get_by_role('button', name='남색 11번 자동 분석 시작', exact=True).tap()
            expect(page.locator('#analysis-error')).to_contain_text('이용 코드')
            assert all_posts == []
            close_if_open()

            # No manual seek, timestamp input, or playback pause is needed.
            # The client samples the entire original, then analyzes two distant
            # automatically chosen regions sequentially.
            start_analysis('success')
            job = wait_job('completed')
            expect(page.get_by_role('dialog')).to_have_count(0, timeout=10000)
            assert job['videoId'] == original_id
            assert job['sampledCount'] == job['sampleCount']
            assert job['selectedCount'] == job['completedCount'] == 2
            assert len(job['segments']) == 2
            assert job['segments'][0]['end'] <= job['segments'][1]['start']
            assert job['segments'][0]['start'] == 0
            assert job['segments'][1]['end'] >= 35
            assert len(state()['analyses']) == 2
            assert state()['observations'] == []
            expect(page.locator('.analysis-result')).to_have_count(2)
            expect(page.locator('[data-auto-status=completed]')).to_be_visible()
            expect(page.locator('.analysis-result').first).to_contain_text('테스트 응답이며 실제 선수 평가 아님')

            discovery = [item for item in run['posts'] if item.get('mode') == 'discover']
            clips = [item for item in run['posts'] if item.get('mode') != 'discover']
            assert len(discovery) == 1 and len(clips) == 2
            scan_frames = [frame for item in discovery for frame in item['frames']]
            assert len(scan_frames) == job['sampleCount'] <= 120
            assert scan_frames[0]['time'] == 0
            assert scan_frames[-1]['time'] >= 31
            assert all(scan_frames[index]['time'] < scan_frames[index + 1]['time'] for index in range(len(scan_frames) - 1))
            assert all(len(item['frames']) <= 12 for item in discovery)
            for payload in run['posts']:
                assert set(payload) <= {'mode', 'videoId', 'start', 'end', 'frames', 'accessCode', 'consent'}
                assert payload['videoId'] == original_id and payload['consent'] is True
                assert payload['accessCode'] == 'automatic-browser-pilot'
                assert len(json.dumps(payload).encode()) < 3_000_000
                assert 'data:video' not in json.dumps(payload)
                if payload.get('mode') != 'discover':
                    assert 1 <= payload['end'] - payload['start'] <= 12
                    assert len(payload['frames']) <= 24
                for frame in payload['frames']:
                    assert frame['image'].startswith('data:image/jpeg;base64,')
                    assert len(frame['image'].encode()) <= 250_000
                    jpeg = base64.b64decode(frame['image'].split(',', 1)[1], validate=True)
                    assert jpeg.startswith(b'\xff\xd8') and jpeg.endswith(b'\xff\xd9')
                    assert jpeg != movie.read_bytes()
            assert scan_frames[0]['image'] != scan_frames[-1]['image']
            dimensions = page.evaluate('''async source => {
                const image = new Image(); image.src = source; await image.decode();
                return [image.naturalWidth, image.naturalHeight];
            }''', scan_frames[0]['image'])
            assert dimensions == [320, 180]
            assert 'automatic-browser-pilot' not in json.dumps(state())
            assert 'data:image/jpeg' not in json.dumps(state())
            page.screenshot(path='/tmp/next-xi-auto-analysis-results.png', full_page=True)

            page.locator('.mobile-nav-item[data-page=dashboard]').tap()
            expect(page.locator('[data-auto-status=completed]')).to_be_visible()
            expect(page.locator('.auto-summary')).to_be_visible()
            expect(page.locator('.radar-chart')).to_have_attribute('aria-label', '아직 평가 전인 8개 항목 스파이더맵')
            page.screenshot(path='/tmp/next-xi-auto-analysis-dashboard.png', full_page=True)
            page.locator('.mobile-nav-item[data-page=report]').tap()
            expect(page.locator('[data-auto-status=completed]')).to_be_visible()
            expect(page.locator('.analysis-result')).to_have_count(2)
            page.reload(wait_until='networkidle')
            expect(page.locator('.analysis-result')).to_have_count(2)
            assert state()['autoAnalyses'][0]['status'] == 'completed'
            page.locator('.mobile-nav-item[data-page=videos]').tap()

            # No target: discovery finishes without paying for clip analysis or
            # inventing observations, scores, or a successful player identity.
            start_analysis('not_found')
            job = wait_job('not_found')
            expect(page.get_by_role('dialog')).to_have_count(0, timeout=10000)
            assert job['detectedCount'] == job['selectedCount'] == job['completedCount'] == 0
            assert len(run['posts']) == 1 and run['clip_count'] == 0
            assert len(state()['analyses']) == 2
            assert state()['observations'] == []
            expect(page.locator('[data-auto-status=not_found]')).to_be_visible()

            # An invalid access code stops at the first request; it must not
            # launch a queue of further discovery/paid clip calls.
            start_analysis('unauthorized')
            job = wait_job('failed')
            expect(page.locator('#analysis-error')).to_contain_text('올바르지 않습니다')
            expect(page.locator('input[name=accessCode]')).to_have_value('')
            page.wait_for_timeout(200)
            assert len(run['posts']) == 1 and run['clip_count'] == 0
            assert len(state()['analyses']) == 2
            close_if_open()

            for kind, message in [
                ('permission_denied', '접근 권한을 거부'),
                ('quota_exceeded', '사용 잔액 또는 이용 한도'),
                ('model_unavailable', '설정된 AI 모델'),
            ]:
                start_analysis(kind)
                wait_job('failed')
                expect(page.locator('#analysis-error')).to_contain_text(message)
                assert len(run['posts']) == 1 and run['clip_count'] == 0
                assert len(state()['analyses']) == 2
                close_if_open()

            # A ready endpoint only confirms configuration exists. A provider
            # rejection must explain the actual key problem and stop the queue.
            start_analysis('credentials_rejected')
            wait_job('failed')
            expect(page.locator('#analysis-error')).to_contain_text('OpenAI')
            expect(page.locator('#analysis-error')).to_contain_text('API 키 인증을 거절')
            assert len(run['posts']) == 1 and run['clip_count'] == 0
            assert len(state()['analyses']) == 2
            close_if_open()

            # A later provider error preserves the first completed region and
            # records a partial job instead of discarding useful finished work.
            start_analysis('partial')
            job = wait_job('partial')
            assert job['selectedCount'] == 2 and job['completedCount'] == 1
            assert len(state()['analyses']) == 2, 'reanalysis replaces the same interval without duplicating it'
            assert any('partial' in entry['result']['summary'] for entry in state()['analyses'])
            assert run['clip_count'] == 2
            close_if_open()
            expect(page.locator('[data-auto-status=partial]')).to_be_visible()

            # Resume the partial job directly at the unfinished second clip,
            # then cancel while it waits. No rescan or repeated first clip is
            # needed, and the completed work remains saved for a later retry.
            start_analysis('cancel')
            page.wait_for_function('''key => {
                const value = JSON.parse(localStorage.getItem(key));
                return value?.autoAnalyses?.[0]?.completedCount === 1
                    && document.querySelector('#analysis-progress p')?.textContent.includes('응답');
            }''', arg=STATE_KEY, timeout=60000)
            page.wait_for_timeout(200)
            assert len(held_routes) == 1
            assert len(run['posts']) == run['clip_count'] == 1
            assert run['posts'][0].get('mode') != 'discover'
            page.locator('#analysis-form .modal-actions [data-action=close-modal]').tap()
            job = wait_job('cancelled')
            assert job['completedCount'] == 1
            assert len(state()['analyses']) == 2 and len(state()['videos']) == 2
            assert any('partial' in entry['result']['summary'] for entry in state()['analyses'])
            try:
                held_routes.pop().abort()
            except Exception:
                pass  # Browser already disposed of the aborted request.
            close_if_open()
            expect(page.locator('[data-auto-status=cancelled]')).to_be_visible()

            # The automatic form remains usable on narrow phones, with no
            # timestamp controls that hand video-navigation work to the user.
            for width in [320, 390]:
                page.set_viewport_size({'width': width, 'height': 844})
                open_analysis()
                page.get_by_role('button', name='남색 11번 자동 분석 시작', exact=True).tap()
                expect(page.locator('#analysis-error')).to_contain_text('동의')
                expect(page.locator('#analysis-error')).to_be_in_viewport()
                expect(page.get_by_role('button', name='남색 11번 자동 분석 시작', exact=True)).to_be_in_viewport()
                assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
                page.screenshot(path=f'/tmp/next-xi-auto-analysis-modal-{width}.png', full_page=True)
                close_if_open()

            page.get_by_role('button', name='영상 삭제', exact=True).tap()
            page.get_by_role('button', name='원본 영상 삭제', exact=True).tap()
            assert state()['analyses'] == [] and state()['autoAnalyses'] == []
            assert len(state()['videos']) == 1
            expect(page.locator('.analysis-result')).to_have_count(0)
            expect(page.locator('.auto-analysis-status')).to_have_count(0)
            page.locator('.mobile-nav-item[data-page=dashboard]').tap()
            expect(page.locator('.auto-summary')).to_have_count(0)
            assert len(all_posts) == 13
            assert not errors, errors
            print('PASS: real 36s H.264 decoding and whole-span JPEG sampling; no manual time/seek; two automatically selected clips; sequential persistence; dashboard/report/reload; no fabricated ratings; no-target abstention; 401 stops queue; partial failure and cancellation retain completed work; 320/390px; deletion clears jobs/results; no JavaScript errors. AI responses were mocked; recognition accuracy and deployed credentials were not tested.')
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
