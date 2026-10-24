import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PreparedChange, SnClient } from "../sn/client.js";
import { WriteJournal } from "./write-journal.js";
import { withAccountLock, unlockAbandonedAccount, privateDirectory } from "./account-state.js";

const plan = { before: { content: "prior ciphertext" }, after: { uuid: "11111111-1111-4111-8111-111111111111", content: "new ciphertext" }, preview: { title: "PRIVATE TITLE", text: "PRIVATE BODY" }, change: {kind:"note_create",title:"PRIVATE TITLE",text:"PRIVATE BODY"} } as unknown as PreparedChange;
const fake = () => ({ prepareChange: vi.fn(async () => plan), commitChange: vi.fn(async () => undefined), prepareRecovery: vi.fn(async () => plan) }) as unknown as SnClient;

async function fixture(fn: (dir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sn-journal-"));
  const dir = path.join(root,"private");
  try { await privateDirectory(dir); await fn(dir); } finally { await rm(root, { recursive: true, force: true }); }
}

// Windows private-file checks launch PowerShell, about a second each.
describe("encrypted write journal", { timeout: 120_000 }, () => {
  it("stores no plaintext and reopens in another instance; repeat commit is idempotent", async () => fixture(async (dir) => {
    const key = new Uint8Array(32).fill(23);
    const client = fake();
    const journal = new WriteJournal(dir, key);
    const prepared = await journal.prepare(client, {kind:"note_create",title:"PRIVATE TITLE",text:"PRIVATE BODY"}) as {operationId:string};
    const file = path.join(dir, `${prepared.operationId}.enc`);
    const bytes = await readFile(file, "utf8");
    expect(bytes).not.toContain("PRIVATE");
    expect(bytes).not.toContain("ciphertext");
    if(process.platform!=="win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    const reopened = new WriteJournal(dir, key);
    await expect(reopened.commit(client, prepared.operationId)).rejects.toThrow(/approval required/);
    expect(client.commitChange).not.toHaveBeenCalled();
    await reopened.approve(prepared.operationId);
    await reopened.commit(client, prepared.operationId);
    expect(await reopened.commit(client, prepared.operationId)).toMatchObject({status:"committed",replay:true});
    expect(client.commitChange).toHaveBeenCalledTimes(1);
    expect(await reopened.status(prepared.operationId)).toMatchObject({status:"committed"});
    expect(await reopened.prepareUndo(client, prepared.operationId)).toMatchObject({status:"prepared"});
  }));
  it("records uncertainty before allowing reconciliation of the SAME plan", async () => fixture(async (dir) => {
    const c = fake();
    vi.mocked(c.commitChange).mockRejectedValueOnce(new Error("timeout after server write"));
    const j = new WriteJournal(dir, new Uint8Array(32).fill(7));
    const {operationId} = await j.prepare(c, {kind:"note_create",title:"t",text:"b"}) as {operationId:string};
    await j.approve(operationId);
    await expect(j.commit(c, operationId)).rejects.toThrow(/THIS operation ID/);
    expect(await j.status(operationId)).toMatchObject({status:"uncertain"});
    await expect(j.prepareUndo(c, operationId)).rejects.toThrow(/confirmed/);
    await j.commit(c, operationId);
    expect(vi.mocked(c.commitChange).mock.calls[0]?.[0]).toEqual(vi.mocked(c.commitChange).mock.calls[1]?.[0]);
    expect(vi.mocked(c.commitChange).mock.calls[0]?.[1]).toEqual({reconcileOnly:false});
    expect(vi.mocked(c.commitChange).mock.calls[1]?.[1]).toEqual({reconcileOnly:true});
  }));
  it("rejects wrong keys, tampering, path traversal, and symlink records", async () => fixture(async (dir) => {
    const j = new WriteJournal(dir, new Uint8Array(32).fill(7));
    const {operationId} = await j.prepare(fake(), {kind:"note_create",title:"t",text:"b"}) as {operationId:string};
    await expect(new WriteJournal(dir,new Uint8Array(32).fill(8)).status(operationId)).rejects.toThrow();
    await expect(j.status("../../escape")).rejects.toThrow();
    const file = path.join(dir,`${operationId}.enc`);
    const original = await readFile(file,"utf8");
    await writeFile(file, original.replace(/:(.)/, (_match, first: string) => `:${first === "0" ? "1" : "0"}`));
    await expect(j.status(operationId)).rejects.toThrow();
    await rm(file);
    await symlink(process.platform === "win32" ? dir : "/etc/passwd", file, process.platform === "win32" ? "junction" : undefined);
    await expect(j.status(operationId)).rejects.toThrow();
  }));
  it("durably rejects a preview and prevents approval or any network write", async () => fixture(async (dir) => {
    const c=fake(), key=new Uint8Array(32).fill(4), j=new WriteJournal(dir,key);
    const {operationId}=await j.prepare(c,{kind:"note_create",title:"t",text:"b"}) as {operationId:string};
    expect(await j.pending()).toMatchObject([{operationId,approved:false}]);
    await j.approve(operationId);
    expect(await j.preview(operationId)).toMatchObject({approved:true});
    await j.reject(operationId);
    const reopened=new WriteJournal(dir,key);
    expect(await reopened.status(operationId)).toMatchObject({status:"rejected"});
    expect(await reopened.pending()).toEqual([]);
    await expect(reopened.approve(operationId)).rejects.toThrow(/fresh/);
    await expect(reopened.commit(c,operationId)).rejects.toThrow(/rejected/);
    expect(c.commitChange).not.toHaveBeenCalled();
  }));
  it("rejects expired unused previews without a network write", async () => fixture(async (dir) => {
    const c = fake(); const j = new WriteJournal(dir,new Uint8Array(32).fill(9));
    const {operationId} = await j.prepare(c,{kind:"note_create",title:"t",text:"b"}) as {operationId:string};
    const now = vi.spyOn(Date,"now").mockReturnValue(Date.now()+3600_001);
    try { await expect(j.commit(c,operationId)).rejects.toThrow(/expired/); }
    finally { now.mockRestore(); }
    expect(c.commitChange).not.toHaveBeenCalled();
  }));
});

describe("account-wide cross-process exclusion", { timeout: 120_000 }, () => {
  it("rejects concurrent access, refuses live-owner unlock, releases after errors", async () => fixture(async(dir)=>{
    await withAccountLock(dir,async()=>{
      await expect(withAccountLock(dir,async()=>undefined)).rejects.toThrow(/busy/);
      await expect(unlockAbandonedAccount(dir)).rejects.toThrow(/alive/);
    });
    await expect(withAccountLock(dir,async()=>{throw new Error("test");})).rejects.toThrow("test");
    expect(await readdir(dir)).not.toContain("account.lock");
    await withAccountLock(dir,async()=>undefined);
    await writeFile(path.join(dir,"account.lock"),"",{mode:0o600});
    await expect(unlockAbandonedAccount(dir)).rejects.toThrow(/Incomplete/);
    await unlockAbandonedAccount(dir,true);
    expect(await readdir(dir)).not.toContain("account.lock");
  }));

  it("approves a batch once, records partial outcomes per item, and reconciles without resending", async () => fixture(async (dir) => {
    const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
    const plans = [{ ...plan, after: { uuid: a } }, { ...plan, after: { uuid: b } }] as unknown as PreparedChange[];
    const preview = { kind: "batch", items: 2, counts: { note_trash: 2 }, plan: [{ title: "PRIVATE TITLE" }] };
    const c = { ...fake(),
      prepareChanges: vi.fn(async () => ({ plans, preview })),
      prepareRecoveries: vi.fn(async () => ({ plans, preview, skipped: [] as unknown[] })),
      commitChanges: vi.fn().mockResolvedValueOnce({ confirmed: [a], unconfirmed: [b] }).mockResolvedValue({ confirmed: [a, b], unconfirmed: [] }),
    } as unknown as SnClient;
    const j = new WriteJournal(dir, new Uint8Array(32).fill(9));
    const prepared = await j.prepareBatch(c, []) as { operationId: string; preview: unknown };
    expect(prepared.preview).toEqual(preview);
    expect(await readFile(path.join(dir, `${prepared.operationId}.enc`), "utf8")).not.toContain("PRIVATE");
    expect((await j.preview(prepared.operationId)).preview).toEqual(preview);
    await expect(j.commit(c, prepared.operationId)).rejects.toThrow(/approval required/);
    await j.approve(prepared.operationId);
    await expect(j.commit(c, prepared.operationId)).rejects.toThrow(/1 of 2 writes confirmed/);
    expect(await j.status(prepared.operationId)).toMatchObject({ status: "uncertain", items: 2, unconfirmed: [b] });
    expect(await j.prepareUndo(c, prepared.operationId)).toMatchObject({ status: "prepared" });
    expect(c.prepareRecoveries).toHaveBeenLastCalledWith(plans, { appliedOnly: true });
    expect(await j.commit(c, prepared.operationId)).toMatchObject({ status: "committed", items: 2 });
    expect(vi.mocked(c.commitChanges).mock.calls.map((call) => call[1])).toEqual([{ reconcileOnly: false }, { reconcileOnly: true }]);
    expect(c.commitChange).not.toHaveBeenCalled();
    expect(await j.prepareUndo(c, prepared.operationId)).toMatchObject({ status: "prepared", preview });
    expect(c.prepareRecoveries).toHaveBeenLastCalledWith(plans, { appliedOnly: false });
    vi.mocked(c.prepareRecoveries).mockResolvedValueOnce({ plans, preview, skipped: [{ uuid: a, reason: "tag_create" }] } as never);
    expect(await j.prepareUndo(c, prepared.operationId)).toMatchObject({ skipped: [{ uuid: a, reason: "tag_create" }] });
    const conflicted = await j.prepareBatch(c, []) as { operationId: string };
    await j.approve(conflicted.operationId);
    vi.mocked(c.commitChanges).mockRejectedValueOnce(new Error(`Conflict on ${a}: expected item changed, disappeared, or UUID collided; nothing was sent`));
    await expect(j.commit(c, conflicted.operationId)).rejects.toThrow(/nothing was sent. Re-read/);
  }));
});
