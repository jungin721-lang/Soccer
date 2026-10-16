"""Real local-video splitting regression; no app server or paid API is used.

Run: python tests/video-clips-browser.py
Optional: VIDEO_CLIPS_LONG_TEST=1 adds a 65s 1920x888 real encode/decode check.
Use --long-only or --engine-only to run those independent checks by themselves.
Requires /usr/bin/chromium, Playwright, Pillow, ffmpeg, and ffprobe.
The runner serves public/ on an ephemeral loopback port and owns that server.
Actual H.264/AAC decoding, canvas capture, MediaRecorder encoding, downloads,
and ffprobe checks run in Chromium. Oversize/unsupported cases are explicitly
simulations. 320/390px Chromium touch viewports are not physical phone tests.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import urlsplit
import json
import argparse
import os
import subprocess
import time
import zipfile

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / '.test-results'
MAX_CLIP_BYTES = 24 * 1024 ** 2
TARGET = {'kit': 'navy', 'number': 11, 'age': 11}

# These wrappers observe native work. Original File reads throw so an accidental
# full-file JavaScript buffering path cannot silently pass with our small file.
# Generated clips/JSON remain readable and downloadable through native APIs.
AUDIT_SCRIPT = r"""(() => {
  const sources = new WeakSet(), active = new Set(), tracks = [];
  const audit = window.__videoClipAudit = {draws: [], created: [], revoked: [], wholeSourceReads: 0, stops: 0};
  audit.source = file => { sources.add(file); return file; };
  audit.snapshot = () => ({draws: audit.draws, created: audit.created, revoked: audit.revoked,
    active: [...active], wholeSourceReads: audit.wholeSourceReads, stops: audit.stops,
    tracks: tracks.map(track => ({kind: track.kind, state: track.readyState}))});
  document.addEventListener('change', event => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'file')
      for (const file of event.target.files || []) sources.add(file);
  }, true);
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => {
    const url = create(blob); active.add(url);
    audit.created.push({url, type: blob.type, size: blob.size, source: sources.has(blob)});
    return url;
  };
  URL.revokeObjectURL = url => { audit.revoked.push(url); active.delete(url); return revoke(url); };
  const slice = Blob.prototype.slice;
  Blob.prototype.slice = function(start, end, ...rest) {
    const result = slice.call(this, start, end, ...rest);
    if (sources.has(this) && (start === undefined || start === 0) && (end === undefined || end >= this.size)) sources.add(result);
    return result;
  };
  for (const name of ['arrayBuffer', 'text', 'stream', 'bytes']) {
    const original = Blob.prototype[name]; if (!original) continue;
    Blob.prototype[name] = function(...args) {
      if (sources.has(this)) { audit.wholeSourceReads++; throw new Error('Forbidden whole-original JavaScript read'); }
      return original.apply(this, args);
    };
  }
  for (const name of ['readAsArrayBuffer', 'readAsBinaryString', 'readAsDataURL', 'readAsText']) {
    const original = FileReader.prototype[name]; if (!original) continue;
    FileReader.prototype[name] = function(blob, ...args) {
      if (sources.has(blob)) { audit.wholeSourceReads++; throw new Error('Forbidden whole-original FileReader read'); }
      return original.call(this, blob, ...args);
    };
  }
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
    const result = draw.call(this, source, ...args);
    if (source instanceof HTMLVideoElement) {
      audit.draws.push({time: source.currentTime, ready: source.readyState, width: source.videoWidth, height: source.videoHeight});
      if (audit.abortAfterDraw && tracks.some(track => track.readyState === 'live')) {
        const abort = audit.abortAfterDraw; audit.abortAfterDraw = null; queueMicrotask(abort);
      }
    }
    return result;
  };
  const capture = HTMLCanvasElement.prototype.captureStream;
  if (capture) HTMLCanvasElement.prototype.captureStream = function(...args) {
    const stream = capture.apply(this, args); tracks.push(...stream.getTracks()); return stream;
  };
  const stop = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function(...args) { audit.stops++; return stop.apply(this, args); };
})()"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def run(command):
    return subprocess.run(command, check=True, capture_output=True).stdout


