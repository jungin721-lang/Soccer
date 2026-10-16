import test from 'node:test';
import assert from 'node:assert/strict';
import { SKILLS, parseYouTube, parseTimestamp, getScores, seedState, validateState } from '../public/domain.js';

const FIRST_VIDEO = 'arJ6xMRKnbw';
const SECOND_VIDEO = 'UlIcc0uTHuQ';
const LOCAL_VIDEO = 'local-8dce4f5b-373b-42a1-880b-031f143136e3';
const validFileVideo = (overrides = {}) => ({
  kind: 'file',
  id: LOCAL_VIDEO,
  title: '오늘 경기 · 남색 11번',
  fileName: '오늘 경기.MOV',
  size: 512 * 1024 * 1024,
  mime: 'video/quicktime',
  duration: 1800.25,
  lastModified: 1792112400000,
  start: 0,
  source: '원본 파일',
  addedAt: '2026-10-16T01:23:00.000Z',
  ...overrides,
});
const validAnalysis = (overrides = {}) => ({
  id: 'analysis-01f0dc71-0273-497a-a946-d3c39a43fc33',
  videoId: LOCAL_VIDEO,
  createdAt: '2026-10-16T01:25:00.000Z',
  model: 'configured-vision-model',
  start: 57.25,
  end: 69.25,
  result: {
    identified: true,
    summary: '남색 11번 선수의 짧은 구간에서 확인한 행동입니다.',
    observations: [{ skill: 'touch', time: 60, note: '받은 공을 다음 동작으로 연결했습니다.', type: 'strength', confidence: 'medium' }],
    limitations: ['짧은 영상만으로 전체 경기 능력을 평가하지 않았습니다.'],
    nextAction: '같은 상황이 보이는 다른 장면과 함께 확인해 주세요.',
  },
  ...overrides,
});
const validObservation = (overrides = {}) => ({
  id: 'scene-1',
  videoId: FIRST_VIDEO,
  skill: 'touch',
  time: 83,
  rating: 4,
  note: '공을 받은 뒤 다음 동작으로 연결하는 장면을 확인했습니다.',
  type: 'strength',
  createdAt: '2026-10-16T01:23:00.000Z',
  ...overrides,
});

test('sample links and supported YouTube link forms resolve to the correct video', () => {
  const cases = [
    [`https://www.youtube.com/watch?v=${FIRST_VIDEO}&t=57s`, FIRST_VIDEO],
    [`https://www.youtube.com/watch?v=${SECOND_VIDEO}`, SECOND_VIDEO],
    [`https://youtu.be/${FIRST_VIDEO}?t=83`, FIRST_VIDEO],
    [` https://m.youtube.com/watch?v=${SECOND_VIDEO}&t=10s `, SECOND_VIDEO],
    [`https://youtube.com/embed/${FIRST_VIDEO}`, FIRST_VIDEO],
    [`https://youtube.com/shorts/${SECOND_VIDEO}`, SECOND_VIDEO],
  ];
  for (const [url, id] of cases) assert.equal(parseYouTube(url), id, url);
});

test('video registration rejects executable, credential-bearing, spoofed and unsupported URLs', () => {
  const urls = [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    `http://youtube.com/watch?v=${FIRST_VIDEO}`,
    `https://youtube.com.evil.example/watch?v=${FIRST_VIDEO}`,
    `https://evil.example/youtube.com/watch?v=${FIRST_VIDEO}`,
    `https://youtube.com@evil.example/watch?v=${FIRST_VIDEO}`,
    `https://user:password@youtube.com/watch?v=${FIRST_VIDEO}`,
    `https://youtube.com:8443/watch?v=${FIRST_VIDEO}`,
    `https://vimeo.com/${FIRST_VIDEO}`,
    `https://youtube.com/redirect?v=${FIRST_VIDEO}`,
    'https://youtube.com/watch?v=short',
    'https://youtube.com/watch?v=123456789012',
    'https://youtube.com/watch',
    '/watch?v=-6FfOX2Hpok',
    '',
  ];
  for (const url of urls) assert.equal(parseYouTube(url), null, url);
});

test('timestamp entry supports minute and hour forms without accepting malformed times', () => {
  const valid = [['00:00', 0], ['01:23', 83], ['12:59', 779], ['1:02:03', 3723], [' 90:00 ', 5400]];
  for (const [input, seconds] of valid) assert.equal(parseTimestamp(input), seconds, input);
  for (const input of ['', '83', '-1:00', '1:60', '1:2', '1:60:00', '01:00:60', '00:01.5', 'abc', '1:00:00:00']) {
    assert.equal(parseTimestamp(input), null, input);
  }
});

