import {cp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'.artifacts','review');
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
await cp(path.join(root,'public'),out,{recursive:true});
// Root entry points to the new app; the previous app remains unchanged in source.
await writeFile(path.join(out,'index.html'),'<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=/match-review/index.html"><title>PLAY NOTE</title></head><body><a href="/match-review/index.html">PLAY NOTE 영상 분석 앱 열기</a></body></html>');
console.log('New PLAY NOTE site exported to .artifacts/review. Deploy with netlify/functions, never static-only.');
