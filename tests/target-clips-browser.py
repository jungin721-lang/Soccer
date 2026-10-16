"""Focused synthetic evidence-clip and mobile setup-guide regression.

Run against a running local app: python tests/target-clips-browser.py
Override TARGET_CLIPS_ORIGIN to use another local app port.
No user report, user image, AI request, or external write is used.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('video_clip_test_helpers', ROOT / 'tests/video-clips-browser.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
ORIGIN = os.environ.get('TARGET_CLIPS_ORIGIN', 'http://127.0.0.1:3301').rstrip('/')
ARTIFACT = ROOT / '.artifacts/v24-target-check.json'


def synthetic_report():
    return {
        'schema': 'next-xi-feedback/v1', 'id': 'synthetic-target-clip-qa',
        'title': 'SYNTHETIC ONLY · target clip regression',
        'target': {'kit': 'navy', 'number': 11, 'age': 11}, 'reviewedAt': None,
        'source': {'kind': 'video_frames', 'durationSeconds': 8, 'reviewedFrames': 1,
                   'confirmedTargetFrames': 1, 'continuous': False,
                   'description': 'Synthetic fixture only; no person or real player was analyzed.'},
        'summary': 'Synthetic schema test, not a player assessment.',
        'observations': [{'id': 'synthetic-evidence', 'time': 6,
                          'fact': 'Synthetic test marker.', 'interpretation': 'No player inference.',
                          'uncertainty': 'This report exists only to test the clipping interface.'}],
        'unobserved': ['No actual football play is present.'],
        'training': [{'id': 'synthetic-placeholder', 'title': 'Synthetic schema field',
                      'reason': 'Required schema fixture.', 'goal': 'No coaching claim.',
                      'minutes': 1, 'frequency': 'Test only', 'equipment': [],
                      'steps': [{'label': 'Test', 'minutes': 1, 'instructions': ['Synthetic fixture only.']}],
                      'success': 'The interface accepts a valid synthetic report.'}],
        'limitations': ['No user images, child images, or genuine player observations are included.'],
        'provenance': {'kind': 'chat_review', 'professionalReview': False},
    }


def main():
    parsed_origin = urlsplit(ORIGIN)
    assert parsed_origin.hostname in ('localhost', '127.0.0.1'), 'Use a local app server only'
    report = synthetic_report()
    fragment = base64.urlsafe_b64encode(json.dumps(report).encode()).decode().rstrip('=')
    result = {'syntheticOnly': True, 'origin': ORIGIN, 'targetMode': {}, 'setupGuide': []}
    with TemporaryDirectory(prefix='next-xi-target-clips-') as temporary_dir:
        temporary = Path(temporary_dir)
        movie, wrong = temporary / 'synthetic-eight-seconds.mp4', temporary / 'synthetic-wrong-five-seconds.mp4'
        helpers.make_movie(movie, seconds=8)
        helpers.make_movie(wrong, seconds=5)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True,
                                          has_touch=True, accept_downloads=True, reduced_motion='reduce')
            context.add_init_script(helpers.AUDIT_SCRIPT)
            violations, errors = [], []

            def protect(route):
                request = route.request
                address = urlsplit(request.url)
                if request.method not in ('GET', 'HEAD') or address.path.startswith('/api/') or (
                    address.scheme in ('http', 'https') and address.netloc != parsed_origin.netloc
                ):
                    violations.append(f'{request.method} {address.path}')
                    route.abort('blockedbyclient')
                else:
                    assert 'report=' not in request.url, 'Private report appeared in an HTTP request'
                    route.continue_()

            context.route('**/*', protect)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(f'{ORIGIN}/video-clips.html#report={fragment}', wait_until='networkidle')
            expect(page.locator('#target-report-banner')).to_be_visible()
            assert page.evaluate('location.hash') == ''
            assert page.evaluate('history.state.videoClipMode') == 'evidence'
            for selector in ['#clip-target-kit', '#clip-target-number', '#clip-target-age', '#clip-length']:
                expect(page.locator(selector)).to_be_disabled()
            expect(page.locator('#clip-length-options')).to_be_hidden()
            expect(page.locator('#target-source-confirm')).to_be_disabled()
            page.locator('#clip-video-file').set_input_files(str(wrong))
            expect(page.locator('#clip-error')).to_be_visible()
            expect(page.locator('#clip-error-message')).to_contain_text('길이')
            expect(page.locator('#clip-plan')).to_be_hidden()
            expect(page.locator('#target-source-confirm')).to_be_disabled()
            result['targetMode']['wrongDurationBlocked'] = True
            page.locator('#clip-video-file').set_input_files(str(movie))
            expect(page.locator('#clip-metadata')).to_be_visible()
            expect(page.locator('#clip-error')).to_be_hidden()
            expect(page.locator('#clip-plan-list li')).to_have_count(1)
            expect(page.locator('#clip-plan-list')).to_contain_text('00:00:03.000')
            expect(page.locator('#clip-plan-list')).to_contain_text('00:00:08.000')
            page.locator('#clip-rights-consent').check()
            expect(page.locator('#create-first-clip')).to_be_disabled()
            page.locator('#target-source-confirm').check()
            expect(page.locator('#create-first-clip')).to_be_enabled()
            page.locator('#create-first-clip').click()
            expect(page.locator('#clip-result')).to_be_visible(timeout=25000)
            expect(page.locator('#clip-result-title')).to_contain_text('근거 영상')
            prompt = page.locator('#clip-prompt').input_value()
            assert '00:00:03.000' in prompt and '00:00:08.000' in prompt
            assert 'source.timeMap' in prompt and '새로운 선수 탐색' in prompt
            with page.expect_download() as video_download:
                page.locator('#download-clip').click()
            downloaded = video_download.value
            clip_path = temporary / downloaded.suggested_filename
            downloaded.save_as(str(clip_path))
            with page.expect_download() as metadata_download:
                page.locator('#download-manifest').click()
            manifest_path = temporary / metadata_download.value.suggested_filename
            metadata_download.value.save_as(str(manifest_path))
            manifest = json.loads(manifest_path.read_text())
            helpers.inspect_manifest(manifest, movie, 1, 3, 8, clip_path)
            result['targetMode']['clip'] = helpers.inspect_download(clip_path, 5, source=movie, offset=3)
            result['targetMode']['requestedSourceRange'] = manifest['source']['requested']
            result['targetMode']['absoluteTimeMap'] = manifest['source']['timeMap']
            helpers.released(helpers.audit(page), 'target evidence encode', allow_result_urls=True)
            page.reload(wait_until='networkidle')
            assert page.evaluate('location.hash') == ''
            expect(page.locator('#target-report-error')).to_be_visible()
            expect(page.locator('.workspace')).to_be_hidden()
            expect(page.locator('#create-first-clip')).to_be_disabled()
            expect(page.locator('#clip-plan')).to_be_hidden()
            result['targetMode']['scrubbedReloadBlocked'] = True
            for width in (320, 390):
                page.set_viewport_size({'width': width, 'height': 844})
                page.goto(f'{ORIGIN}/free-analysis-setup.html', wait_until='networkidle')
                page.locator('summary').click()
                metrics = page.evaluate("""() => ({width:innerWidth,content:document.documentElement.scrollWidth,
                    bodyFont:parseFloat(getComputedStyle(document.body).fontSize),
                    controls:[...document.querySelectorAll('a.button,summary')].map(el=>({text:el.textContent.trim(),height:el.getBoundingClientRect().height}))})""")
                assert metrics['content'] <= width, metrics
                assert metrics['bodyFont'] >= 16, metrics
                assert all(control['height'] >= 44 for control in metrics['controls']), metrics
                result['setupGuide'].append(metrics)
            assert not violations, violations
            assert not errors, errors
            result['networkViolations'] = violations
            result['pageErrors'] = errors
            context.close()
            browser.close()
    ARTIFACT.parent.mkdir(exist_ok=True)
    ARTIFACT.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f'PASS: synthetic target clip decoded; hash/target/source/reload guards and 320/390px setup guide verified. {ARTIFACT}')


if __name__ == '__main__':
    main()
