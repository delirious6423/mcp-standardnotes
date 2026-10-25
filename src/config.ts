import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * DATA_DIR from a shell-style machine file, read as data: `[export ]DATA_DIR=value`, the value bare or
 * in single or double quotes, optionally followed by a `# comment`. Anything needing a shell (variables,
 * command substitution, escapes) is refused rather than silently choosing another state directory.
 */
function machineDataDir(text: string, file: string): string | undefined {
  const line = text.split(/\r?\n/).reverse().find((l) => /^\s*(?:export\s+)?DATA_DIR=/.test(l));
  if (line === undefined) return undefined;
  const value = /^\s*(?:export\s+)?DATA_DIR=(?:"([^"$`\\]*)"|'([^']*)'|([^\s"'$`\\#;|&<>()]*))\s*(?:#.*)?$/.exec(line);
  const found = value?.[1] ?? value?.[2] ?? value?.[3];
  if (found === undefined) throw new Error(`Cannot read DATA_DIR from ${file} without a shell; set SN_STATE_DIR instead`);
  return found || undefined;
}

/** Resolve the same state directory from a desktop launch, MCP, or terminal. Never execute machine files. */
export async function configureStateDirectory(): Promise<string> {
  // Empty means unset: client configs often carry `SN_STATE_DIR=""`.
  let base = process.env.SN_STATE_DIR || undefined;
  let data = process.env.DATA_DIR || undefined;
  if (!base && !data) {
    const file = path.join(os.homedir(), "code/dotfiles/machines", `${os.hostname()}.env`);
    try {
      data = machineDataDir(await readFile(file, "utf8"), file);
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
