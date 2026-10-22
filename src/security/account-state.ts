import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export function accountDirectory(base: string, server: string, email: string): string {
  if (!path.isAbsolute(base)) throw new Error("SN_STATE_DIR must be an absolute path on your data volume");
  const id = createHash("sha256").update(JSON.stringify([server, email])).digest("hex");
  return path.join(base, id);
}

export async function privateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) {
    throw new Error("State directory must be a real directory owned by this user");
  }
  if ((st.mode & 0o077) !== 0) throw new Error("State directory must have permissions 0700");
}

export async function atomicPrivateWrite(file: string, data: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fh = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(temp, file);
    const parent = await open(path.dirname(file), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await rm(temp, { force: true });
  }
}

async function releaseOwnedLock(lock: string, token: string): Promise<void> {
  const owner = JSON.parse(await readFile(lock, "utf8")) as { token: string };
  if (owner.token !== token) throw new Error("Refusing to release another process\u0027s account lock");
  await rm(lock);
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
  const st = await lstat(lock);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("Invalid lock file");
  const contents = await readFile(lock, "utf8");
  let owner: { pid: number; token: string };
  try { owner = JSON.parse(contents) as typeof owner; }
  catch {
    if (!allowIncomplete) throw new Error("Incomplete lock. Stop ALL clients, then explicitly use --incomplete-lock");
    const current = await lstat(lock);
    if (current.ino !== st.ino || current.dev !== st.dev || await readFile(lock, "utf8") !== contents) {
      throw new Error("Lock changed during manual recovery; refusing to remove it");
    }
    await rm(lock);
    return;
  }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Invalid lock owner; inspect manually");
  try {
    process.kill(owner.pid, 0);
    throw new Error("Lock owner is still alive; refusing to unlock");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  // Recheck owner before unlink. Recovery is a manual action, never an automatic timeout.
  if ((JSON.parse(await readFile(lock, "utf8")) as { token: string }).token !== owner.token) {
    throw new Error("Lock ownership changed");
  }
  await chmod(lock, 0o600);
  await rm(lock);
}
