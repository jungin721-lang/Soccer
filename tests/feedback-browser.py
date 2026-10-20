"""Private feedback browser regression using synthetic reports/video only.

Run: python tests/feedback-browser.py
Requires Chromium, Playwright and FFmpeg. Serves public/ on an owned ephemeral
loopback server; never runs the app server, sends reports, or calls paid APIs.
Checks 320/390px Chromium touch viewports, not physical iPhone/Android devices.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import urlsplit
import base64
import copy
import json
import subprocess
import time

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / '.test-results'
CANARY = 'synthetic-private-feedback-canary'
VIDEO_NAME = 'source-private-local-only.mp4'
AUDIT = r"""(() => {
  const active = new Set();
  const audit = window.__feedbackAudit = {created: [], revoked: [], sourceReads: 0, xssExecuted: false};
  audit.snapshot = () => ({created:audit.created, revoked:audit.revoked, active:[...active], sourceReads:audit.sourceReads, xssExecuted:audit.xssExecuted});
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => { const url = create(blob); active.add(url); audit.created.push(url); return url; };
  URL.revokeObjectURL = url => { active.delete(url); audit.revoked.push(url); return revoke(url); };
  const videoFile = file => file instanceof File && /^video\//.test(file.type);
  for (const name of ['arrayBuffer','text','stream','bytes']) {
    const original = Blob.prototype[name]; if (!original) continue;
    Blob.prototype[name] = function(...args) {
      if (videoFile(this)) { audit.sourceReads++; throw new Error('Original video must not be buffered into JavaScript'); }
      return original.apply(this,args);
    };
  }
  for (const name of ['readAsArrayBuffer','readAsBinaryString','readAsDataURL','readAsText']) {
    const original = FileReader.prototype[name]; if (!original) continue;
    FileReader.prototype[name] = function(blob,...args) {
      if (videoFile(blob)) { audit.sourceReads++; throw new Error('Original video must not be read by FileReader'); }
      return original.call(this,blob,...args);
    };
  }
})()"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def fixture(report_id='synthetic-match-review'):
    return {
        'schema': 'next-xi-feedback/v1', 'id': report_id,
        'title': '합성 경기 피드백 · 개인정보 없는 테스트 ⚽',
        'target': {'kit': 'navy', 'number': 11, 'age': 11}, 'reviewedAt': None,
        'source': {'kind': 'still_frames', 'durationSeconds': 4, 'reviewedFrames': 6,
                   'confirmedTargetFrames': 2, 'continuous': False,
                   'description': '합성 영상의 일부 프레임만 검토한 테스트 자료입니다.'},
        'summary': f'{CANARY}: 확인한 장면과 연습을 구분하는 합성 결과입니다.',
        'observations': [
            {'id': 'scene-one', 'time': 1, 'endTime': 1.5,
             'fact': '합성 장면에서 공 옆에 남색 표시가 보입니다.',
             'interpretation': '다음 패스 전에 주위를 확인하는 연습을 제안할 수 있습니다.',
             'uncertainty': '정지화면 사이의 움직임과 번호는 확인하지 못했습니다.'},
            {'id': 'scene-two', 'time': 2.5, 'endTime': 3,
             'fact': '두 번째 합성 장면에서 표시 위치가 바뀝니다.',
             'interpretation': '짧은 움직임을 이어 보는 참고 장면입니다.',
             'uncertainty': '선수의 의도와 화면 밖 행동은 알 수 없습니다.'},
        ],
        'unobserved': ['경기 전체 능력과 화면 밖 움직임은 확인 불가입니다.'],
        'training': [{'id': 'practice-one', 'title': '고개 들고 공 다루기',
                      'reason': '일부 장면에서 확인하지 못한 주변 확인을 연습합니다.',
                      'goal': '공을 멈춘 뒤 좌우 표식을 한 번씩 확인합니다.',
                      'minutes': 10, 'frequency': '주 2회', 'equipment': ['공', '표식 2개'],
                      'steps': [{'label': '준비', 'minutes': 2, 'instructions': ['편한 속도로 공을 움직입니다.']},
                                {'label': '둘러보기', 'minutes': 3, 'instructions': ['공을 멈추고 좌우 표식을 번갈아 봅니다.']},
                                {'label': '이어가기', 'minutes': 5, 'instructions': ['무리하지 않고 표식 사이를 움직입니다.']}],
                      'success': '다섯 번 중 세 번 표식 두 개를 차례로 확인하면 성공입니다.'}],
        'limitations': ['합성 테스트이며 실제 선수 분석이 아닙니다.', '일부 프레임으로 경기 전체를 판단하지 않습니다.'],
        'provenance': {'kind': 'chat_review', 'professionalReview': False},
    }


