import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=path.join(root,'.artifacts','site');
await rm(destination,{recursive:true,force:true});await mkdir(destination,{recursive:true});
await cp(path.join(root,'public'),destination,{recursive:true});
await writeFile(path.join(destination,'.nojekyll'),'');
// The v2 export is a frontend for the accompanying authenticated functions.
// It deliberately has no localStorage substitute masquerading as a server.
await writeFile(path.join(root,'.artifacts','NEXT-XI.html'),await readFile(path.join(root,'public','index.html')));
console.log('NEXT XI v2 frontend exported to .artifacts/site. Deploy the repository with its Netlify functions, not this folder alone.');