test('unobserved skills remain null rather than becoming zero or fabricated scores', () => {
  const scores = getScores([]);
  assert.equal(scores.length, 8);
  assert.deepEqual(scores.map(s => s.id), SKILLS.map(s => s.id));
  assert.ok(scores.every(s => s.value === null && s.count === 0));
});

test('scores average only rated evidence for the matching skill', () => {
  const scores = getScores([
    validObservation({ id: 'touch-1', rating: 2 }),
    validObservation({ id: 'touch-2', rating: 5 }),
    validObservation({ id: 'unrated', rating: null }),
    validObservation({ id: 'pass-1', skill: 'pass', rating: 4 }),
  ]);
  const touch = scores.find(s => s.id === 'touch');
  assert.equal(touch.value, 3.5);
  assert.equal(touch.count, 2);
  assert.equal(scores.find(s => s.id === 'pass').value, 4);
  assert.equal(scores.find(s => s.id === 'shoot').value, null);
});

test('initial workspace contains only the latest provided video at 57 seconds and navy number 11 with no invented analysis', () => {
  const state = seedState();
  assert.deepEqual(state.videos.map(v => v.id), [FIRST_VIDEO]);
  assert.equal(state.videos[0].start, 57);
  assert.equal(state.player.number, 11);
  assert.equal(state.player.kit, '남색');
  assert.equal(state.player.age, 11);
  assert.equal(state.player.name, '');
  assert.deepEqual(state.observations, []);
  assert.deepEqual(state.snapshots, []);
  assert.deepEqual(state.completed, []);
  assert.doesNotThrow(() => validateState(state));
  state.videos.pop();
  assert.equal(seedState().videos.length, 1, 'new workspaces do not share mutable sample data');
});

test('state validation preserves real scene evidence and supports an explicitly unscored observation', () => {
  const state = seedState();
  state.observations.push(validObservation(), validObservation({ id: 'scene-2', time: 91, skill: 'scan', rating: null, type: 'note' }));
  const validated = validateState(state);
  assert.deepEqual(validated.observations, state.observations);
  assert.equal(validated.observations[1].rating, null);
  assert.notEqual(validated.player, state.player);
  assert.notEqual(validated.observations[0], state.observations[0]);
});

test('player changes cannot silently switch the requested navy number 11 target', () => {
  for (const change of [{ number: 10 }, { number: '11' }, { kit: '빨강' }, { age: 4 }, { age: 19 }, { age: 11.5 }, { weeklyTraining: -1 }, { weeklyTraining: 15 }]) {
    const state = seedState();
    Object.assign(state.player, change);
    assert.throws(() => validateState(state), /선수 정보/, JSON.stringify(change));
  }
});

test('scene evidence must refer to a registered video and a known skill with a valid rating', () => {
  const invalidChanges = [
    { videoId: 'abcdefghijk' },
    { skill: 'potential' },
    { rating: 0 },
    { rating: 6 },
    { rating: 3.5 },
    { rating: '4' },
    { time: -1 },
    { time: 1.5 },
    { time: 86401 },
    { note: '   ' },
    { type: 'diagnosis' },
    { createdAt: 'not-a-date' },
  ];
  for (const change of invalidChanges) {
    const state = seedState();
    state.observations.push(validObservation(change));
    assert.throws(() => validateState(state), /장면 기록/, JSON.stringify(change));
  }
});

test('duplicate videos and duplicate scene IDs are rejected to prevent duplicated evidence', () => {
  const videos = seedState();
  videos.videos.push({ ...videos.videos[0] });
  assert.throws(() => validateState(videos), /이미 등록된 영상/);
  const scenes = seedState();
  scenes.observations.push(validObservation(), validObservation({ skill: 'pass' }));
  assert.throws(() => validateState(scenes), /중복된 장면 기록/);
});

test('completed habits are deduplicated and imported unknown fields are not retained', () => {
  const state = seedState();
  state.completed = ['week1-0', 'habit-0', 'week1-0'];
  state.videos[0].injected = '<script>alert(1)</script>';
  state.observations.push({ ...validObservation(), injected: 'untrusted' });
  const validated = validateState(state);
  assert.deepEqual(validated.completed, ['week1-0', 'habit-0']);
  assert.equal(Object.hasOwn(validated.videos[0], 'injected'), false);
  assert.equal(Object.hasOwn(validated.observations[0], 'injected'), false);
});

