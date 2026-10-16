const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = __dirname;
const data = process.env.DATA_DIR || path.join(root, 'data');
const cloudURL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const cloudKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (Boolean(cloudURL) !== Boolean(cloudKey)) throw Error('SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY를 모두 설정해주세요.');
const cloud = Boolean(cloudURL && cloudKey);
const bucket = 'project-plans';
async function remote(route, options = {}) {
  const response = await fetch(cloudURL + route, {
    ...options, headers: { apikey: cloudKey, Authorization: `Bearer ${cloudKey}`, ...options.headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error(`저장 서비스 응답 오류 (${response.status})`);
  return response;
}
async function projects() {
  if (cloud) {
    const response = await remote('/rest/v1/showcase_projects?select=body&order=created_at.desc');
    return (await response.json()).map(row => row.body);
  }
  try { return JSON.parse(await fs.readFile(path.join(data, 'projects.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
let queue = Promise.resolve();
async function save(item) {
  if (cloud) {
    await remote('/rest/v1/showcase_projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, body: item, created_at: item.createdAt }) });
    return;
  }
  const operation = queue.then(async () => {
    const list = await projects(); list.unshift(item);
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, 'projects.tmp'), JSON.stringify(list));
    await fs.rename(path.join(data, 'projects.tmp'), path.join(data, 'projects.json'));
  });
  queue = operation.catch(() => {});
  await operation;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') return json(200, { persistent: cloud });
    if (req.method === 'GET' && url.pathname === '/api/projects') return json(200, await projects());
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 15 * 1024 * 1024) return json(413, { error: '기획서는 10MB 이하로 올려주세요.' }); chunks.push(chunk); }
      let p; try { p = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(400, { error: '요청 형식이 올바르지 않습니다.' }); }
      if (!p || typeof p !== 'object') return json(400, { error: '작품 정보를 입력해주세요.' });
      for (const [key, max] of [['title', 80], ['author', 80], ['description', 1000]]) {
        if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > max) return json(400, { error: '작품명, 제작자, 소개를 길이에 맞게 입력해주세요.' });
      }
      if (!['생활·편의', '학습·교육', '문화·취미', '사회·환경'].includes(p.category)) return json(400, { error: '분야를 선택해주세요.' });
      let appURL;
      try {
        if (typeof p.url !== 'string' || p.url.length > 2048) throw Error();
        appURL = new URL(p.url);
        if (!['http:', 'https:'].includes(appURL.protocol) || appURL.username || appURL.password) throw Error();
      } catch { return json(400, { error: '공개된 웹 앱 주소를 https://부터 입력해주세요.' }); }
      const id = randomUUID(); let plan = null; let bytes;
      if (p.plan) {
        if (typeof p.plan.name !== 'string' || !/\.pdf$/i.test(p.plan.name) || typeof p.plan.content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.plan.content)) return json(400, { error: '기획서는 PDF 파일로 올려주세요.' });
        bytes = Buffer.from(p.plan.content, 'base64');
        if (bytes.length > 10 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-') return json(400, { error: '10MB 이하의 올바른 PDF를 올려주세요.' });
        plan = { name: path.basename(p.plan.name).slice(0, 160), href: `/plans/${id}.pdf` };
        if (cloud) await remote(`/storage/v1/object/${bucket}/${id}.pdf`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes });
        else { await fs.mkdir(path.join(data, 'uploads'), { recursive: true }); await fs.writeFile(path.join(data, 'uploads', `${id}.pdf`), bytes); }
      }
      const item = { id, title: p.title.trim(), author: p.author.trim(), description: p.description.trim(), category: p.category, url: appURL.href, createdAt: new Date().toISOString(), plan };
      try { await save(item); }
      catch (error) {
        if (plan) {
          try {
            if (cloud) await remote(`/storage/v1/object/${bucket}/${id}.pdf`, { method: 'DELETE' });
            else await fs.unlink(path.join(data, 'uploads', `${id}.pdf`));
          } catch { console.error('기획서 정리 실패'); }
        }
        throw error;
      }
      return json(201, item);
    }
    if (req.method === 'GET' && /^\/plans\/[a-f0-9-]{36}\.pdf$/.test(url.pathname)) {
      const item = (await projects()).find(p => p.plan?.href === url.pathname);
      if (!item) return json(404, { error: '기획서를 찾을 수 없습니다.' });
      const name = `${item.id}.pdf`;
      const bytes = cloud ? Buffer.from(await (await remote(`/storage/v1/object/authenticated/${bucket}/${name}`)).arrayBuffer()) : await fs.readFile(path.join(data, 'uploads', name));
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(item.plan.name), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox" });
      return res.end(bytes);
    }
    if (req.method === 'GET' && ['/', '/style.css', '/app.js'].includes(url.pathname)) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const bytes = await fs.readFile(path.join(root, 'public', name));
      res.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' }); return res.end(bytes);
    }
    json(404, { error: '페이지를 찾을 수 없습니다.' });
  } catch (e) { console.error(e.message); json(500, { error: '저장 서비스를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.' }); }
});
server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log(`Showcase running on ${process.env.PORT || 3000} (${cloud ? 'Supabase' : 'temporary local storage'})`));
