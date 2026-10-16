"""Real browser video extraction with mocked analysis responses; no live AI call.

The generated MP4 is decoded by Chromium and drawn to JPEGs by the production
client. Only the external analysis API is stubbed, so this verifies transport,
consent, failure recovery, cancellation and honest result rendering separately
from model accuracy or deployed credentials.
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
with tempfile.TemporaryDirectory(prefix='next-xi-analysis-test-') as temporary:
    movie = Path(temporary) / '장면 분석 검증.mp4'
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'testsrc2=size=320x180:rate=15', '-t', '4', '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(movie),
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
            errors, posts, held_routes = [], [], []
            mode = {'status': 'missing'}
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('https://i.ytimg.com/**', lambda route: route.abort())

            def analysis_api(route):
                if route.request.method == 'GET':
                    if mode['status'] == 'missing':
                        route.fulfill(status=404, content_type='text/html', body='Not found')
                    else:
                        route.fulfill(json={'available': True, 'reason': 'ready'})
                    return
                assert route.request.method == 'POST'
                posts.append(route.request.post_data_json)
                if mode['status'] == 'unauthorized':
                    route.fulfill(status=401, json={'error': 'invalid_access_code'})
                elif mode['status'] == 'hold':
                    held_routes.append(route)
                elif mode['status'] == 'unidentified':
                    route.fulfill(json={
                        'model': 'test-model',
                        'result': {
                            'identified': False,
                            'summary': '검증 영상에서는 남색 11번을 확인하지 못했어요.',
                            'observations': [],
                            'limitations': ['테스트 응답이며 실제 선수 평가 아님'],
                            'nextAction': '등번호가 보이는 다른 구간을 선택하세요.',
                        },
                    })
                else:
                    assert mode['status'] == 'success'
                    route.fulfill(json={
                        'model': 'test-model',
                        'result': {
                            'identified': True,
                            'summary': '브라우저 검증용 AI 응답',
                            'observations': [{
                                'skill': 'move', 'time': 1,
                                'note': '검증용 장면 설명', 'type': 'focus',
                                'confidence': 'medium',
                            }],
                            'limitations': ['테스트 응답이며 실제 선수 평가 아님'],
                            'nextAction': '테스트 연습',
                        },
                    })

            page.route('**/api/analysis', analysis_api)
            base = f'http://127.0.0.1:{server.server_port}'
            page.goto(base, wait_until='networkidle')

            def state():
                return page.evaluate('key => JSON.parse(localStorage.getItem(key))', STATE_KEY)

            def open_analysis():
                page.locator('[data-action=analyze-video]').first.tap()

            def prepare_analysis(code='browser-pilot-code'):
                open_analysis()
                expect(page.locator('#analysis-form')).to_be_visible()
                assert page.locator('#analysis-form').evaluate('(form) => form.noValidate')
                page.locator('input[name=start]').fill('00:00')
                page.locator('select[name=length]').select_option('2')
                page.locator('input[name=accessCode]').fill(code)
                page.locator('input[name=consent]').check()

            def submit_analysis():
                page.get_by_role('button', name='이 구간 분석 요청', exact=True).tap()

            # Register real local bytes and verify the dashboard acknowledges it.
            page.locator('.mobile-nav-item[data-page=videos]').tap()
            page.get_by_role('button', name='영상 등록', exact=True).tap()
            page.locator('#original-file').set_input_files(str(movie))
            page.locator('input[name=rights]').check()
            page.get_by_role('button', name='원본 영상 등록', exact=True).tap()
            expect(page.get_by_role('dialog')).to_have_count(0)
            expect(page.locator('.upload-receipt')).to_contain_text('저장 완료')
            expect(page.locator('.upload-receipt')).to_contain_text('장면 분석 검증')
            expect(page.locator('.radar-summary')).to_contain_text('아직 평가 전')
            assert len(state()['videos']) == 2
            assert state().get('analyses', []) == []

            # A static deployment must explain the absent backend, never pretend
            # that a model is running or POST footage to an unknown destination.
            open_analysis()
            expect(page.locator('#analysis-setup.unavailable')).to_contain_text('분석 연결이 필요')
            expect(page.locator('#analysis-setup')).to_contain_text('서버가 없습니다')
            expect(page.locator('#analysis-form')).to_be_hidden()
            assert posts == []
            page.screenshot(path='/tmp/next-xi-analysis-unavailable.png', full_page=True)
            page.get_by_role('button', name='확인했어요', exact=True).tap()

            # Consent and the pilot access code are validated visibly before any
            # frame extraction or POST request. This is not an API key field.
            mode['status'] = 'unauthorized'
            open_analysis()
            expect(page.locator('#analysis-form')).to_be_visible()
            assert page.locator('#analysis-form').evaluate('(form) => form.noValidate')
            submit_analysis()
            expect(page.locator('#analysis-error')).to_contain_text('동의')
            expect(page.locator('#analysis-error')).to_be_in_viewport()
            page.locator('input[name=consent]').check()
            submit_analysis()
            expect(page.locator('#analysis-error')).to_contain_text('이용 코드')
            assert posts == []
            page.locator('select[name=length]').select_option('2')
            page.locator('input[name=accessCode]').fill('wrong-pilot-code')
            submit_analysis()
            expect(page.locator('#analysis-error')).to_contain_text('올바르지 않습니다', timeout=30000)
            expect(page.locator('input[name=accessCode]')).to_have_value('')
            expect(page.get_by_role('button', name='이 구간 분석 요청', exact=True)).to_be_enabled()
            assert len(posts) == 1
            assert state().get('analyses', []) == []
            assert state()['observations'] == []

            # The exact production request contains actual JPEGs, bounded times,
            # explicit consent and a pilot code; never the full video or API key.
            payload = posts[0]
            assert set(payload) == {'frames', 'videoId', 'start', 'end', 'accessCode', 'consent'}
            assert payload['start'] == 0 and payload['end'] == 2
            assert payload['consent'] is True
            assert len(payload['frames']) == 4
            assert [frame['time'] for frame in payload['frames']] == [0, 0.5, 1, 1.5]
            frame_bytes = []
            for frame in payload['frames']:
                assert frame['image'].startswith('data:image/jpeg;base64,')
                data = base64.b64decode(frame['image'].split(',', 1)[1], validate=True)
                assert data.startswith(b'\xff\xd8') and data.endswith(b'\xff\xd9')
                assert data != movie.read_bytes()
                frame_bytes.append(data)
            assert len(set(frame_bytes)) > 1, 'real decoding must extract different moments'
            dimensions = page.evaluate('''async source => {
                const image = new Image(); image.src = source; await image.decode();
                return [image.naturalWidth, image.naturalHeight];
            }''', payload['frames'][0]['image'])
            assert dimensions == [320, 180]
            assert len(json.dumps(payload).encode()) < 3_000_000

            # Recover in the same form and persist the mocked result with source
            # labels. Sparse scene feedback must not turn into eight skill scores.
            mode['status'] = 'success'
            page.locator('input[name=accessCode]').fill('browser-pilot-code')
            submit_analysis()
            expect(page.get_by_role('dialog')).to_have_count(0, timeout=30000)
            expect(page.locator('.analysis-result')).to_contain_text('브라우저 검증용 AI 응답')
            expect(page.locator('.analysis-result')).to_contain_text('AI 초안')
            expect(page.locator('.analysis-result')).to_contain_text('테스트 응답이며 실제 선수 평가 아님')
            expect(page.locator('.analysis-result .ai-observation')).to_have_count(1)
            assert len(state()['analyses']) == 1
            assert state()['analyses'][0]['result']['observations'][0]['time'] == 1
            assert state()['observations'] == []
            assert 'browser-pilot-code' not in json.dumps(state())
            assert 'wrong-pilot-code' not in json.dumps(state())
            assert 'data:image/jpeg' not in json.dumps(state())
            page.screenshot(path='/tmp/next-xi-analysis-result.png', full_page=True)
            page.reload(wait_until='networkidle')
            expect(page.locator('.analysis-result')).to_contain_text('브라우저 검증용 AI 응답')
            page.locator('.mobile-nav-item[data-page=dashboard]').tap()
            expect(page.locator('.dashboard-feedback')).to_contain_text('브라우저 검증용 AI 응답')
            expect(page.locator('.dashboard-feedback')).to_contain_text('AI 초안')
            page.screenshot(path='/tmp/next-xi-analysis-dashboard.png', full_page=True)
            page.locator('.mobile-nav-item[data-page=report]').tap()
            expect(page.locator('.analysis-result')).to_contain_text('브라우저 검증용 AI 응답')
            expect(page.locator('.radar-chart')).to_have_attribute('aria-label', '아직 평가 전인 8개 항목 스파이더맵')
            assert state()['observations'] == []
            page.locator('.mobile-nav-item[data-page=videos]').tap()

            # Identification failure is a stored abstention with no invented
            # observations; it cannot overwrite the prior successful evidence.
            mode['status'] = 'unidentified'
            prepare_analysis()
            submit_analysis()
            expect(page.get_by_role('dialog')).to_have_count(0, timeout=30000)
            expect(page.locator('.analysis-result')).to_contain_text('선수 확인이 어려운 장면')
            expect(page.locator('.analysis-result .ai-observation')).to_have_count(0)
            assert len(state()['analyses']) == 2
            assert state()['analyses'][-1]['result']['identified'] is False
            assert state()['analyses'][-1]['result']['observations'] == []
            assert state()['observations'] == []

            # Cancellation while awaiting the external server aborts the request,
            # leaves the original/previous results intact, and restores controls.
            mode['status'] = 'hold'
            prepare_analysis()
            submit_analysis()
            page.wait_for_function('document.querySelector("#analysis-progress p")?.textContent.includes("응답")')
            page.wait_for_timeout(200)
            assert len(held_routes) == 1
            page.locator('#analysis-form .modal-actions [data-action=close-modal]').tap()
            expect(page.locator('#analysis-error')).to_contain_text('취소', timeout=10000)
            expect(page.get_by_role('button', name='이 구간 분석 요청', exact=True)).to_be_enabled()
            assert len(state()['analyses']) == 2
            assert len(state()['videos']) == 2
            try:
                held_routes.pop().abort()
            except Exception:
                pass  # The browser may already have disposed of the aborted route.
            page.locator('#analysis-form .modal-actions [data-action=close-modal]').tap()

            # The keyboard-sized phone layout keeps the sticky action and error
            # visible without horizontal scrolling on narrow smartphones.
            mode['status'] = 'success'
            for width in [320, 390]:
                page.set_viewport_size({'width': width, 'height': 844})
                open_analysis()
                expect(page.locator('#analysis-form')).to_be_visible()
                submit_analysis()
                expect(page.locator('#analysis-error')).to_contain_text('동의')
                expect(page.locator('#analysis-error')).to_be_in_viewport()
                expect(page.get_by_role('button', name='이 구간 분석 요청', exact=True)).to_be_in_viewport()
                assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
                page.screenshot(path=f'/tmp/next-xi-analysis-modal-{width}.png', full_page=True)
                page.locator('#analysis-form .modal-actions [data-action=close-modal]').tap()

            # Removing the original must also remove its derived AI records from
            # every view, rather than leaving inaccessible analysis behind.
            page.get_by_role('button', name='영상 삭제', exact=True).tap()
            page.get_by_role('button', name='원본 영상 삭제', exact=True).tap()
            expect(page.locator('.analysis-result')).to_have_count(0)
            assert state()['analyses'] == []
            assert len(state()['videos']) == 1
            page.locator('.mobile-nav-item[data-page=dashboard]').tap()
            expect(page.locator('.dashboard-feedback')).to_have_count(0)
            page.locator('.mobile-nav-item[data-page=report]').tap()
            expect(page.locator('.analysis-result')).to_have_count(0)

            assert len(posts) == 4
            assert not errors, errors
            print('PASS: real MP4 upload/decode/JPEG extraction; missing backend without POST; visible consent/code validation; 401 recovery; bounded payload without full video or provider key; persisted labeled mocked results in video/dashboard/report; no fabricated skill scores; reload; unidentified abstention; cancellation; 320/390px layouts; original deletion cleans derived records from every view; no JavaScript errors. Analysis API was mocked; live model accuracy and deployment credentials were not tested.')
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
