"""Real browser-only chat-pack regression with a synthetic H.264 video.

Run: python tests/chat-pack-browser.py
Optional CHAT_PACK_BASE_URL=https://your-site.example reuses a deployed site
instead of starting the local app. HTTPS_PROXY is supported in that mode; its
value and credentials are never logged. All API, write, and third-party browser
requests are blocked and asserted absent. This test never invokes paid AI.

Requires Chromium, Playwright, Pillow, FFmpeg, and the installed Node packages.
Mobile checks use Chromium viewports, not physical iOS or Android devices.
"""
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import unquote, urlsplit
import json
import os
import re
import select
import subprocess
import time
import zipfile

from PIL import Image
from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / '.test-results'
MAX_PACK_BYTES = 8 * 1024 ** 2

# Observe real decoder/canvas work and cleanup without changing their behavior.
# Rejecting whole-video File reads also catches accidental memory-heavy paths;
# generated JPEG/manifest/README reads remain native and work normally.
AUDIT_SCRIPT = r"""(() => {
  const audit = window.__chatPackAudit = {draws: [], created: [], revoked: [], active: [], wholeSourceReads: 0};
  const active = new Set();
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => {
    const url = create(blob); active.add(url);
    audit.created.push({url, type: blob.type, size: blob.size}); audit.active = [...active];
    return url;
  };
  URL.revokeObjectURL = url => {
    audit.revoked.push(url); active.delete(url); audit.active = [...active]; return revoke(url);
  };
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
    if (source instanceof HTMLVideoElement) audit.draws.push({time: source.currentTime, width: source.videoWidth, height: source.videoHeight, ready: source.readyState});
    return draw.call(this, source, ...args);
  };
  const sourceFile = value => value instanceof File && (/^video\//.test(value.type) || /\.(mp4|mov|m4v|webm|3gp)$/i.test(value.name));
  for (const name of ['arrayBuffer', 'text', 'stream']) {
    const original = Blob.prototype[name];
    if (!original) continue;
    Blob.prototype[name] = function(...args) {
      if (sourceFile(this)) { audit.wholeSourceReads++; throw new Error('Whole original-file JavaScript read is forbidden in this regression'); }
      return original.apply(this, args);
    };
  }
  for (const name of ['readAsArrayBuffer', 'readAsBinaryString', 'readAsDataURL', 'readAsText']) {
    const original = FileReader.prototype[name];
    if (!original) continue;
    FileReader.prototype[name] = function(blob, ...args) {
      if (sourceFile(blob)) { audit.wholeSourceReads++; throw new Error('Whole original-file FileReader read is forbidden in this regression'); }
      return original.call(this, blob, ...args);
    };
  }
})()"""


def no_overflow(page, label):
    sizes = page.evaluate('({viewport: innerWidth, content: document.documentElement.scrollWidth})')
    assert sizes['content'] <= sizes['viewport'], f'{label}: horizontal overflow {sizes}'


def audit(page):
    return page.evaluate('window.__chatPackAudit')


def select_source(page, source):
    page.locator('#chat-video-file').set_input_files(str(source))
    expect(page.locator('#selected-file')).to_be_visible()
    expect(page.locator('#selected-file-name')).to_have_text(source.name)
    # The UI deliberately clears the native picker after capturing the File.
    expect(page.locator('#chat-video-file')).to_have_value('')


def set_target_and_consent(page):
    form = page.locator('#chat-pack-form')
    form.locator('[name=kit]').select_option('navy')
    form.locator('[name=number]').fill('11')
    form.locator('[name=age]').fill('11')
    form.locator('[name=rightsConsent]').check()


