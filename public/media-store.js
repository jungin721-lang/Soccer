// Original videos stay on the current device. Only short metadata belongs in the
// workspace state; Blob URLs are temporary and must never be persisted.
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

const DATABASE_NAME = 'next-xi-originals-v1';
const STORE_NAME = 'files';
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', '3gp']);
const GENERIC_VIDEO_TYPES = new Set(['application/octet-stream', 'application/mp4']);
const QUOTA_MESSAGE = '기기 저장 공간이 부족합니다. 불필요한 영상을 삭제하거나 더 짧은 영상을 선택해 주세요.';
const STORAGE_MESSAGE = '이 브라우저에서 원본 영상을 저장할 수 없습니다. Safari 또는 Chrome의 일반 모드에서 다시 시도해 주세요.';

export function validateVideoFile(file) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('비어 있는 파일입니다. 원본 영상 파일을 다시 선택해 주세요.');
  }
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error('영상은 최대 2 GB까지 등록할 수 있습니다. 영상을 나누거나 더 짧은 파일을 선택해 주세요.');
  }
  const extension = typeof file.name === 'string' ? file.name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() : '';
  const type = typeof file.type === 'string' ? file.type.toLowerCase().split(';')[0].trim() : '';
  if (!VIDEO_EXTENSIONS.has(extension) || (type && !type.startsWith('video/') && !GENERIC_VIDEO_TYPES.has(type))) {
    throw new Error('MP4, MOV, M4V, WebM 또는 3GP 영상 파일을 선택해 주세요.');
  }
  return file;
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.max(0, Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1));
  const amount = value / 1024 ** index;
  return `${Number(amount.toFixed(index ? 1 : 0)).toLocaleString('ko-KR')} ${units[index]}`;
}

export function readVideoMetadata(file) {
  validateVideoFile(file);
  return new Promise((resolve) => {
    const result = { duration: 0, width: 0, height: 0, playable: false };
    if (!globalThis.document?.createElement || !globalThis.URL?.createObjectURL) {
      resolve(result);
      return;
    }
    let video;
    let objectUrl;
    let timer;
    let settled = false;
    const finish = (playable = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (video) {
        result.duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        result.width = Number.isFinite(video.videoWidth) ? video.videoWidth : 0;
        result.height = Number.isFinite(video.videoHeight) ? video.videoHeight : 0;
        result.playable = playable && result.width > 0 && result.height > 0;
        video.onloadedmetadata = null;
        video.onloadeddata = null;
        video.onerror = null;
        try {
          video.removeAttribute('src');
          video.load();
        } catch {
          // Cleanup must not leave the metadata promise unresolved.
        }
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(result);
    };
    try {
      video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      // Container metadata can be readable even when its video codec is not.
      // Wait for the first decoded frame before marking the preview playable.
      video.onloadedmetadata = () => { if (video.readyState >= 2) finish(true); };
      video.onloadeddata = () => finish(true);
      video.onerror = () => finish(false);
      timer = setTimeout(() => finish(false), 12_000);
      objectUrl = URL.createObjectURL(file);
      video.src = objectUrl;
      video.load();
    } catch {
      // A recognised container may have a codec the current browser cannot
      // decode. Keep the original instead of rejecting a legitimate file.
      finish(false);
    }
  });
}

function storageError(error) {
  if (['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(error?.name)) return new Error(QUOTA_MESSAGE);
  if (error?.message === QUOTA_MESSAGE || error?.message === STORAGE_MESSAGE) return error;
  return new Error(STORAGE_MESSAGE, { cause: error });
}

function validateId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 200) {
    throw new Error('영상 식별 정보가 올바르지 않습니다. 다시 등록해 주세요.');
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error(STORAGE_MESSAGE));
      return;
    }
    let request;
    let failed = false;
    try {
      request = indexedDB.open(DATABASE_NAME, 1);
    } catch (error) {
      reject(storageError(error));
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () => {
      failed = true;
      reject(new Error('다른 탭에서 영상 저장소를 사용하고 있습니다. NEXT XI 탭을 닫은 뒤 다시 시도해 주세요.'));
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (failed) database.close();
      else resolve(database);
    };
  });
}

function transact(database, mode, operation) {
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let value;
      request.onsuccess = () => { value = request.result; };
      // A successful request does not guarantee that the transaction committed.
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(storageError(transaction.error || request.error));
      transaction.onerror = () => reject(storageError(transaction.error || request.error));
    } catch (error) {
      if (transaction) transaction.abort();
      reject(storageError(error));
    }
  });
}

async function checkStorageSpace(file) {
  let estimate;
  try {
    estimate = await globalThis.navigator?.storage?.estimate?.();
  } catch {
    // Storage estimates are optional and may be unavailable in private mode.
  }
  if (estimate && Number.isFinite(estimate.quota) && estimate.quota > 0 && Number.isFinite(estimate.usage)) {
    if (file.size > Math.max(0, estimate.quota - estimate.usage)) throw new Error(QUOTA_MESSAGE);
  }
}

async function saveVideo(id, file) {
  validateId(id);
  validateVideoFile(file);
  await checkStorageSpace(file);
  const database = await openDatabase();
  try {
    await transact(database, 'readwrite', (store) => store.put({ id, blob: file, savedAt: new Date().toISOString() }));
  } finally {
    database.close();
  }
}

export function saveOriginalVideo(id, file) {
  return saveVideo(id, file);
}

async function loadVideo(id) {
  validateId(id);
  const database = await openDatabase();
  try {
    const record = await transact(database, 'readonly', (store) => store.get(id));
    return record?.blob instanceof Blob ? record.blob : null;
  } finally {
    database.close();
  }
}

export function getOriginalVideo(id) {
  return loadVideo(id);
}

async function removeVideo(id) {
  validateId(id);
  const database = await openDatabase();
  try {
    await transact(database, 'readwrite', (store) => store.delete(id));
  } finally {
    database.close();
  }
}

export function deleteOriginalVideo(id) {
  return removeVideo(id);
}
