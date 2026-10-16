import { createHash, randomUUID } from 'node:crypto';

export const MAX_EVIDENCE_BYTES = 8 * 1024 ** 2;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const LEASE_MS = 120_000;
const stamp = () => new Date().toISOString();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const publicEvidence = value => ({ id: value.id, start: value.start, end: value.end, mime: value.mime, size: value.size });
function successful(job) {
  return job?.status === 'completed' && !job.cancelRequested && job.result?.identified === true
    && !['not_found', 'failed', 'blocked', 'cancelled'].includes(job.stage)
    && !['not_found', 'failed', 'blocked', 'cancelled'].includes(job.progress?.status)
    && Array.isArray(job.clips) && job.clips.length > 0 && job.clips.length <= 50000
    && (!Number.isInteger(job.progress?.selectedCount) || job.progress.selectedCount === job.clips.length)
    && (!Number.isInteger(job.progress?.completedCount) || job.progress.completedCount === job.clips.length);
}
function validateClip(clip, job) {
  if (!clip || !UUID.test(clip.id || '') || clip.jobId !== job.id || clip.videoId !== job.videoId
    || !Number.isFinite(clip.start) || clip.start < 0 || !Number.isFinite(clip.end) || clip.end <= clip.start
    || clip.end > 86400 || clip.end - clip.start > 12 || !clip.result || typeof clip.result.identified !== 'boolean') {
    throw fail('retention_invalid_clip', '저장한 분석 구간을 확인하지 못해 원본을 보관합니다.');
  }
}
function bytesFor(value) {
  if (!(value instanceof Uint8Array)) throw fail('retention_invalid_evidence', '근거 영상을 만들지 못해 원본을 보관합니다.');
  const bytes = Buffer.from(value);
  if (bytes.length < 16 || bytes.length > MAX_EVIDENCE_BYTES || bytes.toString('ascii', 4, 8) !== 'ftyp') throw fail('retention_invalid_evidence', '작은 MP4 근거 영상을 확인하지 못해 원본을 보관합니다.');
  return bytes;
}

/** Delete private evidence together with its owning video; never touch another owner. */
export async function removeVideoEvidence({ store, userId, videoId }) {
  if (!UUID.test(userId || '') || !UUID.test(videoId || '')) throw fail('retention_invalid_id', '근거 영상의 소유 정보를 확인하지 못했습니다.');
  for (const key of await store.list(`evidence-owners/${userId}/${videoId}/`)) {
    const id = key.slice(`evidence-owners/${userId}/${videoId}/`.length);
    if (UUID.test(id)) {
      const record = await store.get(`evidence/${id}`);
      if (!record || (record.userId === userId && record.videoId === videoId)) await store.delete(`evidence/${id}`);
    }
    await store.delete(key);
  }
  for (const key of await store.list(`evidence-media/${userId}/${videoId}/`)) await store.delete(key);
}

/**
 * Results and every playable evidence MP4 commit before original deletion starts.
 * Stable clip IDs and read-back hashes make interrupted preparation resumable.
 */