def no_overflow(page, label):
    size = page.evaluate('({viewport: innerWidth, content: document.documentElement.scrollWidth})')
    assert size['content'] <= size['viewport'], f'{label}: horizontal overflow {size}'


def audit(page):
    return page.evaluate('window.__videoClipAudit.snapshot()')


def released(snapshot, label, allow_result_urls=False):
    assert snapshot['wholeSourceReads'] == 0, f'{label}: original file was read into JavaScript'
    assert all(track['state'] == 'ended' for track in snapshot['tracks']), f'{label}: live capture track leaked'
    assert all(item['url'] in snapshot['revoked'] for item in snapshot['created'] if item['source']), f'{label}: source URL leaked'
    if not allow_result_urls:
        assert not snapshot['active'], f'{label}: object URL leaked'


def configure_context(browser, origin, width, engine_only=False):
    context = browser.new_context(viewport={'width': width, 'height': 844}, is_mobile=True,
                                  has_touch=True, accept_downloads=True, reduced_motion='reduce')
    context.add_init_script(AUDIT_SCRIPT)
    violations, errors = [], []
    allowed = urlsplit(origin)

    def protect(route):
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
            violations.append(f'{request.method} {reason}')
            route.abort('blockedbyclient')
        else:
            route.continue_()

    context.route('**/*', protect)
    if engine_only:
        context.route('**/__video-clips-regression.html', lambda route: route.fulfill(
            status=200, content_type='text/html', body='<!doctype html><title>Local clip engine regression</title>'))
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    response = page.goto(origin + ('/__video-clips-regression.html' if engine_only else '/video-clips.html'), wait_until='networkidle')
    assert response and response.status == 200, 'Video clips page did not load'
    assert not errors, errors
    return context, page, violations, errors


def attach_direct_source(page, movie):
    page.evaluate("""() => {
      const picker = document.createElement('input'); picker.type = 'file'; picker.id = 'regression-source';
      picker.hidden = true; picker.onchange = () => { window.__clipTestSource = window.__videoClipAudit.source(picker.files[0]); };
      document.body.append(picker);
    }""")
    page.locator('#regression-source').set_input_files(str(movie))


def image_at(path, second):
    data = run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-ss', str(second), '-i', str(path),
                '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'])
    with Image.open(BytesIO(data)) as image:
        return image.convert('RGB').resize((160, 90))


def difference(first, second):
    return sum(ImageStat.Stat(ImageChops.difference(first, second)).mean) / 3


def inspect_download(path, duration, source=None, offset=0, dimensions=(640, 360)):
    assert 0 < path.stat().st_size <= MAX_CLIP_BYTES, 'Clip exceeded the promised 24MiB ceiling'
    probe = json.loads(run(['ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', str(path)]))
    videos = [stream for stream in probe['streams'] if stream['codec_type'] == 'video']
    assert len(videos) == 1 and not any(stream['codec_type'] == 'audio' for stream in probe['streams']), 'Clip must have one video track and no audio'
    video = videos[0]
    assert video['codec_name'] in ('h264', 'vp8', 'vp9', 'av1'), video['codec_name']
    assert any(name in probe['format']['format_name'] for name in ('mp4', 'mov', 'webm', 'matroska')), probe['format']['format_name']
    assert (video['width'], video['height']) == dimensions, 'Source dimensions were not retained within the configured ceiling'
    measured = float(probe['format']['duration'])
    assert duration - .55 <= measured <= duration + .75, f'Unexpected clip duration {measured}, wanted {duration}'
    frames = int(video['nb_read_frames'])
    assert frames >= duration * 15, f'Only {frames} frames: continuous video encoding did not run'
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-xerror', '-i', str(path), '-map', '0:v:0', '-f', 'null', '-'])
    first = image_at(path, .1)
    middle = image_at(path, duration / 2)
    last = image_at(path, max(.2, duration - .4))
    changes = (difference(first, middle), difference(middle, last))
    assert all(change > 3 for change in changes), f'Downloaded video frames do not change over time: mean pixel changes {changes}'
    if source and offset:
        # The fixture changes its full-frame tint every two seconds, making a
        # mistaken restart at zero measurably different from the requested cut.
        wanted = difference(first, image_at(source, offset + .1))
        wrong = difference(first, image_at(source, .1))
        assert wanted < wrong * .65, f'Clip starts at wrong absolute source time: wanted diff {wanted:.1f}, zero diff {wrong:.1f}'
    return {'duration': round(measured, 3), 'frames': frames, 'measuredFps': round(frames / measured, 2),
            'bytes': path.stat().st_size, 'codec': video['codec_name'], 'dimensions': dimensions,
            'frameChanges': tuple(round(value, 2) for value in changes)}


