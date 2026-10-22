import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PreparedChange, SafeChange, SnClient } from "../sn/client.js";
import { decryptString, encryptString } from "../sn/protocol004.js";
import { atomicPrivateWrite, privateDirectory } from "./account-state.js";

interface RecordEntry {
  version: 1;
  id: string;
  createdAt: string;
  status: "prepared" | "attempted" | "uncertain" | "committed";
  approvedAt?: string;
  plan: PreparedChange;
}

export class WriteJournal {
  constructor(private readonly dir: string, private readonly key: Uint8Array) {}

  async hasRecords(): Promise<boolean> {
    await privateDirectory(this.dir);
    return (await readdir(this.dir)).some((name) => name.endsWith(".enc"));
  }

  private file(id: string): string {
    z.string().uuid().parse(id);
    return path.join(this.dir, `${id}.enc`);
  }

  private async save(record: RecordEntry): Promise<void> {
    await privateDirectory(this.dir);
    const sealed = await encryptString(JSON.stringify(record), this.key, { u: record.id, v: "004" });
    await atomicPrivateWrite(this.file(record.id), sealed);
  }

  private async read(id: string): Promise<RecordEntry> {
    const fh = await open(this.file(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    let sealed: string;
    try {
      const st = await fh.stat();
      if (!st.isFile() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) {
        throw new Error("Journal file must be a private, user-owned regular file");
      }
      sealed = await fh.readFile("utf8");
    } finally { await fh.close(); }
    const value = JSON.parse(await decryptString(sealed, this.key, id)) as RecordEntry;
    if (value.version !== 1 || value.id !== id || !value.plan || !["prepared", "attempted", "uncertain", "committed"].includes(value.status)) {
      throw new Error("Invalid encrypted operation record");
    }
    return value;
  }

  async prepare(client: SnClient, change: SafeChange): Promise<unknown> {
    return this.store(await client.prepareChange(change));
  }

  private async store(plan: PreparedChange): Promise<unknown> {
    const record: RecordEntry = {
      version: 1, id: randomUUID(), createdAt: new Date().toISOString(), status: "prepared", plan,
    };
    await this.save(record);
    return { operationId: record.id, status: record.status, preview: plan.preview,
      expiresAt: new Date(Date.parse(record.createdAt) + 3600_000).toISOString(),
      next: `Review and approve in your terminal: standardnotes-mcp approve ${record.id}. Then call writes_commit with this operationId. MCP cannot approve its own writes.` };
  }

  async preview(id: string): Promise<unknown> {
    const record = await this.read(id);
    return { operationId: id, status: record.status, preview: record.plan.preview };
  }

  // Only the interactive approval CLI calls this; it is deliberately not an MCP tool.
  async approve(id: string): Promise<void> {
    const record = await this.read(id);
    if (record.status !== "prepared" || Date.now() - Date.parse(record.createdAt) > 3600_000) {
      throw new Error("Only fresh, uncommitted previews can be approved");
    }
    record.approvedAt = new Date().toISOString();
    await this.save(record);
  }

  async commit(client: SnClient, id: string): Promise<unknown> {
    const record = await this.read(id);
    if (record.status === "committed") return { operationId: id, status: "committed", replay: true };
    if (record.status === "prepared" && Date.now() - Date.parse(record.createdAt) > 3600_000) {
      throw new Error("Preview expired; prepare a fresh operation");
    }
    if (!record.approvedAt) throw new Error(`Terminal approval required: standardnotes-mcp approve ${id}`);
    const reconcileOnly = record.status !== "prepared";
    // Durable encrypted before+after records MUST precede any remote write.
    record.status = "attempted";
    await this.save(record);
    try {
      await client.commitChange(record.plan, { reconcileOnly });
    } catch {
      record.status = "uncertain";
      await this.save(record);
      throw new Error(`Operation ${id} was not confirmed. Do not prepare a replacement or blindly retry. Inspect the note and retry THIS operation ID to reconcile only (never resubmit); encrypted recovery data is retained.`);
    }
    record.status = "committed";
    await this.save(record);
    return { operationId: id, status: "committed", uuid: record.plan.after.uuid };
  }

  async status(id: string): Promise<unknown> {
    const record = await this.read(id);
    return { operationId: id, status: record.status, createdAt: record.createdAt,
      uuid: record.plan.after.uuid,
      note: record.status === "attempted" || record.status === "uncertain"
        ? "Remote outcome may be unknown; retry the same operation ID, not a new create/append."
        : undefined };
  }

  async prepareUndo(client: SnClient, id: string): Promise<unknown> {
    const record = await this.read(id);
    if (record.status !== "committed") throw new Error("Only confirmed operations can be undone; reconcile the original first");
    return this.store(await client.prepareRecovery(record.plan));
  }
}
