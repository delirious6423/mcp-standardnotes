import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PreparedChange, SafeChange, SnClient } from "../sn/client.js";
import type { BatchPreview } from "../sn/batch-preview.js";
import { decryptString, encryptString } from "../sn/protocol004.js";
import { atomicPrivateWrite, privateDirectory } from "./account-state.js";
import { openPrivateFile } from "./private-fs.js";

interface RecordEntry {
  version: 1;
  id: string;
  createdAt: string;
  status: "prepared" | "attempted" | "uncertain" | "committed" | "rejected";
  approvedAt?: string;
  /** Exactly one of plan (single write) or batch (one approval, many writes). */
  plan?: PreparedChange;
  batch?: { plans: PreparedChange[]; preview: BatchPreview; unconfirmed?: string[] };
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
    if (value.version !== 1 || value.id !== id || Boolean(value.plan) === Boolean(value.batch?.plans.length) || !["prepared", "attempted", "uncertain", "committed", "rejected"].includes(value.status)) {
      throw new Error("Invalid encrypted operation record");
    }
    return value;
  }

  async prepare(client: SnClient, change: SafeChange): Promise<unknown> {
    return this.store({ plan: await client.prepareChange(change) });
  }

  async prepareBatch(client: SnClient, changes: SafeChange[]): Promise<unknown> {
    return this.store({ batch: await client.prepareChanges(changes) });
  }

  private async store(work: { plan: PreparedChange } | { batch: { plans: PreparedChange[]; preview: BatchPreview } }): Promise<Record<string, unknown>> {
    const record: RecordEntry = {
      version: 1, id: randomUUID(), createdAt: new Date().toISOString(), status: "prepared", ...work,
    };
    await this.save(record);
    return { operationId: record.id, status: record.status, preview: previewOf(record),
      expiresAt: new Date(Date.parse(record.createdAt) + 3600_000).toISOString(),
      next: "Call writes_commit with this operationId. A local review window will ask you to approve or reject before any write. You can also review pending edits in Standard Notes Agent Connection." };
  }

  async preview(id: string): Promise<{operationId: string; status: RecordEntry["status"]; approved: boolean; preview: unknown; createdAt: string; expiresAt: string}> {
    const record = await this.read(id);
    return { operationId: id, status: record.status, approved: Boolean(record.approvedAt), preview: previewOf(record),
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
    if (record.batch) return this.commitBatch(client, record, reconcileOnly, signal);
    try {
      await client.commitChange(record.plan!, { reconcileOnly, ...(signal ? {signal} : {}) });
    } catch {
      record.status = "uncertain";
      await this.save(record);
      throw new Error(`Operation ${id} was not confirmed. Do not prepare a replacement or blindly retry. Inspect the note and retry THIS operation ID to reconcile only (never resubmit); encrypted recovery data is retained.`);
    }
    record.status = "committed";
    await this.save(record);
    return { operationId: id, status: "committed", uuid: record.plan!.after.uuid };
  }

  private async commitBatch(client: SnClient, record: RecordEntry, reconcileOnly: boolean, signal?: AbortSignal): Promise<unknown> {
    const batch = record.batch!;
    const total = batch.plans.length;
    let outcome: { confirmed: string[]; unconfirmed: string[] };
    try {
      outcome = await client.commitChanges(batch.plans, { reconcileOnly, ...(signal ? {signal} : {}) });
    } catch (error) {
      record.status = "uncertain";
      await this.save(record);
      if (error instanceof Error && error.message.endsWith("nothing was sent")) {
        throw new Error(`Batch ${record.id}: an item changed after preview, so nothing was sent. Re-read the items and prepare a new batch.`);
      }
      throw new Error(`Batch ${record.id} was not confirmed. Do not prepare a replacement or blindly retry. Retry THIS operation ID to reconcile only (never resubmits); encrypted recovery data is retained.`);
    }
    if (outcome.unconfirmed.length > 0) {
      record.status = "uncertain";
      batch.unconfirmed = outcome.unconfirmed;
      await this.save(record);
      throw new Error(`Batch ${record.id}: ${outcome.confirmed.length} of ${total} writes confirmed, ${outcome.unconfirmed.length} not. Nothing is resent automatically. Retry THIS operation ID to reconcile; writes_status lists the unconfirmed items. For items that still show their old content, prepare a new batch.`);
    }
    record.status = "committed";
    delete batch.unconfirmed;
    await this.save(record);
    return { operationId: record.id, status: "committed", items: total };
  }

  async status(id: string): Promise<unknown> {
    const record = await this.read(id);
    return { operationId: id, status: record.status, approved: Boolean(record.approvedAt), createdAt: record.createdAt,
      ...(record.plan ? { uuid: record.plan.after.uuid }
        : { items: record.batch!.plans.length, unconfirmed: record.batch!.unconfirmed }),
      note: record.status === "attempted" || record.status === "uncertain"
        ? "Remote outcome may be unknown; retry the same operation ID, not a new create/append."
        : undefined };
  }

  async prepareUndo(client: SnClient, id: string): Promise<unknown> {
    const record = await this.read(id);
    // A partly applied batch can be undone for the items that landed; everything else needs a confirmed outcome.
    const partialBatch = record.status === "uncertain" && Boolean(record.batch);
    if (record.status !== "committed" && !partialBatch) throw new Error("Only confirmed operations can be undone; reconcile the original first");
    if (record.batch) {
      const { skipped, ...batch } = await client.prepareRecoveries(record.batch.plans, { appliedOnly: partialBatch });
      return { ...(await this.store({ batch })), ...(skipped.length ? { skipped } : {}) };
    }
    return this.store({ plan: await client.prepareRecovery(record.plan!) });
  }
}

function previewOf(record: RecordEntry): unknown {
  return record.plan ? record.plan.preview : record.batch!.preview;
}
