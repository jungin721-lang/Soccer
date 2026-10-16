import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createGrowthWorkspace, validateGrowthWorkspace } from '../public/growth-domain.js';

function fixture() {
  const state = createGrowthWorkspace();
  const videoId = randomUUID(), jobId = randomUUID(), analysisId = randomUUID();
  const createdAt = '2026-10-16T09:00:00.000Z';
  const target = { kit: 'red', number: 1, age: 10 };
  const context = { matchDate: '2026-10-16', position: '미등록', opponentLevel: 'unknown', minutesPlayed: null, filming: 'unknown' };
  state.videos = [{ id: videoId, kind: 'server', title: '합성 검증 자료', fileName: 'synthetic.mp4', size: 2048, mime: 'video/mp4', addedAt: createdAt, duration: 86400, target, context, retentionPolicy: 'delete_after_analysis', sourceStatus: 'deleted_after_analysis', sourceDeletedAt: createdAt, evidenceBytes: 64 }];
  state.analyses = [{ id: analysisId, jobId, videoId, createdAt, start: 10, end: 13, model: 'synthetic', sampledTimes: [10, 11, 12, 13], referenceTime: 11, evidence: { id: analysisId, start: 10, end: 13, mime: 'video/mp4', size: 64 }, result: { identified: true, summary: '합성 관찰', observations: [], limitations: ['합성 검증 자료'], nextAction: '검증 안내' } }];
  state.jobs = [{ id: jobId, videoId, createdAt, updatedAt: createdAt, status: 'completed', stage: 'completed', attempt: 1, target, context, provider: 'cloudflare', retention: { status: 'completed', evidenceCount: 1, totalBytes: 64, sourceDeletedAt: createdAt, leaseOwner: 'private-internal-lease', errorCode: null }, progress: { sampleCount: 86401, sampledCount: 86401, selectedCount: 43200, completedCount: 43200 } }];
  return state;
}

test('retained evidence and exact sampled-frame trace survive profile saves without exposing storage or lease data', () => {
  const state = fixture();
  Object.assign(state.analyses[0].evidence, { key: 'private-binary-path', sha256: 'private-hash', token: 'not-a-real-token' });
  const clean = validateGrowthWorkspace(state);
  assert.equal(clean.videos[0].sourceStatus, 'deleted_after_analysis');
  assert.equal(clean.videos[0].retentionPolicy, 'delete_after_analysis');
  assert.equal(clean.videos[0].evidenceBytes, 64);
  assert.deepEqual(clean.analyses[0].sampledTimes, [10, 11, 12, 13]);
  assert.equal(clean.analyses[0].referenceTime, 11);
  assert.deepEqual(Object.keys(clean.analyses[0].evidence), ['id', 'start', 'end', 'mime', 'size']);
  assert.equal(clean.jobs[0].provider, 'cloudflare');
  assert.equal(clean.jobs[0].progress.sampledCount, 86401);
  assert.equal(clean.jobs[0].progress.selectedCount, 43200);
  assert.equal(clean.jobs[0].retention.sourceDeletedAt, state.videos[0].sourceDeletedAt);
  assert.equal(Object.hasOwn(clean.jobs[0].retention, 'leaseOwner'), false);
});

test('retention timestamps and evidence offsets cannot describe a different source interval', () => {
  for (const patch of [{ sourceStatus: 'invented' }, { sourceDeletedAt: 'not-a-date' }, { sourceStatus: 'stored' }, { evidenceBytes: -1 }, { retentionPolicy: 'public_forever' }]) {
    const state = fixture(); Object.assign(state.videos[0], patch); assert.throws(() => validateGrowthWorkspace(state));
  }
  for (const patch of [{ id: '../private' }, { start: 9 }, { end: 14 }, { size: 0 }, { size: 8 * 1024 ** 2 + 1 }, { mime: 'text/html' }]) {
    const state = fixture(); Object.assign(state.analyses[0].evidence, patch); assert.throws(() => validateGrowthWorkspace(state));
  }
  const missing = fixture(); delete missing.videos[0].sourceDeletedAt; assert.throws(() => validateGrowthWorkspace(missing));
});

test('sample references must belong to the actual ordered decoded timestamps', () => {
  for (const patch of [
    { sampledTimes: [] }, { sampledTimes: [10, 10] }, { sampledTimes: [10, 11, 12, 13, 14] },
    { sampledTimes: [9, 11] }, { sampledTimes: [11, 14] }, { sampledTimes: [11, Infinity] },
    { referenceTime: 11.5 }, { sampledTimes: undefined, referenceTime: 11 },
  ]) {
    const state = fixture(); Object.assign(state.analyses[0], patch); assert.throws(() => validateGrowthWorkspace(state));
  }
});

test('dense detections retain more than the old six-hundred-analysis limit without truncation', () => {
  const state = fixture(); const template = state.analyses[0];
  state.analyses = Array.from({ length: 1001 }, () => { const id = randomUUID(); return { ...template, id, evidence: { ...template.evidence, id } }; });
  const clean = validateGrowthWorkspace(state);
  assert.equal(clean.analyses.length, 1001);
  assert.equal(clean.analyses.at(-1).id, state.analyses.at(-1).id);
});
