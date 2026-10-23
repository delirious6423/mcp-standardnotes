import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PreparedChange, SafeChange, SnClient } from "../sn/client.js";
import { decryptString, encryptString } from "../sn/protocol004.js";
import { atomicPrivateWrite, privateDirectory } from "./account-state.js";
import { openPrivateFile } from "./private-fs.js";

interface RecordEntry {
  version: 1;
  id: string;
  createdAt: string;
  status: "prepared" | "attempted" | "uncertain" | "committed" | "rejected";
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
    const fh = await openPrivateFile(this.file(id));
    let sealed: string;
    try { sealed = await fh.readFile("utf8"); }
    finally { await fh.close(); }
    const value = JSON.parse(await decryptString(sealed, this.key, id)) as RecordEntry;
    if (value.version !== 1 || value.id !== id || !value.plan || !["prepared", "attempted", "uncertain", "committed", "rejected"].includes(value.status)) {
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
      next: "Call writes_commit with this operationId. A local review window will ask you to approve or reject before any write. You can also review pending edits in Standard Notes Agent Connection." };
  }

  async preview(id: string): Promise<{operationId: string; status: RecordEntry["status"]; approved: boolean; preview: unknown; createdAt: string; expiresAt: string}> {
    const record = await this.read(id);
    return { operationId: id, status: record.status, approved: Boolean(record.approvedAt), preview: record.plan.preview,
      createdAt: record.createdAt, expiresAt: new Date(Date.parse(record.createdAt) + 3600_000).toISOString() };
  }

  async pending(): Promise<Array<{operationId: string; status: string; approved: boolean; createdAt: string; expiresAt: string}>> {
    const ids = (await readdir(this.dir)).filter((name) => /^[0-9a-f-]{36}\.enc$/.test(name)).map((name) => name.slice(0, -4));
    const pending = [];
    for (const id of ids) {
      const { preview: _preview, ...summary } = await this.preview(id);
      if (summary.status === "prepared" && Date.parse(summary.expiresAt) > Date.now()) pending.push(summary);
    }
    return pending;
  }

  async reject(id: string): Promise<void> {
    const record = await this.read(id);
    if (record.status === "rejected") return;
    if (record.status !== "prepared") throw new Error("Already attempted; cannot reject or assume the remote write failed");
    record.status = "rejected";
    delete record.approvedAt;
    await this.save(record);
  }

  // Only the human approval UI/CLI calls this; it is deliberately not an MCP tool.
  async approve(id: string): Promise<void> {
    const record = await this.read(id);
    if (record.status !== "prepared" || Date.now() - Date.parse(record.createdAt) > 3600_000) {
      throw new Error("Only fresh, uncommitted previews can be approved");
    }
    record.approvedAt = new Date().toISOString();
    await this.save(record);
  }

  async commit(client: SnClient, id: string, signal?: AbortSignal): Promise<unknown> {
    const record = await this.read(id);
    if (record.status === "committed") return { operationId: id, status: "committed", replay: true };
    if (record.status === "rejected") throw new Error("This operation was rejected; no write sent");
    if (record.status === "prepared" && Date.now() - Date.parse(record.createdAt) > 3600_000) {
      throw new Error("Preview expired; prepare a fresh operation");
    }
    if (!record.approvedAt) throw new Error("Human approval required in Standard Notes Agent Connection");
    const reconcileOnly = record.status !== "prepared";
    // Durable encrypted before+after records MUST precede any remote write.
    signal?.throwIfAborted();
    record.status = "attempted";
    await this.save(record);
    try {
      await client.commitChange(record.plan, { reconcileOnly, ...(signal ? {signal} : {}) });
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
    return { operationId: id, status: record.status, approved: Boolean(record.approvedAt), createdAt: record.createdAt,
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
