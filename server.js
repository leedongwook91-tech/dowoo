const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const masterSalt = 'class-showcase-master-v1';
const masterHash = Buffer.from('98acef02607d6a431e3d325e494a139262bf952664759e2e151180304439644b', 'hex');
const attempts = new Map();
async function passwordHash(password, salt) { return (await derive(password, salt, 32)).toString('hex'); }
async function matches(password, salt, hash) {
  if (typeof salt !== 'string' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return false;
  return timingSafeEqual(await derive(password, salt, 32), Buffer.from(hash, 'hex'));
}
function publicProject(item) { const { deleteAuth, ...visible } = item; return visible; }
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
    if (req.method === 'GET' && url.pathname === '/api/projects') return json(200, (await projects()).map(publicProject));
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 15 * 1024 * 1024) return json(413, { error: '기획서는 10MB 이하로 올려주세요.' }); chunks.push(chunk); }
      let p; try { p = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(400, { error: '요청 형식이 올바르지 않습니다.' }); }
      if (!p || typeof p !== 'object') return json(400, { error: '작품 정보를 입력해주세요.' });
      for (const [key, max] of [['title', 80], ['author', 80], ['description', 1000]]) {
        if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > max) return json(400, { error: '작품명, 제작자, 소개를 길이에 맞게 입력해주세요.' });
      }
      if (!['생활·편의', '학습·교육', '문화·취미', '사회·환경'].includes(p.category)) return json(400, { error: '분야를 선택해주세요.' });
      if (typeof p.password !== 'string' || !/^\d{4}$/.test(p.password)) return json(400, { error: '삭제 암호는 숫자 4자리로 입력해주세요.' });
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
      const salt = randomBytes(16).toString('hex');
      item.deleteAuth = { salt, hash: await passwordHash(p.password, salt) };
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
      return json(201, publicProject(item));
    }
    if (req.method === 'DELETE' && /^\/api\/projects\/[a-f0-9-]{36}$/.test(url.pathname)) {
      const id = url.pathname.split('/').pop();
      const item = (await projects()).find(p => p.id === id);
      if (!item) return json(404, { error: '이미 삭제되었거나 존재하지 않는 작품입니다.' });
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024) return json(413, { error: '요청이 너무 큽니다.' }); chunks.push(chunk); }
      let password; try { password = JSON.parse(Buffer.concat(chunks).toString())?.password; } catch { return json(400, { error: '암호를 입력해주세요.' }); }
      if (typeof password !== 'string' || !/^\d{4}$/.test(password)) return json(400, { error: '숫자 4자리 암호를 입력해주세요.' });
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      const failures = attempts.get(id);
      if (failures?.count >= 5) {
        res.setHeader('Retry-After', Math.ceil((failures.until - now) / 1000));
        return json(429, { error: '암호를 5회 잘못 입력했습니다. 15분 후 다시 시도해주세요.' });
      }
      const master = timingSafeEqual(await derive(password, masterSalt, 32), masterHash);
      const owner = item.deleteAuth && await matches(password, item.deleteAuth.salt, item.deleteAuth.hash);
      if (!master && !owner) {
        attempts.set(id, { count: (failures?.count || 0) + 1, until: failures?.until || now + 15 * 60 * 1000 });
        return json(403, { error: '암호가 일치하지 않습니다. 이전에 등록한 작품은 관리자 암호로 삭제할 수 있습니다.' });
      }
      if (cloud) await remote(`/rest/v1/showcase_projects?id=eq.${id}`, { method: 'DELETE' });
      else {
        const operation = queue.then(async () => {
          const list = (await projects()).filter(p => p.id !== id);
          await fs.writeFile(path.join(data, 'projects.tmp'), JSON.stringify(list));
          await fs.rename(path.join(data, 'projects.tmp'), path.join(data, 'projects.json'));
        });
        queue = operation.catch(() => {}); await operation;
      }
      attempts.delete(id);
      if (item.plan) {
        try {
          if (cloud) await remote(`/storage/v1/object/${bucket}/${id}.pdf`, { method: 'DELETE' });
          else await fs.unlink(path.join(data, 'uploads', `${id}.pdf`));
        } catch { console.error('삭제된 작품의 PDF 정리가 필요합니다:', id); }
      }
      return json(200, { deleted: true });
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
