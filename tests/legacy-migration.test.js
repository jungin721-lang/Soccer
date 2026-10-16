import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { seedState } from '../public/domain.js';
import { LEGACY_SOURCE_KEY, LEGACY_ARCHIVE_SOURCE, MAX_LEGACY_ARCHIVE_BYTES, inspectLegacyWorkspace, getLegacyOriginal, buildLegacyImportArchive, archiveFingerprint } from '../public/legacy-migration.js';

const OLD_ID = 'local-8dce4f5b-373b-42a1-880b-031f143136e3';
const NEW_ID = '6b1abcb4-8448-42a4-9541-cf50959b75e9';
const original = new File(['original video'], '오늘 경기.MOV', { type: 'video/quicktime', lastModified: 1792112400000 });
const fileVideo = overrides => ({ id: OLD_ID, kind: 'file', title: '오늘 경기', fileName: original.name, size: original.size, mime: original.type, duration: 1800.25, lastModified: original.lastModified, start: 0, source: '원본 파일', addedAt: '2026-10-16T01:23:00.000Z', ...overrides });
function legacy() {
  const state = seedState();
  state.player.name = '선수 별명';
  state.videos.push(fileVideo());
  state.observations.push({ id: 'scene-1', videoId: OLD_ID, skill: 'touch', time: 60, rating: 4, note: '이전 사람이 남긴 장면 기록', type: 'strength', createdAt: '2026-10-16T01:25:00.000Z' });
  state.analyses.push({ id: 'analysis-1', videoId: OLD_ID, createdAt: '2026-10-16T01:26:00.000Z', model: 'old-model', start: 57, end: 69, result: { identified: true, summary: '이전 AI 해석', observations: [{ skill: 'scan', time: 60, note: '주변을 확인하는 움직임', type: 'note', confidence: 'medium' }], limitations: ['짧은 장면'], nextAction: '다음 장면과 확인' } });
  state.completed.push('habit-0');
  state.snapshots.push({ id: 'snapshot-1', createdAt: '2026-10-16T01:27:00.000Z', observationCount: 1, scores: [4, null, null, null, null, null, null, null] });
  return state;
}
function storageFor(value) {
  let reads = 0;
  return {
    getItem(key) { assert.equal(key, LEGACY_SOURCE_KEY); reads++; return value; },
    setItem() { throw new Error('Migration must never write the old storage'); },
    removeItem() { throw new Error('Migration must never remove the old storage'); },
    get reads() { return reads; },
  };
}
const inspect = value => inspectLegacyWorkspace({ storage: storageFor(JSON.stringify(value)) });

test('legacy discovery reads only the v1 key and inventories every preserved record type', () => {
  const state = legacy(), storage = storageFor(JSON.stringify(state));
  const result = inspectLegacyWorkspace({ storage });
  assert.equal(storage.reads, 1);
  assert.equal(result.available, true);
  assert.equal(result.sourceKey, LEGACY_SOURCE_KEY);
  assert.deepEqual(result.videos, [state.videos[1]]);
  assert.deepEqual(result.recordCounts, { videos: 2, fileVideos: 1, youtubeVideos: 1, observations: 1, analyses: 1, autoAnalyses: 0, completed: 1, snapshots: 1 });
  assert.equal(result.archive.observations[0].rating, 4);
  assert.equal(result.archive.analyses[0].result.summary, '이전 AI 해석');
  assert.match(result.warnings.join(' '), /현재 능력 평가로 합치지/);
  result.player.name = '바뀐 별명';
  assert.equal(result.archive.player.name, '선수 별명');
});

test('absent, corrupt, blocked and unsupported versions leave the source untouched', () => {
  assert.equal(inspectLegacyWorkspace({ storage: storageFor(null) }).available, false);
  for (const raw of ['', '{malformed', 'null', '[]', JSON.stringify({ ...legacy(), version: 2 }), JSON.stringify({ ...legacy(), version: '1' })]) {
    const result = inspectLegacyWorkspace({ storage: storageFor(raw) });
    assert.equal(result.available, false);
    assert.equal(result.archive, null);
    assert.match(result.warnings[0], /그대로 유지/);
  }
  for (const name of ['SecurityError', 'QuotaExceededError']) {
    const result = inspectLegacyWorkspace({ storage: { getItem() { throw new DOMException('blocked', name); } } });
    assert.equal(result.available, false);
    assert.match(result.warnings[0], /변경하지 않았/);
  }
  assert.equal(inspect({ ...legacy(), version: 1 }).available, true);
});

test('legacy archives remove unknown keys, credentials, URLs and prototype payloads', () => {
  const state = legacy();
  state.player.apiKey = 'secret';
  state.ownerId = 'private';
  state.videos[1].url = 'javascript:alert(1)';
  state.videos[1].blob = 'data:video/mp4;base64,private';
  state.observations[0].token = 'secret';
  state.analyses[0].frames = ['raw-image'];
  const raw = JSON.stringify(state).replace('"player":{', '"player":{"__proto__":{"polluted":true},');
  const result = inspectLegacyWorkspace({ storage: storageFor(raw) });
  assert.equal(result.available, true);
  const serialized = JSON.stringify(result.archive);
  for (const value of ['secret', 'private', 'javascript:', 'base64', 'raw-image', '__proto__', 'polluted']) assert.equal(serialized.includes(value), false, value);
  assert.equal({}.polluted, undefined);
});