export async function finalizeOriginalRetention({ store, job: requested, createEvidence, signal }) {
  if (!store || !UUID.test(requested?.id || '') || !UUID.test(requested?.userId || '') || !UUID.test(requested?.videoId || '')) throw fail('retention_configuration', '원본 보관 정책을 실행하지 못했습니다.');
  const jobKey = `jobs/${requested.id}`;
  let job = await store.get(jobKey);
  if (!successful(job) || job.userId !== requested.userId || job.videoId !== requested.videoId) return job;
  if (job.retention?.status === 'completed') return job;
  const owner = randomUUID();
  const identity = { id: job.id, userId: job.userId, videoId: job.videoId };
  let claimed = false;
  let deletionStarted = false;
  const checkSignal = () => { if (signal?.aborted) throw fail('retention_interrupted', '근거 영상 보관을 다음 실행에서 이어갑니다.'); };
  const live = async () => {
    checkSignal();
    const [account, video, workspace, current] = await Promise.all([
      store.get(`users/${identity.userId}`), store.get(`videos/${identity.videoId}`),
      store.get(`workspaces/${identity.userId}`), store.get(jobKey),
    ]);
    if (!account || account.deleting || !video || video.deleting || video.status !== 'ready'
      || video.userId !== identity.userId || !workspace?.videos?.some(item => item.id === identity.videoId)
      || !successful(current) || current.userId !== identity.userId || current.videoId !== identity.videoId
      || (video.activeJobId && video.activeJobId !== identity.id)
      || (claimed && current.retention?.leaseOwner !== owner)) {
      throw fail('retention_owner_gone', '삭제되거나 변경된 영상은 다시 저장하지 않습니다.');
    }
    return { account, video, workspace, job: current };
  };
  const updateJob = async updater => {
    checkSignal();
    job = await store.update(jobKey, current => {
      if (!current || current.userId !== identity.userId || current.videoId !== identity.videoId || !successful(current)
        || current.retention?.leaseOwner !== owner) throw fail('retention_lease_lost', '다른 실행에서 원본 정리를 이어갑니다.');
      return updater({ ...current, retention: { ...current.retention, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), updatedAt: stamp() } });
    });
    return job;
  };
  const verified = async (clip, record) => {
    if (!record || record.id !== clip.id || record.analysisId !== clip.id || record.userId !== identity.userId
      || record.videoId !== identity.videoId || record.jobId !== identity.id || record.start !== clip.start || record.end !== clip.end
      || record.mime !== 'video/mp4' || record.key !== `evidence-media/${identity.userId}/${identity.videoId}/${clip.id}`
      || !Number.isInteger(record.size) || record.size < 16 || record.size > MAX_EVIDENCE_BYTES || !/^[a-f\d]{64}$/.test(record.sha256 || '')) return false;
    const bytes = await store.getBinary(record.key);
    return bytes instanceof Uint8Array && bytes.length === record.size && hash(bytes) === record.sha256 && Buffer.from(bytes).toString('ascii', 4, 8) === 'ftyp';
  };
  try {
    await live();
    job = await store.update(jobKey, current => {
      if (!successful(current) || current.userId !== identity.userId || current.videoId !== identity.videoId) throw fail('retention_owner_gone', '분석 상태가 바뀌어 원본을 보관합니다.');
      if (current.retention?.status === 'completed') return current;
      if (current.retention?.leaseOwner && Date.parse(current.retention.leaseUntil) > Date.now()) throw fail('retention_busy', '다른 실행에서 근거 영상을 보관하고 있습니다.');
      return { ...current, retention: { ...(current.retention || {}), status: 'preparing', leaseOwner: owner, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), updatedAt: stamp(), errorCode: null } };
    });
    if (job.retention?.status === 'completed') return job;
    claimed = true;
    if (new Set(job.clips.map(clip => clip.id)).size !== job.clips.length) throw fail('retention_invalid_clip', '중복된 근거 구간을 확인해 원본을 보관합니다.');
    const evidence = [];
    for (const clip of job.clips) {
      validateClip(clip, job);
      const current = await live();
      const duration = current.video.duration ?? current.job.progress?.duration;
      if (Number.isFinite(duration) && clip.end > duration) throw fail('retention_invalid_clip', '원본 길이 밖의 근거 구간이 있어 원본을 보관합니다.');
      const analysis = current.workspace.analyses?.find(item => item.id === clip.id && item.jobId === identity.id && item.videoId === identity.videoId);
      if (!analysis || analysis.start !== clip.start || analysis.end !== clip.end || JSON.stringify(analysis.result) !== JSON.stringify(clip.result)) throw fail('retention_result_missing', '분석 결과의 저장을 확인하지 못해 원본을 보관합니다.');
      let record = await store.get(`evidence/${clip.id}`);
      if (!await verified(clip, record)) {
        if (current.video.sourceStatus === 'deleting_after_analysis' || current.video.sourceStatus === 'deleted_after_analysis') throw fail('retention_evidence_missing', '보관한 근거 영상을 확인하지 못해 정리를 멈췄습니다.');
        if (record && (record.userId !== identity.userId || record.videoId !== identity.videoId || record.jobId !== identity.id)) throw fail('retention_evidence_conflict', '다른 기록의 근거 영상을 덮어쓰지 않았습니다.');
        if (typeof createEvidence !== 'function') throw fail('retention_encoder_missing', '근거 영상 처리기가 없어 원본을 보관합니다.');
        const bytes = bytesFor(await createEvidence({ clip: structuredClone(clip), video: current.video, job: current.job, signal }));
        await live();
        record = { id: clip.id, analysisId: clip.id, userId: identity.userId, videoId: identity.videoId, jobId: identity.id, start: clip.start, end: clip.end, mime: 'video/mp4', size: bytes.length, sha256: hash(bytes), key: `evidence-media/${identity.userId}/${identity.videoId}/${clip.id}`, createdAt: stamp() };
        await store.set(`evidence-owners/${identity.userId}/${identity.videoId}/${clip.id}`, { id: clip.id });
        await store.putBinary(record.key, bytes);
        await live();
        await store.set(`evidence/${clip.id}`, record);
        await live();
        if (!await verified(clip, await store.get(`evidence/${clip.id}`))) throw fail('retention_verify_failed', '근거 영상을 다시 읽지 못해 원본을 보관합니다.');
      }
      evidence.push(publicEvidence(record));
      await updateJob(currentJob => ({ ...currentJob, retention: { ...currentJob.retention, evidenceCount: evidence.length } }));
    }
    const byId = new Map(evidence.map(item => [item.id, item]));
    await live();
    await store.update(`workspaces/${identity.userId}`, workspace => {
      if (!workspace?.videos?.some(item => item.id === identity.videoId) || job.clips.some(clip => !workspace.analyses?.some(item => item.id === clip.id && item.jobId === identity.id && item.videoId === identity.videoId))) throw fail('retention_owner_gone', '삭제된 결과를 다시 추가하지 않습니다.');
      return { ...workspace, revision: (workspace.revision || 0) + 1, analyses: workspace.analyses.map(item => byId.has(item.id) && item.jobId === identity.id && item.videoId === identity.videoId ? { ...item, evidence: byId.get(item.id) } : item) };
    });
    await updateJob(current => ({ ...current, clips: current.clips.map(clip => ({ ...clip, evidence: byId.get(clip.id) })), retention: { ...current.retention, status: 'deleting', evidenceCount: evidence.length, totalBytes: evidence.reduce((sum, item) => sum + item.size, 0) } }));
    const committed = await live();
    if (committed.workspace.analyses.filter(item => byId.has(item.id) && item.jobId === identity.id).some(item => JSON.stringify(item.evidence) !== JSON.stringify(byId.get(item.id)))) throw fail('retention_result_missing', '근거 영상 연결을 확인하지 못해 원본을 보관합니다.');
    // Re-read every evidence payload immediately before the irreversible phase.
    for (const clip of job.clips) if (!await verified(clip, await store.get(`evidence/${clip.id}`))) throw fail('retention_verify_failed', '근거 영상 확인이 끝나지 않아 원본을 보관합니다.');
    await live();
    await store.update(`videos/${identity.videoId}`, video => {
      if (!video || video.userId !== identity.userId || video.deleting || video.status !== 'ready' || (video.activeJobId && video.activeJobId !== identity.id)) throw fail('retention_owner_gone', '삭제된 원본을 다시 추가하지 않습니다.');
      return { ...video, sourceStatus: 'deleting_after_analysis', sourceRetentionJobId: identity.id };
    });
    await live();
    await store.update(`workspaces/${identity.userId}`, workspace => {
      if (!workspace?.videos?.some(item => item.id === identity.videoId)) throw fail('retention_owner_gone', '삭제된 원본을 다시 추가하지 않습니다.');
      return { ...workspace, revision: (workspace.revision || 0) + 1, videos: workspace.videos.map(video => video.id === identity.videoId ? { ...video, sourceStatus: 'deleting_after_analysis' } : video) };
    });
    deletionStarted = true;
    const prefix = `media/${identity.userId}/${identity.videoId}/`;
    for (const key of await store.list(prefix)) { await live(); await updateJob(current => current); await store.delete(key); }
    if ((await store.list(prefix)).length) throw fail('retention_delete_incomplete', '원본 조각 정리를 다음 실행에서 이어갑니다.');
    const deletedAt = (await live()).video.sourceDeletedAt || stamp();
    await live();
    await store.update(`videos/${identity.videoId}`, video => {
      if (!video || video.userId !== identity.userId || video.deleting || video.sourceRetentionJobId !== identity.id) throw fail('retention_owner_gone', '삭제된 영상 정보를 다시 추가하지 않습니다.');
      return { ...video, sourceStatus: 'deleted_after_analysis', sourceDeletedAt: video.sourceDeletedAt || deletedAt, evidenceBytes: job.retention.totalBytes, chunks: [] };
    });
    await live();
    await store.update(`workspaces/${identity.userId}`, workspace => {
      if (!workspace?.videos?.some(item => item.id === identity.videoId)) throw fail('retention_owner_gone', '삭제된 성장 기록을 다시 추가하지 않습니다.');
      return { ...workspace, revision: (workspace.revision || 0) + 1, videos: workspace.videos.map(video => video.id === identity.videoId ? { ...video, sourceStatus: 'deleted_after_analysis', sourceDeletedAt: video.sourceDeletedAt || deletedAt, evidenceBytes: job.retention.totalBytes } : video) };
    });
    await live();
    // Keep the evidence charge; release original bytes only after all chunks vanished.
    await store.update(`quotas/storage/${identity.userId}`, quota => {
      if (!quota) throw fail('retention_owner_gone', '삭제된 계정의 보관 한도를 다시 만들지 않습니다.');
      return { ...quota, entries: quota.entries.map(entry => entry.videoId === identity.videoId ? { ...entry, size: job.retention.totalBytes, status: 'evidence_only' } : entry) };
    });
    return await updateJob(current => ({ ...current, retention: { ...current.retention, status: 'completed', sourceDeletedAt: deletedAt, leaseOwner: null, leaseUntil: null, errorCode: null } }));
  } catch (error) {
    if (claimed) {
      try {
        await store.update(jobKey, current => {
          if (!current || current.retention?.leaseOwner !== owner) throw fail('retention_owner_gone', '삭제된 분석 작업을 다시 추가하지 않습니다.');
          return { ...current, retention: { ...current.retention, status: 'pending', phase: deletionStarted ? 'deleting' : 'preparing', leaseOwner: null, leaseUntil: null, errorCode: error.code || 'retention_failed', updatedAt: stamp() } };
        });
      } catch { /* A deleted account or job must stay deleted. */ }
      const [account, video] = await Promise.all([store.get(`users/${identity.userId}`), store.get(`videos/${identity.videoId}`)]);
      if (!account || account.deleting || !video || video.deleting) await removeVideoEvidence({ store, userId: identity.userId, videoId: identity.videoId });
    }
    throw error;
  }
}
