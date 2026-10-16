const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {mkdtemp,rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
async function launch(env) {
 const reservation=http.createServer(); reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,SUPABASE_URL:'',SUPABASE_SERVICE_ROLE_KEY:'',...env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('server exited')})]);
 return {base:`http://127.0.0.1:${port}`,stop:async()=>{const done=once(child,'exit');child.kill();await done;}};
}
const project={title:'학생 작품',author:'학생',description:'공개 웹 앱',category:'학습·교육',url:'https://example.com/app',password:'2468'};
const pdf=Buffer.from('%PDF-1.4\nExample plan');
async function exercise(base){
 let r=await fetch(base+'/api/projects',{method:'POST',body:JSON.stringify({...project,url:'javascript:alert(1)'})});assert.equal(r.status,400);
 r=await fetch(base+'/api/projects',{method:'POST',body:JSON.stringify({...project,title:123})});assert.equal(r.status,400);
 r=await fetch(base+'/api/projects',{method:'POST',body:JSON.stringify({...project,plan:{name:'bad.pdf',content:Buffer.from('not PDF').toString('base64')}})});assert.equal(r.status,400);
 r=await fetch(base+'/api/projects',{method:'POST',body:JSON.stringify(project)});assert.equal(r.status,201);assert.equal((await r.json()).plan,null);
 r=await fetch(base+'/api/projects',{method:'POST',body:JSON.stringify({...project,plan:{name:'기획서.pdf',content:pdf.toString('base64')}})});assert.equal(r.status,201);const item=await r.json();assert.equal(item.app,undefined);assert.equal(item.deleteAuth,undefined);assert.equal(item.password,undefined);
 r=await fetch(base+item.plan.href);assert.equal(r.headers.get('content-type'),'application/pdf');assert.match(r.headers.get('content-disposition'),/^inline;/);assert.deepEqual(Buffer.from(await r.arrayBuffer()),pdf);
 assert.equal((await (await fetch(base+'/api/projects')).json()).length,2);assert.ok((await (await fetch(base+'/api/projects')).json()).every(p=>!p.deleteAuth&&!p.password));return item;
}
test('URL registration, optional PDF viewing and local restart persistence',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'showcase-'));let app;
 try{app=await launch({DATA_DIR:dir});const item=await exercise(app.base);await app.stop();app=await launch({DATA_DIR:dir});assert.equal((await (await fetch(app.base+'/api/projects')).json())[0].id,item.id);await verifyDeletion(app.base,item);}finally{if(app)await app.stop();await rm(dir,{recursive:true,force:true});}
});
test('Supabase adapter persists metadata and private PDFs across app restarts (mock)',async()=>{
 const rows=[],files=new Map();const mock=http.createServer(async(req,res)=>{
 assert.equal(req.headers.apikey,'test-server-key');assert.equal(req.headers.authorization,'Bearer test-server-key');
 const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
 if(req.url.startsWith('/rest/v1/')){if(req.method==='DELETE'){const id=new URL(req.url,'http://test').searchParams.get('id').slice(3);const index=rows.findIndex(r=>r.id===id);if(index>=0)rows.splice(index,1);res.writeHead(204);res.end();}else if(req.method==='POST'){rows.unshift(JSON.parse(body));res.writeHead(201);res.end();}else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rows));}return;}
 const key=req.url.split('/').pop();if(req.method==='DELETE'){files.delete(key);res.writeHead(200);res.end('{}');}else if(req.method==='POST'){assert.equal(req.headers['content-type'],'application/pdf');files.set(key,body);res.writeHead(200);res.end('{}');}else if(files.has(key)){res.end(files.get(key));}else{res.writeHead(404);res.end();}
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');let app;const env={SUPABASE_URL:`http://127.0.0.1:${mock.address().port}`,SUPABASE_SERVICE_ROLE_KEY:'test-server-key'};
 try{app=await launch(env);assert.equal((await (await fetch(app.base+'/api/config')).json()).persistent,true);const item=await exercise(app.base);await app.stop();app=await launch(env);assert.equal((await (await fetch(app.base+'/api/projects')).json())[0].id,item.id);assert.deepEqual(Buffer.from(await (await fetch(app.base+item.plan.href)).arrayBuffer()),pdf);await verifyDeletion(app.base,item);assert.equal(files.size,0);}finally{if(app)await app.stop();await new Promise(r=>mock.close(r));}
});

async function verifyDeletion(base, item) {
 const remove = (id,password) => fetch(base+'/api/projects/'+id,{method:'DELETE',body:JSON.stringify({password})});
 let response = await remove(item.id,'9999');assert.equal(response.status,403);
 assert.equal((await fetch(base+item.plan.href)).status,200);
 response = await remove(item.id,'2468');assert.equal(response.status,200);
 assert.equal((await fetch(base+item.plan.href)).status,404);
 assert.equal((await remove(item.id,'2468')).status,404);
 const remaining = await (await fetch(base+'/api/projects')).json();
 assert.equal((await remove(remaining[0].id,'1005')).status,200);
 assert.equal((await (await fetch(base+'/api/projects')).json()).length,0);
}
test('PIN validation, legacy admin deletion and attempt limit',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'showcase-'));let app;
 try {
  const fs=require('node:fs/promises');const legacy={...project,id:'11111111-1111-4111-8111-111111111111',plan:null};delete legacy.password;
  await fs.writeFile(path.join(dir,'projects.json'),JSON.stringify([legacy]));
  app=await launch({DATA_DIR:dir});
  let response=await fetch(app.base+'/api/projects',{method:'POST',body:JSON.stringify({...project,password:'123'})});assert.equal(response.status,400);
  response=await fetch(app.base+'/api/projects/'+legacy.id,{method:'DELETE',body:JSON.stringify({password:'1005'})});assert.equal(response.status,200);
  response=await fetch(app.base+'/api/projects',{method:'POST',body:JSON.stringify({...project,password:'0123'})});const item=await response.json();assert.equal(response.status,201);
  const remove=password=>fetch(app.base+'/api/projects/'+item.id,{method:'DELETE',body:JSON.stringify({password})});
  for(let i=0;i<5;i++)assert.equal((await remove('9999')).status,403);
  assert.equal((await remove('0123')).status,429);
  const html=await (await fetch(app.base+'/')).text();assert.ok(html.includes('우리 반 웹 앱 전시관'));assert.ok(html.includes('학생들이 직접 기획하고 만든 웹 앱을 소개합니다.'));
  const js=await (await fetch(app.base+'/app.js')).text();assert.ok(!js.includes('오늘의 한 끼'));assert.ok(!js.includes('1005'));
 } finally {if(app)await app.stop();await rm(dir,{recursive:true,force:true});}
});
