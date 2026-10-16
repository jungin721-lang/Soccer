import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoClipBundle, MAX_CLIP_BUNDLE_BYTES } from '../public/video-clips-bundle.js';
import { buildStoredZip } from '../public/chat-pack.js';

function fixture() {
  const name = 'clip-02-00-00-55-000.mp4';
  const file = new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], name, { type: 'video/mp4' });
  return { file, manifest: { version: 1, kind: 'continuous-video-clip', source: { actual: { start: 55, end: 120 }, timeMap: [{ clipSeconds: 0, sourceSeconds: 55 }] }, clip: { index: 2 }, output: { filename: name, bytes: file.size }, target: { kit: 'navy', number: 11, age: 11 }, analysis: { performed: false, playerIdentified: false } } };
}

test('clip bundle contains generated video, original offsets, target and no fabricated analysis', async () => {
  const result = fixture();
  const file = await createVideoClipBundle(result);
  assert.equal(file.name, 'NEXT-XI-clip-02.zip');
  assert.equal(file.type, 'application/zip');
  assert.ok(file.size < MAX_CLIP_BUNDLE_BYTES);
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('manifest.json') && text.includes('README.txt'));
  assert.ok(text.includes('00:00:55.000') && text.includes('00:02:00.000'));
  assert.ok(text.includes('선수 식별·추적이나 AI 분석 결과가 아닙니다.'));
  assert.equal(result.manifest.target.kitLabel, undefined, 'caller manifest must not be mutated');
});

test('bundle rejects raw-looking filenames, mismatched records, size and forged analysis state', async () => {
  for (const change of [
    r => { r.file = new File(['private'], 'child-name-original.mp4', { type: 'video/mp4' }); },
    r => { r.manifest.output.bytes += 1; },
    r => { r.manifest.analysis.performed = true; },
    r => { r.manifest.source.actual.end = 40; },
    r => { r.manifest.target.number = 500; },
    r => { r.file = new File([r.file], r.file.name, { type: 'video/webm' }); },
  ]) {
    const result = fixture(); change(result);
    await assert.rejects(createVideoClipBundle(result));
  }
});

test('bundle cancellation and ZIP limits are enforced before generated file reads', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createVideoClipBundle(fixture(), { signal: controller.signal }), { name: 'AbortError' });
  const larger = new Blob([new Uint8Array(8 * 1024 ** 2)]);
  await assert.rejects(buildStoredZip([{ name: 'clip.mp4', data: larger }]), /8MiB/);
  const allowed = await buildStoredZip([{ name: 'clip.mp4', data: larger }], { maxBytes: MAX_CLIP_BUNDLE_BYTES });
  assert.ok(allowed.size > 8 * 1024 ** 2 && allowed.size < MAX_CLIP_BUNDLE_BYTES);
  for (const maxBytes of [0, NaN, Infinity, 26 * 1024 ** 2]) await assert.rejects(buildStoredZip([{ name: 'clip.mp4', data: larger }], { maxBytes }));
});
