import keytar from "keytar";
import { randomBytes } from "node:crypto";

const SERVICE = process.env.KEYCHAIN_SERVICE ?? "mcp-standardnotes";

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

export async function saveSession(
  email: string,
  session: StoredSession,
): Promise<void> {
  if (!email) throw new Error("email required");
  await keytar.setPassword(SERVICE, email, JSON.stringify(session));
}

export async function loadSession(
  email: string,
): Promise<StoredSession | null> {
  if (!email) throw new Error("email required");
  const raw = await keytar.getPassword(SERVICE, email);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    throw new Error("Stored session is corrupt; run `npm run login` again.");
  }
}

export async function resolveEmail(serverUrl: string): Promise<string> {
  if (process.env.SN_EMAIL) return process.env.SN_EMAIL;
  const credentials = await keytar.findCredentials(SERVICE);
  const matches = credentials.filter(({ password }) => {
    try { return (JSON.parse(password) as StoredSession).serverUrl === serverUrl; }
    catch { return false; }
  });
  if (matches.length !== 1) throw new Error("Log in interactively first; set SN_EMAIL only if you have multiple accounts");
  return matches[0]!.account;
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

export async function deleteSession(email: string): Promise<boolean> {
  return keytar.deletePassword(SERVICE, email);
}