def read_zip(path, source_name, draw_records, expected_sample_set=0):
    assert 0 < path.stat().st_size <= MAX_PACK_BYTES, 'ZIP exceeds its promised 8MiB ceiling'
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, 'ZIP CRC integrity check failed'
        names = archive.namelist()
        images = [f'next-xi-sample-{index:02}.jpg' for index in range(1, 7)]
        assert len(names) == len(set(names)) == 8, names
        assert set(names) == set(images + ['manifest.json', 'README.txt']), names
        assert not any(name.lower().endswith(('.mp4', '.mov', '.m4v', '.webm')) for name in names)
        manifest_bytes = archive.read('manifest.json')
        readme = archive.read('README.txt').decode('utf-8')
        assert source_name not in manifest_bytes.decode('utf-8') + readme, 'Original filename leaked into shared materials'
        manifest = json.loads(manifest_bytes)
        assert manifest['schema'] == 'next-xi-chat-pack/v1'
        assert manifest['purpose'] == 'manual_chat_review'
        assert manifest['target'] == {'kit': 'navy', 'number': 11, 'age': 11, 'kitLabel': '남색'}
        assert manifest['analysis'] == {'performed': False, 'playerIdentified': False, 'ratingsGenerated': False}
        video = manifest['video']
        assert 35.9 <= video['durationSeconds'] <= 36.1
        assert (video['width'], video['height']) == (320, 180)
        sampling = manifest['sampling']
        assert sampling['method'] == 'uniform_time_windows'
        assert sampling['sampleSet'] == expected_sample_set
        assert sampling['windowCount'] == 6 and sampling['totalFrames'] == 36
        assert sampling['maxWindowSeconds'] == 3 and sampling['continuousCoverage'] is False
        assert sampling['alternateTimesAvailable'] is True
        assert isinstance(manifest['limitations'], list) and len(manifest['limitations']) >= 3
        assert 'AI 분석' in readme and '선수 식별' in readme and '원본' in readme
        sheets = manifest['sheets']
        assert len(sheets) == 6
        times, centers = [], []
        for index, sheet in enumerate(sheets, 1):
            assert sheet['index'] == index and sheet['file'] == images[index - 1]
            assert 0 <= sheet['start'] < sheet['end'] <= video['durationSeconds']
            assert sheet['end'] - sheet['start'] <= 3.0001
            assert len(sheet['frames']) == 6
            frame_times = [frame['time'] for frame in sheet['frames']]
            assert frame_times == sorted(frame_times) and len(set(frame_times)) == 6
            assert all(sheet['start'] - .1 <= second <= sheet['end'] + .1 for second in frame_times)
            assert all(re.fullmatch(r'\d{2}:\d{2}:\d{2}\.\d{3}', frame['label']) for frame in sheet['frames'])
            times.extend(frame_times)
            centers.append((sheet['start'] + sheet['end']) / 2)
            image_bytes = archive.read(sheet['file'])
            assert image_bytes[:2] == b'\xff\xd8'
            with Image.open(BytesIO(image_bytes)) as image:
                assert image.format == 'JPEG' and image.width > 320 and image.height > 180
                image.verify()
        assert len(set(times)) == 36
        assert min(times) <= video['durationSeconds'] * .15
        assert max(times) >= video['durationSeconds'] * .85
        assert centers[-1] - centers[0] >= video['durationSeconds'] * .75
        assert len(draw_records) == 36, 'Expected 36 real video-to-canvas draws'
        assert all(row['width'] == 320 and row['height'] == 180 and row['ready'] >= 2 for row in draw_records)
        assert all(abs(row['time'] - second) < .15 for row, second in zip(draw_records, times))
        return manifest


def configured_origin():
    raw = os.environ.get('CHAT_PACK_BASE_URL', '').strip()
    if not raw:
        return None
    parsed = urlsplit(raw)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('CHAT_PACK_BASE_URL must be a public HTTPS site URL without credentials or query parameters')
    return f'{parsed.scheme}://{parsed.netloc}'


def browser_proxy(remote):
    if not remote:
        return None
    raw = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy') or os.environ.get('HTTP_PROXY') or os.environ.get('http_proxy')
    if not raw:
        return None
    parsed = urlsplit(raw if '://' in raw else 'http://' + raw)
    if parsed.scheme not in ('http', 'https', 'socks5') or not parsed.hostname:
        raise ValueError('Proxy configuration is not a supported browser proxy')
    host = f'[{parsed.hostname}]' if ':' in parsed.hostname else parsed.hostname
    result = {'server': f'{parsed.scheme}://{host}' + (f':{parsed.port}' if parsed.port else '')}
    if parsed.username is not None:
        result['username'] = unquote(parsed.username)
    if parsed.password is not None:
        result['password'] = unquote(parsed.password)
    return result


def start_local_server(temporary):
    environment = os.environ.copy()
    for key in ('OPENAI_API_KEY', 'SOCCER_AI_API_KEY', 'SOCCER_ANALYSIS_ACCESS_CODE'):
        environment.pop(key, None)
    environment.update(PORT='0', NEXT_XI_DATA_DIR=str(temporary / 'server-data'))
    process = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('Isolated local app server failed to start')
        if select.select([process.stdout], [], [], .1)[0]:
            line = process.stdout.readline()
            match = re.search(r'NEXT XI is running on port (\d+)', line)
            if match:
                return process, f'http://127.0.0.1:{match[1]}'
    process.terminate()
    process.wait(timeout=5)
    raise RuntimeError('Isolated local app server startup timed out')


