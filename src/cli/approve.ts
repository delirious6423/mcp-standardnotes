#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { z } from "zod";
import { accountDirectory, privateDirectory, withAccountLock } from "../security/account-state.js";
import { WriteJournal } from "../security/write-journal.js";
import { recoveryKey, resolveEmail } from "../sn/session.js";

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Approval requires your interactive terminal, not piped input");
  const id = z.string().uuid().parse(process.argv[2]);
  const server = process.env.SN_SERVER_URL ?? "https://api.standardnotes.com";
  const base = process.env.SN_STATE_DIR;
  if (!base) throw new Error("SN_STATE_DIR is required");
  const dir = accountDirectory(base, server, await resolveEmail(server));
  await privateDirectory(base);
  // Never hold the account lock while the human reads; re-check the immutable record at approval.
  const journal = new WriteJournal(dir, await recoveryKey(path.basename(dir), false));
  const preview = await journal.preview(id);
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try { answer = await terminal.question(`Type approve ${id} to allow exactly this operation: `); }
  finally { terminal.close(); }
  if (answer !== `approve ${id}`) throw new Error("Not approved; no remote changes made");
  await withAccountLock(dir, () => journal.approve(id));
  process.stdout.write("Approved. The agent may now commit this exact operation.\n");
}
main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : "Approval failed"}\n`);
  process.exitCode = 1;
});
