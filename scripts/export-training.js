import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=path.join(root,'.artifacts','training');
await rm(destination,{recursive:true,force:true});
await mkdir(destination,{recursive:true});
await cp(path.join(root,'public','training'),destination,{recursive:true});
await writeFile(path.join(destination,'_headers'),`/*
  Cache-Control: public, max-age=0, must-revalidate
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
`);
await writeFile(path.join(destination,'BUILD.json'),JSON.stringify({app:'next-step-training',version:'1.1.0-sync',storage:'IndexedDB locally; authenticated same-origin API when connected',automaticSync:'requires full repository server deployment',externalAPI:false},null,2));
console.log('Standalone training site exported to .artifacts/training (static hosting; local mode works without server; account sync requires repository functions; no AI API).');
