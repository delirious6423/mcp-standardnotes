#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { z } from "zod";
import { accountDirectory, privateDirectory, withAccountLock } from "../security/account-state.js";
import { WriteJournal } from "../security/write-journal.js";
import { recoveryKey, resolveEmail } from "../sn/session.js";
import { renderPreview, visible } from "./render-preview.js";
import { configureStateDirectory } from "../config.js";
import { serverUrl } from "../sn/server-url.js";

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Approval requires your interactive terminal, not piped input");
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const id = z.string().uuid().parse(args.find((a) => a !== "--json"));
  const server = serverUrl();
  const base = await configureStateDirectory();
  const dir = accountDirectory(base, server, await resolveEmail(server));
  await privateDirectory(base);
  // Never hold the account lock while the human reads; re-check the immutable record at approval.
  const journal = new WriteJournal(dir, await recoveryKey(path.basename(dir), false));
  const preview = await journal.preview(id);
  process.stdout.write(json ? `${visible(JSON.stringify(preview, null, 2))}\n` : renderPreview(preview));
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try { answer = await terminal.question(`Type "approve ${id}" to allow exactly this operation, or "reject" to refuse it permanently: `); }
  finally { terminal.close(); }
  if (answer.trim() === "reject") {
    await withAccountLock(dir, () => journal.reject(id));
    process.stdout.write("Rejected. This operation can never be committed.\n");
    return;
  }
  if (answer !== `approve ${id}`) throw new Error("Not approved; no remote changes made");
  await withAccountLock(dir, () => journal.approve(id));
  process.stdout.write("Approved. The agent may now commit this exact operation.\n");
}
main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : "Approval failed"}\n`);
  process.exitCode = 1;
});
