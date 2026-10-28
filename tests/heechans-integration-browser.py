"""Check the original public app at its intended root with deployment CSP."""
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
KEY = 'heechans-football-growth-v1'
old_data = {
    'settings': {'name': '희찬', 'age': '11', 'health': '', 'guardian': True},
    'records': [{'id': 123, 'name': '축구공 리프팅', 'value': 18,
                 'date': '2025-01-01', 'week': '2024-12-30', 'session': '2025-01-01_wed_pm'}],
    'sessions': [{'key': '2025-01-01_wed_pm', 'date': '2025-01-01',
                  'week': '2024-12-30', 'day': 'wed', 'slot': 'pm'}],
}

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/': self.path = '/heechans/index.html'
        return super().do_GET()
    def end_headers(self):
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        super().end_headers()

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT/'public')))
Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        for width, height in [(320, 640), (390, 844), (1440, 900)]:
            ctx = browser.new_context(viewport={'width': width, 'height': height})
            page = ctx.new_page(); errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.clock.install(time=datetime(2026, 10, 28, 0, 0, tzinfo=timezone.utc))
            page.clock.pause_at(datetime(2026, 10, 28, 0, 0, tzinfo=timezone.utc))
            page.goto(base+'/', wait_until='networkidle')
            page.evaluate('(value) => localStorage.setItem("heechans-football-growth-v1",JSON.stringify(value))', old_data)
            page.reload(wait_until='networkidle')
            assert page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY) == old_data
            expect(page.locator('#greeting')).to_contain_text('희찬')
            page.locator('[data-view=training]').click()
            expect(page.locator('#allSessions .session')).to_have_count(6)
            page.locator('#allSessions .session').nth(2).get_by_role('button', name='시작').click()
            exercises = page.locator('#workoutExercises')
            expect(exercises).to_contain_text('플랭크')
            expect(exercises).to_contain_text('데드버그')
            expect(exercises).to_contain_text('투명의자')
            expect(exercises).not_to_contain_text('줄넘기')
            page.locator('#timerStart').click()
            page.clock.fast_forward(500000); page.locator('#timerStart').click()
            page.clock.fast_forward(20000); page.locator('#timerStart').click()
            page.clock.fast_forward(255000)
            expect(page.locator('#sessionElapsed')).to_have_text('12:35')
            page.locator('#exitFromWorkout').click(); page.locator('#exitCancel').click()
            expect(page.locator('#sessionElapsed')).to_have_text('12:35')
            page.locator('#finishSession').click()
            saved = page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)
            assert saved['settings'] == old_data['settings']
            assert saved['records'] == old_data['records']
            assert old_data['sessions'][0] in saved['sessions']
            new_session = next(s for s in saved['sessions'] if s.get('seconds') is not None)
            assert new_session['seconds'] == 755, new_session
            page.reload(wait_until='networkidle')
            assert page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY) == saved
            page.locator('[data-view=training]').click()
            page.locator('#allSessions .session').nth(3).get_by_role('button', name='시작').click()
            expect(exercises).to_contain_text('줄넘기')
            expect(exercises).to_contain_text('벽에 논스톱 패스')
            expect(exercises).to_contain_text('리프팅')
            expect(exercises).not_to_contain_text('플랭크')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            assert not errors, errors
            ctx.close(); print(f'PASS {width}px: root+CSP, old data, schedule and 12:35 session')
        # A stale tab must not overwrite a different tab's in-progress draft.
        ctx = browser.new_context(); first = ctx.new_page(); second = ctx.new_page()
        for page in (first, second):
            page.goto(base+'/', wait_until='networkidle')
            page.locator('[data-view=training]').click()
        first.locator('#allSessions .session').nth(2).get_by_role('button', name='시작').click()
        first.locator('#timerStart').click()
        draft_before = first.evaluate('localStorage.getItem("heechans-football-growth-v1-active-session")')
        second.locator('#allSessions .session').nth(3).get_by_role('button', name='시작').click()
        expect(second.locator('#toast')).to_contain_text('다른 탭')
        assert first.evaluate('localStorage.getItem("heechans-football-growth-v1-active-session")') == draft_before
        ctx.close(); print('PASS competing tabs: stale start keeps the first draft')

        # A different completed session for the same slot must not be silently
        # treated as this session and discard the in-progress data.
        ctx = browser.new_context(); page = ctx.new_page()
        page.goto(base+'/', wait_until='networkidle')
        case = {'settings': {}, 'records': [], 'sessions': [
            {'id': 'existing-session', 'key': '2026-10-28_wed_am', 'date': '2026-10-28',
             'week': '2026-10-26', 'day': 'wed', 'slot': 'am'}]}
        draft = {'id': 'another-session', 'day': 'wed', 'slot': 'am',
                 'key': '2026-10-28_wed_am', 'date': '2026-10-28', 'week': '2026-10-26',
                 'goalSeconds': 1800, 'accumulated': 10000, 'startedAt': None,
                 'goalAcknowledged': False, 'items': []}
        page.evaluate('([data,draft]) => {localStorage.setItem("heechans-football-growth-v1",JSON.stringify(data));localStorage.setItem("heechans-football-growth-v1-active-session",JSON.stringify(draft))}', [case, draft])
        page.reload(wait_until='networkidle'); page.locator('#finishSession').click()
        expect(page.locator('#toast')).to_contain_text('다른 완료 기록')
        assert page.evaluate('JSON.parse(localStorage.getItem("heechans-football-growth-v1"))') == case
        saved_draft = page.evaluate('JSON.parse(localStorage.getItem("heechans-football-growth-v1-active-session"))')
        assert saved_draft['id'] == draft['id'] and saved_draft['accumulated'] == 10000
        ctx.close(); print('PASS conflicting slot: existing record and draft are preserved')
        browser.close()
finally:
    server.shutdown(); server.server_close()
