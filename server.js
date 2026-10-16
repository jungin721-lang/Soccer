import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { seedState, validateState } from './public/domain.js';
import { handleAnalysis, MAX_ANALYSIS_BYTES } from './lib/analysis.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.NEXT_XI_DATA_DIR || path.join(root, '.data');
await mkdir(dataDir, { recursive: true });
const stateFile = path.join(dataDir, 'workspace.json');
let state;
try { state = JSON.parse(await readFile(stateFile, 'utf8')); validateState(state); }
catch (e) { if (e.code !== 'ENOENT') throw e; state = seedState(); }
let queue = Promise.resolve();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function json(res, code, payload) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); }
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com; frame-src https://www.youtube-nocookie.com; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/analysis') {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_ANALYSIS_BYTES) return json(res, 413, { code: 'invalid_request', error: '장면 크기가 너무 큽니다. 더 짧은 구간을 선택해 주세요.' });
        chunks.push(chunk);
      }
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
      const response = await handleAnalysis(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(await response.text());
    }
    if (url.pathname === '/api/workspace') {
      if (req.method === 'GET') return json(res, 200, state);
      if (req.method !== 'PUT') return json(res, 405, { error: '지원하지 않는 요청입니다.' });
      // Only accept same-origin browser writes. This workspace is not a public multi-user service.
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: '허용되지 않은 요청입니다.' });
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'JSON 형식이 필요합니다.' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2_000_000) return json(res, 413, { error: '저장 가능한 크기를 초과했습니다.' }); }
      let incoming;
      try { incoming = JSON.parse(body); } catch { return json(res, 400, { error: '데이터 형식이 올바르지 않습니다.' }); }
      const task = queue.then(async () => {
        if (incoming.revision !== state.revision) return json(res, 409, { error: '다른 창에서 변경되었습니다. 새로고침 후 다시 시도해 주세요.' });
        let clean;
        try { clean = validateState(incoming); } catch (e) { return json(res, 400, { error: e.message }); }
        const next = { revision: state.revision + 1, ...clean };
        await writeFile(stateFile + '.tmp', JSON.stringify(next, null, 2));
        await rename(stateFile + '.tmp', stateFile);
        state = next;
        return json(res, 200, state);
      });
      queue = task.catch(() => {}); await task; return;
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '찾을 수 없는 경로입니다.' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '지원하지 않는 요청입니다.' });
    const requested = decodeURIComponent(url.pathname);
    const file = path.resolve(root, 'public', '.' + (requested === '/' ? '/index.html' : requested));
    if (!file.startsWith(path.join(root, 'public') + path.sep)) return json(res, 403, { error: '접근할 수 없습니다.' });
    try {
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { json(res, 404, { error: '페이지를 찾을 수 없습니다.' }); }
  } catch (e) { console.error('Request failed:', e.message); if (!res.headersSent) json(res, 500, { error: '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' }); else res.end(); }
});
const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`NEXT XI is running on port ${port}`));
