import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createLocalStore } from './lib/growth/store.js';
import { createGrowthAPI } from './lib/growth/api.js';
import { runGrowthJob, recoverGrowthJobs } from './lib/growth/worker.js';
import { analysisAvailability } from './lib/growth/runtime.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.NEXT_XI_DATA_DIR || path.join(root, '.data');
await mkdir(dataDir, { recursive: true });
const store = await createLocalStore(dataDir);
const pending = [], active = new Set();
let origin;
const dispatchJob = async (jobId, token) => { pending.push({ jobId, token }); setImmediate(drain); };
async function drain() {
  if (!origin || active.size >= 2 || !pending.length) return;
  const job = pending.shift();
  if (active.has(job.jobId)) return setImmediate(drain);
  active.add(job.jobId);
  try {
    const record = await store.get(`jobs/${job.jobId}`);
    if (record) await runGrowthJob({ store, ...job, mediaURL: `${origin}/api/v2/media/${record.videoId}?jobId=${job.jobId}`, dispatchContinuation: dispatchJob });
  } catch { console.error('Growth worker stopped: execution_error'); }
  finally { active.delete(job.jobId); setImmediate(drain); }
}
const api = createGrowthAPI({ store, dispatchJob, availability: analysisAvailability });
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const json = (res,status,value) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const server = http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  try {
    const url=new URL(req.url,origin||'http://localhost');
    if(url.pathname.startsWith('/api/v2/')) {
      const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
      const response=await api(request);res.writeHead(response.status,Object.fromEntries(response.headers));
      if(req.method==='HEAD'||!response.body)return res.end();
      const stream=Readable.fromWeb(response.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
    }
    if(url.pathname.startsWith('/api/'))return json(res,404,{error:'찾을 수 없는 경로입니다.'});
    if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'지원하지 않는 요청입니다.'});
    const requested=decodeURIComponent(url.pathname);
    const file=path.resolve(root,'public','.'+(requested==='/'?'/index.html':requested));
    if(!file.startsWith(path.join(root,'public')+path.sep))return json(res,403,{error:'접근할 수 없습니다.'});
    try{const content=await readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);}catch{json(res,404,{error:'페이지를 찾을 수 없습니다.'});}
  } catch {if(!res.headersSent)json(res,500,{error:'서버에 연결하지 못했습니다. 다시 시도해 주세요.'});else res.destroy();}
});
const port=Number(process.env.PORT||3000);
server.listen(port,'0.0.0.0',()=>{origin=`http://127.0.0.1:${server.address().port}`;console.log(`NEXT XI is running on port ${server.address().port}`);recoverGrowthJobs({store,dispatchJob}).catch(()=>{});});
const recovery=setInterval(()=>recoverGrowthJobs({store,dispatchJob}).catch(()=>{}),60_000);recovery.unref();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{clearInterval(recovery);server.close(()=>{store.close();process.exit(0);});setTimeout(()=>process.exit(0),3000).unref();});