test('original file metadata survives JSON export and import alongside legacy videos and scene evidence', () => {
  const state = seedState();
  state.videos.push(validFileVideo());
  state.observations.push(validObservation({ videoId: LOCAL_VIDEO }));
  const validated = validateState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(validated.videos[0], state.videos[0], 'the existing YouTube video is preserved without requiring a new kind');
  assert.deepEqual(validated.videos[1], state.videos[1]);
  assert.deepEqual(validated.observations, state.observations);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(validated))), validated);
});

test('file video metadata allows the maximum size, unavailable duration and MIME fallback', () => {
  const state = seedState();
  state.videos.push(validFileVideo({ size: 2 * 1024 ** 3, duration: null, mime: '', lastModified: 0, start: undefined, source: undefined }));
  const file = validateState(state).videos[1];
  assert.equal(file.size, 2 * 1024 ** 3);
  assert.equal(file.duration, null);
  assert.equal(file.mime, '');
  assert.equal(file.lastModified, 0);
  assert.equal(file.start, 0);
  assert.equal(file.source, '원본 파일');
});

test('file videos reject invalid identifiers and incomplete or unsafe file metadata', () => {
  const invalidChanges = [
    { id: FIRST_VIDEO }, { id: 'local-not-a-uuid' }, { id: LOCAL_VIDEO + '-extra' },
    { fileName: '' }, { fileName: '   ' }, { fileName: 'a'.repeat(256) }, { fileName: null },
    { size: 0 }, { size: -1 }, { size: 1.5 }, { size: 2 * 1024 ** 3 + 1 }, { size: '1024' },
    { mime: null }, { mime: 'a'.repeat(101) },
    { duration: undefined }, { duration: 0 }, { duration: -1 }, { duration: 86400.1 }, { duration: Infinity }, { duration: NaN }, { duration: '60' },
    { lastModified: undefined }, { lastModified: -1 }, { lastModified: 1.5 }, { lastModified: '0' },
  ];
  for (const change of invalidChanges) {
    const state = seedState();
    state.videos.push(validFileVideo(change));
    assert.throws(() => validateState(state), /영상 정보/, JSON.stringify(change));
  }
});

test('video kinds cannot turn arbitrary IDs into YouTube videos or bypass file metadata checks', () => {
  for (const video of [
    { ...seedState().videos[0], kind: 'remote' },
    { ...seedState().videos[0], kind: null },
    { ...seedState().videos[0], kind: 'file' },
    { ...validFileVideo(), kind: 'youtube' },
    { ...validFileVideo(), kind: undefined },
  ]) {
    const state = seedState();
    state.videos = [video];
    assert.throws(() => validateState(state), /영상 정보/);
  }
  const explicitYouTube = seedState();
  explicitYouTube.videos[0].kind = 'youtube';
  assert.equal(validateState(explicitYouTube).videos[0].kind, 'youtube');
});

test('serialized videos retain only source metadata and never include file data or temporary object URLs', () => {
  const state = seedState();
  const transient = { blob: { type: 'video/mp4' }, file: { name: 'match.mp4' }, fileData: 'base64-data', objectUrl: 'blob:https://example.test/temporary', url: 'blob:temporary' };
  Object.assign(state.videos[0], validFileVideo(), transient, { id: FIRST_VIDEO, kind: 'youtube' });
  state.videos.push({ ...validFileVideo(), ...transient });
  const validated = validateState(state);
  for (const video of validated.videos) {
    for (const key of Object.keys(transient)) assert.equal(Object.hasOwn(video, key), false, key);
  }
  for (const key of ['fileName', 'size', 'mime', 'duration', 'lastModified']) {
    assert.equal(Object.hasOwn(validated.videos[0], key), false, `YouTube metadata excludes ${key}`);
  }
  assert.equal(JSON.stringify(validated).includes('blob:'), false);
});

test('invalid video start positions normalize to zero without changing valid saved positions', () => {
  for (const start of [undefined, null, '57', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 86401]) {
    const state = seedState();
    state.videos[0].start = start;
    state.videos.push(validFileVideo({ start }));
    assert.ok(validateState(state).videos.every(v => v.start === 0), String(start));
  }
  assert.equal(validateState(seedState()).videos[0].start, 57);
});

test('legacy workspaces without AI analyses remain valid and receive an empty analysis history', () => {
  const state = seedState();
  assert.deepEqual(state.analyses, []);
  delete state.analyses;
  assert.deepEqual(validateState(state).analyses, []);
  state.analyses = null;
  assert.throws(() => validateState(state), /AI 분석 기록/);
});

