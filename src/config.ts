import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Resolve the same state directory from a desktop launch, MCP, or terminal. Never execute machine files. */
export async function configureStateDirectory(): Promise<string> {
  let base = process.env.SN_STATE_DIR;
  let data = process.env.DATA_DIR;
  if (!base && !data) {
    try {
      const machine = await readFile(path.join(os.homedir(), "code/dotfiles/machines", `${os.hostname()}.env`), "utf8");
      data = machine.match(/^DATA_DIR=["']?([^\r\n"']+)["']?\s*$/m)?.[1];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  base ??= data ? path.join(data, "standardnotes-mcp") : path.join(
    process.platform === "win32" ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"))
      : process.platform === "darwin" ? path.join(os.homedir(), "Library/Application Support")
      : (process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state")),
    "standardnotes-mcp",
  );
  if (!path.isAbsolute(base)) throw new Error("The recovery state location must be absolute");
  process.env.SN_STATE_DIR = base;
  return base;
}
