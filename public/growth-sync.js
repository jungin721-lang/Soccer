const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Three-way merge: only fields edited against the displayed snapshot are sent.
// Arrays are atomic: conflicting edits require explicit user reconciliation.
export function mergeWorkspaceEdit(base, desired, latest) {
  function merge(before, after, current) {
    if (same(before, after)) return structuredClone(current);
    if (same(before, current) || same(after, current)) return structuredClone(after);
    if (object(before) && object(after) && object(current)) {
      const result = structuredClone(current);
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const value = merge(before[key], after[key], current[key]);
        if (value === undefined) delete result[key]; else result[key] = value;
      }
      return result;
    }
    throw Object.assign(new Error('같은 항목이 다른 기기에서 변경됐어요. 입력 내용은 유지했어요. 내용을 따로 보관한 뒤 창을 닫고 최신 기록을 확인해 다시 입력해 주세요.'), { code: 'edit_conflict' });
  }
  return merge(base, desired, latest);
}
