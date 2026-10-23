import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicPrivateWrite, privateDirectory } from "../security/account-state.js";

export interface ManualConfiguration {client: string; configPath: string; entry: unknown}

/** Explicit GUI action. Existing configs are NEVER rewritten: other clients cannot share our lock. */
export async function configureAgents(home = os.homedir()): Promise<{configured: string[]; preserved: string[]; manual: ManualConfiguration[]}> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const entry = { command: process.execPath, args: [path.join(root, "dist/index.js")], env: {
    SN_STATE_DIR: process.env.SN_STATE_DIR!,
    ...(process.env.SN_EMAIL ? {SN_EMAIL:process.env.SN_EMAIL} : {}),
    ...(process.env.SN_GUI_PATH ? {SN_GUI_PATH:process.env.SN_GUI_PATH} : {}),
  } };
  const configured: string[] = [], preserved: string[] = [], manual: ManualConfiguration[] = [];
  for (const [name, parent, filename] of [["Pi", path.join(home, ".pi/agent"), "mcp.json"], ["Claude Code", home, ".claude.json"]] as const) {
    const file = path.join(parent,filename);
    try {
      const dir = await lstat(parent);
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("Config parent must be a real directory");
      let existing = false;
      try {
        const st = await lstat(file);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error("Refusing a non-regular client config");
        existing = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing) {
        preserved.push(name);
        // Read only to decide whether to offer our own snippet. Never return unrelated config/token data.
        let registered = false;
        try {
          const value = JSON.parse(await readFile(file,"utf8")) as {mcpServers?:Record<string,unknown>};
          registered = Boolean(value?.mcpServers && Object.hasOwn(value.mcpServers,"standardnotes"));
        } catch { /* Even malformed configs are preserved, not silently repaired. */ }
        if (!registered) manual.push({client:name,configPath:file,entry});
        continue;
      }
      const staging = path.join(parent,".standardnotes-agent-config");
      await privateDirectory(staging);
      const temp = path.join(staging,`${randomUUID()}.json`);
      try {
        await atomicPrivateWrite(temp,JSON.stringify({mcpServers:{standardnotes:entry}},null,2)+"\n");
        // Link is atomic create-if-absent, unlike compare+rename. No copy/cross-volume fallback.
        await link(temp,file);
        if (process.platform !== "win32") {
          const directory = await open(parent,"r");
          try {await directory.sync();} finally {await directory.close();}
        }
        configured.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        preserved.push(name);manual.push({client:name,configPath:file,entry});
      } finally {await rm(temp,{force:true});}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      preserved.push(`${name} (not installed)`);
    }
  }
  return {configured,preserved,manual};
}
