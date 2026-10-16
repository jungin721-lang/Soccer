import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'real-http-test-password-123';
const CHUNK = 2 * 1024 ** 2;
async function startServer(dataDir) {
  const child = spawn(process.execPath, ['server.js'], { cwd: repository, env: { ...process.env, PORT: '0', NEXT_XI_DATA_DIR: dataDir, SOCCER_AI_API_KEY: '', OPENAI_API_KEY: '', SOCCER_ANALYSIS_ACCESS_CODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let port;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`HTTP test server startup failed: ${output}`)); }, 10_000);
    const finish = error => { clearTimeout(timer); child.off('error', onError); child.off('exit', onExit); child.stdout.off('data', onData); error ? reject(error) : resolve(); };
    const onError = error => finish(error);
    const onExit = code => finish(new Error(`HTTP test server exited ${code}: ${output}`));
    const onData = chunk => { output += chunk; const match = /NEXT XI is running on port (\d+)/.exec(output); if (match) { port = Number(match[1]); finish(); } };
    child.once('error', onError); child.once('exit', onExit); child.stdout.on('data', onData); child.stderr.on('data', chunk => { output += chunk; });
  });
  return { base: `http://127.0.0.1:${port}`, alias: `http://localhost:${port}`, async close() { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); try { await exited; } finally { clearTimeout(timer); } } };
}