def write_report(path, report):
    path.write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')


def no_overflow(page, label):
    size = page.evaluate('({viewport:innerWidth,content:document.documentElement.scrollWidth})')
    assert size['content'] <= size['viewport'], f'{label}: horizontal overflow {size}'


def touch_target(locator, label):
    box = locator.bounding_box()
    assert box and box['height'] >= 44 and box['width'] >= 44, f'{label}: below 44px touch target: {box}'


def stored(page):
    return page.evaluate("async () => (await import('/feedback.js')).listFeedbackReports()")


def clean_audit(page, allow_video=False):
    snapshot = page.evaluate('window.__feedbackAudit.snapshot()')
    assert snapshot['sourceReads'] == 0, 'Original video was read into JavaScript'
    assert snapshot['xssExecuted'] is False, 'Imported HTML executed'
    if not allow_video:
        assert not snapshot['active'], 'Local video object URL leaked'
        assert set(snapshot['created']).issubset(set(snapshot['revoked']))
    return snapshot


def open_page(browser, origin, width, fragment=''):
    context = browser.new_context(viewport={'width': width, 'height': 844}, is_mobile=True,
                                  has_touch=True, reduced_motion='reduce')
    context.add_init_script(AUDIT)
    violations, errors, request_count = [], [], [0]
    allowed = urlsplit(origin)
    static_paths = {'/feedback.html', '/feedback.css', '/chat-pack.css', '/feedback-ui.js', '/feedback.js',
                    '/growth-domain.js', '/domain.js', '/assets/favicon.svg'}

    def protect(route):
        request = route.request
        parsed = urlsplit(request.url)
        request_count[0] += 1
        reason = None
        if request.method not in ('GET', 'HEAD'):
            reason = 'write request'
        elif parsed.path.startswith('/api/') and parsed.path != '/api/v2/feedback':
            reason = 'API request'
        elif parsed.scheme in ('http', 'https') and (parsed.scheme, parsed.netloc) != (allowed.scheme, allowed.netloc):
            reason = 'third-party request'
        elif parsed.scheme in ('http', 'https') and (parsed.path not in static_paths and parsed.path != '/api/v2/feedback' or parsed.query or parsed.fragment):
            reason = 'non-static request'
        sensitive = [CANARY, VIDEO_NAME, 'report=']
        transmitted = request.url + (request.post_data or '') + json.dumps(request.headers)
        if any(marker in transmitted for marker in sensitive):
            reason = 'private report/video/fragment transmitted'
        if reason:
            violations.append(reason)
            route.abort('blockedbyclient')
        elif parsed.path == '/api/v2/feedback':
            route.fulfill(status=401, content_type='application/json', body=json.dumps({'error': '홈에서 로그인해 주세요.'}))
        else:
            route.continue_()

    context.route('**/*', protect)
    page = context.new_page()
    page.on('pageerror', lambda failure: errors.append(str(failure)))
    response = page.goto(origin + '/feedback.html' + fragment, wait_until='networkidle')
    assert response and response.status == 200
    expect(page.locator('#feedback-file')).to_be_enabled()
    assert not errors, errors
    no_overflow(page, f'initial {width}px')
    return context, page, violations, errors, request_count


