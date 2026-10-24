#!/usr/bin/env node
import { deleteSession, resolveEmail } from "../sn/session.js";
import { serverUrl } from "../sn/server-url.js";
import { accountDirectory, privateDirectory, withAccountLock } from "../security/account-state.js";
import { configureStateDirectory } from "../config.js";

async function main(): Promise<void> {
  const server = serverUrl();
  const email = process.env.SN_EMAIL ?? process.argv[2] ?? await resolveEmail(server);
  const base = await configureStateDirectory();
  const dir = accountDirectory(base, server, email);
  await privateDirectory(base);
  const removed = await withAccountLock(dir, () => deleteSession(email));
  if (!removed) throw new Error("No login session found in the keychain");
  process.stdout.write("Login session removed. Encrypted recovery history and its separate key were preserved.\n");
}
main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : "Logout failed"}\n`);
  process.exitCode = 1;
});
