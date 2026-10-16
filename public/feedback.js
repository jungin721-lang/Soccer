import { KIT_LABELS } from './growth-domain.js';

export { KIT_LABELS };
export const FEEDBACK_SCHEMA = 'next-xi-feedback/v1';
export const FEEDBACK_MAX_BYTES = 1024 * 1024;
export const FEEDBACK_MAX_REPORTS = 50;
export const FEEDBACK_LINK_MAX_BYTES = 64 * 1024;
const DB_NAME = 'next-xi-private-feedback-v1';
const STORE = 'reports';
const STORAGE_MESSAGE = '이 브라우저에 피드백을 저장하지 못했어요. 일반 모드에서 저장 공간을 확인한 뒤 다시 시도해 주세요.';
const invalid = path => { throw new Error(`피드백 형식이 맞지 않아요 (${path}). 채팅에서 받은 분석 결과 JSON 파일인지 확인해 주세요.`); };

function exact(value, required, optional = [], path = 'report') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) invalid(path);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`);
}
function text(value, max, path) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid(path);
  return value;
}
function id(value, path) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value) || ['constructor', 'prototype'].includes(value)) invalid(path);
  return value;
}
function number(value, min, max, path, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) invalid(path);
  return value;
}
function array(value, min, max, path, validate) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid(path);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid(path);
  }
  return Array.prototype.map.call(value, (item, index) => validate(item, `${path}[${index}]`));
}
function unique(items, path) {
  if (new Set(items.map(item => item.id)).size !== items.length) invalid(path);
  return items;
}
function date(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) invalid('reviewedAt');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) invalid('reviewedAt');
  return value;
}

/** Return a bounded, plain-data copy. Imported prose is always rendered as text. */
export function validateFeedbackReport(value) {
  exact(value, ['schema', 'id', 'title', 'target', 'reviewedAt', 'source', 'summary', 'observations', 'unobserved', 'training', 'limitations', 'provenance']);
  if (value.schema !== FEEDBACK_SCHEMA) invalid('schema');
  exact(value.target, ['kit', 'number', 'age'], [], 'target');
  if (typeof value.target.kit !== 'string' || !Object.hasOwn(KIT_LABELS, value.target.kit)) invalid('target.kit');
  const target = { kit: value.target.kit, number: number(value.target.number, 1, 99, 'target.number', true), age: number(value.target.age, 5, 18, 'target.age', true) };
  exact(value.source, ['kind', 'durationSeconds', 'reviewedFrames', 'confirmedTargetFrames', 'continuous', 'description'], [], 'source');
  if (!['still_frames', 'video_frames'].includes(value.source.kind) || value.source.continuous !== false) invalid('source');
  const source = {
    kind: value.source.kind,
    durationSeconds: number(value.source.durationSeconds, 0.001, 86400, 'source.durationSeconds'),
    reviewedFrames: number(value.source.reviewedFrames, 1, 10000, 'source.reviewedFrames', true),
    confirmedTargetFrames: number(value.source.confirmedTargetFrames, 0, value.source.reviewedFrames, 'source.confirmedTargetFrames', true),
    continuous: false,
    description: text(value.source.description, 3000, 'source.description'),
  };
  const observations = unique(array(value.observations, 1, 100, 'observations', (item, path) => {
    exact(item, ['id', 'time', 'fact', 'interpretation', 'uncertainty'], ['endTime'], path);
    const result = {
      id: id(item.id, `${path}.id`),
      time: number(item.time, 0, source.durationSeconds, `${path}.time`),
      fact: text(item.fact, 4000, `${path}.fact`),
      interpretation: text(item.interpretation, 4000, `${path}.interpretation`),
      uncertainty: text(item.uncertainty, 3000, `${path}.uncertainty`),
    };
    if (Object.hasOwn(item, 'endTime')) result.endTime = number(item.endTime, result.time, source.durationSeconds, `${path}.endTime`);
    return result;
  }), 'observations.id');
  const training = unique(array(value.training, 1, 12, 'training', (item, path) => {
    exact(item, ['id', 'title', 'reason', 'goal', 'minutes', 'frequency', 'equipment', 'steps', 'success'], [], path);
    const minutes = number(item.minutes, 1, 90, `${path}.minutes`, true);
    const steps = array(item.steps, 1, 12, `${path}.steps`, (step, stepPath) => {
      exact(step, ['label', 'minutes', 'instructions'], [], stepPath);
      return {
        label: text(step.label, 200, `${stepPath}.label`),
        minutes: number(step.minutes, 0.5, minutes, `${stepPath}.minutes`),
        instructions: array(step.instructions, 1, 10, `${stepPath}.instructions`, (line, linePath) => text(line, 1500, linePath)),
      };
    });
    if (Math.abs(steps.reduce((sum, step) => sum + step.minutes, 0) - minutes) > 0.001) invalid(`${path}.steps.minutes`);
    return {
      id: id(item.id, `${path}.id`), title: text(item.title, 200, `${path}.title`), reason: text(item.reason, 3000, `${path}.reason`),
      goal: text(item.goal, 1500, `${path}.goal`), minutes,
      frequency: text(item.frequency, 250, `${path}.frequency`),
      equipment: array(item.equipment, 0, 15, `${path}.equipment`, (line, linePath) => text(line, 200, linePath)),
      steps, success: text(item.success, 2000, `${path}.success`),
    };
  }), 'training.id');
  exact(value.provenance, ['kind', 'professionalReview'], [], 'provenance');
  if (value.provenance.kind !== 'chat_review' || value.provenance.professionalReview !== false) invalid('provenance');
  const result = {
    schema: FEEDBACK_SCHEMA, id: id(value.id, 'id'), title: text(value.title, 200, 'title'), target,
    reviewedAt: date(value.reviewedAt), source, summary: text(value.summary, 5000, 'summary'), observations,
    unobserved: array(value.unobserved, 1, 30, 'unobserved', (line, path) => text(line, 2000, path)), training,
    limitations: array(value.limitations, 1, 30, 'limitations', (line, path) => text(line, 2000, path)),
    provenance: { kind: 'chat_review', professionalReview: false },
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > FEEDBACK_MAX_BYTES) invalid('size');
  return result;
}

export function parseFeedbackReport(input) {
  if (typeof input !== 'string' || input.length > FEEDBACK_MAX_BYTES || !input.trim() || new TextEncoder().encode(input).byteLength > FEEDBACK_MAX_BYTES) {
    throw new Error('비어 있지 않은 1MiB 이하의 분석 결과 JSON 파일을 선택해 주세요.');
  }
  let value;
  try { value = JSON.parse(input); } catch { throw new Error('JSON을 읽지 못했어요. 채팅에서 받은 분석 결과 JSON 파일인지 확인해 주세요.'); }
  return validateFeedbackReport(value);
}

/** A fragment stays out of the HTTP request; callers remove it before displaying. */
export function parseFeedbackFragment(fragment) {
  if (typeof fragment !== 'string' || !fragment.startsWith('#report=')) throw new Error('피드백 링크 형식을 확인해 주세요.');
  const encoded = fragment.slice(8);
  if (!encoded || encoded.length > Math.ceil(FEEDBACK_LINK_MAX_BYTES * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) throw new Error('피드백 링크가 너무 크거나 형식이 맞지 않아요. JSON 파일로 가져와 주세요.');
  try {
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    if (binary.length > FEEDBACK_LINK_MAX_BYTES) throw new Error('size');
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return parseFeedbackReport(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new Error('링크의 피드백을 읽지 못했어요. 채팅에서 받은 JSON 파일로 가져와 주세요.'); }
}

export function formatEvidenceTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const whole = Math.floor(ms / 1000);
  const clock = `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
  return ms % 1000 ? `${clock}.${String(ms % 1000).padStart(3, '0')}` : clock;
}