def verify_rendered_report(page, report, width):
    expect(page.locator('#feedback-report')).to_be_visible()
    expect(page.locator('#feedback-report h2')).to_have_text(report['title'])
    expect(page.locator('.summary-text')).to_have_text(report['summary'])
    expect(page.locator('.report-date')).to_have_text('검토 날짜 미기록')
    expect(page.locator('.source-counts')).to_contain_text('검토 6프레임')
    expect(page.locator('.source-counts')).to_contain_text('대상 확인 2프레임')
    expect(page.locator('.observation')).to_have_count(2)
    assert page.locator('.observation .fact-label').all_text_contents() == ['관찰한 사실', '가능한 해석', '아직 모르는 점'] * 2
    expect(page.locator('#feedback-report')).to_contain_text('확인 불가')
    expect(page.locator('#feedback-report')).to_contain_text('자동 분석 결과 아님')
    expect(page.locator('#feedback-report')).to_contain_text('전문가 검토 미확인')
    expect(page.locator('.training-heading')).to_contain_text('10분 연습')
    assert page.locator('.training-steps h4 span').all_text_contents() == ['2분', '3분', '5분']
    assert sum(step['minutes'] for step in report['training'][0]['steps']) == report['training'][0]['minutes']
    for selector in ('.evidence-time', '.local-video .file-label'):
        touch_target(page.locator(selector).first, selector)
    no_overflow(page, f'rendered {width}px')


def exercise_import(browser, origin, report_file, report, movie, temporary, width):
    context, page, violations, errors, requests = open_page(browser, origin, width)
    try:
        expect(page.locator('#report-count')).to_have_text('0 / 50')
        touch_target(page.locator('label[for="feedback-file"]'), 'JSON file picker')
        page.locator('#feedback-file').set_input_files(str(report_file))
        expect(page.locator('#report-count')).to_have_text('1 / 50')
        verify_rendered_report(page, report, width)
        expect(page.locator('.evidence-time').first).to_be_disabled()
        assert stored(page)['reports'] == [report]
        page.reload(wait_until='networkidle')
        expect(page.locator('#feedback-file')).to_be_enabled()
        verify_rendered_report(page, report, width)
        assert stored(page)['reports'] == [report], 'IndexedDB did not retain the imported result after reload'
        touch_target(page.locator('#report-list button'), 'saved report')
        touch_target(page.locator('.delete-button'), 'delete report')

        if width == 390:
            picker = page.locator('.local-video input[type=file]')
            picker.set_input_files(str(movie))
            expect(page.locator('.local-player')).to_be_visible(timeout=15000)
            expect(page.locator('.evidence-time').nth(1)).to_be_enabled()
            assert page.locator('.local-player').evaluate('video => [video.videoWidth,video.videoHeight]') == [320, 180]
            page.locator('.evidence-time').nth(1).click()
            page.wait_for_function('() => {const video=document.querySelector(".local-player");return !video.seeking && video.readyState >= 2 && video.currentTime >= 2.6;}')
            timestamp = page.locator('.local-player').evaluate('video => {video.pause();return video.currentTime;}')
            assert 2.5 <= timestamp < 3.5, f'Wrong absolute evidence seek: {timestamp}'
            touch_target(page.locator('.remove-video'), 'disconnect local video')
            assert clean_audit(page, allow_video=True)['active'], 'Native local video was never opened'
            assert VIDEO_NAME not in json.dumps(stored(page)), 'Original filename was persisted in the report database'
            page.locator('.remove-video').click()
            expect(page.locator('.local-player')).to_be_hidden()
            expect(page.locator('.evidence-time').first).to_be_disabled()
            clean_audit(page)
            picker.set_input_files(str(movie))
            expect(page.locator('.local-player')).to_be_visible(timeout=15000)
            page.reload(wait_until='networkidle')
            expect(page.locator('#feedback-file')).to_be_enabled()
            verify_rendered_report(page, report, width)
            expect(page.locator('.local-player')).to_be_hidden()
            expect(page.locator('.evidence-time').first).to_be_disabled()
            assert stored(page)['reports'] == [report]
            assert VIDEO_NAME not in json.dumps(stored(page)), 'Original video connection survived reload in storage'
            assert page.evaluate('Object.keys(localStorage).length + Object.keys(sessionStorage).length') == 0
            assert page.evaluate('async () => (await indexedDB.databases()).map(db => db.name)') == ['next-xi-private-feedback-v1']

        page.evaluate('document.activeElement?.blur()')
        page.screenshot(path=str(ARTIFACTS / f'feedback-synthetic-{width}.png'), full_page=True)
        page.locator('.delete-button').click()
        expect(page.locator('#delete-dialog')).to_be_visible()
        touch_target(page.locator('#cancel-delete'), 'cancel deletion')
        touch_target(page.locator('#confirm-delete'), 'confirm deletion')
        no_overflow(page, f'deletion dialog {width}px')
        page.locator('#cancel-delete').click()
        assert len(stored(page)['reports']) == 1, 'Cancelling deletion removed the result'
        page.locator('.delete-button').click()
        page.locator('#confirm-delete').click()
        expect(page.locator('#report-count')).to_have_text('0 / 50')
        expect(page.locator('#feedback-report')).to_be_hidden()
        assert stored(page)['reports'] == []
        page.reload(wait_until='networkidle')
        expect(page.locator('#feedback-empty')).to_be_visible()
        expect(page.locator('#report-count')).to_have_text('0 / 50')
        assert stored(page)['reports'] == [], 'Deletion did not survive reload'
        clean_audit(page)
        assert not violations, violations
        assert not errors, errors
        return requests[0]
    finally:
        context.close()