test('qualitative file analysis results survive JSON round trips without becoming rated scene evidence', () => {
  const state = seedState();
  state.videos.push(validFileVideo());
  state.analyses.push(validAnalysis());
  const validated = validateState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(validated.analyses, state.analyses);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(validated))), validated);
  assert.deepEqual(validated.observations, []);
  assert.ok(getScores(validated.observations).every(score => score.value === null));
  assert.notEqual(validated.analyses[0].result, state.analyses[0].result);
  assert.notEqual(validated.analyses[0].result.observations[0], state.analyses[0].result.observations[0]);
  assert.notEqual(validated.analyses[0].result.limitations, state.analyses[0].result.limitations);
});

test('an unidentified player can have a saved explanation but cannot have asserted observations', () => {
  const state = seedState();
  state.videos.push(validFileVideo());
  const result = { ...validAnalysis().result, identified: false, observations: [] };
  state.analyses.push(validAnalysis({ result }));
  assert.equal(validateState(state).analyses[0].result.identified, false);
  result.observations.push(validAnalysis().result.observations[0]);
  assert.throws(() => validateState(state), /AI 분석 기록/);
});

test('analysis records require a registered original file and a finite interval no longer than twelve seconds', () => {
  const invalidChanges = [
    { id: '' }, { id: 'a'.repeat(81) }, { id: 'invalid id' }, { id: null },
    { videoId: FIRST_VIDEO }, { videoId: 'local-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    { createdAt: 'invalid' }, { createdAt: 1792112400000 },
    { model: '' }, { model: ' ' }, { model: null }, { model: 'm'.repeat(101) },
    { start: -1 }, { start: NaN }, { start: Infinity }, { start: '57' },
    { end: 57.25 }, { end: 57 }, { end: 69.251 }, { end: Infinity }, { end: '69' },
    { start: 86395, end: 86401 },
  ];
  for (const change of invalidChanges) {
    const state = seedState();
    state.videos.push(validFileVideo());
    state.analyses.push(validAnalysis(change));
    assert.throws(() => validateState(state), /AI 분석 기록/, JSON.stringify(change));
  }
});

test('analysis results reject malformed text, excessive lists and observations outside the analyzed interval', () => {
  const sample = validAnalysis();
  const observation = sample.result.observations[0];
  const invalidResults = [
    null, { ...sample.result, identified: 'true' },
    { ...sample.result, summary: null }, { ...sample.result, summary: 's'.repeat(2001) },
    { ...sample.result, observations: null }, { ...sample.result, observations: Array(25).fill(observation) },
    { ...sample.result, limitations: null }, { ...sample.result, limitations: Array(11).fill('') },
    { ...sample.result, limitations: [null] }, { ...sample.result, limitations: ['l'.repeat(501)] },
    { ...sample.result, nextAction: null }, { ...sample.result, nextAction: 'n'.repeat(1501) },
    ...[
      { skill: 'potential' }, { time: 56 }, { time: 71 }, { time: 60.5 },
      { note: '' }, { note: ' ' }, { note: 'n'.repeat(1501) },
      { type: 'diagnosis' }, { confidence: 'certain' }, { rating: 5 }, { rating: null },
    ].map(change => ({ ...sample.result, observations: [{ ...observation, ...change }] })),
  ];
  for (const result of invalidResults) {
    const state = seedState();
    state.videos.push(validFileVideo());
    state.analyses.push(validAnalysis({ result }));
    assert.throws(() => validateState(state), /AI 분석 기록/);
  }
  const state = seedState();
  state.videos.push(validFileVideo());
  state.analyses.push(validAnalysis({ result: { ...sample.result, observations: [{ ...observation, time: 57 }, { ...observation, time: 70 }] } }));
  assert.equal(validateState(state).analyses[0].result.observations.length, 2, 'integer timestamps may round the fractional clip boundaries');
});

test('analysis history is bounded, rejects duplicate IDs and removes fields outside the persistence schema', () => {
  const state = seedState();
  state.videos.push(validFileVideo());
  const analysis = validAnalysis();
  analysis.frames = ['data:image/jpeg;base64,not-persisted'];
  analysis.result.rating = 5;
  analysis.result.observations[0].extra = 'untrusted';
  state.analyses.push(analysis);
  const clean = validateState(state).analyses[0];
  assert.equal(Object.hasOwn(clean, 'frames'), false);
  assert.equal(Object.hasOwn(clean.result, 'rating'), false);
  assert.equal(Object.hasOwn(clean.result.observations[0], 'extra'), false);
  state.analyses.push(validAnalysis());
  assert.throws(() => validateState(state), /중복된 AI 분석 기록/);
  state.analyses = Array.from({ length: 101 }, (_, index) => validAnalysis({ id: `analysis-${index}` }));
  assert.throws(() => validateState(state), /AI 분석 기록/);
});
