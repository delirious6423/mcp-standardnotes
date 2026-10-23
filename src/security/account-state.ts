import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { durablePrivateRename, openPrivateFile, privateDirectory, protectNewPrivateFile, sameFile } from "./private-fs.js";

export { privateDirectory } from "./private-fs.js";

export function accountDirectory(base: string, server: string, email: string): string {
  if (!path.isAbsolute(base)) throw new Error("SN_STATE_DIR must be an absolute path on your data volume");
  const id = createHash("sha256").update(JSON.stringify([server, email])).digest("hex");
  return path.join(base, id);
}

export async function atomicPrivateWrite(file: string, data: string): Promise<void> {
  await privateDirectory(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  const fh = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      await protectNewPrivateFile(temp, fh);
      await fh.writeFile(data, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await durablePrivateRename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

async function lockSnapshot(lock: string) {
  const fh = await openPrivateFile(lock);
  try { return { stat: await fh.stat({ bigint: true }), contents: await fh.readFile("utf8") }; }
  finally { await fh.close(); }
}

async function removeUnchangedLock(lock: string, previous: Awaited<ReturnType<typeof lockSnapshot>>): Promise<void> {
  const current = await lockSnapshot(lock);
  if (!sameFile(previous.stat, current.stat) || previous.contents !== current.contents) {
    throw new Error("Lock changed during recovery; refusing to remove it");
  }
  await rm(lock);
}

async function releaseOwnedLock(lock: string, token: string): Promise<void> {
  const previous = await lockSnapshot(lock);
  const owner = JSON.parse(previous.contents) as { token: string };
  if (owner.token !== token) throw new Error("Refusing to release another process's account lock");
  await removeUnchangedLock(lock, previous);
}

// No stale-lock guessing: a killed process leaves the account blocked until explicit recovery.
export async function withAccountLock<T>(dir: string, action: () => Promise<T>): Promise<T> {
  await privateDirectory(dir);
  const lock = path.join(dir, "account.lock");
  const token = randomUUID();
  let fh;
  try {
    fh = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Account is busy or has an unrecovered lock. Retry later; after a crash use the unlock command.");
    }
    throw err;
  }
  try {
    await protectNewPrivateFile(lock, fh);
    await fh.writeFile(JSON.stringify({ pid: process.pid, token }));
    await fh.sync();
    return await action();
  } finally {
    await fh.close();
    await releaseOwnedLock(lock, token);
  }
}

export async function unlockAbandonedAccount(dir: string, allowIncomplete = false): Promise<void> {
  await privateDirectory(dir);
  const lock = path.join(dir, "account.lock");
  const previous = await lockSnapshot(lock);
  const { contents } = previous;
  let owner: { pid: number; token: string };
  try { owner = JSON.parse(contents) as typeof owner; }
  catch {
    if (!allowIncomplete) throw new Error("Incomplete lock. Stop ALL clients, then explicitly use --incomplete-lock");
    await removeUnchangedLock(lock, previous);
    return;
  }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Invalid lock owner; inspect manually");
  try {
    process.kill(owner.pid, 0);
    throw new Error("Lock owner is still alive; refusing to unlock");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  // Check both inode and exact contents, even when a replacement copied the token.
  await removeUnchangedLock(lock, previous);
}
