import { buildStoredZip, validateChatPackTarget } from './chat-pack.js';
import { CLIP_LIMITS, formatClipTime } from './video-clips.js';
import { KIT_LABELS } from './growth-domain.js';

export const MAX_CLIP_BUNDLE_BYTES = 25 * 1024 ** 2;

// Package only the newly encoded clip, never the original File selected by the
// user. The original name is not used in an output name or sharing instructions.
export async function createVideoClipBundle(result, { signal } = {}) {
  if (signal?.aborted) throw new DOMException('자료 만들기를 취소했습니다.', 'AbortError');
  const file = result?.file, manifest = result?.manifest;
  if (!(file instanceof File) || !file.size || file.size > CLIP_LIMITS.maxClipBytes ||
      !/^clip-\d+-\d{2,}-\d{2}-\d{2}-\d{3}\.(mp4|webm)$/.test(file.name) ||
      !manifest || manifest.kind !== 'continuous-video-clip' || manifest.version !== 1 ||
      manifest.output?.filename !== file.name || manifest.output?.bytes !== file.size ||
      manifest.analysis?.performed !== false || manifest.analysis?.playerIdentified !== false ||
      !Number.isInteger(manifest.clip?.index) || manifest.clip.index < 1) {
    throw new Error('만들어진 영상과 시간 기록을 확인하지 못했습니다. 해당 구간을 다시 만들어 주세요.');
  }
  const mime = String(file.type).split(';')[0].toLowerCase();
  if (!['video/mp4', 'video/webm'].includes(mime) || !file.name.endsWith(mime === 'video/mp4' ? '.mp4' : '.webm')) {
    throw new Error('영상 형식과 확장자가 맞지 않습니다. 해당 구간을 다시 만들어 주세요.');
  }
  const target = validateChatPackTarget(manifest.target);
  const actual = manifest.source?.actual;
  if (!actual || !Number.isFinite(actual.start) || !Number.isFinite(actual.end) || actual.start < 0 || actual.end <= actual.start || actual.end > 86400) {
    throw new Error('원본 시간 범위를 확인하지 못했습니다. 해당 구간을 다시 만들어 주세요.');
  }
  const record = JSON.stringify(manifest, null, 2);
  if (new TextEncoder().encode(record).byteLength > 128 * 1024) throw new Error('시간 기록이 너무 큽니다. 해당 구간을 다시 만들어 주세요.');
  const readme = `NEXT XI · 연속 경기 영상\n\n` +
    `구간: ${manifest.clip.index}번\n원본 범위: ${formatClipTime(actual.start)} ~ ${formatClipTime(actual.end)}\n` +
    `대상: ${KIT_LABELS[target.kit]} 유니폼 ${target.number}번, ${target.age}세\n\n` +
    `이 ZIP에는 원본의 일부 연속 구간을 기기에서 다시 기록한 소리 없는 영상과 manifest.json이 있습니다. ` +
    `선수 식별·추적이나 AI 분석 결과가 아닙니다. 시각 대응은 manifest.json의 source.timeMap을 함께 확인하세요.\n\n` +
    `유니폼 색과 등번호가 확인되는 장면만 근거로 잘한 행동과 다음 훈련을 제안해 주세요. ` +
    `실제 관찰과 해석을 구분하고 식별이 어렵거나 동작 사이를 확인하지 못했다면 관찰 부족으로 표시해 주세요. ` +
    `전체 경기 능력치·전국 순위·성격·건강 상태는 추정하지 마세요.\n\n` +
    `영상에 다른 아이들의 모습이 포함될 수 있습니다. 공유할 권한이 있는 자료만 직접 첨부하세요. ` +
    `분석 후에는 next-xi-feedback/v1 형식의 피드백 JSON도 만들어 주세요. 앱의 피드백 화면에서 비공개로 가져올 수 있습니다.\n`;
  const zip = await buildStoredZip([
    { name: file.name, data: file },
    { name: 'manifest.json', data: record },
    { name: 'README.txt', data: readme },
  ], { signal, maxBytes: MAX_CLIP_BUNDLE_BYTES });
  return new File([zip], `NEXT-XI-clip-${String(manifest.clip.index).padStart(2, '0')}.zip`, { type: 'application/zip' });
}