function storageError(error) {
  if (error?.code === 'report_limit') return error;
  return new Error(error?.name === 'QuotaExceededError' ? '기기 저장 공간이 부족해요. 저장된 피드백이나 다른 파일을 정리한 뒤 다시 시도해 주세요.' : STORAGE_MESSAGE);
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error(STORAGE_MESSAGE)); return; }
    let request, blocked = false;
    try { request = indexedDB.open(DB_NAME, 1); } catch (error) { reject(storageError(error)); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () => { blocked = true; reject(new Error('다른 NEXT XI 탭을 닫고 다시 시도해 주세요.')); };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); if (blocked) db.close(); else resolve(db); };
  });
}
async function transaction(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      let tx, result, actionError;
      try {
        tx = db.transaction(STORE, mode);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(actionError || storageError(tx.error));
        tx.onabort = () => reject(actionError || storageError(tx.error));
        action(tx.objectStore(STORE), value => { result = value; }, error => { actionError = error; tx.abort(); });
      } catch (error) { if (tx) tx.abort(); reject(storageError(error)); }
    });
  } finally { db.close(); }
}

export async function listFeedbackReports() {
  const texts = await transaction('readonly', (store, done) => {
    const request = store.getAll(); request.onsuccess = () => done(request.result);
  });
  if (texts.length > FEEDBACK_MAX_REPORTS) throw new Error('저장된 피드백이 허용 개수보다 많아요. 브라우저의 사이트 데이터에서 이 페이지의 저장소를 확인해 주세요.');
  const reports = [];
  let invalidCount = 0;
  for (const input of texts) {
    try { reports.push(parseFeedbackReport(input)); } catch { invalidCount += 1; }
  }
  return { reports, invalidCount };
}

export async function saveFeedbackReport(value) {
  const report = validateFeedbackReport(value);
  await transaction('readwrite', (store, done, fail) => {
    const existing = store.getKey(report.id);
    existing.onsuccess = () => {
      const count = store.count();
      count.onsuccess = () => {
        if (existing.result === undefined && count.result >= FEEDBACK_MAX_REPORTS) {
          const error = new Error('피드백은 이 기기에 최대 50개까지 저장할 수 있어요. 하나를 지운 뒤 가져와 주세요.');
          error.code = 'report_limit'; fail(error); return;
        }
        // Only validated report JSON is persisted. No video, token, or account data.
        const request = store.put(JSON.stringify(report), report.id); request.onsuccess = () => done(report);
      };
    };
  });
  return report;
}

export async function removeFeedbackReport(reportId) {
  id(reportId, 'id');
  await transaction('readwrite', (store, done) => { const request = store.delete(reportId); request.onsuccess = () => done(); });
}
