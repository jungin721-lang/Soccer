import { seedState, validateState } from './domain.js';
import { getOriginalVideo, validateVideoFile } from './media-store.js';

export const LEGACY_SOURCE_KEY = 'next-xi-standalone-v1';
export const LEGACY_ARCHIVE_SOURCE = 'legacy_browser_unverified';
export const MAX_LEGACY_ARCHIVE_BYTES = 1024 * 1024;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const LOCAL_ID = /^local-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const encoder = new TextEncoder();
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const byteLength = value => encoder.encode(value).byteLength;
const bounded = value => {
  if (byteLength(value) > MAX_LEGACY_ARCHIVE_BYTES) throw new Error('이전 기록은 한 번에 1 MB까지 가져올 수 있습니다. 기존 기록과 원본 파일은 그대로 유지됩니다.');
  return value;
};
function emptyInspection(warnings = []) {
  return { available: false, sourceKey: LEGACY_SOURCE_KEY, player: null, videos: [], recordCounts: { videos: 0, fileVideos: 0, youtubeVideos: 0, observations: 0, analyses: 0, autoAnalyses: 0, completed: 0, snapshots: 0 }, archive: null, warnings };
}
function cleanLegacyState(value) {
  if (!object(value) || (value.version !== undefined && value.version !== 1)) throw new Error('지원하는 이전 버전의 기록이 아닙니다.');
  const player = value.player;
  if (!object(player)) throw new Error('이전 선수 정보를 확인할 수 없습니다.');
  // validateState predates the v2 private-data boundary and spreads player.
  // Explicitly select its original fields before invoking that validator.
  const legacy = validateState({
    player: { name: player.name, age: player.age, number: player.number, kit: player.kit, position: player.position, weeklyTraining: player.weeklyTraining },
    videos: value.videos, observations: value.observations, completed: value.completed, snapshots: value.snapshots,
    analyses: value.analyses, autoAnalyses: value.autoAnalyses,
  });
  for (const snapshot of legacy.snapshots) {
    if (!snapshot.id.trim() || snapshot.id.length > 80) throw new Error('이전 성장 기록의 식별 정보를 확인해 주세요.');
  }
  // Deep-clone validated metadata. No original bytes or temporary Blob URLs
  // enter the archive, even if an old state contains extra properties.
  const clean = JSON.parse(JSON.stringify({ revision: 0, ...legacy }));
  bounded(JSON.stringify(clean));
  return clean;
}

/** Read-only discovery. Storage denial and corrupt data never clear old data. */
export function inspectLegacyWorkspace({ storage } = {}) {
  let raw;
  try {
    const source = storage === undefined ? globalThis.localStorage : storage;
    if (!source || typeof source.getItem !== 'function') return emptyInspection(['이 브라우저의 이전 기록 저장소에 접근할 수 없습니다. 기존 자료는 변경하지 않았습니다.']);
    raw = source.getItem(LEGACY_SOURCE_KEY);
  } catch {
    return emptyInspection(['브라우저가 이전 기록 읽기를 허용하지 않았습니다. 기존 자료는 변경하지 않았습니다.']);
  }
  if (raw === null || raw === undefined) return emptyInspection();
  try {
    if (typeof raw !== 'string') throw new Error('이전 기록 형식이 올바르지 않습니다.');
    bounded(raw);
    const archive = cleanLegacyState(JSON.parse(raw));
    const files = archive.videos.filter(video => video.kind === 'file');
    return {
      available: true, sourceKey: LEGACY_SOURCE_KEY, player: { ...archive.player }, videos: files.map(video => ({ ...video })),
      recordCounts: {
        videos: archive.videos.length, fileVideos: files.length, youtubeVideos: archive.videos.length - files.length,
        observations: archive.observations.length, analyses: archive.analyses.length, autoAnalyses: archive.autoAnalyses.length,
        completed: archive.completed.length, snapshots: archive.snapshots.length,
      },
      archive,
      warnings: [
        '이전 기록은 검토 전 보관 자료로 가져옵니다. 과거 점수와 AI 해석을 현재 능력 평가로 합치지 않습니다.',
        ...(files.length ? ['원본은 이전과 같은 사이트 주소·브라우저의 기기 저장소에서 찾습니다. 다른 주소나 기기에서는 원본을 다시 선택해야 할 수 있습니다.'] : []),
      ],
    };
  } catch (error) {
    const limit = error instanceof Error && error.message.includes('1 MB');
    return emptyInspection([limit ? error.message : '이전 기록이 손상됐거나 지원하는 형식이 아닙니다. 기존 기록과 원본 파일은 그대로 유지됩니다.']);
  }
}