def exercise_private_link(browser, origin, temporary, width):
    report = fixture('synthetic-link-preview')
    report['summary'] = f'{CANARY} · 유니코드 링크 미리보기 ⚽'
    encoded = base64.urlsafe_b64encode(json.dumps(report, ensure_ascii=False).encode()).decode().rstrip('=')
    context, page, violations, errors, requests = open_page(browser, origin, width, '#report=' + encoded)
    try:
        assert urlsplit(page.url).fragment == '', 'Private report remains in the address bar'
        expect(page.locator('.shared-preview')).to_contain_text('아직 저장하지 않았어요')
        expect(page.locator('#report-count')).to_have_text('0 / 50')
        verify_rendered_report(page, report, width)
        assert stored(page)['reports'] == [], 'Opening a private link auto-saved the report'
        expect(page.locator('.delete-button')).to_have_count(0)
        save = page.get_by_role('button', name='이 기기에 저장', exact=True)
        touch_target(save, 'explicit private preview save')
        page.screenshot(path=str(ARTIFACTS / f'feedback-synthetic-preview-{width}.png'), full_page=True)
        # Reloading the cleaned URL must lose an unsaved preview.
        page.reload(wait_until='networkidle')
        expect(page.locator('#feedback-empty')).to_be_visible()
        assert stored(page)['reports'] == []
        page.goto(origin + '/feedback.html#report=' + encoded, wait_until='networkidle')
        expect(page.locator('.shared-preview')).to_be_visible()
        page.get_by_role('button', name='이 기기에 저장', exact=True).click()
        expect(page.locator('#report-count')).to_have_text('1 / 50')
        expect(page.locator('.shared-preview')).to_have_count(0)
        assert stored(page)['reports'] == [report]
        page.reload(wait_until='networkidle')
        verify_rendered_report(page, report, width)
        expect(page.locator('#report-count')).to_have_text('1 / 50')
        assert urlsplit(page.url).fragment == ''
        clean_audit(page)
        assert not violations, violations
        assert not errors, errors
        return requests[0]
    finally:
        context.close()


