import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWorkspaceEdit } from '../public/growth-sync.js';

test('a stale settings form preserves fields edited by another device', () => {
  const base={revision:1,profile:{name:'old',number:11},practices:[]};
  const desired=structuredClone(base);desired.profile.name='new';
  const latest=structuredClone(base);latest.revision=2;latest.profile.number=17;latest.practices=[{id:'remote'}];
  assert.deepEqual(mergeWorkspaceEdit(base,desired,latest),{revision:2,profile:{name:'new',number:17},practices:[{id:'remote'}]});
  assert.equal(base.profile.name,'old');
});
test('same-field and same-collection concurrent edits do not overwrite server records', () => {
  assert.throws(()=>mergeWorkspaceEdit({name:'a'},{name:'b'},{name:'c'}),{code:'edit_conflict'});
  assert.throws(()=>mergeWorkspaceEdit({practices:[]},{practices:[{id:'local'}]},{practices:[{id:'remote'}]}),{code:'edit_conflict'});
});
test('identical concurrent edits converge and latest media remains server owned', () => {
  const base={profile:{name:'a'},videos:[]};
  const desired={profile:{name:'b'},videos:[]};
  const latest={profile:{name:'b'},videos:[{id:'private'}]};
  assert.deepEqual(mergeWorkspaceEdit(base,desired,latest),latest);
});