def inspect_manifest(manifest, movie, index, start, end, downloaded, dimensions=(640, 360)):
    assert movie.name not in json.dumps(manifest, ensure_ascii=False), 'Original filename leaked into sharing manifest'
    assert manifest['clip']['index'] == index
    requested = manifest['source']['requested']
    assert requested == {'start': start, 'end': end, 'duration': end - start}, requested
    actual = manifest['source']['actual']
    assert abs(actual['start'] - start) < .25 and abs(actual['end'] - end) < .75, actual
    mapping = manifest['source']['timeMap']
    assert len(mapping) >= 2
    assert mapping[0]['clipSeconds'] == 0 and abs(mapping[0]['sourceSeconds'] - start) < .25
    assert mapping[-1]['sourceSeconds'] > end - .75
    assert all(abs(row['sourceSeconds'] - start - row['clipSeconds']) < .3 for row in mapping)
    assert all(left['clipSeconds'] <= right['clipSeconds'] and left['sourceSeconds'] <= right['sourceSeconds'] for left, right in zip(mapping, mapping[1:]))
    assert manifest['output']['bytes'] == downloaded.stat().st_size
    assert (manifest['output']['width'], manifest['output']['height']) == dimensions
    assert manifest['processing']['method'] == 'browser-canvas-mediarecorder'
    assert manifest['processing']['soundOmitted'] is True
    assert manifest['analysis']['performed'] is False and manifest['analysis']['playerIdentified'] is False
    assert all(manifest['target'][key] == value for key, value in TARGET.items())


