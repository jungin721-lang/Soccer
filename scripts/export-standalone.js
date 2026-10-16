import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = name => readFile(path.join(root, 'public', name), 'utf8');
const [html, css, domainSource, planSource, mediaSource, analysisSource, appSource] = await Promise.all(['index.html', 'styles.css', 'domain.js', 'plans.js', 'media-store.js', 'analysis-client.js', 'app.js'].map(source));
const inlineModule = code => code.replace(/^import .*?;\n/gm, '').replace(/^export /gm, '');
const localAPI = `
const STANDALONE_KEY = 'next-xi-standalone-v1';
function localResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {status: options.status || 200, headers: {'Content-Type': 'application/json'}});
}
async function localRequest(url, options = {}) {
  try {
    const raw = localStorage.getItem(STANDALONE_KEY);
    let current = raw ? JSON.parse(raw) : seedState();
    if (raw) validateState(current);
    if (options.method === 'PUT') {
      const incoming = JSON.parse(options.body);
      if (incoming.revision !== current.revision) return localResponse({error:'다른 창에서 변경되었습니다. 새로고침 후 다시 시도해 주세요.'},{status:409});
      current = {revision: current.revision + 1, ...validateState(incoming)};
      localStorage.setItem(STANDALONE_KEY, JSON.stringify(current));
    }
    return localResponse(current);
  } catch (e) { return localResponse({error:'브라우저에 저장하지 못했습니다. 저장 공간과 브라우저 설정을 확인해 주세요.'},{status:500}); }
}
`;
let app = inlineModule(appSource).replaceAll("fetch('/api/workspace'", "localRequest('/api/workspace'");
app = app.replace('이 버전은 서버의 한 워크스페이스에 저장됩니다. 로그인·다중 사용자 분리는 아직 연결되지 않았어요.<br>공개 서비스로 배포하기 전에 계정과 접근 권한을 연결해야 합니다.', '이 실행 파일은 현재 브라우저에 기록을 저장합니다. 브라우저 데이터를 삭제하면 기록도 삭제될 수 있어요.<br>중요한 기록은 내보내기로 보관해 주세요. 다른 기기와 자동 동기화되지 않습니다.');
app = app.replace('개인 개발 워크스페이스', '브라우저에 저장되는 개인 공간');
app = app.replace('성장 공간에 연결하지 못했어요.', '브라우저 저장 공간을 열지 못했어요.');
app = app.replace('서버 연결을 확인한 뒤 다시 시도해 주세요.', '파일을 일반 브라우저에서 열고 저장소 사용을 허용한 뒤 다시 시도해 주세요.');
let output = html.replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`).replace('<script type="module" src="/app.js"></script>', '');
let javascript = inlineModule(domainSource) + '\n' + inlineModule(planSource) + '\n' + inlineModule(mediaSource) + '\n' + inlineModule(analysisSource) + '\n' + localAPI + '\n' + app;
for (const name of ['favicon.svg','jersey-11.svg','hero-pitch.svg']) {
  const svg = await source('assets/' + name);
  const data = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  output = output.replaceAll('/assets/' + name, data);
  javascript = javascript.replaceAll('/assets/' + name, data);
}
output = output.replace('</body>', `<script type="module">${javascript.replaceAll('</script', '<\\/script')}</script></body>`);
await mkdir(path.join(root, '.artifacts'), {recursive:true});
const destination = path.join(root, '.artifacts', 'NEXT-XI.html');
await writeFile(destination, output);
await mkdir(path.join(root, '.artifacts', 'site'), {recursive:true});
await writeFile(path.join(root, '.artifacts', 'site', 'index.html'), output);
await writeFile(path.join(root, '.artifacts', 'site', '.nojekyll'), '');
console.log('Standalone app created:', destination);
console.log('Static hosting bundle created: .artifacts/site');
