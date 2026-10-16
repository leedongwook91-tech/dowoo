const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const root = __dirname, data = path.join(root,'data');
async function projects(){try{return JSON.parse(await fs.readFile(path.join(data,'projects.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return [];throw e}}
let queue=Promise.resolve();
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const json=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj))};
 try{
 if(req.method==='GET'&&url.pathname==='/api/projects')return json(200,await projects());
 if(req.method==='POST'&&url.pathname==='/api/projects'){
  let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>36*1024*1024)return json(413,{error:'파일은 각각 10MB 이하로 올려주세요.'});chunks.push(chunk)}
  let p;try{p=JSON.parse(Buffer.concat(chunks).toString())}catch{return json(400,{error:'요청 형식이 올바르지 않습니다.'})}
  if(!p.title?.trim()||!p.author?.trim()||!p.description?.trim())return json(400,{error:'작품명, 제작자, 소개를 입력해주세요.'});
  if(p.title.length>80||p.author.length>80||p.description.length>1000)return json(400,{error:'입력 가능한 글자 수를 초과했습니다.'});
  if(!['생활·편의','학습·교육','문화·취미','사회·환경'].includes(p.category))return json(400,{error:'분야를 선택해주세요.'});
  if(p.url){try{if(!['http:','https:'].includes(new URL(p.url).protocol))throw Error()}catch{return json(400,{error:'올바른 웹 주소를 입력해주세요.'})}}
  if(!p.plan||!p.app)return json(400,{error:'기획서와 앱 파일을 모두 첨부해주세요.'});
  const id=randomUUID(), files={};
  for(const [key,allowed] of [['plan',['.pdf','.ppt','.pptx','.doc','.docx']],['app',['.zip','.html']]]){
   const file=p[key];if(typeof file.name!=='string'||typeof file.content!=='string'||!allowed.includes(path.extname(file.name).toLowerCase()))return json(400,{error:'지원하지 않는 파일 형식입니다.'});
   const bytes=Buffer.from(file.content,'base64');if(!bytes.length||bytes.length>10*1024*1024)return json(400,{error:'파일은 0바이트 초과, 10MB 이하여야 합니다.'});
   files[key]={name:path.basename(file.name).slice(0,160),disk:id+'-'+key,bytes};
  }
  await fs.mkdir(path.join(data,'uploads'),{recursive:true});
  for(const f of Object.values(files))await fs.writeFile(path.join(data,'uploads',f.disk),f.bytes);
  const item={id,title:p.title.trim(),author:p.author.trim(),description:p.description.trim(),category:p.category,url:p.url||'',createdAt:new Date().toISOString(),plan:{name:files.plan.name,href:'/files/'+files.plan.disk},app:{name:files.app.name,href:'/files/'+files.app.disk}};
  const save=queue.then(async()=>{const list=await projects();list.unshift(item);const temp=path.join(data,'projects.tmp');await fs.writeFile(temp,JSON.stringify(list));await fs.rename(temp,path.join(data,'projects.json'))});queue=save.catch(()=>{});await save;return json(201,item);
 }
 if(req.method==='GET'&&/^\/files\/[a-f0-9-]+-(plan|app)$/.test(url.pathname)){
  const name=url.pathname.slice(7);const list=await projects();const file=list.flatMap(p=>[p.plan,p.app]).find(f=>f.href===url.pathname);if(!file)return json(404,{error:'파일을 찾을 수 없습니다.'});
  const bytes=await fs.readFile(path.join(data,'uploads',name));res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name),'X-Content-Type-Options':'nosniff'});return res.end(bytes);
 }
 if(req.method==='GET'&&['/','/style.css','/app.js'].includes(url.pathname)){
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1);const bytes=await fs.readFile(path.join(root,'public',name));res.writeHead(200,{'Content-Type':name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'});return res.end(bytes);
 }
 json(404,{error:'페이지를 찾을 수 없습니다.'});
 }catch(e){console.error(e.message);json(500,{error:'처리하지 못했습니다. 잠시 후 다시 시도해주세요.'})}
});server.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('Student showcase running on port '+(process.env.PORT||3000)));
