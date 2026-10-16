import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VIDEO_BYTES, validateVideoFile, formatBytes, readVideoMetadata, saveOriginalVideo, getOriginalVideo, deleteOriginalVideo } from '../public/media-store.js';

test('original video formats accept phone filenames, empty MIME, and video container types', () => {
  const files = [
    new File(['video'], 'IMG_001.MOV', { type: 'video/quicktime' }),
    new File(['video'], '경기.mp4', { type: 'video/mp4' }),
    new File(['video'], '경기.m4v', { type: '' }),
    new File(['video'], '경기.webm', { type: 'video/webm' }),
    new File(['video'], '경기.3gp', { type: 'video/3gpp' }),
    new File(['video'], '경기.MP4', { type: 'application/octet-stream' }),
    new File(['video'], '경기.mp4', { type: 'application/mp4' }),
  ];
  for (const file of files) assert.equal(validateVideoFile(file), file);
});

test('file validation rejects empty, nonvideo, unsupported and oversized selections', () => {
  assert.throws(() => validateVideoFile(null), /비어 있는/);
  assert.throws(() => validateVideoFile(new File([], 'empty.mp4', { type: 'video/mp4' })), /비어 있는/);
  for (const file of [
    new File(['image'], 'picture.jpg', { type: 'image/jpeg' }),
    new File(['image'], 'picture.mp4', { type: 'image/jpeg' }),
    new File(['text'], 'document.mov', { type: 'text/plain' }),
    new File(['text'], 'renamed.mp4.exe', { type: 'video/mp4' }),
    new File(['video'], 'unsupported.avi', { type: 'video/x-msvideo' }),
    new File(['video'], 'no-extension', { type: 'video/mp4' }),
    new File(['video'], 'mp4', { type: 'video/mp4' }),
  ]) assert.throws(() => validateVideoFile(file), /영상 파일/);
  assert.equal(MAX_VIDEO_BYTES, 2 * 1024 ** 3);
  assert.throws(() => validateVideoFile({ name: 'large.mp4', type: 'video/mp4', size: MAX_VIDEO_BYTES + 1 }), /최대 2 GB/);
  assert.doesNotThrow(() => validateVideoFile({ name: 'limit.mp4', type: 'video/mp4', size: MAX_VIDEO_BYTES }));
});

test('byte formatting keeps phone file sizes readable', () => {
  const cases = [[0, '0 B'], [NaN, '0 B'], [-3, '0 B'], [0.5, '1 B'], [512, '512 B'], [1024, '1 KB'], [1536, '1.5 KB'], [30 * 1024 ** 2, '30 MB'], [MAX_VIDEO_BYTES, '2 GB']];
  for (const [value, text] of cases) assert.equal(formatBytes(value), text);
});

test('metadata without a browser reports an unsupported preview without reading file bytes', async () => {
  const file = new File(['not-a-real-video'], 'phone.mov', { type: 'video/quicktime' });
  file.arrayBuffer = () => { throw new Error('Whole video must not be read into memory'); };
  assert.deepEqual(await readVideoMetadata(file), { duration: 0, width: 0, height: 0, playable: false });
});

test('an environment without IndexedDB gets a useful storage error instead of silent success', async () => {
  assert.equal(typeof globalThis.indexedDB, 'undefined');
  const file = new File(['video'], 'phone.mp4', { type: 'video/mp4' });
  for (const operation of [saveOriginalVideo('file-1', file), getOriginalVideo('file-1'), deleteOriginalVideo('file-1')]) {
    await assert.rejects(operation, /Safari 또는 Chrome의 일반 모드/);
  }
});
