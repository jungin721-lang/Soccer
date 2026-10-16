import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function unusedPort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startServer(dataDir) {
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repository,
    env: { ...process.env, PORT: String(port), NEXT_XI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Test server did not become ready: ${output}`));
    }, 10_000);
    const finish = error => {
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stdout.off('data', onData);
      error ? reject(error) : resolve();
    };
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(new Error(`Test server exited (${code ?? signal}): ${output}`));
    const onData = chunk => {
      output += chunk;
      if (output.includes('NEXT XI is running on port')) finish();
    };
    child.on('error', onError);
    child.on('exit', onExit);
    child.stdout.on('data', onData);
    child.stderr.on('data', chunk => { output += chunk; });
  });
  await ready;
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try { await exited; } finally { clearTimeout(timeout); }
    },
  };
}

test('HTTP workspace persists evidence, protects the player target, and isolates application files', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'next-xi-http-'));
  let server;
  t.after(async () => {
    await server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  server = await startServer(dataDir);
  let current;
  const getState = async () => {
    const response = await fetch(`${server.base}/api/workspace`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  const putState = (body, headers = {}) => fetch(`${server.base}/api/workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  await t.test('a fresh workspace uses only the latest sample at 57 seconds with no invented ratings', async () => {
    current = await getState();
    assert.equal(current.revision, 0);
    assert.equal(current.player.kit, '남색');
    assert.equal(current.player.number, 11);
    assert.equal(current.player.age, 11);
    assert.deepEqual(current.videos.map(({ id, start }) => ({ id, start })), [{ id: 'arJ6xMRKnbw', start: 57 }]);
    assert.deepEqual(current.observations, []);
    assert.deepEqual(current.snapshots, []);
  });

  await t.test('a same-origin edit stores real evidence and advances the revision exactly once', async () => {
    const changed = structuredClone(current);
    changed.player.name = '테스트 선수';
    changed.observations.push({
      id: 'http-scene-1', videoId: 'arJ6xMRKnbw', skill: 'touch', time: 57,
      rating: 3, note: '통합 테스트용 관찰 기록입니다.', type: 'note', createdAt: '2026-10-16T01:00:00.000Z',
    });
    changed.completed = ['week1-0', 'habit-0'];
    changed.snapshots.push({
      id: 'http-snapshot-1', createdAt: '2026-10-16T01:01:00.000Z', observationCount: 1,
      scores: [3, null, null, null, null, null, null, null],
    });
    const response = await putState(changed, { Origin: server.base });
    assert.equal(response.status, 200);
    current = await response.json();
    assert.equal(current.revision, changed.revision + 1);
    assert.deepEqual(current.observations, changed.observations);
    assert.deepEqual(current.snapshots, changed.snapshots);
    assert.deepEqual(await getState(), current);
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'workspace.json'), 'utf8')), current);
  });

  await t.test('an outdated tab cannot overwrite a newer revision', async () => {
    const stale = structuredClone(current);
    stale.revision -= 1;
    stale.player.name = '오래된 창';
    const response = await putState(stale);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /다른 창/);
    assert.deepEqual(await getState(), current);
  });

  await t.test('changing the designated navy number 11 target is rejected without changing data', async () => {
    for (const change of [{ number: 10 }, { kit: '빨강' }]) {
      const tampered = structuredClone(current);
      Object.assign(tampered.player, change);
      const response = await putState(tampered);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /남색 11번/);
    }
    assert.deepEqual(await getState(), current);
  });

  await t.test('cross-origin writes and non-JSON or malformed bodies cannot mutate the workspace', async () => {
    const crossOrigin = await putState(current, { Origin: 'https://untrusted.example' });
    assert.equal(crossOrigin.status, 403);
    assert.ok((await crossOrigin.json()).error);
    const plain = await putState(current, { 'Content-Type': 'text/plain' });
    assert.equal(plain.status, 415);
    assert.ok((await plain.json()).error);
    const broken = await fetch(`${server.base}/api/workspace`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"revision":',
    });
    assert.equal(broken.status, 400);
    assert.ok((await broken.json()).error);
    const unsupported = await fetch(`${server.base}/api/workspace`, { method: 'POST' });
    assert.equal(unsupported.status, 405);
    assert.deepEqual(await getState(), current);
  });

  await t.test('the app and module load with security headers while unknown API paths return JSON errors', async () => {
    const page = await fetch(server.base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(page.headers.get('content-security-policy'), /frame-src https:\/\/www\.youtube-nocookie\.com/);
    assert.match(await page.text(), /<html[\s>]/i);
    const module = await fetch(`${server.base}/domain.js`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /^text\/javascript/);
    assert.match(await module.text(), /export function seedState/);
    const head = await fetch(server.base, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const missing = await fetch(`${server.base}/api/not-a-route`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type'), /^application\/json/);
    assert.ok((await missing.json()).error);
  });

  await t.test('server code, repository metadata, and persisted data are outside the static file root', async () => {
    for (const endpoint of ['/server.js', '/package.json', '/.git/config', '/.data/workspace.json', '/workspace.json', '/%2e%2e%2fserver.js']) {
      const response = await fetch(`${server.base}${endpoint}`);
      assert.ok([403, 404].includes(response.status), `${endpoint}: ${response.status}`);
      const body = await response.text();
      assert.ok(!body.includes('테스트 선수'), endpoint);
      assert.ok(!body.includes("import http from 'node:http'"), endpoint);
    }
  });

  await t.test('a fresh server process restores the saved evidence, plan, and revision', async () => {
    await server.close();
    server = await startServer(dataDir);
    assert.deepEqual(await getState(), current);
    const next = structuredClone(current);
    next.completed.push('week1-1');
    const response = await putState(next);
    assert.equal(response.status, 200);
    const restored = await response.json();
    assert.equal(restored.revision, current.revision + 1);
    assert.deepEqual(restored.observations, current.observations);
    assert.deepEqual(restored.completed, ['week1-0', 'habit-0', 'week1-1']);
  });
});