def exercise_engine(browser, origin, movie, temporary):
    context, page, violations, errors = configure_context(browser, origin, 390, engine_only=True)
    try:
        attach_direct_source(page, movie)
        details = page.evaluate("""async () => {
          const api = await import('/video-clips.js'); window.__clipAPI = api;
          const plan = api.planVideoClips(130, {chunkSeconds:60, overlapSeconds:5});
          const metadata = await api.inspectClipSource(window.__clipTestSource);
          return {plan, metadata};
        }""")
        assert details['plan'] == [{'index': 1, 'start': 0, 'end': 60, 'duration': 60},
                                   {'index': 2, 'start': 55, 'end': 120, 'duration': 65},
                                   {'index': 3, 'start': 115, 'end': 130, 'duration': 15}]
        assert abs(details['metadata']['duration'] - 8) < .1
        assert (details['metadata']['width'], details['metadata']['height']) == (640, 360)
        released(audit(page), 'metadata inspection')

        # Abort after a real video frame was drawn with a live canvas track.
        cancelled = page.evaluate("""async () => {
          const controller = new AbortController();
          window.__videoClipAudit.abortAfterDraw = () => controller.abort();
          try {
            await window.__clipAPI.createVideoClip(window.__clipTestSource, {
              clip:{index:1,start:0,end:8,duration:8}, target:{kit:'navy',number:11,age:11}, signal:controller.signal});
            return {rejected:false};
          } catch (error) { return {rejected:true,name:error.name}; }
        }""")
        assert cancelled == {'rejected': True, 'name': 'AbortError'}, cancelled
        cancelled_audit = audit(page)
        assert cancelled_audit['draws'] and cancelled_audit['tracks'], 'Cancellation did not reach actual decoding/capture'
        released(cancelled_audit, 'real recording cancellation')

        before_draws = len(cancelled_audit['draws'])
        started = time.monotonic()
        manifest = page.evaluate("""async () => {
          const result = await window.__clipAPI.createVideoClip(window.__clipTestSource, {
            clip:{index:2,start:2,end:5,duration:3}, target:{kit:'navy',number:11,age:11}});
          window.__directClip = result.file;
          return result.manifest;
        }""")
        assert time.monotonic() - started >= 2, 'Real-time MediaRecorder recording did not run'
        with page.expect_download() as pending:
            page.evaluate("""() => {
              const url = URL.createObjectURL(window.__directClip);
              const a = document.createElement('a'); a.href = url; a.download = window.__directClip.name;
              a.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
            }""")
        clip = temporary / pending.value.suggested_filename
        pending.value.save_as(str(clip))
        page.wait_for_function('window.__videoClipAudit.snapshot().active.length === 0')
        summary = inspect_download(clip, 3, source=movie, offset=2)
        inspect_manifest(manifest, movie, 2, 2, 5, clip)
        finished = audit(page)
        draws = finished['draws'][before_draws:]
        assert len(draws) >= 30 and draws[-1]['time'] - draws[0]['time'] >= 2.4
        assert 1.9 <= draws[0]['time'] <= 2.2 and draws[-1]['time'] >= 4.6, 'Absolute clip seek was not used'
        assert all(row['ready'] >= 2 for row in draws)
        released(finished, 'absolute-offset clip completion/download')

        simulated = page.evaluate("""async () => {
          const audit = window.__videoClipAudit, before = audit.created.length;
          const oversized = audit.source(new File(['x'], 'simulated-oversize.mp4', {type:'video/mp4'}));
          Object.defineProperty(oversized, 'size', {value:8 * 1024 ** 3 + 1});
          let largeRejected = false, unsupportedRejected = false;
          try { await window.__clipAPI.inspectClipSource(oversized); } catch { largeRejected = true; }
          const oversizedOpened = audit.created.length !== before;
          const supported = MediaRecorder.isTypeSupported;
          try {
            MediaRecorder.isTypeSupported = () => false;
            try { await window.__clipAPI.createVideoClip(window.__clipTestSource, {
              clip:{index:1,start:0,end:1,duration:1},target:{kit:'navy',number:11,age:11}}); }
            catch { unsupportedRejected = true; }
          } finally { MediaRecorder.isTypeSupported = supported; }
          return {largeRejected, oversizedOpened, unsupportedRejected};
        }""")
        assert simulated == {'largeRejected': True, 'oversizedOpened': False, 'unsupportedRejected': True}, simulated
        released(audit(page), 'oversize/unsupported simulations')
        assert not violations, violations
        assert not errors, errors
        return summary
    finally:
        context.close()


def set_target_and_consent(page):
    page.locator('#clip-target-kit').select_option('navy')
    page.locator('#clip-target-number').fill('11')
    page.locator('#clip-target-age').fill('11')
    page.locator('#clip-rights-consent').check()


def exercise_long_clip(browser, origin, movie, temporary):
    context, page, violations, errors = configure_context(browser, origin, 390, engine_only=True)
    try:
        attach_direct_source(page, movie)
        started = time.monotonic()
        manifest = page.evaluate("""async () => {
          const {createVideoClip} = await import('/video-clips.js');
          const result = await createVideoClip(window.__clipTestSource, {
            clip:{index:2,start:2,end:67,duration:65},target:{kit:'navy',number:11,age:11}});
          window.__directClip = result.file; return result.manifest;
        }""")
        elapsed = time.monotonic() - started
        assert elapsed >= 63, '65-second real-time recording did not run'
        with page.expect_download() as pending:
            page.evaluate("""() => {
              const url = URL.createObjectURL(window.__directClip);
              const a = document.createElement('a'); a.href = url; a.download = window.__directClip.name;
              a.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
            }""")
        clip = temporary / f'long-{pending.value.suggested_filename}'
        pending.value.save_as(str(clip))
        page.wait_for_function('window.__videoClipAudit.snapshot().active.length === 0')
        summary = inspect_download(clip, 65, source=movie, offset=2, dimensions=(1920, 888))
        inspect_manifest(manifest, movie, 2, 2, 67, clip, dimensions=(1920, 888))
        summary['encodeWallSeconds'] = round(elapsed, 2)
        released(audit(page), '65s 1920x888 recording/download')
        assert not violations, violations
        assert not errors, errors
        return summary
    finally:
        context.close()


