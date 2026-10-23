// Synthetic protocol fixture, real stdio MCP processes and real VM OS keychain.
// Not evidence of official-cloud compatibility; that needs a separate throwaway cloud account.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import keytar from 'keytar';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { encryptString, decryptItemContent } from '../dist/sn/protocol004.js';
import { privateDirectory, unlockAbandonedAccount } from '../dist/security/account-state.js';

const keyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const noteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const root = new Uint8Array(32).fill(17);
const itemsKey = new Uint8Array(32).fill(34);
const wrapping = new Uint8Array(32).fill(51);
const perItem = new Uint8Array(32).fill(68);
const keyMap = new Map([[keyId,itemsKey]]);
const kp = {version:'004',identifier:'test@example.invalid',pw_nonce:'synthetic-only'};
const hex = (key) => Buffer.from(key).toString('hex');
let timestamp = 100;
const raw = (uuid,type,content,enc_item_key,items_key_id=null) => ({uuid,content_type:type,content,enc_item_key,items_key_id,created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z',created_at_timestamp:1,updated_at_timestamp:++timestamp,deleted:false});
const aad = (u) => ({u,v:'004'});
const original = {title:'Synthetic note',text:'PRIVATE ORIGINAL BODY',noteType:'markdown',starred:true,references:[{uuid:keyId,content_type:'Custom',future:true}],appData:{'org.standardnotes.sn':{pinned:true,archived:true,locked:false},thirdparty:{keep:[1,2,3]}},futureField:{preserve:'exactly'}};
const store = new Map([
  [keyId,raw(keyId,'SN|ItemsKey',await encryptString(JSON.stringify({itemsKey:hex(itemsKey),version:'004'}),wrapping,aad(keyId)),await encryptString(hex(wrapping),root,{...aad(keyId),kp}))],
  [noteId,raw(noteId,'Note',await encryptString(JSON.stringify(original),perItem,aad(noteId)),await encryptString(hex(perItem),itemsKey,aad(noteId)),keyId)],
]);
let writes=0, mutationRequests=0, dropNextWrite=false, delayReads=0;
let access='synthetic-access-0', refresh='synthetic-refresh-0', refreshed=0;
const api = http.createServer(async(req,res)=>{
  try {
    let body=''; for await(const chunk of req) body+=chunk;
    const input=JSON.parse(body);
    if(req.url==='/v1/items' && Array.isArray(input.items) && input.items.length>0)mutationRequests++;
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/sessions/refresh') {
      assert.equal(input.refresh_token,refresh);
      access=`synthetic-access-${++refreshed}`; refresh=`synthetic-refresh-${refreshed}`;
      res.end(JSON.stringify({data:{access_token:access,refresh_token:refresh,access_expiration:0,refresh_expiration:0}})); return;
    }
    assert.equal(req.url,'/v1/items');
    if(req.headers.authorization!==`Bearer ${access}`) {
      res.statusCode=401;res.end(JSON.stringify({error:{message:'expired'}}));return;
    }
    const saved=[], conflicts=[];
    for(const item of input.items??[]) {
      assert.notEqual(item.deleted,true,'No purge can reach sync');
      assert.ok(item.content.startsWith('004:'));
      assert.ok(!JSON.stringify(item).includes('PRIVATE ORIGINAL BODY'));
      const existing=store.get(item.uuid);
      if(existing && item.updated_at_timestamp!==existing.updated_at_timestamp) {
        conflicts.push({type:'sync_conflict',server_item:existing,unsaved_item:item});continue;
      }
      const value={...item,updated_at_timestamp:++timestamp,updated_at:new Date().toISOString()};
      store.set(value.uuid,value);saved.push(value);writes++;
    }
    if(saved.length && dropNextWrite) {dropNextWrite=false;req.socket.destroy();return;}
    if(!saved.length && delayReads) await new Promise(r=>setTimeout(r,delayReads));
    res.end(JSON.stringify({data:{retrieved_items:[...store.values()],saved_items:saved,conflicts,sync_token:`sync-${timestamp}`}}));
  } catch(e) {res.statusCode=500;res.end(JSON.stringify({error:{message:String(e)}}));}
});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${api.address().port}`;
const parent=await mkdtemp(path.join(os.tmpdir(),'sn-mcp-e2e-'));
const temp=path.join(parent,'state');await privateDirectory(temp);
const service=`sn-synthetic-${process.pid}`;
const email='test@example.invalid';
const clients=[],transports=[];let stderr='';let assertions=0;
const check=(value,message)=>{assert.ok(value,message);assertions++;};
const env={...process.env,SN_EMAIL:email,SN_SERVER_URL:endpoint,SN_STATE_DIR:temp,SN_ALLOW_LOCAL_TEST_SERVER:'1',KEYCHAIN_SERVICE:service,
  ...(process.env.SN_E2E_GUI==='1'?{}:{SN_GUI_PATH:path.join(temp,'no-gui-installed')})};
const parse=(r)=>JSON.parse(r.content.find(x=>x.type==='text').text);
const guiMode=process.env.SN_E2E_GUI==='1';
// Ownership binds the ACTUAL native executable: the Linux diagnostic wrapper below only execs it.
const nativeGui=env.SN_GUI_PATH;
if(guiMode && process.platform==='linux') {
  assert.equal(process.env.SN_VM_TEST,'1','GUI launch diagnostics are VM-only');
  const log='/tmp/sn-gui-test/mcp-gui-stderr.log';
  await writeFile(log,'',{mode:0o600});
  const quote=value=>`'${value.replaceAll("'", "'\\''")}'`;
  const launcher=path.join(parent,'gui-launch');
  await writeFile(launcher,`#!/bin/sh\nexec ${quote(env.SN_GUI_PATH)} "$@" >>${quote(log)} 2>&1\n`,{mode:0o700});
  env.SN_GUI_PATH=launcher;
}
function driver(mode,operationId,owner) {
  assert.match(operationId,/^[a-f0-9-]{36}$/);
  const pid=owner.pid??owner.parentPid;
  assert.ok(Number.isSafeInteger(pid) && pid>1,'observed owned GUI/server PID');
  const ownedEnv={...env,SN_GUI_TEST_OPERATION_ID:operationId,SN_GUI_TEST_PID:owner.pid?String(pid):'',SN_GUI_TEST_PARENT_PID:owner.pid?'':String(pid),SN_GUI_TEST_EXE:nativeGui};
  const child=process.platform==='win32'
    ? spawn('powershell.exe',['-NoProfile','-Sta','-NonInteractive','-ExecutionPolicy','Bypass','-File','tests/vm/windows-gui-driver.ps1',mode],{env:ownedEnv,stdio:['ignore','inherit','inherit']})
    : spawn('python3',['tests/vm/gui-driver.py',mode],{env:ownedEnv,stdio:['ignore','inherit','inherit']});
  return new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`GUI driver ${mode} failed`)));});
}
async function approve(operationId) {
  if(guiMode) {
    const child=spawn(process.env.SN_GUI_PATH,['--approve',operationId],{env,stdio:'ignore'});
    const closed=new Promise((r,j)=>{child.on('error',j);child.on('close',r);});
    try {await driver('approve',operationId,{pid:child.pid});assert.equal(await closed,0,'native GUI durable approval');}
    catch(error){child.kill();await closed;throw error;}
    return;
  }
  if(process.platform!=='linux') {
    // Synthetic non-GUI transport suite only. Native GUI human-click acceptance is a separate gate.
    const child=spawn(process.execPath,['dist/gui/bridge.js'],{env,stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();
    child.stdin.end(JSON.stringify({id:1,method:'approve',params:{operationId}})+'\n');
    assert.equal(await new Promise((r,j)=>{child.on('error',j);child.on('close',r);}),0);
    assert.equal(JSON.parse(output).result.approved,true);return;
  }
  const child = spawnSync('script',['-q','-e','-c',`${process.execPath} dist/cli/approve.js ${operationId}`,'/dev/null'],{env,input:`approve ${operationId}\n`,encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,`approval CLI: ${child.stdout} ${child.stderr}`);
}
async function call(c,name,args={}) {
  let human;
  if(name==='writes_commit') {
    const status = parse(await c.callTool({name:'writes_status',arguments:args}));
    if(status.status==='prepared' && !status.approved) {
      if(guiMode) human=driver('approve',args.operationId,{parentPid:transports[clients.indexOf(c)].pid});else await approve(args.operationId);
    }
  }
  const result=await c.callTool({name,arguments:args},undefined,{timeout:120000});
  if(human)await human;
  assert.ok(!result.isError,`${name}: ${JSON.stringify(result)}`);
  return parse(result);
}
async function rejected(c,name,args) {
  let result, transportError, human;
  if(guiMode && name==='writes_commit') {
    const status=parse(await c.callTool({name:'writes_status',arguments:args}));
    if(status.status==='prepared' && !status.approved)human=driver('close',args.operationId,{parentPid:transports[clients.indexOf(c)].pid});
  }
  try { result=await c.callTool({name,arguments:args},undefined,{timeout:120000}); }
  catch(e) { transportError=e; }
  if(human)await human;
  // Do not catch our own assertion: a successful tool result MUST fail this check.
  if(transportError) check(Boolean(transportError),`${name} rejects at transport`);
  else check(result?.isError===true,`${name} should fail`);
}
// Stall a real native GUI's backend while it owns the account lock. Cancellation
// must kill the entire owned tree, including PowerShell on Windows; never touch a
// process by name. The script/marker contain only synthetic fixture paths and PIDs.
async function cancelledGuiLeavesNoDescendants(operationId) {
  assert.equal(process.env.SN_VM_TEST,'1','native cancellation test is VM-only');
  const fixture=path.join(parent,'stalled-gui');
  const marker=path.join(fixture,'owned-pids.json');
  const nonce=crypto.randomUUID();
  const account=path.join(temp,(await readdir(temp))[0]);
  await mkdir(path.join(fixture,'dist','gui'),{recursive:true});
  await writeFile(path.join(fixture,'package.json'),'{"type":"module"}');
  const moduleUrl=pathToFileURL(path.resolve('dist/security/account-state.js')).href;
  await writeFile(path.join(fixture,'dist','gui','bridge.js'),`
    import {spawn} from 'node:child_process';
    import {writeFile,rename} from 'node:fs/promises';
    import path from 'node:path';
    import {withAccountLock} from ${JSON.stringify(moduleUrl)};
    for await(const _ of process.stdin) {}
    await withAccountLock(${JSON.stringify(account)},async()=>{
      const windows=process.platform==='win32';
      const command=windows?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):process.execPath;
      const args=windows?['-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 300']:['-e','setInterval(()=>{},1000)'];
      const leaf=spawn(command,args,{stdio:'ignore'});
      await writeFile(${JSON.stringify(marker+'.tmp')},JSON.stringify({nonce:${JSON.stringify(nonce)},gui:process.ppid,owner:process.pid,leaf:leaf.pid}),{mode:0o600});
      await rename(${JSON.stringify(marker+'.tmp')},${JSON.stringify(marker)});
      await new Promise(()=>{});
    });
  `,{mode:0o600});
  const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{...env,SN_CONNECTOR_ROOT:fixture,SN_NODE_PATH:process.execPath},stderr:'pipe'});
  transports.push(transport);transport.stderr?.resume();
  const c=new Client({name:'synthetic-cancellation',version:'1.0.0'});clients.push(c);await c.connect(transport);
  const abort=new AbortController();let owned;
  const before=writes, requestsBefore=mutationRequests;
  const request=c.callTool({name:'writes_commit',arguments:{operationId}},undefined,{signal:abort.signal,timeout:120000});
  // Attach immediately so a transport failure cannot become an unhandled rejection.
  const settled=request.then(r=>r,()=>null);
  try {
    const deadline=Date.now()+45000;
    while(Date.now()<deadline) {
      try {owned=JSON.parse(await readFile(marker,'utf8'));break;} catch(e) {if(e.code!=='ENOENT')throw e;}
      await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(owned?.nonce,nonce,'stalled native GUI backend owns this fixture');
    const observed=[owned.gui,owned.owner,owned.leaf];
    check(observed.every(pid=>Number.isSafeInteger(pid) && pid>1) && new Set(observed).size===3,'three distinct process observations, never init/group identifiers');
    const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
    check([owned.gui,owned.owner,owned.leaf].every(alive),'owned GUI/backend/grandchild all running before cancellation');
    abort.abort();await settled;
    const reaped=Date.now()+20000;
    while(Date.now()<reaped && [owned.gui,owned.owner,owned.leaf].some(alive))await new Promise(r=>setTimeout(r,100));
    check(![owned.gui,owned.owner,owned.leaf].some(alive),'MCP cancellation leaves no native GUI, lock owner or descendant');
    check(writes===before && mutationRequests===requestsBefore,'cancelled preview sends no mutation request and saves no items');
    // Abrupt cancellation cannot run finally; explicit dead-owner recovery must work.
    await unlockAbandonedAccount(account);
    const status=await call(clients[0],'writes_status',{operationId});
    check(status.status==='prepared' && !status.approved,'cancelled preview remains unapproved after safe lock recovery');
  } finally {
    abort.abort();await settled;
    // Do not kill from stale marker PIDs: they could have been reused. The native
    // lifecycle under test must clean up; on failure the token-owned VM is discarded.
  }
}
try {
  await keytar.setPassword(service,email,JSON.stringify({serverUrl:endpoint,email,sessionPayload:{access_token:access,refresh_token:refresh},masterKeyHex:hex(root),keyParams:kp,savedAt:new Date().toISOString()}));
  for(let i=0;i<2;i++) {
    const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env,stderr:'pipe'});
    transports.push(transport);
    const c=new Client({name:`synthetic-client-${i}`,version:'1.0.0'});
    await c.connect(transport);
    transport.stderr?.on('data',d=>{stderr+=d.toString();});
    clients.push(c);
  }
  const [a,b]=clients;
  const names=(await a.listTools()).tools.map(t=>t.name);
  check(names.includes('writes_prepare') && names.includes('writes_commit'),'preview/commit present');
  check(!names.some(n=>/delete|purge/.test(n)),'No destructive legacy tool exposed');
  const read=await call(a,'notes_get',{uuid:noteId});
  check(read.text===original.text && /^[a-f0-9]{64}$/.test(read.revision),'read includes matching revision');
  const prepared=await call(a,'writes_prepare',{change:{kind:'note_update',uuid:noteId,revision:read.revision,append:' + APPENDED'}});
  check(writes===0,'prepare never sync-pushes');
  check(JSON.stringify(prepared.preview).includes('APPENDED'),'preview includes actual proposed content');
  await rejected(a,'writes_commit',{operationId:prepared.operationId});
  check(writes===0,'MCP cannot approve its own writes');
  const unapproved=await call(a,'writes_status',{operationId:prepared.operationId});
  check(unapproved.status==='prepared' && !unapproved.approved,'unchecked Approve then close never authorizes the operation');
  await call(a,'writes_commit',{operationId:prepared.operationId});
  let content=await decryptItemContent(store.get(noteId),keyMap);
  check(content.text===original.text+' + APPENDED','append applied once');
  check(JSON.stringify(content.futureField)===JSON.stringify(original.futureField),'unknown metadata preserved');
  check(content.starred && content.appData['org.standardnotes.sn'].pinned && content.appData['org.standardnotes.sn'].archived,'flags preserved');
  check(JSON.stringify(content.references)===JSON.stringify(original.references),'references preserved');
  const count=writes;
  check((await call(b,'writes_commit',{operationId:prepared.operationId})).replay,'replay across clients');
  check(writes===count,'retry does not rewrite or append twice');
  const revision=(await call(a,'notes_get',{uuid:noteId})).revision;
  const pa=await call(a,'writes_prepare',{change:{kind:'note_update',uuid:noteId,revision,title:'Client A'}});
  const pb=await call(b,'writes_prepare',{change:{kind:'note_update',uuid:noteId,revision,title:'Client B'}});
  await call(a,'writes_commit',{operationId:pa.operationId});
  await approve(pb.operationId);
  await rejected(b,'writes_commit',{operationId:pb.operationId});
  check((await decryptItemContent(store.get(noteId),keyMap)).title==='Client A','stale client cannot overwrite');
  const undo=await call(b,'writes_undo_prepare',{operationId:pa.operationId});
  await call(b,'writes_commit',{operationId:undo.operationId});
  check((await decryptItemContent(store.get(noteId),keyMap)).title===original.title,'encrypted recovery restores prior content');
  for(const kind of ['note_trash','note_restore']) {
    const n=await call(a,'notes_get',{uuid:noteId});
    const p=await call(a,'writes_prepare',{change:{kind,uuid:noteId,revision:n.revision}});
    await call(a,'writes_commit',{operationId:p.operationId});
    check((await decryptItemContent(store.get(noteId),keyMap)).trashed===(kind==='note_trash'),kind);
  }
  const create=await call(a,'writes_prepare',{change:{kind:'note_create',title:'Timeout test',text:'PRIVATE NEW BODY'}});
  dropNextWrite=true;
  await approve(create.operationId);
  await rejected(a,'writes_commit',{operationId:create.operationId});
  check((await call(b,'writes_status',{operationId:create.operationId})).status==='uncertain','timeout recorded as uncertain');
  const beforeRetry=writes;
  await call(b,'writes_commit',{operationId:create.operationId});
  check(writes===beforeRetry,'uncertain create reconciled without duplicate');
  const tagPlan=await call(a,'writes_prepare',{change:{kind:'tag_create',title:'Synthetic tag'}});
  const tagCommitted=await call(a,'writes_commit',{operationId:tagPlan.operationId});
  let tag=await call(a,'tags_get',{uuid:tagCommitted.uuid});
  const attach=await call(b,'writes_prepare',{change:{kind:'tag_attach',uuid:tag.uuid,revision:tag.revision,noteUuid:noteId}});
  await call(b,'writes_commit',{operationId:attach.operationId});
  tag=await call(a,'tags_get',{uuid:tag.uuid});
  check(tag.noteUuids.includes(noteId),'tag attachment');
  await rejected(a,'writes_prepare',{change:{kind:'note_trash',uuid:noteId,revision,permanent:true}});
  await rejected(a,'writes_prepare',{change:{kind:'recovery',uuid:noteId,revision}});
  if(guiMode) {
    const declined=await call(a,'writes_prepare',{change:{kind:'note_create',title:'Reject test',text:'Do not write'}});
    const human=driver('reject',declined.operationId,{parentPid:transports[clients.indexOf(a)].pid});
    const result=await a.callTool({name:'writes_commit',arguments:{operationId:declined.operationId}},undefined,{timeout:120000});
    await human;check(result.isError,'GUI Reject prevents commit');
    check((await call(a,'writes_status',{operationId:declined.operationId})).status==='rejected','GUI rejection is durable');
    const before=writes;await rejected(a,'writes_commit',{operationId:declined.operationId});check(writes===before,'rejected ID never writes');
  }
  if(guiMode) {
    const pending=await call(a,'writes_prepare',{change:{kind:'note_create',title:'Cancel fixture',text:'Never submit'}});
    await cancelledGuiLeavesNoDescendants(pending.operationId);
  }
  // Rotation must be loaded fresh by the other stdio process.
  access='force-expired';
  await call(a,'notes_list',{});
  await call(b,'notes_list',{});
  check(refreshed===1,'two clients share refreshed session safely');
  // Force overlap: second client fails busy, then succeeds after first releases lock.
  delayReads=100;
  const pending=call(a,'notes_list',{});
  await new Promise(r=>setTimeout(r,30));
  await rejected(b,'notes_list',{});
  await pending;delayReads=0;
  await call(b,'notes_list',{});
  const dirs=await readdir(temp);
  const account=path.join(temp,dirs[0]);
  for(const name of await readdir(account)) {
    check(name.endsWith('.enc'),'only encrypted journals remain; no leaked lock');
    const file=path.join(account,name);
    if(process.platform!=='win32')check((await stat(file)).mode%512===0o600,'journal POSIX permissions');
    const data=await readFile(file,'utf8');
    check(!data.includes('PRIVATE') && !data.includes('Synthetic note'),'no note plaintext at rest');
  }
  check(!stderr.includes('PRIVATE ORIGINAL BODY') && !stderr.includes('PRIVATE NEW BODY'),'no bodies in stderr');
  process.stdout.write(`PASS: ${assertions} assertions, two real stdio MCP clients, real OS keychain, encrypted recovery, stale edits, timeout/retry, token rotation and exclusion\n`);
} finally {
  for(const c of clients) await c.close();
  for(const t of transports) await t.close();
  await new Promise(r=>api.close(r));
  await keytar.deletePassword(service,email);
  for(const item of await keytar.findCredentials(`${service}-recovery`)) await keytar.deletePassword(`${service}-recovery`,item.account);
  await rm(parent,{recursive:true,force:true});
  process.stdout.write('CLEANUP PASS: fixture MCP clients closed; mock API, keychain entries and journal files removed. Descendant cleanup requires separate PID assertions or owned VM discard.\n');
}
