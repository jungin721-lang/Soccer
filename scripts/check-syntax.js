import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function files(dir) { const entries=await readdir(dir,{withFileTypes:true});return (await Promise.all(entries.filter(e=>e.name!=='__pycache__').map(e=>e.isDirectory()?files(`${dir}/${e.name}`):/\.(?:m?js)$/.test(e.name)?[`${dir}/${e.name}`]:[]))).flat(); }
for(const name of ['server.js',...(await files('public')),...(await files('lib')),...(await files('netlify')),...(await files('scripts'))]) {
  const result=spawnSync(process.execPath,['--check',name],{stdio:'inherit'});if(result.status)process.exit(result.status);
}
console.log('All JavaScript syntax checks passed.');