def exercise_mobile(browser, origin, movie, corrupt, temporary, width, sequential=False):
    context, page, violations, errors = configure_context(browser, origin, width)
    try:
        no_overflow(page, f'initial {width}px')
        expect(page.locator('#create-first-clip')).to_be_disabled()
        page.locator('#clip-video-file').set_input_files(str(movie))
        expect(page.locator('#clip-error')).to_be_hidden()
        expect(page.locator('#create-first-clip')).to_be_disabled()
        set_target_and_consent(page)
        expect(page.locator('#create-first-clip')).to_be_enabled(timeout=15000)
        if sequential:
            page.locator('#clip-length').select_option('30')
        no_overflow(page, f'selected {width}px')
        page.locator('#create-first-clip').click()
        if sequential:
            page.wait_for_function("window.__videoClipAudit.snapshot().tracks.some(track => track.state === 'live')")
            page.locator('#cancel-clip').click()
            expect(page.locator('#resume-clip')).to_be_visible(timeout=10000)
            expect(page.locator('#clip-result')).to_be_hidden()
            released(audit(page), 'UI cancel before resume')
            page.locator('#resume-clip').click()
        expect(page.locator('#clip-result')).to_be_visible(timeout=45000)
        expect(page.locator('#clip-error')).to_be_hidden()
        page.wait_for_function('document.querySelector("#clip-preview").readyState >= 2')
        page.locator('#clip-preview').evaluate('async video => { await video.play(); }')
        page.wait_for_function('document.querySelector("#clip-preview").currentTime > 0.2')
        page.locator('#clip-preview').evaluate('video => video.pause()')
        assert page.locator('#clip-preview').evaluate('video => [video.videoWidth, video.videoHeight]') == [640, 360]
        no_overflow(page, f'result {width}px')
        for selector in ('#download-clip', '#download-manifest', '#copy-clip-prompt'):
            box = page.locator(selector).bounding_box()
            assert box and box['height'] >= 44, f'{selector}: touch target is below 44px at {width}px'
        page.evaluate('document.activeElement?.blur()')
        page.screenshot(path=str(ARTIFACTS / f'video-clips-result-{width}.png'), full_page=True)
        with page.expect_download() as pending_clip:
            page.locator('#download-clip').click()
        clip = temporary / f'{width}-{pending_clip.value.suggested_filename}'
        pending_clip.value.save_as(str(clip))
        with page.expect_download() as pending_manifest:
            page.locator('#download-manifest').click()
        manifest_file = temporary / f'{width}-manifest.json'
        pending_manifest.value.save_as(str(manifest_file))
        first_manifest = json.loads(manifest_file.read_text())
        first_end = 30 if sequential else 8
        inspect_manifest(first_manifest, movie, 1, 0, first_end, clip)
        summaries = [inspect_download(clip, first_end)]
        assert movie.name not in page.locator('#clip-prompt').input_value(), 'Original filename leaked into sharing prompt'
        for selector in ('#clip-video-file', '#clip-target-kit', '#clip-target-number', '#clip-target-age', '#clip-length'):
            expect(page.locator(selector)).to_be_disabled()
        # This is the real app ZIP path; compare its members to native video
        # and JSON downloads instead of trusting a .zip extension or UI label.
        page.locator('#download-clip-zip').click()
        expect(page.locator('#download-clip-bundle')).to_be_visible(timeout=10000)
        with page.expect_download() as pending_bundle:
            page.locator('#download-clip-bundle').click()
        bundle = temporary / f'{width}-clip-bundle.zip'
        pending_bundle.value.save_as(str(bundle))
        assert 0 < bundle.stat().st_size <= 25 * 1024 ** 2
        with zipfile.ZipFile(bundle) as archive:
            assert archive.testzip() is None, 'ZIP CRC validation failed'
            names = archive.namelist()
            assert len(names) == len(set(names)) == 3, names
            videos = [name for name in names if name.endswith(('.mp4', '.webm'))]
            manifests = [name for name in names if name.endswith('.json')]
            assert len(videos) == len(manifests) == 1
            assert 'README.txt' in names
            assert archive.read(videos[0]) == clip.read_bytes(), 'ZIP contains different video bytes'
            assert archive.read(manifests[0]) == manifest_file.read_bytes(), 'ZIP contains different manifest bytes'
            assert json.loads(archive.read(manifests[0])) == first_manifest
            assert movie.name not in ''.join(names), 'ZIP member names expose the source filename'
            readme = archive.read('README.txt').decode('utf-8')
            assert movie.name not in readme, 'ZIP sharing instructions expose the source filename'
            assert 'source.timeMap' in readme and 'AI 분석 결과가 아닙니다' in readme

        # A saved-result request alone does not bypass the discard guard.
        # The same reset is required before changing file/target/length.
        old_urls = set(audit(page)['active'])
        assert old_urls, 'UI did not retain downloadable result blobs'
        released(audit(page), f'completed UI {width}px', allow_result_urls=True)
        if sequential:
            page.locator('#next-clip').click()
            expect(page.locator('#discard-confirm')).to_be_visible()
            expect(page.locator('#confirm-next')).to_be_disabled()
            expect(page.locator('#clip-save-confirm')).not_to_be_checked()
            page.locator('#keep-current-clip').click()
            expect(page.locator('#discard-confirm')).to_be_hidden()
            assert set(audit(page)['active']) == old_urls, 'Keeping current clip discarded its files'
            page.locator('#next-clip').click()
            page.locator('#clip-save-confirm').check()
            page.locator('#confirm-next').click()
            expect(page.locator('#clip-result-title')).to_contain_text('2번째', timeout=20000)
            assert old_urls.issubset(set(audit(page)['revoked'])), 'Next clip retained previous output URLs'
            with page.expect_download() as pending_second:
                page.locator('#download-clip').click()
            second = temporary / f'{width}-second-{pending_second.value.suggested_filename}'
            pending_second.value.save_as(str(second))
            with page.expect_download() as pending_second_manifest:
                page.locator('#download-manifest').click()
            second_manifest = temporary / f'{width}-second-manifest.json'
            pending_second_manifest.value.save_as(str(second_manifest))
            inspect_manifest(json.loads(second_manifest.read_text()), movie, 2, 25, 34, second)
            summaries.append(inspect_download(second, 9))
            expect(page.locator('#next-clip')).to_be_hidden()
            no_overflow(page, 'second sequential clip 390px')
            page.screenshot(path=str(ARTIFACTS / 'video-clips-second-390.png'), full_page=True)
            old_urls = set(audit(page)['active'])
            released(audit(page), 'sequential second clip', allow_result_urls=True)

        page.locator('#reset-clips').click()
        expect(page.locator('#discard-confirm')).to_be_visible()
        expect(page.locator('#confirm-next')).to_be_disabled()
        page.locator('#keep-current-clip').click()
        assert set(audit(page)['active']) == old_urls, 'Cancelling reset discarded files'
        page.locator('#reset-clips').click()
        page.locator('#clip-save-confirm').check()
        page.locator('#confirm-next').click()
        expect(page.locator('#clip-result')).to_be_hidden()
        expect(page.locator('#clip-video-file')).to_be_enabled()
        assert old_urls.issubset(set(audit(page)['revoked'])), 'Confirmed reset leaked previous download/preview URLs'
        released(audit(page), f'confirmed reset {width}px')
        page.locator('#clip-video-file').set_input_files(str(corrupt))
        expect(page.locator('#clip-result')).to_be_hidden()
        expect(page.locator('#clip-error')).to_be_visible(timeout=15000)
        after = audit(page)
        released(after, f'corrupt replacement {width}px')
        assert not page.locator('#download-clip').get_attribute('href'), 'Stale clip remains downloadable after source change'
        no_overflow(page, f'error {width}px')
        assert not violations, violations
        assert not errors, errors
        return summaries
    finally:
        context.close()


