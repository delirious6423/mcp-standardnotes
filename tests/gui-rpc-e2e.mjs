// Native-VM-only pipe/keychain auth test. No official account, no real credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import keytar from 'keytar';
import {deriveRootKey,encryptString} from '../dist/sn/protocol004.js';
import {privateDirectory} from '../dist/security/account-state.js';

assert.equal(process.env.SN_VM_TEST,'1','Run only inside the native VM harness');
const email='gui-auth@example.invalid', password='SYNTHETIC GUI SECRET | spaces';
const kp={version:'004',identifier:email,pw_nonce:'synthetic-gui-nonce'};
const root=await deriveRootKey(password,kp);
const keyId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', itemsKey=new Uint8Array(32).fill(34), wrapping=new Uint8Array(32).fill(51);
const hex=b=>Buffer.from(b).toString('hex');
const itemKey={uuid:keyId,content_type:'SN|ItemsKey',content:await encryptString(JSON.stringify({itemsKey:hex(itemsKey),version:'004'}),wrapping,{u:keyId,v:'004'}),enc_item_key:await encryptString(hex(wrapping),root.masterKey,{u:keyId,v:'004',kp}),items_key_id:null,deleted:false,created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z',created_at_timestamp:1,updated_at_timestamp:1};
let logins=0, writes=0, requireMfa=true;
const api=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  try {
    let body='';for await(const c of req)body+=c;
    const input=JSON.parse(body);
    if(req.url==='/v2/login-params') {
      assert.equal(input.email,email);
      if(requireMfa && input.mfa_test!=='123456') {res.statusCode=401;res.end(JSON.stringify({error:{tag:'mfa-required',message:'2FA required',payload:{mfa_key:'mfa_test'}}}));return;}
      res.end(JSON.stringify({data:kp}));return;
    }
    if(req.url==='/v2/login') {
      assert.equal(input.password,root.serverPassword);logins++;
      res.end(JSON.stringify({data:{session:{access_token:'synthetic-gui-access',refresh_token:'synthetic-gui-refresh'},key_params:kp,user:{uuid:'11111111-1111-4111-8111-111111111111',email}}}));return;
    }
    assert.equal(req.url,'/v1/items');assert.equal(req.headers.authorization,'Bearer synthetic-gui-access');
    writes+=(input.items??[]).length;
    res.end(JSON.stringify({data:{retrieved_items:[itemKey],saved_items:[],conflicts:[],sync_token:'synthetic-gui-sync'}}));
  } catch {res.statusCode=500;res.end(JSON.stringify({error:{message:'synthetic API failure'}}));}
});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const temp=await mkdtemp(path.join(os.tmpdir(),'sn-gui-rpc-'));
const service=`sn-gui-rpc-${process.pid}`;
const state=path.join(temp,'state');await privateDirectory(state);
const env={...process.env,SN_EMAIL:email,SN_STATE_DIR:state,KEYCHAIN_SERVICE:service,SN_ALLOW_LOCAL_TEST_SERVER:'1',SN_SERVER_URL:`http://127.0.0.1:${api.address().port}`};
let assertions=0;
const check=(v,m)=>{assert.ok(v,m);assertions++;};
async function rpc(method,params) {
  const child=spawn(process.execPath,['dist/gui/bridge.js'],{env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.stdin.end(JSON.stringify({id:1,method,...(params?{params}:{})})+'\n');
  const code=await new Promise((r,j)=>{child.on('error',j);child.on('close',r);});
  assert.equal(code,0);check(!stderr.includes(password),'no password in child diagnostics');
  const response=JSON.parse(stdout);check(!stdout.includes(password),'no password in protocol result');return response;
}
try {
  check((await rpc('status')).result.savedSession===false,'no false connected state');
  check((await rpc('login',{email,password})).error.code==='mfa_required','GUI receives typed MFA challenge');
  check(logins===0,'MFA challenge sends no login password');
  check((await rpc('status')).result.savedSession===false,'MFA failure stores no session');
  check((await rpc('login',{email,password,mfa:'123456'})).result.connected===true,'native-pipe login + MFA');
  check(logins===1,'one authenticated session');
  const saved=await keytar.getPassword(service,email);check(Boolean(saved),'session in real VM keychain');
  check(!saved.includes(password),'login password is not persisted');
  const status=(await rpc('status')).result;check(status.savedSession && !status.verified,'local status does not fake live proof');
  check((await rpc('check')).result.notes===0,'fresh process resumes keychain session and checks counts');
  check(writes===0,'status/login/check send no note writes');
  for(const dir of await readdir(state)) for(const f of await readdir(path.join(state,dir))) {
    check(!(await readFile(path.join(state,dir,f),'utf8')).includes(password),'no plaintext credentials on disk');
  }
  check((await rpc('disconnect')).result.disconnected,'GUI disconnect clears only login');
  check(await keytar.getPassword(service,email)===null,'keychain login removed');
  check((await rpc('status')).result.savedSession===false,'status reflects disconnect');
  requireMfa=false;
  check((await rpc('login',{email,password})).result.connected,'GUI login without MFA');
  if(process.env.SN_GUI_AUTH==='1') {
    await rpc('disconnect'); requireMfa=true;
    const home=path.join(temp,'gui-home');await mkdir(path.join(home,'.pi/agent'),{recursive:true});
    await writeFile(path.join(home,'.claude.json'),JSON.stringify({unrelated:'preserve'}));
    await writeFile(path.join(home,'.pi/agent/mcp.json'),JSON.stringify({mcpServers:{standardnotes:{disabled:true}}}));
    const guiEnv={...env,HOME:home,...(process.platform==='win32'?{USERPROFILE:home}:{})};
    const gui=spawn(process.env.SN_GUI_PATH,[],{env:guiEnv,stdio:['ignore','ignore','pipe']});let diagnostics='';gui.stderr.on('data',b=>diagnostics+=b);
    const guiClosed=new Promise(r=>gui.on('close',r));
    const driver=process.platform==='win32'
      ? spawn('powershell.exe',['-NoProfile','-Sta','-NonInteractive','-ExecutionPolicy','Bypass','-File','tests/vm/windows-gui-driver.ps1','auth'],{env:{...guiEnv,SN_GUI_TEST_PID:String(gui.pid)},stdio:['pipe','inherit','inherit']})
      : spawn('python3',['tests/vm/gui-driver.py','auth'],{env:{...guiEnv,SN_GUI_TEST_PID:String(gui.pid),SN_GUI_TEST_EXE:process.env.SN_GUI_PATH},stdio:['pipe','inherit','inherit']});
    driver.stdin.end(JSON.stringify({email,password,mfa:'123456'}));
    const driverCode=await new Promise((r,j)=>{driver.on('error',j);driver.on('close',r);});
    const debugSeconds=Math.min(300,Math.max(0,Number(process.env.SN_GUI_DEBUG_SECONDS)||0));
    if(driverCode!==0 && debugSeconds>0) {
      await writeFile('/tmp/sn-gui-test/gui.log',diagnostics,{mode:0o600});
      console.error(`DEBUG: owned synthetic GUI remains alive for ${debugSeconds}s before cleanup`);
      await new Promise(r=>setTimeout(r,debugSeconds*1000));
    }
    if(driverCode!==0)gui.kill();
    await guiClosed;
    check(!diagnostics.includes(password),'GUI stderr never contains password');
    if(process.env.SN_GUI_AUTH==='1')await writeFile('/tmp/sn-gui-test/gui.log',diagnostics,{mode:0o600});
    assert.equal(driverCode,0,'GUI auth driver');
    const config=JSON.parse(await readFile(path.join(home,'.claude.json'),'utf8'));
    check(config.unrelated==='preserve' && !config.mcpServers,'GUI never overwrites existing client configuration');
    check(JSON.parse(await readFile(path.join(home,'.pi/agent/mcp.json'),'utf8')).mcpServers.standardnotes.disabled,'GUI preserves disabled registration');
    check(await keytar.getPassword(service,email)===null,'GUI confirm disconnect removed session');
    console.log('PASS: native GPUI masked login, MFA, verified counts, agent configuration and confirmed disconnect');
  }
  console.log(`PASS: ${assertions} native GUI pipe/auth/MFA/keychain assertions (synthetic account)`);
} finally {
  await keytar.deletePassword(service,email);
  await new Promise(r=>api.close(r));
  await rm(temp,{recursive:true,force:true});
  console.log('CLEANUP PASS: GUI RPC fixture API, keychain login and state removed');
}
