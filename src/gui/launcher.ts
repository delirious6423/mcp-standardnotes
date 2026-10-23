import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withAccount } from "../security/account-context.js";

export async function guiExecutable(): Promise<string> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const name = `standardnotes-connection${process.platform === "win32" ? ".exe" : ""}`;
  const candidates = process.env.SN_GUI_PATH ? [process.env.SN_GUI_PATH] : [path.join(root, "bin", name), path.join(root, name)];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) throw new Error("SN_GUI_PATH must be absolute");
    try { await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); return candidate; }
    catch { /* Try the next installed location. */ }
  }
  throw new Error("Open/install Standard Notes Agent Connection to review this change; no approval was granted");
}

export async function ensureGuiApproval(operationId: string, signal?: AbortSignal): Promise<void> {
  const preview = await withAccount(async (_client, journal) => (await journal()).preview(operationId));
  if (preview.status === "rejected") throw new Error("This operation was rejected; no write sent");
  if (preview.status !== "prepared" || preview.approved) return;
  if (signal?.aborted) throw new Error("Write cancelled before approval");
  const executable = await guiExecutable();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["--approve", operationId], { stdio: "ignore", detached: process.platform !== "win32" });
    const abort = (): void => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === "win32") {
        const root = process.env.SystemRoot;
        if (root && path.isAbsolute(root)) execFile(path.join(root,"System32/taskkill.exe"),["/PID",String(child.pid),"/T","/F"],{timeout:10_000,windowsHide:true},()=>undefined);
        else child.kill();
      } else {
        try { process.kill(-child.pid,"SIGTERM"); } catch { /* Group already exited. */ }
      }
    };
    signal?.addEventListener("abort",abort,{once:true});
    if (signal?.aborted) abort();
    // A dismissed/closed/failed GUI never becomes approval. The journal remains the authority.
    child.on("error", () => { signal?.removeEventListener("abort",abort); reject(new Error("Approval window unavailable or cancelled; no write sent")); });
    child.on("close", (code) => {
      signal?.removeEventListener("abort",abort);
      if (code === 0 && !signal?.aborted) resolve();
      else reject(new Error("Change rejected or approval window closed; no write sent"));
    });
  });
}