test('native HTTP v2 isolates authenticated growth workspaces, persists private originals and refuses fabricated analysis', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'next-xi-http-v2-')); let server;
  t.after(async () => { await server?.close(); await rm(directory, { recursive: true, force: true }); });
  server = await startServer(directory);
  let cookie; let otherCookie; let current; let video; let uploadId;
  const bytes = Buffer.alloc(CHUNK + 53); for (let n = 0; n < bytes.length; n++) bytes[n] = n % 251;
  const call = (route, { method = 'GET', body, raw, session = cookie, headers = {}, base = server.base } = {}) => fetch(`${base}/api/v2${route}`, { method, headers: { ...(session ? { Cookie: session } : {}), ...(!['GET', 'HEAD'].includes(method) ? { Origin: base } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : raw !== undefined ? { body: raw } : {}) });
  const state = async session => { const response = await call('/workspace', { session }); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /private.*no-store/); return response.json(); };

  await t.test('private state requires a session and the old anonymous workspace API is closed', async () => {
    assert.equal((await call('/workspace', { session: null })).status, 401);
    assert.deepEqual(await (await call('/auth/me', { session: null })).json(), { user: null });
    assert.equal((await fetch(`${server.base}/api/workspace`)).status, 404);
    assert.equal((await fetch(`${server.base}/api/analysis`)).status, 404);
  });

  await t.test('same-origin guardian signup creates a private cookie and accepts the actual localhost browser origin', async () => {
    const body = { email: 'http-parent@example.com', password: PASSWORD, guardianName: 'HTTP 보호자', guardianConsent: true, adult: true };
    const foreign = await call('/auth/register', { method: 'POST', body, session: null, headers: { Origin: 'https://other.example' } }); assert.equal(foreign.status, 403);
    const response = await call('/auth/register', { method: 'POST', body, session: null, base: server.alias }); assert.equal(response.status, 201, await response.clone().text());
    assert.match(response.headers.get('set-cookie'), /HttpOnly/); assert.match(response.headers.get('set-cookie'), /SameSite=Lax/); cookie = response.headers.get('set-cookie').split(';')[0];
    const user = (await response.json()).user; assert.equal(user.email, body.email); assert.equal(Object.hasOwn(user, 'password'), false);
    current = await state(cookie); assert.equal(current.revision, 0); assert.deepEqual(current.videos, []); assert.deepEqual(current.analyses, []); assert.equal(current.consents.guardian, true);
    const other = await call('/auth/register', { method: 'POST', session: null, body: { ...body, email: 'other-parent@example.com' } }); assert.equal(other.status, 201); otherCookie = other.headers.get('set-cookie').split(';')[0];
  });

  await t.test('profile edits use CAS and cannot overwrite server-owned video/results or guardian consent', async () => {
    const changed = { ...current, profile: { ...current.profile, name: '성장 테스트 선수', number: 7, kit: 'red' }, videos: [{ id: 'fake-file' }], analyses: [{ summary: 'fake AI result' }], consents: { guardian: false, analysis: true, training: true } };
    const response = await call('/workspace', { method: 'PUT', body: changed }); assert.equal(response.status, 200); current = await response.json(); assert.equal(current.revision, 1); assert.equal(current.profile.number, 7); assert.deepEqual(current.videos, []); assert.deepEqual(current.analyses, []); assert.equal(current.consents.guardian, true); assert.equal(current.consents.analysis, false);
    const stale = await call('/workspace', { method: 'PUT', body: changed }); assert.equal(stale.status, 409);
    assert.equal((await state(otherCookie)).profile.name, '');
    const foreign = await call('/workspace', { method: 'PUT', body: current, headers: { Origin: 'https://other.example' } }); assert.equal(foreign.status, 403);
    const malformed = await call('/workspace', { method: 'PUT', raw: '{bad-json', headers: { 'Content-Type': 'application/json' } }); assert.equal(malformed.status, 400);
  });

  await t.test('HTTP chunk upload resumes and private media supports exact byte ranges and HEAD', async () => {
    const initial = await call('/uploads', { method: 'POST', body: { rightsConsent: true, fileName: '경기 원본.mp4', title: 'HTTP 원본 경기', size: bytes.length, mime: 'video/mp4', target: { kit: 'red', number: 7, age: 11 }, context: { matchDate: '2026-10-16', filming: 'clear', position: 'MF', opponentLevel: 'similar', minutesPlayed: 30 } } }); assert.equal(initial.status, 201); const upload = (await initial.json()).upload; uploadId = upload.id; assert.equal(upload.chunkSize, CHUNK);
    const first = await call(`/uploads/${uploadId}`, { method: 'PUT', raw: bytes.subarray(0, CHUNK), headers: { 'Upload-Offset': '0', 'Content-Type': 'application/octet-stream' } }); assert.equal(first.status, 200); assert.equal((await first.json()).upload.offset, CHUNK);
    const resumed = await call(`/uploads/${uploadId}`); assert.equal((await resumed.json()).upload.offset, CHUNK);
    const final = await call(`/uploads/${uploadId}`, { method: 'PUT', raw: bytes.subarray(CHUNK), headers: { 'Upload-Offset': String(CHUNK), 'Content-Type': 'application/octet-stream' } }); assert.equal(final.status, 200);
    const complete = await call(`/uploads/${uploadId}/complete`, { method: 'POST' }); assert.equal(complete.status, 200); const saved = await complete.json(); video = saved.video; current = saved.workspace;
    assert.equal(video.kind, 'server'); assert.equal(video.target.number, 7); assert.equal(Object.hasOwn(video, 'chunks'), false);
    assert.equal((await call(`/media/${video.id}`, { session: null })).status, 404); assert.equal((await call(`/media/${video.id}`, { session: otherCookie })).status, 404);
    const range = await call(`/media/${video.id}`, { headers: { Range: `bytes=${CHUNK - 5}-${CHUNK + 8}` } }); assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes ${CHUNK - 5}-${CHUNK + 8}/${bytes.length}`); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(CHUNK - 5, CHUNK + 9));
    const head = await call(`/media/${video.id}`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
    const invalid = await call(`/media/${video.id}`, { headers: { Range: `bytes=${bytes.length}-` } }); assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.length}`);
  });

  await t.test('missing API credentials stop enqueue with a clear error and create no invented result', async () => {
    const status = await call('/status', { session: null }); assert.equal(status.status, 200); assert.deepEqual(await status.json(), { available: false, reason: 'missing_credentials', provider: 'cloudflare', freeOnly: true });
    const response = await call('/jobs', { method: 'POST', body: { videoId: video.id, analysisConsent: true, provider: 'cloudflare' } }); assert.equal(response.status, 503); assert.equal((await response.json()).code, 'analysis_unavailable');
    assert.deepEqual((await (await call('/jobs')).json()).jobs, []); assert.deepEqual((await state(cookie)).analyses, []);
  });

  await t.test('static assets carry security headers and private server/storage files never leave the public root', async () => {
    const page = await fetch(server.base); assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /^text\/html/); assert.equal(page.headers.get('x-content-type-options'), 'nosniff'); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.match(await page.text(), /<html[\s>]/i);
    const module = await fetch(`${server.base}/growth-domain.js`); assert.equal(module.status, 200); assert.match(module.headers.get('content-type'), /^text\/javascript/); assert.match(await module.text(), /export function createGrowthWorkspace/);
    const head = await fetch(server.base, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    for (const route of ['/server.js', '/package.json', '/.env', '/.git/config', '/.data/growth.sqlite', '/growth.sqlite', '/growth.sqlite-wal', '/lib/growth/api.js', '/%2e%2e%2fserver.js']) { const response = await fetch(`${server.base}${route}`); assert.ok([403, 404].includes(response.status), `${route}: ${response.status}`); const text = await response.text(); assert.equal(text.includes(PASSWORD), false); assert.equal(text.includes("import http from 'node:http'"), false); }
    const missing = await call('/not-real'); assert.equal(missing.status, 404); assert.match(missing.headers.get('content-type'), /^application\/json/);
  });

  await t.test('server restart restores opaque sessions, workspace edits and exact original bytes', async () => {
    await server.close(); server = await startServer(directory);
    assert.deepEqual(await state(cookie), current); assert.equal((await (await call('/auth/me')).json()).user.email, 'http-parent@example.com');
    const restored = await call(`/media/${video.id}`); assert.equal(restored.status, 200); assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes);
    assert.equal((await (await call(`/uploads/${uploadId}`)).json()).upload.status, 'completed');
    const changed = await call('/workspace', { method: 'PUT', body: { ...current, profile: { ...current.profile, name: '재시작 후 선수' } } }); assert.equal(changed.status, 200); current = await changed.json(); assert.equal(current.profile.name, '재시작 후 선수');
  });

  await t.test('video deletion removes private media while leaving the second account intact', async () => {
    const deletion = await call(`/videos/${video.id}`, { method: 'DELETE' }); assert.equal(deletion.status, 200); assert.deepEqual((await deletion.json()).workspace.videos, []);
    assert.equal((await call(`/media/${video.id}`)).status, 404); assert.deepEqual((await state(otherCookie)).videos, []);
    const logout = await call('/auth/logout', { method: 'POST' }); assert.equal(logout.status, 200); assert.equal((await call('/workspace')).status, 401);
  });
});
