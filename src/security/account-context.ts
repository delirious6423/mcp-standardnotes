import { readdir } from "node:fs/promises";
import path from "node:path";
import { createClientFromSession, type SnClient } from "../sn/client.js";
import { loadSession, recoveryKey, resolveEmail } from "../sn/session.js";
import { accountDirectory, privateDirectory, withAccountLock } from "./account-state.js";
import { WriteJournal } from "./write-journal.js";
import { serverUrl as configuredServerUrl } from "../sn/server-url.js";

export async function stateDirectory(server: string, email: string): Promise<string> {
  const base = process.env.SN_STATE_DIR;
  if (!base) throw new Error("SN_STATE_DIR is required; use the installed launcher");
  const dir = accountDirectory(base, server, email);
  await privateDirectory(base);
  return dir;
}

/** `email` is the single identity that opened this account directory, keychain session and journal. */
export async function withAccount<T>(fn: (client: () => Promise<SnClient>, journal: () => Promise<WriteJournal>, email: string) => Promise<T>): Promise<T> {
  const serverUrl = configuredServerUrl();
  const email = await resolveEmail(serverUrl);
  const dir = await stateDirectory(serverUrl, email);
  return withAccountLock(dir, async () => {
    const client = async (): Promise<SnClient> => {
      const stored = await loadSession(email);
      if (!stored || stored.serverUrl !== serverUrl || stored.email !== email) {
        throw new Error("Keychain session does not match this account/server; sign in with `standardnotes-mcp login` in your terminal");
      }
      return createClientFromSession({ serverUrl, email });
    };
    const journal = async (): Promise<WriteJournal> => {
      const hasRecords = (await readdir(dir)).some((name) => name.endsWith(".enc"));
      return new WriteJournal(dir, await recoveryKey(path.basename(dir), !hasRecords));
    };
    return fn(client, journal, email);
  });
}

export async function withClient<T>(fn: (client: SnClient, journal: () => Promise<WriteJournal>) => Promise<T>): Promise<T> {
  return withAccount(async (client, journal) => fn(await client(), journal));
}