def exercise_invalid_and_xss(browser, origin, temporary):
    context, page, violations, errors, requests = open_page(browser, origin, 320)
    try:
        report = fixture('synthetic-safe-html')
        report['summary'] = '<img src="https://payload.invalid/' + CANARY + '" onerror="window.__feedbackAudit.xssExecuted=true"><script>window.__feedbackAudit.xssExecuted=true</script>'
        report_file = temporary / 'synthetic-html-as-text.json'
        write_report(report_file, report)
        page.locator('#feedback-file').set_input_files(str(report_file))
        verify_rendered_report(page, report, 320)
        expect(page.locator('#feedback-report img,#feedback-report script,#feedback-report iframe')).to_have_count(0)
        clean_audit(page)
        assert stored(page)['reports'] == [report]
        rejected = 0
        invalid_cases = []
        bad = copy.deepcopy(report); bad['source']['filename'] = '<img onerror="alert(1)">'; invalid_cases.append(json.dumps(bad))
        bad = copy.deepcopy(report); bad['training'][0]['steps'][0]['minutes'] = 1; invalid_cases.append(json.dumps(bad))
        invalid_cases.append('{"schema": "next-xi-feedback/v1", broken json')
        details = page.locator('.paste-details')
        for index, content in enumerate(invalid_cases):
            details.evaluate('node => {node.open = true}')
            page.locator('#feedback-text').fill(content)
            page.locator('#import-text').click()
            expect(page.locator('#feedback-error')).to_be_visible()
            expect(page.locator('#report-count')).to_have_text('1 / 50')
            assert stored(page)['reports'] == [report], f'Invalid payload {index} changed stored reports'
            clean_audit(page)
            rejected += 1
        page.goto(origin + '/feedback.html#report=invalid!', wait_until='networkidle')
        expect(page.locator('#feedback-error')).to_be_visible()
        assert urlsplit(page.url).fragment == ''
        expect(page.locator('#report-count')).to_have_text('1 / 50')
        assert stored(page)['reports'] == [report]
        no_overflow(page, 'invalid import and fragment 320px')
        assert not violations, violations
        assert not errors, errors
        return rejected + 1, requests[0]
    finally:
        context.close()


def main():
    started = time.monotonic()
    ARTIFACTS.mkdir(exist_ok=True)
    requests = 0
    with TemporaryDirectory(prefix='next-xi-feedback-browser-') as directory:
        temporary = Path(directory)
        report = fixture()
        report_file = temporary / 'synthetic-feedback.json'
        write_report(report_file, report)
        movie = temporary / VIDEO_NAME
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                        'testsrc2=size=320x180:rate=20', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                        '-g', '20', '-movflags', '+faststart', str(movie)], check=True)
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT / 'public')))
        thread = Thread(target=server.serve_forever, daemon=True); thread.start()
        origin = f'http://127.0.0.1:{server.server_port}'
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
                try:
                    for width in (390, 320):
                        requests += exercise_import(browser, origin, report_file, report, movie, temporary, width)
                        print(f'PASS: {width}px JSON import, IndexedDB reload/delete, evidence/training labels and touch targets', flush=True)
                        requests += exercise_private_link(browser, origin, temporary, width)
                        print(f'PASS: {width}px UTF-8 private fragment preview, no auto-save, hash removal and explicit save/reload', flush=True)
                    invalid_count, invalid_requests = exercise_invalid_and_xss(browser, origin, temporary)
                    requests += invalid_requests
                finally:
                    browser.close()
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=5)
    print(f'PASS: 5 synthetic browser scenarios; {invalid_count} malformed/schema/training/fragment rejections; '
          f'HTML prose stays text, real local H.264 evidence seek/disconnect without video persistence or buffering; '
          f'{requests} allowed static/account-status GET requests, zero write/third-party/private-content requests or page errors; '
          f'320/390px overflow and 44px touch checks. {time.monotonic() - started:.1f}s. '
          f'Synthetic screenshots only; physical phones remain unverified.')


if __name__ == '__main__':
    main()