test('the archive size limit counts UTF-8 bytes and does not parse arbitrarily large stored JSON', () => {
  const state = legacy();
  state.unknown = '가'.repeat(Math.ceil(MAX_LEGACY_ARCHIVE_BYTES / 3));
  const raw = JSON.stringify(state);
  assert.ok(raw.length < MAX_LEGACY_ARCHIVE_BYTES);
  assert.ok(new TextEncoder().encode(raw).byteLength > MAX_LEGACY_ARCHIVE_BYTES);
  const result = inspectLegacyWorkspace({ storage: storageFor(raw) });
  assert.equal(result.available, false);
  assert.match(result.warnings[0], /1 MB/);
});

test('read-only original recovery returns a named File without decoding or copying bytes into an ArrayBuffer', async () => {
  const video = fileVideo();
  const blob = new Blob([original], { type: original.type });
  blob.arrayBuffer = () => { throw new Error('Do not read a full match into memory'); };
  let requested;
  const result = await getLegacyOriginal(video, { getOriginal: async id => { requested = id; return blob; } });
  assert.equal(requested, OLD_ID);
  assert.ok(result instanceof File);
  assert.equal(result.name, original.name);
  assert.equal(result.size, original.size);
  assert.equal(result.type, original.type);
  assert.equal(result.lastModified, original.lastModified);
  assert.deepEqual(video, fileVideo());
});

test('missing, mismatched, blocked or quota-limited original storage never destroys old data', async () => {
  await assert.rejects(getLegacyOriginal(fileVideo(), { getOriginal: async () => null }), /기록은 그대로 유지/);
  await assert.rejects(getLegacyOriginal(fileVideo(), { getOriginal: async () => new Blob(['different']) }), /삭제하지 않았/);
  for (const name of ['SecurityError', 'QuotaExceededError']) {
    await assert.rejects(getLegacyOriginal(fileVideo(), { getOriginal: async () => { throw new DOMException('blocked', name); } }), /원본은 삭제하지 않았/);
  }
  await assert.rejects(getLegacyOriginal({ ...fileVideo(), id: 'javascript:alert(1)' }, { getOriginal: () => { throw new Error('Should not open storage'); } }), /원본 영상 정보/);
  await assert.rejects(getLegacyOriginal(seedState().videos[0]), /원본 영상 정보/);
  if (!globalThis.indexedDB) await assert.rejects(getLegacyOriginal(fileVideo()), /원본은 삭제하지 않았/);
});

test('archive import preserves all old records as unverified and maps only explicitly uploaded originals', () => {
  const inspection = inspect(legacy());
  const payload = buildLegacyImportArchive({ [OLD_ID]: NEW_ID }, { inspection });
  assert.equal(payload.version, 1);
  assert.equal(payload.source, LEGACY_ARCHIVE_SOURCE);
  assert.equal(payload.sourceKey, LEGACY_SOURCE_KEY);
  assert.deepEqual(payload.idMap, [{ oldId: OLD_ID, newId: NEW_ID }]);
  assert.equal(payload.archive.observations[0].videoId, OLD_ID, 'old records are not converted into trusted v2 evidence');
  assert.equal(payload.archive.analyses[0].videoId, OLD_ID);
  assert.deepEqual(payload.archive.completed, ['habit-0']);
  assert.equal(Object.hasOwn(payload, 'importConsent'), false, 'explicit consent is supplied by the UI, not inferred by migration');
  assert.deepEqual(buildLegacyImportArchive(new Map([[OLD_ID, NEW_ID]]), { inspection }), payload);
  assert.deepEqual(buildLegacyImportArchive([{ oldId: OLD_ID, newId: NEW_ID }], { inspection }), payload);
  assert.deepEqual(buildLegacyImportArchive({}, { inspection }).idMap, []);
  assert.equal(inspection.archive.videos[1].id, OLD_ID);
});

test('malicious, duplicate and unrelated video mappings cannot enter the import payload', () => {
  const inspection = inspect(legacy());
  for (const idMap of [null, { [OLD_ID]: 'javascript:alert(1)' }, { [OLD_ID]: 'not-a-uuid' }, { unknown: NEW_ID }, { arJ6xMRKnbw: NEW_ID }, [{ oldId: OLD_ID, newId: NEW_ID }, { oldId: OLD_ID, newId: NEW_ID }]]) assert.throws(() => buildLegacyImportArchive(idMap, { inspection }), /연결/);
  assert.throws(() => buildLegacyImportArchive({}, { inspection: { available: false } }), /찾지 못/);
  const altered = inspect(legacy());
  altered.archive.observations[0].rating = 99;
  assert.throws(() => buildLegacyImportArchive({}, { inspection: altered }), /장면 기록/);
});

test('archive fingerprints use stable SHA-256 and fall back to server hashing without a weak replacement', async () => {
  const first = { b: 2, a: 1 }, second = { a: 1, b: 2 };
  const expected = createHash('sha256').update('{"a":1,"b":2}').digest('hex');
  assert.equal(await archiveFingerprint(first), expected);
  assert.equal(await archiveFingerprint(second), expected);
  assert.equal(await archiveFingerprint(first, { crypto: null }), null);
  assert.equal(await archiveFingerprint(first, { crypto: { subtle: { digest: async () => { throw new Error('Unavailable'); } } } }), null);
  const payload = buildLegacyImportArchive({}, { inspection: inspect(legacy()) });
  assert.equal(await archiveFingerprint(payload), await archiveFingerprint(JSON.parse(JSON.stringify(payload))));
});