def exercise_mobile(browser, origin, movie, corrupt, replacement, temporary, width, full_error_checks):
    context = browser.new_context(viewport={'width': width, 'height': 844}, is_mobile=True, has_touch=True, accept_downloads=True, reduced_motion='reduce')
    context.add_init_script(AUDIT_SCRIPT)
    violations, errors = [], []
    allowed = urlsplit(origin)

    def block_unsafe(route):
        request = route.request
        parsed = urlsplit(request.url)
        reason = None
        if request.method not in ('GET', 'HEAD'):
            reason = 'write request'
        elif parsed.path.startswith('/api/'):
            reason = 'API request'
        elif parsed.scheme in ('http', 'https') and (parsed.scheme, parsed.netloc) != (allowed.scheme, allowed.netloc):
            reason = 'third-party request'
        if reason:
            # Do not retain full URLs or queries, which could contain secrets.
            violations.append(f'{request.method} {reason}')
            route.abort('blockedbyclient')
        else:
            route.continue_()

    context.route('**/*', block_unsafe)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        response = page.goto(origin + '/chat-pack.html', wait_until='networkidle')
        assert response and response.status == 200, 'Chat-pack page is not published'
        expect(page.locator('#create-pack')).to_be_visible()
        no_overflow(page, f'initial {width}px')
        if full_error_checks:
            page.screenshot(path=str(ARTIFACTS / 'chat-pack-initial-390.png'), full_page=True)
            page.set_viewport_size({'width': 1440, 'height': 1000})
            no_overflow(page, 'initial 1440px')
            page.screenshot(path=str(ARTIFACTS / 'chat-pack-initial-1440.png'), full_page=True)
            page.set_viewport_size({'width': width, 'height': 844})
        select_source(page, movie)
        # Browser-native required consent must stop all decoding/packaging.
        page.locator('#create-pack').click()
        expect(page.locator('[name=rightsConsent]')).not_to_be_checked()
        expect(page.locator('#pack-progress')).to_be_hidden()
        assert audit(page)['created'] == []
        set_target_and_consent(page)

        if full_error_checks:
            # Both clicks occur in one browser turn, while the real source is
            # being opened; no fake decoder/timing override is involved.
            page.evaluate("() => {document.querySelector('#create-pack').click();document.querySelector('#cancel-pack').click();}")
            expect(page.locator('#pack-notice')).to_contain_text('취소', timeout=10000)
            expect(page.locator('#create-pack')).to_be_enabled()
            expect(page.locator('#pack-error')).to_be_hidden()
            expect(page.locator('#pack-progress')).to_be_hidden()
            cancelled = audit(page)
            assert cancelled['created'], 'Cancellation must exercise an actual opened video'
            assert cancelled['active'] == [], 'Cancelled decoding leaked an object URL'
            assert cancelled['draws'] == [], 'Immediate cancellation should stop sampling'

            select_source(page, corrupt)
            page.locator('#create-pack').click()
            expect(page.locator('#pack-error')).to_be_visible(timeout=20000)
            expect(page.locator('#pack-error-message')).to_contain_text('영상')
            expect(page.locator('#retry-pack')).to_be_visible()
            expect(page.locator('#create-pack')).to_be_enabled()
            assert audit(page)['active'] == []
            previous_opens = len(audit(page)['created'])
            page.locator('#retry-pack').click()
            expect(page.locator('#pack-error')).to_be_visible(timeout=20000)
            expect(page.locator('#create-pack')).to_be_enabled()
            assert len(audit(page)['created']) > previous_opens, 'Retry did not reopen the selected source'
            assert audit(page)['active'] == [], 'Invalid-video retry leaked an object URL'
            select_source(page, movie)

        before_draw = len(audit(page)['draws'])
        page.locator('#create-pack').click()
        expect(page.locator('#pack-result')).to_be_visible(timeout=60000)
        expect(page.locator('#frame-grid .frame-card')).to_have_count(6)
        expect(page.locator('#pack-summary')).to_contain_text('JPEG 이미지 6장')
        expect(page.locator('#pack-result')).to_contain_text('자동 분석 결과가 아닌')
        expect(page.locator('#alternate-pack')).to_be_visible()
        expect(page.locator('#pack-error')).to_be_hidden()
        no_overflow(page, f'result {width}px')
        # Native lazy-loading starts when the real image approaches the screen.
        # Measure the finished preview, rather than racing its decoder.
        page.locator('.frame-preview-button').first.scroll_into_view_if_needed()
        expect(page.locator('.frame-preview-button img').first).to_have_js_property('complete', True)
        expect(page.locator('.frame-preview-button img').first).not_to_have_js_property('naturalWidth', 0)
        for control in ('#download-pack', '#alternate-pack', '.frame-preview-button'):
            box = page.locator(control).first.bounding_box()
            assert box and box['height'] >= 44, f'{control} is smaller than a 44px touch target'
        page.screenshot(path=str(ARTIFACTS / f'chat-pack-result-{width}.png'), full_page=True)
        # Native dialog reads a generated JPEG blob under the real app CSP.
        page.locator('.frame-preview-button').first.click()
        expect(page.locator('#frame-preview')).to_be_visible()
        expect(page.locator('#preview-image')).to_have_js_property('complete', True)
        expect(page.locator('#preview-image')).not_to_have_js_property('naturalWidth', 0)
        no_overflow(page, f'preview {width}px')
        page.locator('#close-preview').click()
        expect(page.locator('#frame-preview')).to_be_hidden()

        with page.expect_download() as download_info:
            page.locator('#download-pack').click()
        downloaded = temporary / f'chat-pack-{width}.zip'
        download_info.value.save_as(str(downloaded))
        current = audit(page)
        first_manifest = read_zip(downloaded, movie.name, current['draws'][before_draw:])
        assert current['wholeSourceReads'] == 0
        assert all(item['url'] in current['revoked'] for item in current['created'] if item['type'].startswith('video/')), 'Successful decoding kept its original URL alive'

        if full_error_checks:
            # Re-run the real decoder at alternate positions, rather than merely
            # testing a changed label or a mocked manifest.
            old_urls = set(current['active'])
            before_draw = len(current['draws'])
            page.locator('#alternate-pack').click()
            expect(page.locator('#pack-result')).to_be_visible(timeout=60000)
            expect(page.locator('#alternate-note')).to_contain_text('2 / 3')
            with page.expect_download() as alternate_info:
                page.locator('#download-pack').click()
            alternate = temporary / 'chat-pack-alternate.zip'
            alternate_info.value.save_as(str(alternate))
            current = audit(page)
            alternate_manifest = read_zip(alternate, movie.name, current['draws'][before_draw:], expected_sample_set=1)
            assert all(original['frames'][0]['time'] != changed['frames'][0]['time'] for original, changed in zip(first_manifest['sheets'], alternate_manifest['sheets']))
            assert old_urls.issubset(set(current['revoked'])), 'Alternate generation retained the previous result URLs'
            assert current['wholeSourceReads'] == 0
            no_overflow(page, 'alternate result 390px')

        generated_urls = set(current['active'])
        assert len(generated_urls) == 7, 'Expected only six JPEG preview URLs and one ZIP URL'
        select_source(page, replacement)
        expect(page.locator('#pack-result')).to_be_hidden()
        expect(page.locator('#frame-grid .frame-card')).to_have_count(0)
        assert not page.locator('#download-pack').get_attribute('href')
        replaced = audit(page)
        assert generated_urls.issubset(set(replaced['revoked'])), 'Changing source failed to revoke previous downloads/previews'
        assert not replaced['active'], 'Changing source retained generated blobs'
        assert replaced['wholeSourceReads'] == 0
        assert not violations, violations
        assert not errors, errors
    finally:
        context.close()


