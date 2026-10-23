import {it,expect,vi} from "vitest";
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const {publish}=vi.hoisted(()=>({publish:vi.fn()}));
vi.mock("node:fs/promises",async(importOriginal)=>{
  const original=await importOriginal<typeof import("node:fs/promises")>();
  return {...original,link:async(source:string,target:string)=>{await publish(target);return original.link(source,target);}};
});
import {configureAgents} from "./configure.js";

async function fixture(fn:(home:string)=>Promise<void>){
  const home=await mkdtemp(path.join(os.tmpdir(),"sn-gui-config-"));
  try {await mkdir(path.join(home,".pi/agent"),{recursive:true});publish.mockReset();await fn(home);}
  finally{await rm(home,{recursive:true,force:true});}
}
it("never rewrites existing configs or makes copies of unrelated provider secrets",async()=>fixture(async(home)=>{
  const before=JSON.stringify({mcpServers:{other:{env:{TOKEN:"SYNTHETIC TOKEN"}}}});
  await writeFile(path.join(home,".claude.json"),before);
  const disabled=JSON.stringify({mcpServers:{standardnotes:{disabled:true}}});
  await writeFile(path.join(home,".pi/agent/mcp.json"),disabled);
  const result=await configureAgents(home);
  expect(result.configured).toEqual([]);expect(result.manual).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC TOKEN");
  expect(await readFile(path.join(home,".claude.json"),"utf8")).toBe(before);
  expect(await readFile(path.join(home,".pi/agent/mcp.json"),"utf8")).toBe(disabled);
  expect(await readdir(home)).toEqual(expect.arrayContaining([".claude.json",".pi"]));
  expect((await readdir(home)).some(n=>n.endsWith(".bak")||n.endsWith(".tmp"))).toBe(false);
}));
it("publishes absent configs privately without replacing a concurrent writer",async()=>fixture(async(home)=>{
  const concurrent=JSON.stringify({mcpServers:{concurrent:{command:"preserve"}}});
  publish.mockImplementation(async(target:string)=>{if(target.endsWith(".claude.json"))await writeFile(target,concurrent);});
  const result=await configureAgents(home);
  expect(result.configured).toEqual(["Pi"]);
  expect(await readFile(path.join(home,".claude.json"),"utf8")).toBe(concurrent);
  const created=path.join(home,".pi/agent/mcp.json");
  expect(JSON.parse(await readFile(created,"utf8")).mcpServers.standardnotes).toBeTruthy();
  if(process.platform!=="win32") expect((await stat(created)).mode&0o777).toBe(0o600);
  expect(await readdir(path.join(home,".pi/agent/.standardnotes-agent-config"))).toEqual([]);
}));
