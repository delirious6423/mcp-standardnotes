import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClientFromSession, type SnClient } from "../sn/client.js";
import { SnApiError } from "../sn/http.js";
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

// One synced client per process: after the first call, each call sends a delta sync instead of
// downloading the whole vault. Dropped after any error so the next call starts from a clean sync.
let cached: { key: string; masterKeyHex: string; client: SnClient } | undefined;

/** Test hook: forget the per-process client. */
export function resetClientCache(): void {
  cached = undefined;
}

// After HTTP 429 every process for this account waits out Retry-After without sending requests.
const RATE_LIMIT_FILE = "rate-limited-until.json";
const MAX_WAIT_MS = 2 * 3600_000;
const DEFAULT_WAIT_MS = 600_000;

async function rateLimitedUntil(dir: string): Promise<number> {
  try {
    const until = Number((JSON.parse(await readFile(path.join(dir, RATE_LIMIT_FILE), "utf8")) as { until?: unknown }).until);
    // A malformed or implausibly distant marker is ignored rather than locking the account out.
    return Number.isFinite(until) && until - Date.now() <= MAX_WAIT_MS ? until : 0;
  } catch {
    return 0;
  }
}

async function recordRateLimit(dir: string, error: SnApiError): Promise<void> {
  const seconds = Number((error.payload as { retryAfter?: unknown } | undefined)?.retryAfter);
  const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_WAIT_MS) : DEFAULT_WAIT_MS;
  await writeFile(path.join(dir, RATE_LIMIT_FILE), JSON.stringify({ until: Date.now() + wait }), { mode: 0o600 });
}

/** `email` is the single identity that opened this account directory, keychain session and journal. */
export async function withAccount<T>(fn: (client: () => Promise<SnClient>, journal: () => Promise<WriteJournal>, email: string) => Promise<T>): Promise<T> {
  const serverUrl = configuredServerUrl();
  const email = await resolveEmail(serverUrl);
  const dir = await stateDirectory(serverUrl, email);
  return withAccountLock(dir, async () => {
    const client = async (): Promise<SnClient> => {
      const until = await rateLimitedUntil(dir);
      if (until > Date.now()) {
        throw new Error(`Rate limited by Standard Notes until ${new Date(until).toISOString()} (about ${Math.ceil((until - Date.now()) / 60_000)} min). No request was sent. Wait; do not retry in a loop.`);
      }
      await rm(path.join(dir, RATE_LIMIT_FILE), { force: true });
      const stored = await loadSession(email);
      if (!stored || stored.serverUrl !== serverUrl || stored.email !== email) {
        throw new Error("Keychain session does not match this account/server; sign in with `standardnotes-mcp login` in your terminal");
      }
      const key = `${serverUrl}\n${email}`;
      if (cached && cached.key === key && cached.masterKeyHex === stored.masterKeyHex) {
        // Another process may have rotated the tokens; the keychain copy is current under this lock.
        const { access_token: access, refresh_token: refresh } = stored.sessionPayload;
        const used = cached.client.sessionTokens();
        if (used.access !== access || used.refresh !== refresh) cached.client.adoptTokens(access, refresh);
        return cached.client;
      }
      const fresh = await createClientFromSession({ serverUrl, email });
      cached = { key, masterKeyHex: stored.masterKeyHex, client: fresh };
      return fresh;
    };
    const journal = async (): Promise<WriteJournal> => {
      const hasRecords = (await readdir(dir)).some((name) => name.endsWith(".enc"));
      return new WriteJournal(dir, await recoveryKey(path.basename(dir), !hasRecords));
    };
    try {
      return await fn(client, journal, email);
    } catch (error) {
      cached = undefined;
      if (error instanceof SnApiError && error.status === 429) await recordRateLimit(dir, error);
      throw error;
    }
  });
}

export async function withClient<T>(fn: (client: SnClient, journal: () => Promise<WriteJournal>) => Promise<T>): Promise<T> {
  return withAccount(async (client, journal) => fn(await client(), journal));
}
