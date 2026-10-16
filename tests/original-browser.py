"""Original-file browser tests: a generated real MP4, a static-only deployment, no cloud API."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from threading import Thread
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
subprocess.run(['node', 'scripts/export-standalone.js'], cwd=ROOT, check=True)
with tempfile.TemporaryDirectory(prefix='next-xi-original-test-') as temporary:
    movie = Path(temporary) / '오늘의 경기.mp4'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(movie)], check=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT / '.artifacts/site')))
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
            errors, api_requests = [], []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('request', lambda r: api_requests.append(r.url) if '/api/' in r.url else None)
            page.route('https://i.ytimg.com/**', lambda r: r.abort())
            base = f'http://127.0.0.1:{server.server_port}'
            page.goto(base, wait_until='networkidle')
            initial_persisted_state = page.evaluate('localStorage.getItem("next-xi-standalone-v1")')
            page.locator('.mobile-nav-item[data-page=videos]').tap()
            page.get_by_role('button', name='영상 등록', exact=True).tap()
            expect(page.get_by_role('tab', name='원본 파일', exact=True)).to_have_attribute('aria-selected','true')
            # Slow phone metadata must not require the user to press Register twice.
            # Hold the real video's metadata events, then release them after submit.
            page.evaluate('''() => {
                const create = document.createElement.bind(document);
                window.heldMetadataEvents = [];
                let intercepted = false;
                document.createElement = function(name, ...args) {
                    const element = create(name, ...args);
                    if (name.toLowerCase() === 'video' && !intercepted) {
                        intercepted = true;
                        for (const type of ['loadedmetadata', 'loadeddata', 'error']) {
                            let handler;
                            Object.defineProperty(element, 'on' + type, {
                                configurable: true,
                                get: () => handler,
                                set: value => { handler = value; }
                            });
                            element.addEventListener(type, event => {
                                window.heldMetadataEvents.push({type, run: () => handler?.call(element, event)});
                            });
                        }
                    }
                    return element;
                };
                window.releaseMetadata = () => {
                    document.createElement = create;
                    const events = window.heldMetadataEvents.splice(0);
                    events.forEach(event => event.run());
                };
            }''')
            page.locator('#original-file').set_input_files(str(movie))
            expect(page.locator('#selected-file .loading-spinner')).to_have_count(1)
            expect(page.locator('input[name=title]')).to_have_value('오늘의 경기')
            # Native required validation previously swallowed submit without any app response.
            assert page.locator('#video-form').evaluate('(form) => form.noValidate')
            page.get_by_role('button', name='원본 영상 등록', exact=True).tap()
            expect(page.locator('#video-error')).to_contain_text('권한')
            expect(page.locator('#video-error')).to_be_in_viewport()
            assert page.evaluate('localStorage.getItem("next-xi-standalone-v1")') == initial_persisted_state
            page.screenshot(path='/tmp/next-xi-original-upload.png',full_page=True)
            page.locator('input[name=rights]').check()
            page.get_by_role('button', name='원본 영상 등록', exact=True).tap()
            expect(page.locator('#original-save-progress')).to_be_visible()
            expect(page.locator('button[type=submit]')).to_be_disabled()
            page.wait_for_function('window.heldMetadataEvents.some(event => event.type === "loadeddata")')
            page.evaluate('window.releaseMetadata()')
            expect(page.get_by_role('dialog')).to_have_count(0)
            expect(page.locator('h1')).to_have_text('성장은, 오늘도 계속됩니다.')
            expect(page.locator('.stat-card').nth(0).locator('strong')).to_contain_text('02')
            expect(page.locator('.upload-receipt')).to_contain_text('오늘의 경기')
            expect(page.locator('.upload-receipt')).to_contain_text('저장 완료')
            expect(page.locator('.radar-summary')).to_contain_text('아직 평가 전')
            expect(page.locator('.radar-chart')).to_have_attribute('aria-label', '아직 평가 전인 8개 항목 스파이더맵')
            expect(page.locator('.demo-banner')).to_have_count(0)
            page.screenshot(path='/tmp/next-xi-upload-dashboard.png', full_page=True)
            page.reload(wait_until='networkidle')
            expect(page.locator('.upload-receipt')).to_contain_text('오늘의 경기')
            expect(page.locator('.stat-card').nth(0).locator('strong')).to_contain_text('02')
            page.locator('.upload-receipt [data-action=open-video]').tap()
            expect(page.locator('#video-player video')).to_have_count(1)
            page.wait_for_function('document.querySelector("#video-player video")?.readyState >= 2')
            assert page.locator('#video-player video').evaluate('(v) => v.videoWidth') == 320
            state = page.evaluate('JSON.parse(localStorage.getItem("next-xi-standalone-v1"))')
            record = state['videos'][0]
            assert record['kind'] == 'file' and record['fileName'] == movie.name
            assert record['size'] == movie.stat().st_size and 3.9 <= record['duration'] <= 4.1
            assert 'blob:' not in str(state) and 'base64' not in str(state)
            original_id = record['id']
            page.locator('#video-player video').evaluate('(v) => {v.currentTime=2; return v.play()}')
            page.wait_for_timeout(200)
            page.get_by_role('button',name='장면 기록',exact=True).tap()
            expect(page.locator('input[name=time]')).to_have_value('00:02')
            page.locator('textarea[name=note]').fill('실제 테스트 영상의 원본 장면 기록')
            page.locator('select[name=rating]').select_option('4')
            page.get_by_role('button',name='장면 저장',exact=True).tap()
            expect(page.locator('.observation-item')).to_have_count(1)
            page.locator('.mobile-nav-item[data-page=report]').tap()
            expect(page.locator('.skill-row[data-id=touch]')).to_contain_text('4.0')
            page.locator('.time-chip').tap()
            expect(page.locator('#video-player video')).to_have_count(1)
            page.wait_for_function('document.querySelector("#video-player video")?.currentTime >= 1.9')
            page.reload(wait_until='networkidle')
            expect(page.locator('#video-player video')).to_have_count(1)
            page.wait_for_function('document.querySelector("#video-player video")?.readyState >= 2')
            expect(page.locator('.observation-item')).to_have_count(1)
            with page.expect_download() as download_info:
                page.get_by_role('button',name='원본 내보내기',exact=True).tap()
            saved = Path(temporary) / 'downloaded.mp4'
            download_info.value.save_as(str(saved))
            assert saved.read_bytes() == movie.read_bytes(), 'original bytes must not be recompressed or changed'
            # Missing media: retain metadata and scene evidence; reconnect the same original.
            page.evaluate('''async id => {await new Promise((resolve,reject)=>{const r=indexedDB.open('next-xi-originals-v1',1);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('files','readwrite');tx.objectStore('files').delete(id);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=reject};r.onerror=reject})}''', original_id)
            page.reload(wait_until='networkidle')
            expect(page.locator('.original-missing')).to_contain_text('원본을 찾지 못했어요')
            page.locator('#reconnect-original').set_input_files(str(movie))
            page.wait_for_function('document.querySelector("#video-player video")?.readyState >= 2')
            expect(page.locator('.observation-item')).to_have_count(1)
            # Quota failure must not create a ghost video entry.
            page.evaluate("Object.defineProperty(navigator.storage,'estimate',{configurable:true,value:async()=>({quota:1,usage:0})})")
            page.get_by_role('button',name='영상 등록',exact=True).tap()
            page.locator('#original-file').set_input_files(str(movie))
            expect(page.locator('#selected-file .loading-spinner')).to_have_count(0,timeout=15000)
            page.locator('input[name=rights]').check()
            page.get_by_role('button',name='원본 영상 등록',exact=True).tap()
            expect(page.locator('#video-error')).to_contain_text('저장 공간이 부족')
            assert page.evaluate('JSON.parse(localStorage.getItem("next-xi-standalone-v1")).videos.length') == 2
            page.get_by_role('button',name='닫기',exact=True).tap()
            page.evaluate('delete navigator.storage.estimate')
            # Invalid file type gets a readable error and never reaches storage.
            page.get_by_role('button',name='영상 등록',exact=True).tap()
            page.locator('#original-file').set_input_files({'name':'사진.jpg','mimeType':'image/jpeg','buffer':b'not a video'})
            expect(page.locator('#video-error')).to_contain_text('영상 파일을 선택')
            page.get_by_role('button',name='닫기',exact=True).tap()
            # Metadata-save failure rolls back the already-stored blob.
            page.evaluate('''() => {window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='next-xi-standalone-v1')throw new DOMException('quota','QuotaExceededError');return window.originalSetItem.call(this,key,value)}}''')
            page.get_by_role('button',name='영상 등록',exact=True).tap()
            page.locator('#original-file').set_input_files(str(movie))
            expect(page.locator('#selected-file .loading-spinner')).to_have_count(0,timeout=15000)
            page.locator('input[name=rights]').check()
            page.get_by_role('button',name='원본 영상 등록',exact=True).tap()
            expect(page.locator('#video-error')).to_contain_text('저장하지 못했습니다')
            count = page.evaluate('''async()=>await new Promise((resolve,reject)=>{const r=indexedDB.open('next-xi-originals-v1',1);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('files','readonly');const q=tx.objectStore('files').count();q.onsuccess=()=>resolve(q.result);tx.oncomplete=()=>db.close()};r.onerror=reject})''')
            assert count == 1, f'failed metadata save left an orphan blob: {count}'
            page.evaluate('() => { Storage.prototype.setItem=window.originalSetItem; }')
            page.get_by_role('button',name='닫기',exact=True).tap()
            # Delete removes blob and scene evidence, not only the visible row.
            page.screenshot(path='/tmp/next-xi-original-player.png',full_page=True)
            page.get_by_role('button',name='영상 삭제',exact=True).tap()
            page.get_by_role('button',name='원본 영상 삭제',exact=True).tap()
            expect(page.locator('.playlist-item')).to_have_count(1)
            state = page.evaluate('JSON.parse(localStorage.getItem("next-xi-standalone-v1"))')
            assert state['observations'] == []
            count = page.evaluate('''async()=>await new Promise((resolve,reject)=>{const r=indexedDB.open('next-xi-originals-v1',1);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('files','readonly');const q=tx.objectStore('files').count();q.onsuccess=()=>resolve(q.result);tx.oncomplete=()=>db.close()};r.onerror=reject})''')
            assert count == 0
            for width in [320,390,600]:
                page.set_viewport_size({'width':width,'height':844})
                page.get_by_role('button',name='영상 등록',exact=True).tap()
                assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
                assert page.locator('.modal-actions button[type=submit]').is_visible()
                page.get_by_role('tab',name='YouTube 링크',exact=True).tap()
                expect(page.locator('input[name=url]')).to_be_visible()
                expect(page.locator('#file-upload-panel')).to_be_hidden()
                page.get_by_role('button',name='닫기',exact=True).tap()
            assert not errors, errors
            assert not api_requests,api_requests
            print('PASS: real MP4 selection, visible missing-consent validation, wait-and-submit metadata, dashboard save receipt/count/no fabricated scores, original byte preservation, IndexedDB/reload, current-time evidence, report/seek, reconnect, quota, rollback, invalid file rejection, deletion, 320/390/600px, no API requests or JS errors.')
            browser.close()
    finally:
        server.shutdown();server.server_close()
