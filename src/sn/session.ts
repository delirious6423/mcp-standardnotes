import keytar from "keytar";
import { randomBytes } from "node:crypto";

const SERVICE = process.env.KEYCHAIN_SERVICE || "mcp-standardnotes";

export interface StoredSession {
  serverUrl: string;
  email: string;
  sessionPayload: {
    access_token: string;
    refresh_token: string;
  };
  /** Hex-encoded 32-byte root master key. Required for local decryption on resume. */
  masterKeyHex: string;
  keyParams: unknown;
  /** Last sync_token from the server, used to incremental-sync on restart. */
  syncToken?: string | null;
  savedAt: string;
}

// One keychain entry per server and account: the same email on two servers must not share a session.
// Entries written before this were keyed by email alone; they are still read (only for the server they
// name) and move to the new key on the next save.
function sessionKey(serverUrl: string, email: string): string {
  return `${email} (${serverUrl})`;
}

function parse(raw: string): StoredSession {
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    throw new Error("Stored session is corrupt; run `standardnotes-mcp login` again.");
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  if (!session.email || !session.serverUrl) throw new Error("email and server required");
  await keytar.setPassword(SERVICE, sessionKey(session.serverUrl, session.email), JSON.stringify(session));
  const legacy = await keytar.getPassword(SERVICE, session.email);
  if (legacy) {
    const old = (() => { try { return JSON.parse(legacy) as StoredSession; } catch { return null; } })();
    if (old?.serverUrl === session.serverUrl && old.email === session.email) await keytar.deletePassword(SERVICE, session.email);
  }
}

export async function loadSession(serverUrl: string, email: string): Promise<StoredSession | null> {
  if (!email) throw new Error("email required");
  const current = await keytar.getPassword(SERVICE, sessionKey(serverUrl, email));
  const raw = current ?? await keytar.getPassword(SERVICE, email);
  if (!raw) return null;
  const session = parse(raw);
  // A legacy entry for another server, or an entry whose contents name another account, is not this session.
  return session.serverUrl === serverUrl && session.email === email ? session : null;
}

export async function resolveEmail(serverUrl: string): Promise<string> {
  if (process.env.SN_EMAIL) return process.env.SN_EMAIL;
  const emails = new Set<string>();
  for (const { password } of await keytar.findCredentials(SERVICE)) {
    try {
      const session = JSON.parse(password) as StoredSession;
      if (session.serverUrl === serverUrl && session.email) emails.add(session.email);
    } catch { /* not a session entry */ }
  }
  if (emails.size !== 1) throw new Error("Log in interactively first; set SN_EMAIL only if you have multiple accounts");
  return [...emails][0]!;
}

// A separate key survives account password changes and logout; never put it in files or tool results.
export async function recoveryKey(accountId: string, allowCreate: boolean): Promise<Uint8Array> {
  const service = `${SERVICE}-recovery`;
  let key = await keytar.getPassword(service, accountId);
  if (!key) {
    if (!allowCreate) throw new Error("Recovery key missing from OS keychain; preserve existing journal files");
    key = randomBytes(32).toString("hex");
    await keytar.setPassword(service, accountId, key);
  }
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("Invalid recovery key in OS keychain");
  return new Uint8Array(Buffer.from(key, "hex"));
}

/** Removes this server's session for the account, in either key format. */
export async function deleteSession(serverUrl: string, email: string): Promise<boolean> {
  const removed = await keytar.deletePassword(SERVICE, sessionKey(serverUrl, email));
  const legacy = await keytar.getPassword(SERVICE, email);
  if (legacy && (() => { try { return (JSON.parse(legacy) as StoredSession).serverUrl === serverUrl; } catch { return false; } })()) {
    return (await keytar.deletePassword(SERVICE, email)) || removed;
  }
  return removed;
}
