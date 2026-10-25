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
import { privateDirectory } from '../dist/security/account-state.js';

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
let writes=0, mutationRequests=0, dropNextWrite=false, delayReads=0, fromScratch=0, itemRequests=0, rateLimitNext=0;
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
    itemRequests++;
    if(rateLimitNext) {res.statusCode=429;res.setHeader('Retry-After',String(rateLimitNext));rateLimitNext=0;res.end(JSON.stringify({error:{message:'slow down'}}));return;}
    if(!input.sync_token && !input.cursor_token && !(input.items?.length))fromScratch++;
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
const env={...process.env,SN_EMAIL:email,SN_SERVER_URL:endpoint,SN_STATE_DIR:temp,SN_ALLOW_LOCAL_TEST_SERVER:'1',KEYCHAIN_SERVICE:service};
const parse=(r)=>JSON.parse(r.content.find(x=>x.type==='text').text);
// The real terminal CLI under a pseudo-terminal (tests/approve-pty.py); Windows has no pty module, so it
// approves through the same journal call the CLI makes after its typed confirmation.
async function approve(operationId,answer=`approve ${operationId}`) {
  const cli=[process.execPath,'dist/cli/approve.js',operationId];
  // Windows private-file checks launch PowerShell per step, so a journal update takes seconds there.
  const opts={env,input:`${answer}\n`,encoding:'utf8',timeout:process.platform==='win32'?120000:20000};
  const started=Date.now();
  const child=process.platform!=='win32' ? spawnSync('python3',['-I','tests/approve-pty.py',answer,...cli],opts)
    : spawnSync(process.execPath,['--input-type=module','-e',`
      import path from 'node:path';
      import {accountDirectory,withAccountLock} from './dist/security/account-state.js';
      import {WriteJournal} from './dist/security/write-journal.js';
      import {recoveryKey,resolveEmail} from './dist/sn/session.js';
      const server=process.env.SN_SERVER_URL, dir=accountDirectory(process.env.SN_STATE_DIR,server,await resolveEmail(server));
      const j=new WriteJournal(dir,await recoveryKey(path.basename(dir),false));
      await withAccountLock(dir,()=>${JSON.stringify(answer)}==='reject'?j.reject(${JSON.stringify(operationId)}):j.approve(${JSON.stringify(operationId)}));`],opts);
  assert.equal(child.status,0,`approval CLI: ${child.stdout} ${child.stderr}`);
  if(process.platform==='win32') console.log(`approval took ${Date.now()-started} ms`);
}
async function call(c,name,args={}) {
  if(name==='writes_commit') {
    const status = parse(await c.callTool({name:'writes_status',arguments:args}));
    if(status.status==='prepared' && !status.approved) {
      await approve(args.operationId);
    }
  }
  const result=await c.callTool({name,arguments:args},undefined,{timeout:120000});
  assert.ok(!result.isError,`${name}: ${JSON.stringify(result)}`);
  return parse(result);
}
async function rejected(c,name,args) {
  let result, transportError;
  try { result=await c.callTool({name,arguments:args},undefined,{timeout:120000}); }
  catch(e) { transportError=e; }
  // Do not catch our own assertion: a successful tool result MUST fail this check.
  if(transportError) check(Boolean(transportError),`${name} rejects at transport`);
  else check(result?.isError===true,`${name} should fail`);
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
  const tree=await call(a,'writes_prepare_batch',{changes:[
    {kind:'tag_create',title:'Parent',ref:'@p'},
    {kind:'tag_create',title:'Child',parent:'@p',ref:'@c'},
    {kind:'tag_attach',uuid:'@c',noteUuid:noteId},
    {kind:'tag_update',uuid:tag.uuid,revision:tag.revision,parent:'@p'}]});
  await call(a,'writes_commit',{operationId:tree.operationId});
  const listed=await call(a,'tags_list',{});
  const parentTag=listed.find(t=>t.title==='Parent'), childTag=listed.find(t=>t.title==='Child');
  check(childTag?.parentUuid===parentTag?.uuid && listed.find(t=>t.uuid===tag.uuid)?.parentUuid===parentTag?.uuid,'nested tags built and moved in one batch');
  check((await call(a,'tags_get',{uuid:childTag.uuid})).noteUuids.includes(noteId),'note attached to a tag created in the same batch');
  tag=await call(a,'tags_get',{uuid:tag.uuid});
  // Batch: one approval, one push request, item-level composition, replay and whole-batch undo.
  const createdId=(await call(b,'writes_status',{operationId:create.operationId})).uuid;
  const many=await call(a,'notes_get_batch',{uuids:[noteId,createdId]});
  check(many.notes.length===2 && many.missing.length===0 && many.notes.every(n=>/^[a-f0-9]{64}$/.test(n.revision)),'batch read returns revisions');
  const created=many.notes.find(n=>n.uuid===createdId);
  const batch=await call(a,'writes_prepare_batch',{changes:[
    {kind:'tag_attach',uuid:tag.uuid,revision:tag.revision,noteUuid:createdId},
    {kind:'note_update',uuid:createdId,revision:created.revision,title:'Batch renamed'},
    {kind:'note_trash',uuid:createdId,revision:created.revision},
    {kind:'note_flags',uuid:createdId,revision:created.revision,archived:true,pinned:true}]});
  check(batch.preview.kind==='batch' && batch.preview.items===2 && JSON.stringify(batch.preview).includes('Batch renamed'),'batch preview lists every item change');
  const batchRequests=mutationRequests;
  await call(a,'writes_commit',{operationId:batch.operationId});
  check(mutationRequests===batchRequests+1,'batch commits in one push request');
  content=await decryptItemContent(store.get(createdId),keyMap);
  check(content.title==='Batch renamed' && content.trashed===true && content.appData['org.standardnotes.sn'].archived===true && content.appData['org.standardnotes.sn'].pinned===true,'batch composes changes to one note');
  check((await call(a,'notes_list',{archived:true,includeTrashed:true})).some(n=>n.uuid===createdId && n.pinned),'archived filter and flags in listings');
  check((await call(a,'tags_get',{uuid:tag.uuid})).noteUuids.includes(createdId),'batch attaches tag');
  check((await call(b,'writes_commit',{operationId:batch.operationId})).replay && mutationRequests===batchRequests+1,'batch replay sends nothing');
  const batchUndo=await call(b,'writes_undo_prepare',{operationId:batch.operationId});
  await call(b,'writes_commit',{operationId:batchUndo.operationId});
  content=await decryptItemContent(store.get(createdId),keyMap);
  check(content.title==='Timeout test' && !content.trashed && !content.appData?.['org.standardnotes.sn']?.archived && !(await call(a,'tags_get',{uuid:tag.uuid})).noteUuids.includes(createdId),'batch undo restores every item');
  // Merge: one new note, sources trashed, tags carried over; one undo.
  const pair=(await call(a,'notes_get_batch',{uuids:[noteId,createdId]})).notes;
  const mergeTag=await call(a,'tags_get',{uuid:tag.uuid});
  const tagForMerge=await call(a,'writes_prepare_batch',{changes:[{kind:'tag_attach',uuid:tag.uuid,revision:mergeTag.revision,noteUuid:createdId}]});
  await call(a,'writes_commit',{operationId:tagForMerge.operationId});
  const sources=(await call(a,'notes_get_batch',{uuids:pair.map(n=>n.uuid)})).notes.map(n=>({uuid:n.uuid,revision:n.revision}));
  await rejected(a,'writes_prepare',{change:{kind:'note_merge',title:'Merged',sources}});
  const merge=await call(a,'writes_prepare_batch',{changes:[{kind:'note_merge',title:'Merged',sources}]});
  check(merge.preview.counts.note_merge===1 && merge.preview.counts.note_trash===2 && merge.preview.counts.tag_attach>=1 && merge.preview.items===3+merge.preview.counts.tag_attach,'merge preview counts the new note, trashes and tag');
  await call(a,'writes_commit',{operationId:merge.operationId});
  const mergedId=merge.preview.plan[0].uuid;
  content=await decryptItemContent(store.get(mergedId),keyMap);
  check(content.title==='Merged' && pair.every(n=>content.text.includes(`## ${n.title}\n\n`)) && (await call(a,'tags_get',{uuid:tag.uuid})).noteUuids.includes(mergedId),'merged note created with the sources\' tag');
  check((await Promise.all(sources.map(async s=>(await decryptItemContent(store.get(s.uuid),keyMap)).trashed===true))).every(Boolean),'merge trashes the sources');
  const mergeUndo=await call(b,'writes_undo_prepare',{operationId:merge.operationId});
  await call(b,'writes_commit',{operationId:mergeUndo.operationId});
  check((await Promise.all(sources.map(async s=>!(await decryptItemContent(store.get(s.uuid),keyMap)).trashed))).every(Boolean) && (await decryptItemContent(store.get(mergedId),keyMap)).trashed===true,'merge undo restores the sources and trashes the merged note');
  await rejected(a,'writes_prepare',{change:{kind:'note_trash',uuid:noteId,revision,permanent:true}});
  await rejected(a,'writes_prepare',{change:{kind:'recovery',uuid:noteId,revision}});
  const declined=await call(a,'writes_prepare',{change:{kind:'note_create',title:'Reject test',text:'Do not write'}});
  await approve(declined.operationId,'reject');
  check((await call(a,'writes_status',{operationId:declined.operationId})).status==='rejected','terminal rejection is durable');
  const beforeReject=writes;await rejected(a,'writes_commit',{operationId:declined.operationId});check(writes===beforeReject,'rejected ID never writes');
  // Rotation must be loaded fresh by the other stdio process. notes_get always syncs (a cached list may not):
  // A meets the 401 and refreshes; B must adopt A's rotated tokens from the keychain, not refresh again.
  access='force-expired';
  const refreshedBefore=refreshed;
  await call(a,'notes_get',{uuid:noteId});
  await call(b,'notes_get',{uuid:noteId});
  check(refreshed===refreshedBefore+1 && refreshed===1,'two clients share refreshed session safely');
  const entries=(await keytar.findCredentials(service)).map(c=>c.account);
  check(entries.length===1 && entries[0]===`${email} (${endpoint})`,'the email-only session moved to its server-scoped keychain entry on rotation');
  // One client per process: further reads are delta syncs, not full downloads.
  const scratch=fromScratch;
  for(let i=0;i<3;i++) await call(a,'notes_get',{uuid:noteId});
  check(fromScratch===scratch,'repeat reads in one process never re-download the vault');
  // A 429 blocks every process for this account until Retry-After, without sending requests.
  rateLimitNext=2;
  await rejected(a,'notes_get',{uuid:noteId});
  const sent=itemRequests;
  await rejected(b,'notes_get',{uuid:noteId});
  await rejected(a,'notes_list',{});
  check(itemRequests===sent,'rate-limited processes send nothing while waiting');
  await new Promise(r=>setTimeout(r,2200));
  await call(b,'notes_get',{uuid:noteId});
  check(itemRequests>sent,'requests resume after Retry-After');
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
  for(const item of await keytar.findCredentials(service)) await keytar.deletePassword(service,item.account);
  for(const item of await keytar.findCredentials(`${service}-recovery`)) await keytar.deletePassword(`${service}-recovery`,item.account);
  await rm(parent,{recursive:true,force:true});
  process.stdout.write('CLEANUP PASS: fixture MCP clients closed; mock API, keychain entries and journal files removed. Descendant cleanup requires separate PID assertions or owned VM discard.\n');
}
