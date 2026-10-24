#!/usr/bin/env node
import { accountDirectory, privateDirectory, unlockAbandonedAccount } from "../security/account-state.js";
import { resolveEmail } from "../sn/session.js";
import { configureStateDirectory } from "../config.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "--clients-stopped" || args.length > 2 || (args[1] && args[1] !== "--incomplete-lock")) {
    throw new Error("Stop all Standard Notes MCP clients first, then pass --clients-stopped. Never remove a live lock.");
  }
  const server = process.env.SN_SERVER_URL ?? "https://api.standardnotes.com";
  const base = await configureStateDirectory();
  const email = await resolveEmail(server);
  const dir = accountDirectory(base, server, email);
  await privateDirectory(base);
  await unlockAbandonedAccount(dir, args[1] === "--incomplete-lock");
  process.stdout.write("Removed abandoned account lock. Encrypted operation records were preserved.\n");
}
main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : "Unlock failed"}\n`);
  process.exitCode = 1;
});
