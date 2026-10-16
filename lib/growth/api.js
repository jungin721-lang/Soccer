import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createGrowthWorkspace, validateGrowthWorkspace, validateTarget, kstToday } from '../../public/growth-domain.js';

const scrypt = promisify(scryptCallback);
const CHUNK_SIZE = 2 * 1024 ** 2;
const MAX_VIDEO_BYTES = 2 * 1024 ** 3;
const MAX_ACCOUNT_BYTES = 6 * 1024 ** 3;
const MAX_ACCOUNT_VIDEOS = 10;
const MAX_PENDING_UPLOADS = 3;
const SESSION_MS = 7 * 86400_000;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const json = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
const publicUser = user => ({ id: user.id, email: user.email, guardianName: user.guardianName, guardianConsent: user.guardianConsent, adult: user.adult, createdAt: user.createdAt });
const publicUpload = upload => ({ id: upload.id, videoId: upload.videoId, fileName: upload.fileName, size: upload.size, mime: upload.mime, title: upload.title, target: upload.target, context: upload.context, chunkSize: upload.chunkSize, offset: upload.offset, status: upload.status, createdAt: upload.createdAt });
const publicJob = job => ({ id: job.id, videoId: job.videoId, status: job.status, stage: job.stage, createdAt: job.createdAt, updatedAt: job.updatedAt, target: job.target, context: job.context, progress: job.progress || {}, result: job.result || null, error: job.error || null, attempt: job.attempt || 1, cancelRequested: Boolean(job.cancelRequested) });
function requireID(id) { if (!UUID.test(id || '')) throw fail(404, 'not_found', '기록을 찾을 수 없습니다.'); return id; }
function emailAddress(value) { if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw fail(400, 'invalid_email', '이메일 주소를 확인해 주세요.'); return value.trim().toLowerCase(); }
function validPassword(value) { if (typeof value !== 'string' || value.length < 10 || value.length > 200) throw fail(400, 'invalid_password', '비밀번호는 10~200자로 입력해 주세요.'); return value; }
async function passwordRecord(password) { const salt = randomBytes(16).toString('hex'); return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') }; }
async function matchesPassword(password, record) { if (typeof password !== 'string' || password.length > 200) return false; const actual = await scrypt(password, record.salt, 64); const expected = Buffer.from(record.hash, 'hex'); return expected.length === actual.length && timingSafeEqual(actual, expected); }
function cookie(request, value, expired = false) { return `nx_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expired ? 0 : SESSION_MS / 1000}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
async function readBytes(request, maximum) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw fail(413, 'too_large', '전송 가능한 크기를 초과했습니다.');
  const reader = request.body?.getReader(); if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maximum) { await reader.cancel(); throw fail(413, 'too_large', '전송 가능한 크기를 초과했습니다.'); } chunks.push(value); }
  return Buffer.concat(chunks);
}
async function readJSON(request, maximum = 2_000_000) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw fail(415, 'json_required', 'JSON 요청이 필요합니다.');
  try { const value = JSON.parse((await readBytes(request, maximum)).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch (error) { if (error.status) throw error; throw fail(400, 'invalid_json', '요청 형식이 올바르지 않습니다.'); }
}
function originAllowed(request) {
  const origin = request.headers.get('origin');
  try { return origin && new URL(origin).origin === new URL(request.url).origin && request.headers.get('sec-fetch-site') !== 'cross-site'; }
  catch { return false; }
}
function normalizeVideo(body, id, createdAt) {
  if (typeof body.fileName !== 'string' || !body.fileName.trim() || body.fileName.length > 255 || /[\x00-\x1f\x7f]/.test(body.fileName)) throw fail(400, 'invalid_file', '영상 파일 이름을 확인해 주세요.');
  if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_VIDEO_BYTES) throw fail(400, 'invalid_file', '원본 영상은 2GB까지 등록할 수 있습니다.');
  if (!/\.(mp4|mov|m4v|webm|3gp)$/i.test(body.fileName) || typeof body.mime !== 'string' || body.mime.length > 100 || (body.mime && !/^(video\/[a-z\d.+-]+|application\/octet-stream)$/i.test(body.mime))) throw fail(400, 'invalid_file', 'MP4, MOV, M4V, WebM, 3GP 영상을 선택해 주세요.');
  const workspace = createGrowthWorkspace();
  try {
    const target = validateTarget(body.target);
    workspace.videos = [{ id, kind: 'server', title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : body.fileName.slice(0, 100), fileName: body.fileName, size: body.size, mime: body.mime || 'application/octet-stream', addedAt: createdAt, duration: null, target, context: body.context || {} }];
    return validateGrowthWorkspace(workspace).videos[0];
  }
  catch (error) { throw fail(400, 'invalid_video', error.message); }
}
function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw fail(416, 'invalid_range', '지원하지 않는 영상 범위입니다.');
  let start; let end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) throw fail(416, 'invalid_range', '지원하지 않는 영상 범위입니다.'); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw fail(416, 'invalid_range', '지원하지 않는 영상 범위입니다.');
  return { start, end, partial: true };
}

export function createGrowthAPI({ store, dispatchJob = async () => {}, availability = async () => ({ available: false, reason: 'missing_credentials' }), env = process.env, maxRangeBytes = 4 * 1024 ** 2 }) {
  const maxMediaBytes = Number.isSafeInteger(maxRangeBytes) && maxRangeBytes >= CHUNK_SIZE && maxRangeBytes <= 8 * 1024 ** 2 ? maxRangeBytes : 4 * 1024 ** 2;
  const boundedLimit = (name, fallback, maximum) => { const value = Number(env[name]); return Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : fallback; };
  const limits = { globalDaily: boundedLimit('SOCCER_MAX_DAILY_JOBS', 30, 1000), userDaily: boundedLimit('SOCCER_MAX_USER_DAILY_JOBS', 3, 20), userActive: boundedLimit('SOCCER_MAX_USER_ACTIVE_JOBS', 2, 10), jobAttempts: boundedLimit('SOCCER_MAX_JOB_DAILY_ATTEMPTS', 3, 10) };
  async function currentUser(request, required = true, allowDeleting = false) {
    const token = /(?:^|;\s*)nx_session=([A-Za-z\d_-]{20,200})(?:;|$)/.exec(request.headers.get('cookie') || '')?.[1];
    const session = token ? await store.get(`sessions/${digest(token)}`) : null;
    if (session && session.expiresAt > Date.now()) { const user = await store.get(`users/${session.userId}`); if (user && (!user.deleting || allowDeleting)) return user; }
    if (required) throw fail(401, 'login_required', '로그인한 뒤 이용해 주세요.');
    return null;
  }
  async function startSession(request, user) {
    const token = randomBytes(32).toString('base64url');
    await store.set(`sessions/${digest(token)}`, { userId: user.id, expiresAt: Date.now() + SESSION_MS, createdAt: now() });
    return cookie(request, token);
  }
  async function owned(key, user) { const value = await store.get(key); if (!value || value.userId !== user.id) throw fail(404, 'not_found', '기록을 찾을 수 없습니다.'); return value; }
  async function listOwned(prefix, user) { const rows = await Promise.all((await store.list(prefix)).map(key => store.get(key))); return rows.filter(row => row?.userId === user.id); }
  async function cancelVideoJobs(videoId, user) {
    const jobs = (await listOwned('jobs/', user)).filter(job => job.videoId === videoId);
    for (const job of jobs) await store.update(`jobs/${job.id}`, current => current ? { ...current, cancelRequested: true, status: ['queued', 'running'].includes(current.status) ? 'cancelled' : current.status, updatedAt: now() } : current);
    return jobs;
  }
  async function removeVideo(videoId, user) {
    const video = await owned(`videos/${videoId}`, user);
    const jobs = await cancelVideoJobs(videoId, user);
    for (const key of await store.list(`media/${user.id}/${videoId}/`)) await store.delete(key);
    for (const upload of (await listOwned('uploads/', user)).filter(row => row.videoId === videoId)) await store.delete(`uploads/${upload.id}`);
    for (const job of jobs) { await store.delete(`jobs/${job.id}`); for (const key of await store.list(`budgets/attempt/${job.id}/`)) await store.delete(key); }
    await store.delete(`videos/${video.id}`);
    await store.update(`quotas/storage/${user.id}`, quota => ({ entries: (quota?.entries || []).filter(entry => entry.videoId !== videoId) }));
    await store.update(`workspaces/${user.id}`, workspace => {
      if (!workspace) return createGrowthWorkspace();
      return { ...workspace, revision: (workspace.revision || 0) + 1, videos: workspace.videos.filter(row => row.id !== videoId), analyses: (workspace.analyses || []).filter(row => row.videoId !== videoId), observations: (workspace.observations || []).filter(row => row.videoId !== videoId), jobs: (workspace.jobs || []).filter(row => row.videoId !== videoId) };
    });
  }
  async function reserveBudget(user, jobId, isRetry) {
    const day = kstToday(); const reservation = `${jobId}:${randomUUID()}`; const reserved = [];
    const activeKey = `budgets/active/${user.id}`;
    const jobs = await listOwned('jobs/', user);
    const inactive = new Set(jobs.filter(job => !['queued', 'running'].includes(job.status)).map(job => job.id));
    const active = new Set(jobs.filter(job => ['queued', 'running'].includes(job.status)).map(job => job.id));
    const release = async () => {
      for (const key of reserved) await store.update(key, current => ({ entries: (current?.entries || []).filter(entry => entry !== reservation) }));
      await store.update(activeKey, current => ({ entries: (current?.entries || []).filter(entry => entry.reservation !== reservation) }));
    };
    const take = async (key, maximum, code, message) => { await store.update(key, current => { const entries = current?.entries || []; if (entries.length >= maximum) throw fail(429, code, message); return { entries: [...entries, reservation] }; }); reserved.push(key); };
    try {
      await store.update(activeKey, current => {
        const entries = (current?.entries || []).filter(entry => entry.jobId !== jobId && !inactive.has(entry.jobId) && (active.has(entry.jobId) || entry.until > Date.now()));
        for (const activeId of active) if (activeId !== jobId && !entries.some(entry => entry.jobId === activeId)) entries.push({ reservation: `active:${activeId}`, jobId: activeId, until: Date.now() + 5 * 60_000 });
        if (entries.length >= limits.userActive) throw fail(429, 'active_job_limit', `한 계정에서 동시에 ${limits.userActive}개까지 분석할 수 있습니다. 진행 중인 분석이 끝난 뒤 다시 시도해 주세요.`);
        return { entries: [...entries, { reservation, jobId, until: Date.now() + 5 * 60_000 }] };
      });
      await take(`budgets/global/${day}`, limits.globalDaily, 'global_daily_job_limit', '오늘의 서비스 분석 한도에 도달했습니다. 내일 다시 이용해 주세요.');
      if (!isRetry) await take(`budgets/user/${user.id}/${day}`, limits.userDaily, 'user_daily_job_limit', `새 영상 분석은 하루 ${limits.userDaily}회까지 이용할 수 있습니다.`);
      await take(`budgets/attempt/${jobId}/${day}`, limits.jobAttempts, 'job_attempt_limit', `한 분석의 재시도는 최초 실행을 포함해 하루 ${limits.jobAttempts}회까지 가능합니다.`);
      return { release };
    } catch (error) { await release(); throw error; }
  }
  async function queueJob(video, user, prior) {
    const ready = await availability();
    if (!ready?.available) throw fail(503, ready?.reason === 'invalid_key_format' ? 'analysis_key_format_invalid' : 'analysis_unavailable', ready?.reason === 'invalid_key_format' ? '서버 API 키의 입력 형식을 수정해야 합니다.' : '분석 서버의 API 인증 설정을 완료해야 합니다.');
    const token = randomBytes(32).toString('base64url');
    const stamp = now();
    const job = { id: prior?.id || randomUUID(), userId: user.id, videoId: video.id, target: video.target, context: video.context, status: 'queued', stage: 'queued', createdAt: prior?.createdAt || stamp, updatedAt: stamp, tokenHash: digest(token), cancelRequested: false, progress: prior?.progress || {}, result: prior?.result || null, error: null, attempt: (prior?.attempt || 0) + 1, clips: prior?.clips || [], leaseOwner: null, leaseUntil: null, dispatchPendingUntil: null, analysisConsentAt: prior?.analysisConsentAt || stamp, analysisConsentVersion: '2026-10-growth-v2' };
    const budget = await reserveBudget(user, job.id, Boolean(prior));
    try {
      if (prior) Object.assign(job, await store.update(`jobs/${job.id}`, current => { if (!current || current.userId !== user.id || ['queued', 'running'].includes(current.status)) throw fail(409, 'job_running', '이미 진행 중인 분석입니다.'); return { ...current, ...job, clips: current.clips || [], progress: current.progress || {}, result: current.result || null }; }));
      else {
        await store.create(`jobs/${job.id}`, job);
        try { await store.update(`videos/${video.id}`, current => {
          if (!current || current.userId !== user.id || (current.activeJobId || null) !== (video.activeJobId || null)) throw fail(409, 'job_running', '이미 다른 분석이 시작됐습니다. 진행 상태를 다시 불러와 주세요.');
          return { ...current, activeJobId: job.id };
        }); } catch (error) { await store.delete(`jobs/${job.id}`); throw error; }
      }
      await store.update(`workspaces/${user.id}`, current => {
        if (!current) throw fail(404, 'workspace_missing', '선수의 성장 기록을 찾을 수 없습니다.');
        return current.consents?.analysis === true ? current : { ...current, revision: current.revision + 1, consents: { ...current.consents, analysis: true } };
      });
    } catch (error) { await budget.release(); throw error; }
    try { await dispatchJob(job.id, token); }
    catch {
      let unstarted = false;
      const current = await store.update(`jobs/${job.id}`, value => {
        unstarted = Boolean(value && value.status === 'queued' && !value.leaseOwner);
        return unstarted ? { ...value, tokenHash: digest(randomBytes(32)), status: 'failed', stage: 'failed', error: { code: 'dispatch_failed', message: '백그라운드 분석을 시작하지 못했습니다. 다시 시도해 주세요.' }, updatedAt: now() } : value;
      });
      if (unstarted) { await budget.release(); throw fail(503, 'dispatch_failed', '백그라운드 분석을 시작하지 못했습니다. 다시 시도해 주세요.'); }
      return current || job;
    }
    return job;
  }
  return async request => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/v2/')) return null;
    try {
      if (!['GET', 'HEAD'].includes(request.method) && !originAllowed(request)) throw fail(403, 'forbidden_origin', '이 앱에서 다시 요청해 주세요.');
      const route = url.pathname.slice('/api/v2'.length).replace(/\/$/, '') || '/';
      if (route === '/status' && request.method === 'GET') { const ready = await availability(); return json(200, { available: ready?.available === true, reason: ready?.reason || 'missing_credentials' }); }
      if (route === '/auth/register' && request.method === 'POST') {
        const body = await readJSON(request, 10_000);
        const email = emailAddress(body.email); const password = validPassword(body.password);
        if (body.guardianConsent !== true || body.adult !== true || typeof body.guardianName !== 'string' || !body.guardianName.trim() || body.guardianName.length > 50) throw fail(400, 'guardian_consent_required', '성인 보호자의 이름과 보호자 동의가 필요합니다.');
        const user = { id: randomUUID(), email, guardianName: body.guardianName.trim(), guardianConsent: true, adult: true, consentVersion: '2026-10-growth-v2', consentAt: now(), createdAt: now(), password: await passwordRecord(password) };
        const emailKey = `emails/${digest(email)}`;
        if (!await store.create(emailKey, { userId: user.id })) throw fail(409, 'email_in_use', '이미 등록된 이메일입니다. 로그인해 주세요.');
        try { const workspace = createGrowthWorkspace(); workspace.consents.guardian = true; await store.create(`users/${user.id}`, user); await store.set(`workspaces/${user.id}`, workspace); }
        catch (error) { await store.delete(emailKey); await store.delete(`users/${user.id}`); throw error; }
        return json(201, { user: publicUser(user) }, { 'Set-Cookie': await startSession(request, user) });
      }
      if (route === '/auth/login' && request.method === 'POST') {
        const body = await readJSON(request, 10_000); const email = emailAddress(body.email);
        const userId = (await store.get(`emails/${digest(email)}`))?.userId;
        const user = userId ? await store.get(`users/${userId}`) : null;
        const attemptKey = `auth-attempts/${digest(email)}`;
        const attempts = await store.update(attemptKey, previous => { const window = previous?.until > Date.now() ? previous : { count: 0, until: Date.now() + 15 * 60_000 }; return { ...window, count: window.count + 1 }; });
        if (attempts.count > 15) throw fail(429, 'login_rate_limited', '로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.');
        const valid = await matchesPassword(body.password, user?.password || { salt: 'unregistered-user', hash: '00'.repeat(64) });
        if (!user || user.deleting || !valid) throw fail(401, 'invalid_login', '이메일 또는 비밀번호를 확인해 주세요.');
        await store.delete(attemptKey);
        return json(200, { user: publicUser(user) }, { 'Set-Cookie': await startSession(request, user) });
      }
      if (route === '/auth/logout' && request.method === 'POST') {
        const token = /(?:^|;\s*)nx_session=([A-Za-z\d_-]+)(?:;|$)/.exec(request.headers.get('cookie') || '')?.[1];
        if (token) await store.delete(`sessions/${digest(token)}`);
        return json(200, { ok: true }, { 'Set-Cookie': cookie(request, '', true) });
      }
      if (route === '/auth/me' && request.method === 'GET') { const user = await currentUser(request, false); return json(200, { user: user ? publicUser(user) : null }); }
      const mediaMatch = /^\/media\/([^/]+)$/.exec(route);
      if (mediaMatch && ['GET', 'HEAD'].includes(request.method)) {
        const videoId = requireID(mediaMatch[1]); const video = await store.get(`videos/${videoId}`);
        if (!video || video.status !== 'ready') throw fail(404, 'not_found', '영상을 찾을 수 없습니다.');
        const owner = await store.get(`users/${video.userId}`);
        if (!owner || owner.deleting) throw fail(404, 'not_found', '영상을 찾을 수 없습니다.');
        const user = await currentUser(request, false);
        let authorized = user?.id === video.userId;
        if (!authorized) {
          const token = /^Bearer ([A-Za-z\d_-]{20,200})$/.exec(request.headers.get('authorization') || '')?.[1];
          const jobId = url.searchParams.get('jobId');
          const job = token && UUID.test(jobId || '') ? await store.get(`jobs/${jobId}`) : null;
          authorized = Boolean(job && job.userId === video.userId && job.videoId === videoId && ['queued', 'running'].includes(job.status) && !job.cancelRequested && job.tokenHash === digest(token));
        }
        if (!authorized) throw fail(404, 'not_found', '영상을 찾을 수 없습니다.');
        if (request.method === 'GET' && !request.headers.get('range') && video.size > maxMediaBytes) return json(413, { code: 'range_required', error: '큰 원본 영상은 구간 요청으로 재생해야 합니다. 영상 플레이어에서 다시 열어 주세요.' }, { 'Accept-Ranges': 'bytes' });
        let range;
        try { range = byteRange(request.headers.get('range'), video.size); }
        catch (error) { return json(416, { code: error.code, error: error.message }, { 'Content-Range': `bytes */${video.size}` }); }
        if (range.partial) range.end = Math.min(range.end, range.start + maxMediaBytes - 1);
        const headers = { 'Content-Type': video.mime, 'Content-Length': String(range.end - range.start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(video.fileName)}` };
        if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${video.size}`;
        let index = Math.floor(range.start / video.chunkSize);
        const stream = request.method === 'HEAD' ? null : new ReadableStream({ async pull(controller) {
          if (index >= video.chunks.length || index * video.chunkSize > range.end) { controller.close(); return; }
          const chunk = video.chunks[index]; const bytes = await store.getBinary(chunk.key);
          if (!bytes) { controller.error(new Error('영상 조각을 찾을 수 없습니다.')); return; }
          const start = Math.max(0, range.start - index * video.chunkSize); const end = Math.min(bytes.length, range.end - index * video.chunkSize + 1);
          controller.enqueue(bytes.slice(start, end)); index++;
        } });
        return new Response(stream, { status: range.partial ? 206 : 200, headers });
      }
      const user = await currentUser(request, true, route === '/auth/account' && request.method === 'DELETE');
      if (route === '/auth/account' && request.method === 'DELETE') {
        const body = await readJSON(request, 10_000);
        if (!await matchesPassword(body.password, user.password)) throw fail(401, 'invalid_password', '비밀번호를 확인해 주세요.');
        await store.update(`users/${user.id}`, current => ({ ...current, deleting: true }));
        for (const video of await listOwned('videos/', user)) await removeVideo(video.id, user);
        for (const upload of await listOwned('uploads/', user)) { for (const key of await store.list(`media/${user.id}/${upload.videoId}/`)) await store.delete(key); await store.delete(`uploads/${upload.id}`); }
        for (const key of await store.list('sessions/')) { if ((await store.get(key))?.userId === user.id) await store.delete(key); }
        for (const key of await store.list(`media/${user.id}/`)) await store.delete(key);
        for (const key of await store.list(`budgets/user/${user.id}/`)) await store.delete(key);
        await store.delete(`budgets/active/${user.id}`);
        await store.delete(`quotas/storage/${user.id}`);
        await store.delete(`workspaces/${user.id}`); await store.delete(`users/${user.id}`); await store.delete(`emails/${digest(user.email)}`); await store.delete(`auth-attempts/${digest(user.email)}`);
        return json(200, { ok: true }, { 'Set-Cookie': cookie(request, '', true) });
      }
      if (route === '/workspace' && request.method === 'GET') return json(200, await store.get(`workspaces/${user.id}`) || createGrowthWorkspace());
      if (route === '/workspace' && request.method === 'PUT') {
        const incoming = await readJSON(request);
        if (!Number.isSafeInteger(incoming.revision) || incoming.revision < 0) throw fail(400, 'invalid_revision', '저장 버전을 확인해 주세요.');
        const result = await store.update(`workspaces/${user.id}`, current => {
          current ||= createGrowthWorkspace();
          if (incoming.revision !== current.revision) throw fail(409, 'revision_conflict', '다른 화면에서 변경됐습니다. 최신 기록을 불러온 뒤 다시 저장해 주세요.');
          let clean;
          try { clean = validateGrowthWorkspace({ ...incoming, videos: current.videos, analyses: current.analyses, jobs: current.jobs || [], consents: { ...incoming.consents, guardian: current.consents?.guardian === true, analysis: current.consents?.analysis === true && incoming.consents?.analysis !== false, training: false } }); }
          catch (error) { throw fail(400, 'invalid_workspace', error.message); }
          if (!clean.profile.sensitiveConsent && (clean.profile.allergies.length || clean.profile.dietaryRestrictions.length)) throw fail(400, 'sensitive_consent_required', '알레르기·식이 제한을 저장하려면 민감정보 저장에 별도로 동의해 주세요. 동의를 철회할 때는 해당 내용을 비워 주세요.');
          if (!clean.profile.sensitiveConsent && clean.checkins.length) throw fail(400, 'sensitive_consent_required', '수면·피로·기분·통증 상태를 저장하려면 민감정보 저장에 별도로 동의해 주세요. 동의를 철회할 때는 상태 기록을 지워 주세요.');
          return { ...clean, revision: current.revision + 1 };
        });
        if (incoming.consents?.analysis === false && result.consents.analysis === false) {
          for (const job of (await listOwned('jobs/', user)).filter(row => ['queued', 'running'].includes(row.status))) await store.update(`jobs/${job.id}`, current => current && ['queued', 'running'].includes(current.status) ? { ...current, cancelRequested: true, status: 'cancelled', updatedAt: now() } : current);
        }
        return json(200, result);
      }
      if (route === '/uploads' && request.method === 'GET') return json(200, { uploads: (await listOwned('uploads/', user)).filter(upload => upload.status === 'uploading').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicUpload) });
      if (route === '/uploads' && request.method === 'POST') {
        const body = await readJSON(request, 20_000); const id = randomUUID(); const videoId = randomUUID(); const createdAt = now();
        if (body.rightsConsent !== true) throw fail(400, 'video_rights_consent_required', '영상 이용 권한과 등장 선수에 대한 필요한 동의를 확인한 뒤 등록해 주세요.');
        const metadata = normalizeVideo(body, videoId, createdAt);
        const active = (await listOwned('uploads/', user)).filter(upload => upload.status === 'uploading');
        const videos = await listOwned('videos/', user);
        const initial = [...videos.map(video => ({ videoId: video.id, size: video.size, status: 'ready' })), ...active.map(upload => ({ videoId: upload.videoId, size: upload.size, status: 'uploading' }))];
        await store.update(`quotas/storage/${user.id}`, current => {
          const entries = current?.entries || initial;
          if (entries.length >= MAX_ACCOUNT_VIDEOS || entries.filter(entry => entry.status === 'uploading').length >= MAX_PENDING_UPLOADS) throw fail(409, 'upload_limit', '파일럿 계정은 영상 10개, 동시 전송 3개까지 등록할 수 있습니다. 기존 영상을 완료하거나 삭제해 주세요.');
          if (entries.reduce((sum, entry) => sum + entry.size, 0) + metadata.size > MAX_ACCOUNT_BYTES) throw fail(409, 'account_storage_limit', '파일럿 계정의 원본 보관 한도는 전송 중 영상을 포함해 6GB입니다. 기존 영상을 삭제한 뒤 등록해 주세요.');
          return { entries: [...entries, { videoId, size: metadata.size, status: 'uploading' }] };
        });
        const upload = { ...metadata, id, videoId, userId: user.id, status: 'uploading', createdAt, chunkSize: CHUNK_SIZE, offset: 0, chunks: [], rightsConsentAt: createdAt, rightsConsentVersion: '2026-10-growth-v2-video-rights' };
        try { if (!await store.create(`uploads/${id}`, upload)) throw fail(409, 'upload_conflict', '업로드를 다시 시작해 주세요.'); }
        catch (error) { await store.update(`quotas/storage/${user.id}`, quota => ({ entries: (quota?.entries || []).filter(entry => entry.videoId !== videoId) })); throw error; }
        return json(201, { upload: publicUpload(upload) });
      }
      const uploadMatch = /^\/uploads\/([^/]+)(\/complete)?$/.exec(route);
      if (uploadMatch) {
        const id = requireID(uploadMatch[1]); const upload = await owned(`uploads/${id}`, user);
        if (request.method === 'GET' && !uploadMatch[2]) return json(200, { upload: publicUpload(upload) });
        if (request.method === 'DELETE' && !uploadMatch[2]) {
          if (upload.status === 'completed') await removeVideo(upload.videoId, user);
          else { for (const key of await store.list(`media/${user.id}/${upload.videoId}/`)) await store.delete(key); await store.delete(`uploads/${id}`); await store.update(`quotas/storage/${user.id}`, quota => ({ entries: (quota?.entries || []).filter(entry => entry.videoId !== upload.videoId) })); }
          return json(200, { ok: true });
        }
        if (request.method === 'PUT' && !uploadMatch[2]) {
          const offsetText = request.headers.get('upload-offset');
          if (!/^\d+$/.test(offsetText || '')) throw fail(400, 'invalid_offset', '업로드 위치를 확인해 주세요.');
          const offset = Number(offsetText); if (!Number.isSafeInteger(offset) || offset < 0 || offset >= upload.size || offset % CHUNK_SIZE !== 0) throw fail(409, 'upload_offset_conflict', '서버의 업로드 위치를 다시 불러와 주세요.');
          const bytes = await readBytes(request, CHUNK_SIZE); const expected = Math.min(CHUNK_SIZE, upload.size - offset);
          if (bytes.length !== expected) throw fail(400, 'invalid_chunk_size', '영상 조각의 크기가 맞지 않습니다.');
          const hash = digest(bytes); const index = offset / CHUNK_SIZE; const key = `media/${user.id}/${upload.videoId}/${index}/${hash}`;
          if (offset > upload.offset) throw fail(409, 'upload_offset_conflict', '앞선 영상 조각부터 전송해 주세요.');
          if (offset < upload.offset) { if (upload.chunks[index]?.hash !== hash) throw fail(409, 'upload_chunk_conflict', '이미 저장된 조각과 내용이 다릅니다.'); return json(200, { upload: publicUpload(upload) }); }
          if (upload.status !== 'uploading') throw fail(409, 'upload_completed', '이미 완료한 업로드입니다.');
          await store.putBinary(key, bytes);
          let saved;
          try { saved = await store.update(`uploads/${id}`, current => {
            if (!current || current.userId !== user.id || current.status !== 'uploading') throw fail(409, 'upload_changed', '업로드 상태가 변경됐습니다.');
            if (current.offset > offset && current.chunks[index]?.hash === hash) return current;
            if (current.offset !== offset) throw fail(409, 'upload_offset_conflict', '다른 전송이 먼저 완료됐습니다. 업로드 위치를 다시 불러와 주세요.');
            return { ...current, offset: offset + bytes.length, chunks: [...current.chunks, { index, key, hash, size: bytes.length }] };
          }); } catch (error) { const current = await store.get(`uploads/${id}`); if (!current?.chunks.some(chunk => chunk.key === key)) await store.delete(key); throw error; }
          return json(200, { upload: publicUpload(saved) });
        }
        if (request.method === 'POST' && uploadMatch[2]) {
          if (upload.offset !== upload.size) throw fail(409, 'upload_incomplete', '영상 전송이 아직 완료되지 않았습니다.');
          const video = { id: upload.videoId, userId: user.id, title: upload.title, fileName: upload.fileName, size: upload.size, mime: upload.mime, target: upload.target, context: upload.context, kind: 'server', addedAt: upload.createdAt, duration: null, status: 'ready', chunkSize: CHUNK_SIZE, chunks: upload.chunks, rightsConsentAt: upload.rightsConsentAt, rightsConsentVersion: upload.rightsConsentVersion };
          await store.create(`videos/${video.id}`, video);
          const workspace = await store.update(`workspaces/${user.id}`, current => {
            current ||= createGrowthWorkspace();
            if (current.videos.some(row => row.id === video.id)) return current;
            const { userId, status, chunkSize, chunks, rightsConsentAt, rightsConsentVersion, ...metadata } = video;
            return { ...current, revision: current.revision + 1, videos: [...current.videos, metadata] };
          });
          await store.update(`uploads/${id}`, current => ({ ...current, status: 'completed' }));
          await store.update(`quotas/storage/${user.id}`, quota => ({ entries: (quota?.entries || [{ videoId: video.id, size: video.size, status: 'ready' }]).map(entry => entry.videoId === video.id ? { ...entry, status: 'ready' } : entry) }));
          return json(200, { video: workspace.videos.find(row => row.id === video.id), workspace });
        }
      }
      const videoMatch = /^\/videos\/([^/]+)$/.exec(route);
      if (videoMatch && request.method === 'DELETE') { await removeVideo(requireID(videoMatch[1]), user); return json(200, { ok: true, workspace: await store.get(`workspaces/${user.id}`) }); }
      if (route === '/jobs' && request.method === 'POST') {
        const body = await readJSON(request, 10_000);
        if (body.analysisConsent !== true) throw fail(400, 'analysis_consent_required', '분석을 위한 장면 전송 동의가 필요합니다.');
        const video = await owned(`videos/${requireID(body.videoId)}`, user);
        const active = (await listOwned('jobs/', user)).find(job => job.videoId === video.id && ['queued', 'running'].includes(job.status));
        if (active) return json(200, { job: publicJob(active) });
        const job = await queueJob(video, user);
        return json(202, { job: publicJob(job) });
      }
      if (route === '/jobs' && request.method === 'GET') { const jobs = (await listOwned('jobs/', user)).filter(job => !url.searchParams.get('videoId') || job.videoId === url.searchParams.get('videoId')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); return json(200, { jobs: jobs.map(publicJob) }); }
      const jobMatch = /^\/jobs\/([^/]+)(\/(retry|cancel))?$/.exec(route);
      if (jobMatch) {
        const id = requireID(jobMatch[1]); const job = await owned(`jobs/${id}`, user);
        if (request.method === 'GET' && !jobMatch[2]) return json(200, { job: publicJob(job) });
        if (request.method === 'POST' && jobMatch[3] === 'cancel') {
          const updated = await store.update(`jobs/${id}`, current => ({ ...current, cancelRequested: true, status: ['queued', 'running'].includes(current.status) ? 'cancelled' : current.status, updatedAt: now() }));
          return json(200, { job: publicJob(updated) });
        }
        if (request.method === 'POST' && jobMatch[3] === 'retry') {
          const workspace = await store.get(`workspaces/${user.id}`);
          if (workspace?.consents?.analysis !== true) throw fail(400, 'analysis_consent_required', '분석 동의가 철회되어 재시도하지 않았습니다. 장면 전송에 다시 동의한 뒤 새 분석을 시작해 주세요.');
          const video = await owned(`videos/${job.videoId}`, user); return json(202, { job: publicJob(await queueJob(video, user, job)) });
        }
      }
      if (route.startsWith('/shares')) throw fail(501, 'sharing_not_enabled', '선수 영상 공유는 수신자 인증을 갖춘 후 제공할 예정입니다. 현재는 본인 계정에서만 열람할 수 있습니다.');
      throw fail(404, 'not_found', '요청한 기능을 찾을 수 없습니다.');
    } catch (error) { return json(error.status || 500, { code: error.code || 'server_error', error: error.status ? error.message : '요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.' }); }
  };
}