def main():
    ARTIFACTS.mkdir(exist_ok=True)
    remote_origin = configured_origin()
    with TemporaryDirectory(prefix='next-xi-chat-pack-test-') as directory:
        temporary = Path(directory)
        movie = temporary / '합성 경기 개인정보 없음.mp4'
        corrupt = temporary / '읽을 수 없는 합성 영상.mp4'
        replacement = temporary / '다른 합성 경기.mp4'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12', '-t', '36', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '12', '-movflags', '+faststart', str(movie)], check=True)
        replacement.write_bytes(movie.read_bytes())
        corrupt.write_bytes(b'not a decodable video; synthetic test data only')
        server = None
        try:
            if remote_origin:
                origin = remote_origin
            else:
                server, origin = start_local_server(temporary)
            with sync_playwright() as playwright:
                options = {'executable_path': '/usr/bin/chromium', 'headless': True, 'args': ['--no-sandbox']}
                proxy = browser_proxy(bool(remote_origin))
                if proxy:
                    options['proxy'] = proxy
                try:
                    browser = playwright.chromium.launch(**options)
                except Exception:
                    # Browser launch logs can contain --proxy-server values.
                    raise RuntimeError('Chromium could not start; inspect local browser/proxy configuration privately') from None
                try:
                    exercise_mobile(browser, origin, movie, corrupt, replacement, temporary, 390, True)
                    exercise_mobile(browser, origin, movie, corrupt, replacement, temporary, 320, False)
                finally:
                    browser.close()
        finally:
            if server:
                server.terminate()
                try:
                    server.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
    mode = 'published HTTPS' if remote_origin else 'isolated local app with production CSP'
    print(f'PASS: {mode}; real 36s H.264 selection/seek/canvas at 390/320px; six-JPEG ZIP/CRC/manifest/time spread/8MiB/privacy; cancel/corrupt/retry/alternate-time/file-change cleanup; no whole-original JS reads, API/write/third-party requests, or JS errors. Chromium viewport checks only.')


if __name__ == '__main__':
    main()
