"""End-to-end checks against an isolated local server. Requires Python Playwright + Chromium."""
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='next-xi-browser-') as storage:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    server = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env={**os.environ, 'PORT': str(port), 'NEXT_XI_DATA_DIR': storage}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(base + '/api/workspace', timeout=1).read()
                break
            except Exception:
                time.sleep(.1)
        else:
            raise AssertionError('Test server did not start')
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1100}, device_scale_factor=1)
            errors = []
            page.on('pageerror', lambda err: errors.append(str(err)))
            # External media may be blocked in this environment; test the app's built-in fallback.
            page.route('https://i.ytimg.com/**', lambda route: route.abort())
            page.route('https://www.youtube-nocookie.com/**', lambda route: route.abort())
            page.goto(base, wait_until='networkidle')
            expect(page.locator('h1')).to_have_text('성장은, 오늘도 계속됩니다.')
            expect(page.locator('.stat-card').nth(0).locator('strong')).to_contain_text('01')
            expect(page.locator('.radar-summary')).to_contain_text('아직 평가 전')
            page.screenshot(path='/tmp/next-xi-desktop.png', full_page=True)
            page.get_by_role('button', name='예시 리포트 체험', exact=True).click()
            expect(page.locator('.demo-banner')).to_contain_text('실제 영상 분석 결과가 아닙니다')
            expect(page.locator('.radar-summary')).to_contain_text('예시 데이터')
            page.get_by_role('button', name='체험 끝내기').click()
            expect(page.locator('.demo-banner')).to_have_count(0)
            page.get_by_role('button', name='00:57부터 영상 보기').click()
            expect(page.locator('.player-placeholder')).to_contain_text('00:57')
            page.get_by_role('button', name='남색 11번 · 경기 영상 재생').click()
            expect(page.locator('#video-player iframe')).to_have_attribute('src', 'https://www.youtube-nocookie.com/embed/arJ6xMRKnbw?start=57&autoplay=1&rel=0')
            page.get_by_role('button', name='장면 기록', exact=True).click()
            expect(page.get_by_role('dialog')).to_be_visible()
            page.locator('input[name=time]').fill('01:20')
            page.locator('select[name=skill]').select_option('pass')
            page.locator('textarea[name=note]').fill('브라우저 테스트: 11번 선수가 빈 공간의 동료에게 패스하는 장면을 기록.')
            page.locator('select[name=rating]').select_option('4')
            page.get_by_role('button', name='장면 저장', exact=True).click()
            expect(page.get_by_role('dialog')).to_have_count(0)
            expect(page.locator('.observation-item')).to_have_count(1)
            expect(page.locator('.observation-item')).to_contain_text('01:20')
            page.locator('a[href="#report"]').click()
            expect(page.locator('.skill-row[data-id=pass]')).to_contain_text('4.0')
            expect(page.locator('.skill-row[data-id=shoot]')).to_contain_text('관찰 부족')
            page.get_by_role('button', name='성장 기록 저장', exact=True).click()
            expect(page.locator('#toast')).to_contain_text('성장의 한 페이지')
            page.locator('a[href="#history"]').click()
            expect(page.locator('.history-entry')).to_have_count(1)
            page.get_by_role('button', name='기록 내보내기', exact=True).click()
            page.locator('a[href="#training"]').click()
            page.get_by_role('button', name='실천 완료하기', exact=True).first.click()
            expect(page.get_by_role('button', name='실천했어요', exact=True)).to_have_count(1)
            page.get_by_role('tab', name='WEEK 02 연결하기').click()
            expect(page.locator('.training-card h2').first).to_have_text('받는 발과 강도 맞추기')
            expect(page.locator('.plan-overview h2')).to_have_text('동료가 받기 좋은, 패스 만들기.')
            page.get_by_role('tab', name='몸과 마음의 루틴').click()
            expect(page.locator('.habit-card')).to_have_count(4)
            page.locator('a[href="#profile"]').click()
            page.locator('input[name=name]').fill('성장하는 11번')
            page.get_by_role('button', name='선수 정보 저장').click()
            expect(page.locator('.profile-identity h2')).to_have_text('성장하는 11번')
            page.reload(wait_until='networkidle')
            expect(page.locator('input[name=name]')).to_have_value('성장하는 11번')
            page.locator('a[href="#videos"]').click()
            expect(page.locator('.observation-item')).to_have_count(1)
            page.get_by_role('button', name='영상 등록', exact=True).click()
            page.get_by_role('tab', name='YouTube 링크', exact=True).click()
            page.locator('input[name=url]').fill('https://www.youtube.com/watch?v=arJ6xMRKnbw')
            page.locator('input[name=title]').fill('중복 영상')
            page.locator('input[name=rights]').check()
            page.locator('#video-form button[type=submit]').click()
            expect(page.locator('#video-error')).to_contain_text('이미 등록된 영상')
            page.keyboard.press('Escape')
            page.get_by_role('button', name='영상 등록', exact=True).click()
            page.get_by_role('tab', name='YouTube 링크', exact=True).click()
            page.locator('input[name=url]').fill('https://youtu.be/-6FfOX2Hpok?t=12s')
            page.locator('input[name=title]').fill('등록 기능 테스트')
            page.locator('input[name=rights]').check()
            page.locator('#video-form button[type=submit]').click()
            expect(page.get_by_role('dialog')).to_have_count(0)
            expect(page.locator('.playlist-item')).to_have_count(2)
            expect(page.locator('.player-placeholder')).to_contain_text('00:12')
            page.locator('.playlist-item[data-id="arJ6xMRKnbw"]').click()
            page.get_by_role('button', name='01:20 장면 삭제').click()
            page.get_by_role('button', name='유지하기').click()
            expect(page.locator('.observation-item')).to_have_count(1)
            page.get_by_role('button', name='01:20 장면 삭제').click()
            page.get_by_role('button', name='장면 삭제', exact=True).click()
            expect(page.locator('.observation-item')).to_have_count(0)
            page.reload(wait_until='networkidle')
            expect(page.locator('.observation-item')).to_have_count(0)
            page.locator('a[href="#profile"]').click()
            page.get_by_role('button', name='기록 초기화').click()
            page.get_by_role('button', name='개인 기록 삭제').click()
            expect(page.locator('input[name=name]')).to_have_value('')
            for width in [375, 768, 1440]:
                page.set_viewport_size({'width': width, 'height': 900})
                for view in ['dashboard', 'videos', 'report', 'training', 'history', 'profile']:
                    page.goto(base + '/#' + view, wait_until='networkidle')
                    expect(page.locator('h1')).to_be_visible()
                    overflow = page.evaluate('document.documentElement.scrollWidth > innerWidth')
                    assert not overflow, f'Horizontal overflow at {width}px on {view}'
                if width == 375:
                    page.goto(base, wait_until='networkidle')
                    page.screenshot(path='/tmp/next-xi-mobile.png', full_page=True)
                    page.get_by_role('button', name='메뉴 열기').click()
                    expect(page.locator('body')).to_have_class('menu-open')
                    page.locator('a[href="#videos"]').click()
                    expect(page.locator('body')).not_to_have_class('menu-open')
            assert not errors, errors
            browser.close()
            print('PASS: desktop/mobile navigation, truthful demo, player timestamp, evidence → scores → saved history, training, profile persistence, duplicate/new video registration, delete/reset, and 18 responsive layouts. No JavaScript errors.')
    finally:
        server.terminate()
        server.wait(timeout=10)