def make_movie(path, seconds=8, size='640x360'):
    filters = ("hue=h=13*t,drawbox=x=0:y=0:w=iw:h=ih:color=red@0.45:t=fill:enable='lt(t,2)',"
               "drawbox=x=0:y=0:w=iw:h=ih:color=green@0.45:t=fill:enable='between(t,2,4)',"
               "drawbox=x=0:y=0:w=iw:h=ih:color=blue@0.45:t=fill:enable='between(t,4,6)',"
               "drawbox=x=0:y=0:w=iw:h=ih:color=yellow@0.45:t=fill:enable='gte(t,6)'")
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', f'testsrc2=size={size}:rate=30',
         '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', str(seconds), '-vf', filters,
         '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30',
         '-c:a', 'aac', '-movflags', '+faststart', str(path)])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--engine-only', action='store_true')
    mode.add_argument('--long-only', action='store_true')
    arguments = parser.parse_args()
    long_enabled = arguments.long_only or os.environ.get('VIDEO_CLIPS_LONG_TEST') == '1'
    started = time.monotonic()
    reports = {}
    ARTIFACTS.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix='next-xi-video-clips-') as directory:
        temporary = Path(directory)
        movie = temporary / 'source-합성 경기 개인정보 없음.mp4'
        sequential_movie = temporary / 'source-34-second-synthetic.mp4'
        corrupt = temporary / 'source-corrupt.mp4'
        if not arguments.long_only:
            make_movie(movie)
            if not arguments.engine_only:
                make_movie(sequential_movie, seconds=34)
        long_movie = temporary / 'source-67-second-synthetic.mp4'
        if long_enabled:
            print('RUN: generating 67s H.264/AAC fixture at 1920x888 for a real 65s foreground encode', flush=True)
            make_movie(long_movie, seconds=67, size='1920x888')
        corrupt.write_bytes(b'not a decodable video; synthetic regression fixture only')
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT / 'public')))
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f'http://127.0.0.1:{server.server_port}'
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
                try:
                    if not arguments.long_only:
                        reports['absolute-offset'] = exercise_engine(browser, origin, movie, temporary)
                        print(f"PASS: real absolute-offset/cancel/cleanup checks: {reports['absolute-offset']}", flush=True)
                        if not arguments.engine_only:
                            for width in (390, 320):
                                reports[f'mobile-{width}'] = exercise_mobile(browser, origin, sequential_movie if width == 390 else movie,
                                                                           corrupt, temporary, width, sequential=width == 390)
                                print(f"PASS: {width}px mobile UI: {reports[f'mobile-{width}']}", flush=True)
                    if long_enabled:
                        reports['long-65s'] = exercise_long_clip(browser, origin, long_movie, temporary)
                        print(f"PASS: real 65s clip: {reports['long-65s']}", flush=True)
                finally:
                    browser.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
    seconds = time.monotonic() - started
    count = sum(len(report) if isinstance(report, list) else 1 for report in reports.values())
    coverage = ['absolute source offsets/time maps', 'changing video frames', 'no audio', '24MiB ceiling',
                'stream/object-URL cleanup', 'no whole-original JS reads, API/write/third-party requests, or page errors']
    if not arguments.long_only:
        coverage.extend(['real cancellation', '2 labeled simulations (oversize source, unsupported recorder)'])
        if not arguments.engine_only:
            coverage.extend(['real video/JSON ZIP download with CRC and matching bytes', 'sequential next/reset guards',
                             'UI cancel/resume', 'corrupt-source cleanup', '320/390px overflow and 44px controls'])
    print(f'PASS: {count} real clips/downloads verified by ffprobe and full FFmpeg decoding; {reports}; '
          f'{"; ".join(coverage)}. {seconds:.1f}s. '
          f'Chromium viewports only; physical iPhone/Android remain unverified.')


if __name__ == '__main__':
    main()
