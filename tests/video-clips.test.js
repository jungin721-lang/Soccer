import test from 'node:test';
import assert from 'node:assert/strict';
import { KIT_LABELS } from '../public/growth-domain.js';
import {
  CLIP_LIMITS, planVideoClips, formatClipTime, videoClipSupport,
  validateVideoClipFile, validateVideoClipTarget, inspectClipSource, createVideoClip,
} from '../public/video-clips.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const target = { kit: 'navy', number: 11, age: 11 };

function sourceFile(name = 'match.mp4', type = 'video/mp4') {
  const file = new File(['video'], name, { type });
  file.arrayBuffer = () => { throw new Error('The complete original video must never be read.'); };
  return file;
}

async function withGlobals(values, callback) {
  const descriptors = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    return await callback();
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function browserGlobals(supports = () => true) {
  class Canvas {}
  Canvas.prototype.captureStream = () => {};
  class Recorder {}
  Recorder.isTypeSupported = supports;
  return { document: { createElement: () => ({}) }, HTMLCanvasElement: Canvas, MediaRecorder: Recorder };
}

test('clip limits bound the source, output, overlap, and decoded video size', () => {
  assert.equal(CLIP_LIMITS.maxSourceBytes, 8 * GiB);
  assert.equal(CLIP_LIMITS.maxClipBytes, 24 * MiB);
  assert.equal(CLIP_LIMITS.chunkSeconds, 60);
  assert.equal(CLIP_LIMITS.overlapSeconds, 5);
  assert.equal(CLIP_LIMITS.maxLongEdge, 1920);
  assert.equal(CLIP_LIMITS.frameRate, 30);
});

test('clip plans preserve the complete source with five seconds before every later minute', () => {
  assert.deepEqual(planVideoClips(125), [
    { index: 1, start: 0, end: 60, duration: 60 },
    { index: 2, start: 55, end: 120, duration: 65 },
    { index: 3, start: 115, end: 125, duration: 10 },
  ]);
  for (const duration of [0.001, 0.5, 1, 59.999, 60, 60.001, 65, 119.999, 120, 120.001, 5400, 86400]) {
    const plan = planVideoClips(duration);
    assert.equal(plan.length, Math.ceil(duration / 60), `clip count for ${duration}`);
    assert.equal(plan[0].start, 0);
    assert.equal(plan.at(-1).end, duration);
    for (let index = 0; index < plan.length; index += 1) {
      const clip = plan[index];
      assert.equal(clip.index, index + 1);
      assert.equal(clip.start, Math.max(0, index * 60 - (index ? 5 : 0)));
      assert.equal(clip.end, Math.min(duration, (index + 1) * 60));
      assert.equal(clip.duration, clip.end - clip.start);
      assert.ok(clip.duration > 0 && clip.duration <= 65);
      if (index) assert.equal(plan[index - 1].end - clip.start, 5, 'adjacent clips overlap without a gap');
    }
    assert.deepEqual(planVideoClips(duration), plan, 'planning is deterministic');
  }
});

test('clip plans support shorter chunks and explicit zero overlap', () => {
  assert.deepEqual(planVideoClips(61, { chunkSeconds: 30, overlapSeconds: 3 }), [
    { index: 1, start: 0, end: 30, duration: 30 },
    { index: 2, start: 27, end: 60, duration: 33 },
    { index: 3, start: 57, end: 61, duration: 4 },
  ]);
  assert.deepEqual(planVideoClips(61, { chunkSeconds: 30, overlapSeconds: 0 }), [
    { index: 1, start: 0, end: 30, duration: 30 },
    { index: 2, start: 30, end: 60, duration: 30 },
    { index: 3, start: 60, end: 61, duration: 1 },
  ]);
  assert.deepEqual(planVideoClips(5, { chunkSeconds: 2 }), [
    { index: 1, start: 0, end: 2, duration: 2 },
    { index: 2, start: 1, end: 4, duration: 3 },
    { index: 3, start: 3, end: 5, duration: 2 },
  ]);
});

test('clip plans reject invalid lengths and unbounded chunk options', () => {
  for (const duration of [0, -1, NaN, Infinity, -Infinity, 86400.001, '60', null, undefined]) {
    assert.throws(() => planVideoClips(duration));
  }
  for (const chunkSeconds of [0, -1, 60.001, NaN, Infinity, '30', null]) {
    assert.throws(() => planVideoClips(60, { chunkSeconds }));
  }
  for (const overlapSeconds of [-1, 30, 31, NaN, Infinity, '3', null]) {
    assert.throws(() => planVideoClips(60, { chunkSeconds: 30, overlapSeconds }));
  }
  for (const options of [null, [], '30', 30]) assert.throws(() => planVideoClips(60, options));
  assert.throws(() => planVideoClips(86400, { chunkSeconds: 0.001, overlapSeconds: 0 }), { code: 'invalid_options' });
});

test('clip timestamps preserve source hours and round milliseconds across clock boundaries', () => {
  for (const [seconds, expected] of [
    [0, '00:00:00.000'],
    [0.001, '00:00:00.001'],
    [1.2344, '00:00:01.234'],
    [1.2346, '00:00:01.235'],
    [59.9996, '00:01:00.000'],
    [3599.9996, '01:00:00.000'],
    [3661.25, '01:01:01.250'],
    [86400, '24:00:00.000'],
  ]) assert.equal(formatClipTime(seconds), expected);
  for (const value of [-0.001, NaN, Infinity, -Infinity, Number.MAX_VALUE, '1', null, undefined]) {
    assert.throws(() => formatClipTime(value), { code: 'invalid_time' });
  }
});

test('clip source validation accepts supported phone files and the exact eight GiB limit without reading bytes', () => {
  for (const [name, type] of [
    ['match.mp4', 'video/mp4'], ['경기.MOV', 'video/quicktime'],
    ['match.m4v', 'video/x-m4v'], ['match.webm', 'video/webm'],
    ['match.3gp', 'video/3gpp'], ['match.3g2', 'video/3gpp2'],
    ['match.mp4', ''], ['match.mp4', 'application/octet-stream'],
  ]) assert.doesNotThrow(() => validateVideoClipFile(sourceFile(name, type)), name);
  const boundary = sourceFile();
  Object.defineProperty(boundary, 'size', { value: 8 * GiB });
  assert.doesNotThrow(() => validateVideoClipFile(boundary));
});

test('clip source validation rejects empty, unsupported, fabricated, and oversized files', () => {
  const oversized = sourceFile();
  Object.defineProperty(oversized, 'size', { value: 8 * GiB + 1 });
  for (const file of [
    null, {}, { name: 'match.mp4', size: 3, type: 'video/mp4' },
    new File([], 'empty.mp4', { type: 'video/mp4' }),
    sourceFile('match.avi', 'video/x-msvideo'), sourceFile('match.mp4.exe'),
    sourceFile('match.mp4', 'text/html'), oversized,
  ]) assert.throws(() => validateVideoClipFile(file));
  assert.throws(() => validateVideoClipFile(oversized), { code: 'file_too_large' });
});

test('clip targets normalize kit labels and enforce bounded player fields', () => {
  for (const [kit, label] of Object.entries(KIT_LABELS)) {
    assert.deepEqual(validateVideoClipTarget({ ...target, kit }), { ...target, kit });
    assert.deepEqual(validateVideoClipTarget({ ...target, kit: label }), { ...target, kit });
  }
  for (const number of [1, 99]) assert.doesNotThrow(() => validateVideoClipTarget({ ...target, number }));
  for (const age of [5, 18]) assert.doesNotThrow(() => validateVideoClipTarget({ ...target, age }));
  for (const value of [
    null, [], {}, { ...target, kit: '__proto__' }, { ...target, kit: 'unknown' },
    ...[0, 100, 11.5, NaN, Infinity].map(number => ({ ...target, number })),
    ...[4, 19, 11.5, NaN, Infinity].map(age => ({ ...target, age })),
  ]) assert.throws(() => validateVideoClipTarget(value), { code: 'invalid_target' });
});

test('clip support requires browser recording and canvas capture APIs', async () => {
  for (const missing of ['document', 'MediaRecorder', 'HTMLCanvasElement']) {
    const globals = browserGlobals();
    globals[missing] = undefined;
    await withGlobals(globals, () => assert.equal(videoClipSupport().supported, false));
  }
  const globals = browserGlobals();
  delete globals.HTMLCanvasElement.prototype.captureStream;
  await withGlobals(globals, () => assert.equal(videoClipSupport().supported, false));
  await withGlobals({ ...browserGlobals(), document: {} }, () => assert.equal(videoClipSupport().supported, false));
  await withGlobals({ ...browserGlobals(), MediaRecorder: class {} }, () => assert.equal(videoClipSupport().supported, false));
  await withGlobals(browserGlobals(() => false), () => assert.equal(videoClipSupport().supported, false));
});

test('clip support prefers explicit H.264 MP4 and orders WebM codecs', async () => {
  const all = [];
  await withGlobals(browserGlobals(mime => { all.push(mime); return true; }), () => {
    const support = videoClipSupport();
    assert.equal(support.supported, true);
    assert.equal(support.extension, 'mp4');
    assert.match(support.mimeType, /^video\/mp4;.*avc1/i);
  });
  assert.ok(all.length > 0);
  for (const codec of ['vp9', 'vp8']) {
    await withGlobals(browserGlobals(mime => mime.startsWith('video/webm') && mime.includes(codec)), () => {
      const support = videoClipSupport();
      assert.equal(support.supported, true);
      assert.equal(support.extension, 'webm');
      assert.ok(support.mimeType.includes(codec));
    });
  }
  await withGlobals(browserGlobals(mime => mime.startsWith('video/webm')), () => {
    assert.ok(videoClipSupport().mimeType.includes('vp9'), 'VP9 is preferred when both WebM codecs are supported');
  });
  await withGlobals(browserGlobals(mime => mime === 'video/mp4'), () => {
    assert.deepEqual(videoClipSupport(), { supported: true, mimeType: 'video/mp4', extension: 'mp4' });
  });
});

test('generic Safari MP4 recording requires H.264 playback and falls back to playable WebM', async () => {
  const globals = browserGlobals(mime => mime === 'video/mp4' || mime.startsWith('video/webm'));
  globals.document.createElement = () => ({ canPlayType: () => 'probably' });
  await withGlobals(globals, () => {
    assert.deepEqual(videoClipSupport(), { supported: true, mimeType: 'video/mp4', extension: 'mp4' });
  });
  globals.document.createElement = () => ({
    canPlayType: mime => mime === 'video/mp4' || mime.startsWith('video/webm') ? 'probably' : '',
  });
  await withGlobals(globals, () => {
    const support = videoClipSupport();
    assert.equal(support.supported, true);
    assert.equal(support.extension, 'webm');
    assert.ok(support.mimeType.includes('vp9'));
  });
  globals.MediaRecorder.isTypeSupported = mime => mime === 'video/mp4';
  await withGlobals(globals, () => assert.equal(videoClipSupport().supported, false));
});

test('clip support skips recorded formats the browser cannot play', async () => {
  const globals = browserGlobals();
  globals.document.createElement = () => ({ canPlayType: mime => mime.startsWith('video/webm') ? 'probably' : '' });
  await withGlobals(globals, () => {
    const support = videoClipSupport();
    assert.equal(support.supported, true);
    assert.equal(support.extension, 'webm');
    assert.ok(support.mimeType.includes('vp9'));
  });
  globals.document.createElement = () => ({ canPlayType: () => '' });
  await withGlobals(globals, () => assert.equal(videoClipSupport().supported, false));
});

test('source inspection and clip creation reject invalid inputs before touching the browser or original bytes', async () => {
  let elements = 0;
  const globals = browserGlobals();
  globals.document.createElement = () => { elements += 1; throw new Error('Invalid inputs must not create browser resources.'); };
  await withGlobals(globals, async () => {
    for (const file of [null, {}, new File([], 'empty.mp4', { type: 'video/mp4' })]) {
      await assert.rejects(() => inspectClipSource(file), { code: 'invalid_file' });
      await assert.rejects(() => createVideoClip(file, { target, clip: planVideoClips(1)[0] }), { code: 'invalid_file' });
    }
    const file = sourceFile();
    await assert.rejects(() => createVideoClip(file, { target: { ...target, kit: 'unknown' }, clip: planVideoClips(1)[0] }), { code: 'invalid_target' });
    for (const clip of [
      undefined, null, {},
      { index: 1, start: -1, end: 1, duration: 2 },
      { index: 1, start: 1, end: 1, duration: 0 },
      { index: 1, start: 0, end: 66, duration: 66 },
      { index: 1, start: 0, end: Infinity, duration: Infinity },
      { index: 1, start: '0', end: 1, duration: 1 },
    ]) await assert.rejects(() => createVideoClip(file, { target, clip }), { code: 'invalid_clip' });
  });
  assert.equal(elements, 0);
});

test('pre-cancelled source inspection and clip creation stop before browser access, even with invalid inputs', async () => {
  const controller = new AbortController();
  controller.abort();
  let elements = 0;
  const globals = browserGlobals();
  globals.document.createElement = () => { elements += 1; throw new Error('Cancelled work must not create browser resources.'); };
  await withGlobals(globals, async () => {
    for (const file of [sourceFile(), null]) {
      await assert.rejects(() => inspectClipSource(file, { signal: controller.signal }), { name: 'AbortError', code: 'aborted' });
      await assert.rejects(() => createVideoClip(file, { target, clip: planVideoClips(1)[0], signal: controller.signal }), { name: 'AbortError', code: 'aborted' });
    }
  });
  assert.equal(elements, 0);
});

test('source inspection uses a Blob URL and releases decoded video resources on success and invalid metadata', async () => {
  for (const metadata of [
    { duration: 125.5, videoWidth: 3840, videoHeight: 2160 },
    { duration: Infinity, videoWidth: 1920, videoHeight: 1080, code: 'invalid_duration' },
    { duration: 125, videoWidth: 1920.5, videoHeight: 1080, code: 'invalid_dimensions' },
  ]) {
    const file = sourceFile();
    let paused = 0;
    let removed = 0;
    let releasedSource = 0;
    const revoked = [];
    class Video extends EventTarget {
      constructor() {
        super();
        Object.assign(this, metadata, { readyState: 1, style: {} });
      }
      setAttribute() {}
      removeAttribute(name) { if (name === 'src') releasedSource += 1; }
      load() { this.dispatchEvent(new Event('loadedmetadata')); }
      pause() { paused += 1; }
      remove() { removed += 1; }
    }
    const video = new Video();
    const document = new EventTarget();
    document.hidden = false;
    document.createElement = name => { assert.equal(name, 'video'); return video; };
    document.body = { append: element => assert.equal(element, video) };
    const url = {
      createObjectURL: original => { assert.equal(original, file); return 'blob:original-video'; },
      revokeObjectURL: value => revoked.push(value),
    };
    await withGlobals({ document, URL: url }, async () => {
      if (metadata.code) await assert.rejects(() => inspectClipSource(file), { code: metadata.code });
      else assert.deepEqual(await inspectClipSource(file), { duration: 125.5, width: 3840, height: 2160 });
    });
    assert.equal(paused, 1);
    assert.equal(removed, 1);
    assert.equal(releasedSource, 1);
    assert.deepEqual(revoked, ['blob:original-video']);
  }
});