/** Return a readable original only; this function never uploads or deletes it. */
export async function getLegacyOriginal(video, { getOriginal = getOriginalVideo } = {}) {
  if (!object(video) || video.kind !== 'file' || typeof video.id !== 'string' || !LOCAL_ID.test(video.id)) throw new Error('이전 원본 영상 정보를 확인해 주세요.');
  const validated = cleanLegacyState({ ...seedState(), videos: [video] }).videos[0];
  let blob;
  try { blob = await getOriginal(validated.id); }
  catch (error) {
    const message = ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(error?.name) || /저장 공간/.test(error?.message || '')
      ? '기기 저장 공간 문제로 이전 원본을 읽지 못했습니다.'
      : '이 브라우저에서 이전 원본 저장소를 열지 못했습니다.';
    throw new Error(`${message} 원본은 삭제하지 않았습니다. 이전과 같은 브라우저에서 다시 시도하거나 파일을 직접 선택해 주세요.`, { cause: error });
  }
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error('이 기기에 이전 원본이 없습니다. 이전에 사용한 브라우저를 열거나 같은 원본 파일을 직접 선택해 주세요. 기록은 그대로 유지됩니다.');
  if (blob.size !== validated.size) throw new Error('저장된 원본 크기가 이전 기록과 달라 자동으로 연결하지 않았습니다. 같은 원본 파일을 직접 선택해 주세요. 기존 자료는 삭제하지 않았습니다.');
  const name = validated.fileName.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).at(-1);
  const type = blob.type || validated.mime;
  let file;
  if (typeof File === 'function') file = new File([blob], name, { type, lastModified: validated.lastModified });
  else {
    file = blob.slice(0, blob.size, type);
    Object.defineProperties(file, { name: { value: name }, lastModified: { value: validated.lastModified } });
  }
  validateVideoFile(file);
  return file;
}

function cleanIdMap(value, archive) {
  let entries;
  if (value instanceof Map) entries = [...value.entries()];
  else if (Array.isArray(value)) entries = value.map(item => {
    if (!object(item)) throw new Error('이전 영상 연결 정보를 확인해 주세요.');
    return [item.oldId, item.newId];
  });
  else if (object(value)) entries = Object.entries(value);
  else throw new Error('이전 영상 연결 정보를 확인해 주세요.');
  if (entries.length > 100) throw new Error('이전 영상은 한 번에 100개까지 연결할 수 있습니다.');
  const files = new Set(archive.videos.filter(video => video.kind === 'file').map(video => video.id));
  const seen = new Set();
  return entries.map(([oldId, newId]) => {
    if (typeof oldId !== 'string' || !files.has(oldId) || seen.has(oldId) || typeof newId !== 'string' || !UUID.test(newId)) throw new Error('이전 원본과 새로 저장한 영상의 연결 정보를 확인해 주세요.');
    seen.add(oldId);
    return { oldId, newId };
  }).sort((a, b) => a.oldId.localeCompare(b.oldId));
}

/** Prepare an unverified archive; API consent and ownership checks happen later. */
export function buildLegacyImportArchive(idMap = {}, { inspection, storage } = {}) {
  const found = inspection === undefined ? inspectLegacyWorkspace({ storage }) : inspection;
  if (!found?.available || !found.archive) throw new Error('가져올 수 있는 이전 기록을 찾지 못했습니다.');
  const archive = cleanLegacyState(found.archive);
  const payload = { version: 1, source: LEGACY_ARCHIVE_SOURCE, sourceKey: LEGACY_SOURCE_KEY, archive, idMap: cleanIdMap(idMap, archive) };
  bounded(JSON.stringify(payload));
  return payload;
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Server hashing is authoritative when Web Crypto is unavailable on HTTP. */
export async function archiveFingerprint(payload, { crypto } = {}) {
  const serialized = bounded(canonicalJSON(payload));
  let provider;
  try { provider = crypto === undefined ? globalThis.crypto : crypto; } catch { return null; }
  if (!provider?.subtle?.digest) return null;
  try {
    const digest = await provider.subtle.digest('SHA-256', encoder.encode(serialized));
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
