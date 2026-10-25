import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sync: vi.fn(), loadSession: vi.fn(), saveSession: vi.fn() }));
vi.mock("./http.js", () => ({ sync: mocks.sync, SnApiError: class extends Error {} }));
vi.mock("./session.js", () => ({ loadSession: mocks.loadSession, saveSession: mocks.saveSession }));
vi.mock("../security/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { createClientFromSession, itemRevision, type SnClient } from "./client.js";
import { decryptItemContent, encryptString, replaceItemContent } from "./protocol004.js";
import { randomBytes, toHex } from "./crypto.js";
import type { RawItem } from "./http.js";
import { NothingSentError } from "./errors.js";

// All keys and encrypted records below are synthetic; no account, keychain, or network.
const config = { serverUrl: "https://example.invalid", email: "test@example.invalid" };
const keyUuid = "11111111-1111-4111-8111-111111111111";
const noteUuid = "22222222-2222-4222-8222-222222222222";
const tagUuid = "33333333-3333-4333-8333-333333333333";
const otherUuid = "44444444-4444-4444-8444-444444444444";
let server: Map<string, RawItem>;
let keys: Map<string, Uint8Array>;
let writes: RawItem[][];
let failure: "conflict" | "missing" | "saved-mismatch" | "readback-mismatch" | "uncertain" | undefined;
let client: SnClient;

function envelope(uuid: string, content_type: string): RawItem {
  return { uuid, content_type, content: "", enc_item_key: "", items_key_id: keyUuid,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    created_at_timestamp: 1, updated_at_timestamp: 10, deleted: false };
}

async function put(uuid: string, content_type: string, content: Record<string, unknown>): Promise<RawItem> {
  const raw = envelope(uuid, content_type);
  const itemKey = await randomBytes(32);
  const aad = { u: uuid, v: "004" };
  raw.enc_item_key = await encryptString(await toHex(itemKey), keys.get(keyUuid)!, aad);
  raw.content = await encryptString(JSON.stringify(content), itemKey, aad);
  server.set(uuid, raw);
  return raw;
}

async function edit(uuid: string, changes: Record<string, unknown>): Promise<void> {
  const raw = server.get(uuid)!;
  const content = await decryptItemContent(raw, keys);
  server.set(uuid, { ...raw, content: await replaceItemContent(raw, { ...content, ...changes }, keys) });
}

async function revision(uuid = noteUuid): Promise<string> {
  return itemRevision(server.get(uuid)!);
}

beforeEach(async () => {
  vi.clearAllMocks();
  server = new Map();
  writes = [];
  failure = undefined;
  const masterKey = await randomBytes(32);
  const itemsKey = await randomBytes(32);
  keys = new Map([[keyUuid, itemsKey]]);
  const wrappingKey = await randomBytes(32);
  const aad = { u: keyUuid, v: "004", kp: { version: "004" } };
  server.set(keyUuid, { ...envelope(keyUuid, "SN|ItemsKey"), items_key_id: null,
    enc_item_key: await encryptString(await toHex(wrappingKey), masterKey, aad),
    content: await encryptString(JSON.stringify({ version: "004", itemsKey: await toHex(itemsKey) }), wrappingKey, aad),
  });
  await put(noteUuid, "Note", { title: "Original", text: "Body", noteType: "plain-text" });
  await put(tagUuid, "Tag", { title: "Tag", references: [] });
  mocks.loadSession.mockResolvedValue({ ...config, sessionPayload: { access_token: "fake", refresh_token: "fake" },
    masterKeyHex: await toHex(masterKey), keyParams: { version: "004", identifier: config.email, pw_nonce: "synthetic" } });
  mocks.saveSession.mockResolvedValue(undefined);
  mocks.sync.mockImplementation(async (_config: unknown, params: { items?: RawItem[] }) => {
    const response = { retrieved_items: [...server.values()].map((r) => ({ ...r })), saved_items: [] as RawItem[], conflicts: [] as unknown[], sync_token: "token" };
    if (!params.items?.length) return response;
    writes.push(params.items.map((r) => ({ ...r })));
    if (failure === "conflict") {
      response.conflicts = [{ type: "sync_conflict", server_item: server.get(params.items[0]!.uuid) }];
      return response;
    }
    if (failure === "missing") return response;
    for (const item of params.items) {
      expect(item.deleted).toBe(false);
      const saved = { ...item, updated_at_timestamp: item.updated_at_timestamp + 1 };
      server.set(saved.uuid, saved);
      response.saved_items.push({ ...saved });
    }
    if (failure === "uncertain") throw new Error("connection dropped after save");
    if (failure === "saved-mismatch") response.saved_items[0]!.content = "different ciphertext";
    if (failure === "readback-mismatch") {
      const saved = server.get(params.items[0]!.uuid)!;
      server.set(saved.uuid, { ...saved, content: "different ciphertext" });
    }
    return response;
  });
  client = await createClientFromSession(config);
});

describe("bounded safe writes", () => {
  it("does not transmit a mutation when cancelled during read-only preflight", async () => {
    const plan=await client.prepareChange({kind:"note_update",uuid:noteUuid,revision:await revision(),append:" cancelled"});
    const controller=new AbortController();
    const base=mocks.sync.getMockImplementation()!;
    let release!:()=>void, entered!:()=>void;
    const paused=new Promise<void>(resolve=>{release=resolve;});
    const started=new Promise<void>(resolve=>{entered=resolve;});
    mocks.sync.mockImplementationOnce(async(...args:unknown[])=>{entered();await paused;return base(...args);});
    const pending=client.commitChange(plan,{signal:controller.signal});
    const rejected=expect(pending).rejects.toThrow();
    await started;controller.abort();release();
    await rejected;
    expect(writes).toHaveLength(0);
  });
  it("does not search protected title/text or count protected matches toward the hit limit", async () => {
    await edit(noteUuid, { title: "common unique-title-secret", text: "unique-body-secret", protected: true });
    for (let i = 0; i < 5; i++) {
      await put(crypto.randomUUID(), "Note", { title: "common", text: "hidden", protected: true });
    }
    await put(otherUuid, "Note", { title: "common visible", text: "locked-readable", appData: { "org.standardnotes.sn": { locked: true } } });
    await client.sync();
    expect(await client.searchNotes("unique-title-secret", 1)).toEqual([]);
    expect(await client.searchNotes("unique-body-secret", 1)).toEqual([]);
    expect(await client.searchNotes("common", 1)).toMatchObject([{ uuid: otherUuid, locked: true }]);
    expect(await client.searchNotes("locked-readable", 1)).toMatchObject([{ uuid: otherUuid }]);
  });

  it("bounds final UTF-8 text after append, including multibyte text", async () => {
    const limit = 10 * 1024 * 1024;
    const text = "é".repeat(limit / 2);
    await edit(noteUuid, { text });
    await expect(client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), append: "é" })).rejects.toThrow(/Final note text exceeds/);
    await expect(client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), text: text + "a" })).rejects.toThrow(/Final note text exceeds/);
    await expect(client.prepareChange({ kind: "note_create", title: "Too large", text: text + "a" })).rejects.toThrow(/Final note text exceeds/);
    expect(writes).toHaveLength(0);
  });

  it("refreshes known plaintext previews and removes stale HTML derivatives only on body edits", async () => {
    await edit(noteUuid, { preview_plain: "Stale preview" });
    const text = "Updated ".repeat(30);
    const plan = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), text });
    expect(await decryptItemContent(plan.after, keys)).toMatchObject({ text, preview_plain: text.slice(0, 160) });
    await edit(noteUuid, { preview_html: "<p>Original body</p>" });
    const bodyEdit = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), append: " appended" });
    const updated = await decryptItemContent(bodyEdit.after, keys);
    expect(updated.preview_html).toBeUndefined();
    expect(updated.preview_plain).toBe("Body appended");
    const rename = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), title: "Rename is safe" });
    expect((await decryptItemContent(rename.after, keys)).preview_html).toBe("<p>Original body</p>");
    expect(writes).toHaveLength(0);
  });

  it.each([
    { protected: "true" }, { protected: null },
    { appData: "invalid" }, { appData: [] }, { appData: null },
    { appData: { "org.standardnotes.sn": "invalid" } },
    { appData: { "org.standardnotes.sn": [] } },
    { appData: { "org.standardnotes.sn": null } },
    { appData: { "org.standardnotes.sn": { locked: "true" } } },
    { appData: { "org.standardnotes.sn": { locked: null } } },
  ])("fails closed on malformed note access flags for read, write, and tag targets: %j", async (malformed) => {
    const tagPlan = await client.prepareChange({ kind: "tag_attach", uuid: tagUuid, revision: await revision(tagUuid), noteUuid });
    await edit(noteUuid, malformed);
    await expect(client.getNoteWithRevision(noteUuid)).rejects.toThrow(/Malformed note/);
    expect(await client.getNote(noteUuid)).toBeNull();
    expect(await client.searchNotes("Original", 10)).toEqual([]);
    await expect(client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), title: "No" })).rejects.toThrow(/Malformed note/);
    await expect(client.prepareChange({ kind: "tag_attach", uuid: tagUuid, revision: await revision(tagUuid), noteUuid })).rejects.toThrow(/Malformed note/);
    await expect(client.commitChange(tagPlan)).rejects.toThrow(/Malformed note/);
    expect(writes).toHaveLength(0);
  });

  it("marks every failure before the send boundary as nothing sent, and failures after it as uncertain", async () => {
    const plan = await client.prepareChange({ kind: "note_trash", uuid: noteUuid, revision: await revision() });
    const batch = await client.prepareChanges([{ kind: "note_trash", uuid: noteUuid, revision: await revision() }]);
    mocks.sync.mockRejectedValueOnce(new Error("preflight sync failed"));
    await expect(client.commitChange(plan)).rejects.toBeInstanceOf(NothingSentError);
    mocks.sync.mockRejectedValueOnce(new Error("preflight sync failed"));
    await expect(client.commitChanges(batch.plans)).rejects.toBeInstanceOf(NothingSentError);
    await edit(noteUuid, { protected: true });
    await expect(client.commitChange(plan)).rejects.toBeInstanceOf(NothingSentError);
    await expect(client.commitChanges(batch.plans)).rejects.toBeInstanceOf(NothingSentError);
    expect(writes).toHaveLength(0);
    await edit(noteUuid, { protected: false });
    const fresh = await client.prepareChange({ kind: "note_trash", uuid: noteUuid, revision: await revision() });
    failure = "uncertain";
    const sent = await client.commitChange(fresh).catch((e: unknown) => e);
    expect(sent).toBeInstanceOf(Error);
    expect(sent).not.toBeInstanceOf(NothingSentError);
    expect(writes).toHaveLength(1);
  });

  it("returns note text and revision from one sync snapshot when the next snapshot changes", async () => {
    const oldRevision = await revision();
    const calls = mocks.sync.mock.calls.length;
    mocks.sync.mockImplementationOnce(async () => {
      const retrieved_items = [...server.values()].map((raw) => ({ ...raw }));
      await edit(noteUuid, { text: "New remote body" });
      return { retrieved_items, saved_items: [], conflicts: [], sync_token: "snapshot" };
    });
    const oldRead = await client.getNoteWithRevision(noteUuid);
    expect(mocks.sync.mock.calls.length).toBe(calls + 1);
    expect(oldRead).toMatchObject({ text: "Body", revision: oldRevision });
    expect(await revision()).not.toBe(oldRevision);
    const nextRead = await client.getNoteWithRevision(noteUuid);
    expect(nextRead).toMatchObject({ text: "New remote body", revision: await revision() });
    await expect(client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: oldRead!.revision, text: "Overwrite" })).rejects.toThrow(/Stale revision/);
    expect(writes).toHaveLength(0);
  });

  it("returns tag fields and revision from one sync snapshot", async () => {
    const oldRevision = await revision(tagUuid);
    const calls = mocks.sync.mock.calls.length;
    mocks.sync.mockImplementationOnce(async () => {
      const retrieved_items = [...server.values()].map((raw) => ({ ...raw }));
      await edit(tagUuid, { title: "New remote tag", references: [{ uuid: noteUuid, content_type: "Note" }] });
      return { retrieved_items, saved_items: [], conflicts: [], sync_token: "snapshot" };
    });
    expect(await client.getTagWithRevision(tagUuid)).toMatchObject({ title: "Tag", noteUuids: [], revision: oldRevision });
    expect(mocks.sync.mock.calls.length).toBe(calls + 1);
    expect(await client.getTagWithRevision(tagUuid)).toMatchObject({ title: "New remote tag", noteUuids: [noteUuid], revision: await revision(tagUuid) });
  });

  it("previews exact plaintext before/after for creation, edits, tag references and recovery", async () => {
    const create = await client.prepareChange({ kind: "note_create", title: "New", text: "Review this exact body" });
    expect(create.preview).toMatchObject({ before: null, after: { title: "New", text: "Review this exact body", references: [] } });
    const append = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), title: "Updated", append: " plus" });
    expect(append.preview).toMatchObject({ before: { title: "Original", text: "Body" }, after: { title: "Updated", text: "Body plus" } });
    await client.commitChange(append);
    const recovery = await client.prepareRecovery(append);
    expect(recovery.preview).toMatchObject({ before: { title: "Updated", text: "Body plus" }, after: { title: "Original", text: "Body" } });
    const trash = await client.prepareChange({ kind: "note_trash", uuid: noteUuid, revision: await revision() });
    expect(trash.preview).toMatchObject({ before: { text: "Body plus" }, after: { trashed: true, text: "Body plus" } });
    const attach = await client.prepareChange({ kind: "tag_attach", uuid: tagUuid, revision: await revision(tagUuid), noteUuid });
    expect(attach.preview).toMatchObject({ before: { references: [] }, after: { references: [{ uuid: noteUuid, content_type: "Note" }] } });
    expect((append.preview as { after: unknown }).after).toEqual(await decryptItemContent(append.after, keys));
    expect((recovery.preview as { after: unknown }).after).toEqual(await decryptItemContent(recovery.after, keys));
  });

  it("preserves every unknown metadata field and reference object on note rename", async () => {
    const original = { title: "Original", text: '{"structured":"unchanged"}', noteType: "super",
      references: [{ uuid: otherUuid, content_type: "Extension", unknown: { keep: true } }],
      appData: { "org.standardnotes.sn": { pinned: true, client_updated_at: "old" }, other: { opaque: [1, 2] } },
      custom: { nested: ["keep", { value: 1 }] }, preview_plain: "Do not rewrite" };
    await put(noteUuid, "Note", original);
    const plan = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), title: "Renamed" });
    const decoded = await decryptItemContent(plan.after, keys);
    expect(decoded).toEqual({ ...original, title: "Renamed", appData: { ...original.appData,
      "org.standardnotes.sn": { ...original.appData["org.standardnotes.sn"], client_updated_at: expect.any(String) } } });
    expect(plan.before?.content).toMatch(/^004:/);
    expect(plan.after.enc_item_key).toBe(plan.before?.enc_item_key);
    expect(writes).toHaveLength(0);
    await client.commitChange(plan);
    expect(await decryptItemContent(server.get(noteUuid)!, keys)).toEqual(decoded);
  });

  it("preserves tag reference objects, unrelated same-UUID refs, and unknown content", async () => {
    const refs = [ { uuid: noteUuid, content_type: "Extension", opaque: true },
      { uuid: otherUuid, content_type: "Note", custom: { keep: 1 } },
      { uuid: tagUuid, content_type: "Tag", reference_type: "TagToParentTag", extra: 2 } ];
    await put(tagUuid, "Tag", { title: "Tag", references: refs, future: [1, 2] });
    const attach = await client.prepareChange({ kind: "tag_attach", uuid: tagUuid, revision: await revision(tagUuid), noteUuid });
    expect((await decryptItemContent(attach.after, keys)).references).toEqual([...refs, { uuid: noteUuid, content_type: "Note" }]);
    await client.commitChange(attach);
    const detach = await client.prepareChange({ kind: "tag_detach", uuid: tagUuid, revision: await revision(tagUuid), noteUuid });
    const decoded = await decryptItemContent(detach.after, keys);
    expect(decoded.references).toEqual(refs);
    expect(decoded.future).toEqual([1, 2]);
    await client.commitChange(detach);
    const rename = await client.prepareChange({ kind: "tag_update", uuid: tagUuid, revision: await revision(tagUuid), title: "Renamed" });
    expect((await decryptItemContent(rename.after, keys)).references).toEqual(refs);
  });

  it("rejects a stale revision even when only ciphertext changes and timestamp stays the same", async () => {
    const stale = await revision();
    await edit(noteUuid, { text: "Concurrent edit" });
    expect(server.get(noteUuid)!.updated_at_timestamp).toBe(10);
    expect(await revision()).not.toBe(stale);
    await expect(client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: stale, title: "No" })).rejects.toThrow(/Stale revision/);
    expect(writes).toHaveLength(0);
  });

  it("rejects a same-timestamp edit after preparation without sending", async () => {
    const plan = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), title: "No" });
    await edit(noteUuid, { title: "Concurrent" });
    await expect(client.commitChange(plan)).rejects.toThrow(/Conflict/);
    expect(writes).toHaveLength(0);
  });

  it("rejects disappeared expected items and new UUID collisions", async () => {
    const plan = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), title: "No" });
    server.set(noteUuid, { ...server.get(noteUuid)!, deleted: true });
    await expect(client.commitChange(plan)).rejects.toThrow(/disappeared/);
    const create = await client.prepareChange({ kind: "note_create", title: "New", text: "Text" });
    await put(create.after.uuid, "Note", { title: "Collision", text: "Other" });
    await expect(client.commitChange(create)).rejects.toThrow(/collided/);
    expect(writes).toHaveLength(0);
  });

  it.each(["conflict", "missing", "saved-mismatch", "readback-mismatch", "uncertain"] as const)("fails closed with no write retry on %s", async (mode) => {
    const plan = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), title: "Update" });
    failure = mode;
    await expect(client.commitChange(plan)).rejects.toThrow(/reconcile before retry/i);
    expect(writes).toHaveLength(1);
  });

  it("trashes/restores structured notes without touching the body or purging", async () => {
    const text = '{"root":{"children":[]}}';
    await edit(noteUuid, { noteType: "super", text, future: { keep: true } });
    for (const kind of ["note_trash", "note_restore"] as const) {
      const plan = await client.prepareChange({ kind, uuid: noteUuid, revision: await revision() });
      await client.commitChange(plan);
      expect(await decryptItemContent(server.get(noteUuid)!, keys)).toMatchObject({ text, future: { keep: true }, trashed: kind === "note_trash" });
    }
    // No direct-write path exists; every write goes through prepare, approval and commit.
    for (const name of ["deleteNote", "deleteTag", "createNote", "updateNote", "createTag", "updateTag", "attachTag", "detachTag"]) {
      expect(name in client).toBe(false);
    }
    expect(writes).toHaveLength(2);
  });

  it.each([ { protected: true }, { appData: { "org.standardnotes.sn": { locked: true } } } ])("enforces note protection/lock before prepare and before commit: %j", async (flag) => {
    const rename = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), title: "No" });
    const attach = await client.prepareChange({ kind: "tag_attach", uuid: tagUuid, revision: await revision(tagUuid), noteUuid });
    await edit(noteUuid, flag);
    await expect(client.prepareChange({ kind: "note_trash", uuid: noteUuid, revision: await revision() })).rejects.toThrow(/protected or locked/);
    await expect(client.prepareChange({ kind: "tag_detach", uuid: tagUuid, revision: await revision(tagUuid), noteUuid })).rejects.toThrow(/protected or locked/);
    await expect(client.commitChange(rename)).rejects.toThrow(/Conflict/);
    await expect(client.commitChange(attach)).rejects.toThrow(/protected or locked/);
    expect(writes).toHaveLength(0);
  });

  it("makes an identical plan repeat idempotent and verifies a null-token readback", async () => {
    const plan = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), append: " appended" });
    await client.commitChange(plan);
    expect(mocks.sync.mock.calls.at(-1)?.[1].syncToken).toBeUndefined();
    await client.commitChange(plan);
    expect(writes).toHaveLength(1);
    expect((await decryptItemContent(server.get(noteUuid)!, keys)).text).toBe("Body appended");
  });

  it.each(["super", "code", "future-unknown"])("refuses body edits for %s but allows rename", async (noteType) => {
    await edit(noteUuid, { noteType });
    for (const body of [{ text: "replacement" }, { append: "append" }]) {
      await expect(client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), ...body })).rejects.toThrow(/Body edits/);
    }
    await expect(client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), title: "Allowed" })).resolves.toBeDefined();
    expect(writes).toHaveLength(0);
  });

  it("refuses unknown editor bodies and simultaneous replacement/append", async () => {
    await edit(noteUuid, { editorIdentifier: "unknown-editor" });
    await expect(client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), append: "No" })).rejects.toThrow(/Body edits/);
    await expect(client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), text: "No", append: "No" })).rejects.toThrow(/not both/);
  });

  it("never embeds tags in newly created notes", async () => {
    const plan = await client.prepareChange({ kind: "note_create", title: "New", text: "Body", noteType: "markdown" });
    expect((await decryptItemContent(plan.after, keys)).references).toEqual([]);
    await client.commitChange(plan);
    expect(writes[0]).toHaveLength(1);
    expect(writes[0]![0]!.content_type).toBe("Note");
  });

  it("never resubmits a saved-then-purged note creation in reconciliation-only mode", async () => {
    const plan = await client.prepareChange({ kind: "note_create", title: "New", text: "Body" });
    failure = "uncertain";
    await expect(client.commitChange(plan)).rejects.toThrow(/reconcile before retry/i);
    expect(writes).toHaveLength(1);
    server.set(plan.after.uuid, { ...server.get(plan.after.uuid)!, deleted: true });
    failure = undefined;
    const count = writes.length;
    await expect(client.commitChange(plan, { reconcileOnly: true })).rejects.toThrow(/not confirmed; reconciliation only, no write sent/);
    expect(writes).toHaveLength(count);
    expect(server.get(plan.after.uuid)!.deleted).toBe(true);
  });

  it("refuses reconciliation-only writes even if the original before is unchanged", async () => {
    const plan = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), title: "No resubmit" });
    await expect(client.commitChange(plan, { reconcileOnly: true })).rejects.toThrow(/not confirmed; reconciliation only, no write sent/);
    expect(writes).toHaveLength(0);
    expect((await decryptItemContent(server.get(noteUuid)!, keys)).title).toBe("Original");
  });

  it("confirms exact-after ciphertext in reconciliation-only mode without any push", async () => {
    const plan = await client.prepareChange({ kind: "note_create", title: "New", text: "Body" });
    failure = "uncertain";
    await expect(client.commitChange(plan)).rejects.toThrow(/reconcile before retry/i);
    failure = undefined;
    const count = writes.length;
    await client.commitChange(plan, { reconcileOnly: true });
    expect(writes).toHaveLength(count);
  });

  it("rejects a forged purge plan before any send", async () => {
    const plan = await client.prepareChange({ kind: "note_trash", uuid: noteUuid, revision: await revision() });
    plan.after.deleted = true;
    await expect(client.commitChange(plan)).rejects.toThrow(/disabled/);
    expect(writes).toHaveLength(0);
  });

  it("restores original ciphertext using the current timestamps and preserves original metadata", async () => {
    const original = { ...server.get(noteUuid)! };
    const plan = await client.prepareChange({ kind: "note_update", uuid: noteUuid, revision: await revision(), title: "Changed" });
    await client.commitChange(plan);
    const recovery = await client.prepareRecovery(plan);
    expect(recovery.after.content).toBe(original.content);
    expect(recovery.after.enc_item_key).toBe(original.enc_item_key);
    expect(recovery.before?.updated_at_timestamp).toBe(11);
    expect(recovery.after.updated_at_timestamp).toBe(11);
    await client.commitChange(recovery);
    expect(server.get(noteUuid)!.content).toBe(original.content);
    await expect(client.prepareChange(recovery.change)).rejects.toThrow(/internal/);
  });

  it("refuses recovery over concurrent edits or protected tag targets", async () => {
    const plan = await client.prepareChange({ kind: "tag_attach", uuid: tagUuid, revision: await revision(tagUuid), noteUuid });
    await client.commitChange(plan);
    const recovery = await client.prepareRecovery(plan);
    await edit(noteUuid, { protected: true });
    await expect(client.prepareRecovery(plan)).rejects.toThrow(/protected or locked/);
    await expect(client.commitChange(recovery)).rejects.toThrow(/protected or locked/);
    await edit(tagUuid, { title: "Concurrent" });
    await expect(client.prepareRecovery(plan)).rejects.toThrow(/Recovery conflict/);
    expect(writes).toHaveLength(1);
  });

  it("undoes new note creation by trashing, and refuses undo of tag creation", async () => {
    const note = await client.prepareChange({ kind: "note_create", title: "New", text: "Body" });
    await client.commitChange(note);
    await client.commitChange(await client.prepareRecovery(note));
    expect((await decryptItemContent(server.get(note.after.uuid)!, keys)).trashed).toBe(true);
    const tag = await client.prepareChange({ kind: "tag_create", title: "New tag" });
    await client.commitChange(tag);
    await expect(client.prepareRecovery(tag)).rejects.toThrow(/cannot be undone/);
  });
});

describe("incremental sync", () => {
  it("syncs from the saved token after the first full sync, and the commit read-back starts from scratch", async () => {
    mocks.sync.mockClear();
    await client.getNoteWithRevision(noteUuid);
    await client.getNoteWithRevision(noteUuid);
    const tokens = () => mocks.sync.mock.calls.map((call) => (call[1] as { syncToken?: string; items?: unknown[] }));
    expect(tokens().every((p) => p.syncToken === "token")).toBe(true);
    const plan = await client.prepareChange({ kind: "note_trash", uuid: noteUuid, revision: await revision() });
    mocks.sync.mockClear();
    await client.commitChange(plan);
    const reads = tokens().filter((p) => !p.items?.length);
    expect(reads[0]!.syncToken).toBe("token");
    expect(reads.at(-1)!.syncToken).toBeUndefined();
  });
});

describe("batch writes", () => {
  const note2 = "55555555-5555-4555-8555-555555555555";
  const note3 = "66666666-6666-4666-8666-666666666666";
  const syncs = () => mocks.sync.mock.calls.length;
  beforeEach(async () => {
    await put(note2, "Note", { title: "Second", text: "Two", noteType: "plain-text" });
    await put(note3, "Note", { title: "Third", text: "Three", noteType: "plain-text" });
    client = await createClientFromSession(config);
    mocks.sync.mockClear();
  });

  it("composes many changes into one write per item, with one sync to prepare and one push to commit", async () => {
    const tagRev = await revision(tagUuid);
    const { plans, preview } = await client.prepareChanges([
      { kind: "tag_attach", uuid: tagUuid, revision: tagRev, noteUuid },
      { kind: "note_update", uuid: note2, revision: await revision(note2), title: "Renamed", append: " more" },
      { kind: "tag_attach", uuid: tagUuid, revision: tagRev, noteUuid: note2 },
      { kind: "note_trash", uuid: note3, revision: await revision(note3) },
      { kind: "note_create", title: "Fresh", text: "New body" },
    ]);
    expect(syncs()).toBe(1);
    expect(plans.map((p) => p.after.uuid).slice(0, 3)).toEqual([tagUuid, note2, note3]);
    expect(plans[0]!.changes).toHaveLength(2);
    expect(preview).toMatchObject({ kind: "batch", items: 4, counts: { tag_attach: 2, note_update: 1, note_trash: 1, note_create: 1 } });
    expect(preview.plan[0]!.changes.references).toEqual({ added: [
      { uuid: noteUuid, type: "Note", title: "Original" }, { uuid: note2, type: "Note", title: "Second" }], removed: [] });
    expect(preview.plan[1]!.changes).toEqual({ title: { from: "Second", to: "Renamed" }, text: { from: "Two", to: "Two more" } });
    expect(preview.plan[2]!.changes).toEqual({ trashed: { from: null, to: true } });
    expect(preview.plan[3]).toMatchObject({ created: true, title: "Fresh" });

    mocks.sync.mockClear();
    expect(await client.commitChanges(plans)).toEqual({ confirmed: plans.map((p) => p.after.uuid), unconfirmed: [] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(4);
    expect(syncs()).toBe(3);
    const tag = await decryptItemContent(server.get(tagUuid)!, keys);
    expect((tag.references as Array<{ uuid: string }>).map((r) => r.uuid)).toEqual([noteUuid, note2]);
    expect(await decryptItemContent(server.get(note2)!, keys)).toMatchObject({ title: "Renamed", text: "Two more" });
    expect(await decryptItemContent(server.get(note3)!, keys)).toMatchObject({ trashed: true, text: "Three" });
  });

  it("refuses mixed revisions, protected notes, recovery and duplicate items before any send", async () => {
    const old = await revision(note2);
    await edit(note2, { text: "changed elsewhere" });
    await expect(client.prepareChanges([{ kind: "note_trash", uuid: note2, revision: old }])).rejects.toThrow(/Stale/);
    await expect(client.prepareChanges([
      { kind: "note_update", uuid: note3, revision: await revision(note3), title: "a" },
      { kind: "note_trash", uuid: note3, revision: old },
    ])).rejects.toThrow(/Stale/);
    await edit(note3, { protected: true });
    await expect(client.prepareChanges([{ kind: "tag_attach", uuid: tagUuid, revision: await revision(tagUuid), noteUuid: note3 }])).rejects.toThrow(/protected or locked/);
    await expect(client.prepareChanges([{ kind: "recovery", uuid: noteUuid, revision: await revision() }])).rejects.toThrow(/internal/);
    const { plans } = await client.prepareChanges([{ kind: "note_trash", uuid: noteUuid, revision: await revision() }]);
    await expect(client.commitChanges([plans[0]!, plans[0]!])).rejects.toThrow(/only once/);
    expect(writes).toHaveLength(0);
  });

  it("sends nothing when any one item changed after preview", async () => {
    const { plans } = await client.prepareChanges([
      { kind: "note_trash", uuid: noteUuid, revision: await revision() },
      { kind: "note_trash", uuid: note2, revision: await revision(note2) },
    ]);
    await edit(note2, { title: "edited on phone" });
    await expect(client.commitChanges(plans)).rejects.toThrow(/Conflict on 5555.*nothing was sent/);
    expect(writes).toHaveLength(0);
  });

  it("sends nothing when a batch is cancelled during read-only preflight", async () => {
    const { plans } = await client.prepareChanges([{ kind: "note_trash", uuid: note2, revision: await revision(note2) }]);
    const controller = new AbortController();
    const base = mocks.sync.getMockImplementation()!;
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    mocks.sync.mockImplementationOnce(async (...args: unknown[]) => { entered(); await paused; return base(...args); });
    const pending = client.commitChanges(plans, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await started; controller.abort(); release();
    await rejected;
    expect(writes).toHaveLength(0);
  });

  it("reports partly saved batches item by item and never resends when reconciling", async () => {
    const { plans } = await client.prepareChanges([
      { kind: "note_trash", uuid: noteUuid, revision: await revision() },
      { kind: "note_trash", uuid: note2, revision: await revision(note2) },
    ]);
    const base = mocks.sync.getMockImplementation()!;
    mocks.sync.mockImplementation(async (cfg: unknown, params: { items?: RawItem[] }) =>
      base(cfg, params.items ? { ...params, items: params.items.filter((i) => i.uuid !== note2) } : params));
    expect(await client.commitChanges(plans)).toEqual({ confirmed: [noteUuid], unconfirmed: [note2] });
    expect(writes).toHaveLength(1);
    mocks.sync.mockImplementation(base);
    expect(await client.commitChanges(plans, { reconcileOnly: true })).toEqual({ confirmed: [noteUuid], unconfirmed: [note2] });
    expect(writes).toHaveLength(1);
  });

  it("stops sending further chunks after a server conflict or cancellation", async () => {
    const creates = Array.from({ length: 60 }, (_, i) => ({ kind: "note_create" as const, title: `N${i}`, text: "x" }));
    const first = await client.prepareChanges(creates);
    failure = "conflict";
    expect((await client.commitChanges(first.plans)).confirmed).toEqual([]);
    expect(writes).toHaveLength(1);
    failure = undefined;
    const second = await client.prepareChanges(creates);
    const controller = new AbortController();
    const base = mocks.sync.getMockImplementation()!;
    mocks.sync.mockImplementation(async (cfg: unknown, params: { items?: RawItem[] }) => {
      const res = await base(cfg, params);
      if (params.items?.length) controller.abort();
      return res;
    });
    const outcome = await client.commitChanges(second.plans, { signal: controller.signal });
    expect(writes).toHaveLength(2);
    expect([outcome.confirmed.length, outcome.unconfirmed.length]).toEqual([50, 10]);
  });

  it("undoes only the applied items of a partly saved batch and keeps created tags", async () => {
    const { plans } = await client.prepareChanges([
      { kind: "note_trash", uuid: noteUuid, revision: await revision() },
      { kind: "note_trash", uuid: note2, revision: await revision(note2) },
      { kind: "tag_create", title: "New tag" },
    ]);
    const base = mocks.sync.getMockImplementation()!;
    mocks.sync.mockImplementation(async (cfg: unknown, params: { items?: RawItem[] }) =>
      base(cfg, params.items ? { ...params, items: params.items.filter((i) => i.uuid !== note2) } : params));
    expect((await client.commitChanges(plans)).unconfirmed).toEqual([note2]);
    mocks.sync.mockImplementation(base);
    await expect(client.prepareRecoveries(plans)).rejects.toThrow(/Recovery conflict/);
    const undo = await client.prepareRecoveries(plans, { appliedOnly: true });
    expect(undo.plans.map((p) => p.after.uuid)).toEqual([noteUuid]);
    expect(undo.skipped).toEqual([{ uuid: note2, reason: "not_applied" }, { uuid: plans[2]!.after.uuid, reason: "tag_create" }]);
    // Never-applied is an exact state; a later outside edit is a conflict, not a skip.
    await edit(note2, { title: "Edited elsewhere" });
    await expect(client.prepareRecoveries([plans[1]!], { appliedOnly: true })).rejects.toThrow(/Recovery conflict/);
  });

  it("undoes a committed batch as one batch: edits restored, created notes trashed", async () => {
    const { plans } = await client.prepareChanges([
      { kind: "note_update", uuid: noteUuid, revision: await revision(), text: "Rewritten" },
      { kind: "note_create", title: "Temp", text: "x" },
    ]);
    await client.commitChanges(plans);
    mocks.sync.mockClear();
    const undo = await client.prepareRecoveries(plans);
    expect(syncs()).toBe(1);
    expect(undo.preview.counts).toEqual({ recovery: 1, note_trash: 1 });
    expect((await client.commitChanges(undo.plans)).unconfirmed).toEqual([]);
    expect(await decryptItemContent(server.get(noteUuid)!, keys)).toMatchObject({ text: "Body" });
    expect(await decryptItemContent(server.get(plans[1]!.after.uuid)!, keys)).toMatchObject({ trashed: true });
  });

  it("archives, pins and stars where the official app stores them, previews only those fields, and undoes", async () => {
    await put(note2, "Note", { title: "Second", text: "Two", noteType: "plain-text",
      appData: { "org.standardnotes.sn": { prefersPlainEditor: true }, "com.example": { keep: 1 } } });
    client = await createClientFromSession(config);
    const { plans, preview } = await client.prepareChanges([
      { kind: "note_flags", uuid: note2, revision: await revision(note2), archived: true, pinned: true },
      { kind: "note_trash", uuid: note2, revision: await revision(note2) },
      { kind: "note_flags", uuid: note3, revision: await revision(note3), starred: true },
    ]);
    expect(preview.counts).toEqual({ note_flags: 2, note_trash: 1 });
    expect(preview.plan[0]!.changes).toEqual({
      "appData.org.standardnotes.sn.archived": { from: null, to: true },
      "appData.org.standardnotes.sn.pinned": { from: null, to: true },
      trashed: { from: null, to: true },
    });
    expect(preview.plan[1]!.changes).toEqual({ starred: { from: null, to: true } });
    expect((await client.commitChanges(plans)).unconfirmed).toEqual([]);
    const second = await decryptItemContent(server.get(note2)!, keys);
    expect(second).toMatchObject({ trashed: true, appData: { "com.example": { keep: 1 },
      "org.standardnotes.sn": { prefersPlainEditor: true, archived: true, pinned: true } } });
    expect(await decryptItemContent(server.get(note3)!, keys)).toMatchObject({ starred: true });
    expect((await client.listNotes({ limit: 50, offset: 0, includeTrashed: true, archived: true })).map((n) => n.uuid)).toEqual([note2]);
    expect((await client.listNotes({ limit: 50, offset: 0, includeTrashed: true, archived: false })).map((n) => n.uuid)).not.toContain(note2);
    expect(await client.getNoteWithRevision(note3)).toMatchObject({ starred: true, archived: false, pinned: false });
    const undo = await client.prepareRecoveries(plans);
    await client.commitChanges(undo.plans);
    expect(await decryptItemContent(server.get(note2)!, keys)).toEqual({ title: "Second", text: "Two", noteType: "plain-text",
      appData: { "org.standardnotes.sn": { prefersPlainEditor: true }, "com.example": { keep: 1 } } });
  });

  it("reads malformed organisation flags as false instead of failing", async () => {
    await put(note2, "Note", { title: "Odd", text: "x", starred: "yes", appData: { "org.standardnotes.sn": { archived: 1, pinned: "true" } } });
    client = await createClientFromSession(config);
    expect(await client.getNoteWithRevision(note2)).toMatchObject({ archived: false, pinned: false, starred: false });
  });

  it("builds a nested tag tree in one batch, attaches notes to new tags and moves an existing tag", async () => {
    const tagRev = await revision(tagUuid);
    const { plans, preview } = await client.prepareChanges([
      { kind: "tag_create", title: "Work", ref: "@work" },
      { kind: "tag_create", title: "NVIDIA", parent: "@work", ref: "@nv" },
      { kind: "tag_attach", uuid: "@nv", noteUuid },
      { kind: "tag_attach", uuid: "@nv", noteUuid: note2 },
      { kind: "tag_update", uuid: tagUuid, revision: tagRev, title: "Archive", parent: "@work" },
    ]);
    const [work, nv, moved] = plans.map((p) => p.after.uuid);
    expect(moved).toBe(tagUuid);
    expect(preview.plan[1]!.changes.references).toEqual({ removed: [], added: [
      { uuid: work, type: "Tag", title: "Work", relation: "parent" },
      { uuid: noteUuid, type: "Note", title: "Original" }, { uuid: note2, type: "Note", title: "Second" }] });
    expect(preview.plan[2]!.changes.references).toEqual({ removed: [], added: [{ uuid: work, type: "Tag", title: "Work", relation: "parent" }] });
    expect((await client.commitChanges(plans)).unconfirmed).toEqual([]);
    const parentRef = { uuid: work, content_type: "Tag", reference_type: "TagToParentTag" };
    expect((await decryptItemContent(server.get(nv!)!, keys)).references).toEqual([parentRef,
      { uuid: noteUuid, content_type: "Note" }, { uuid: note2, content_type: "Note" }]);
    expect(await decryptItemContent(server.get(tagUuid)!, keys)).toMatchObject({ title: "Archive", references: [parentRef] });
    const tags = await client.listTags();
    expect(tags.find((t) => t.uuid === nv)?.parentUuid).toBe(work);
    expect(tags.find((t) => t.uuid === tagUuid)?.parentUuid).toBe(work);

    // Back to the top level keeps note links; undo keeps created tags and restores the moved one.
    const top = await client.prepareChanges([{ kind: "tag_update", uuid: nv!, revision: await revision(nv), parent: null }]);
    await client.commitChanges(top.plans);
    expect((await decryptItemContent(server.get(nv!)!, keys)).references).toEqual([
      { uuid: noteUuid, content_type: "Note" }, { uuid: note2, content_type: "Note" }]);
    const undo = await client.prepareRecoveries(plans);
    expect(undo.skipped.map((s) => s.reason)).toEqual(["tag_create", "tag_create"]);
    await client.commitChanges(undo.plans);
    expect(await decryptItemContent(server.get(tagUuid)!, keys)).toEqual({ title: "Tag", references: [] });
  });

  it("refuses tag cycles, unknown or duplicate refs, missing parents and protected notes on new tags", async () => {
    const setup = await client.prepareChanges([{ kind: "tag_create", title: "A", ref: "@a" }, { kind: "tag_create", title: "B", parent: "@a" }]);
    await client.commitChanges(setup.plans);
    const [a, b] = setup.plans.map((p) => p.after.uuid) as [string, string];
    await expect(client.prepareChanges([{ kind: "tag_update", uuid: a, revision: await revision(a), parent: b }])).rejects.toThrow(/own ancestor/);
    await expect(client.prepareChanges([{ kind: "tag_update", uuid: a, revision: await revision(a), parent: a }])).rejects.toThrow(/own ancestor/);
    await expect(client.prepareChanges([{ kind: "tag_create", title: "C", parent: b, ref: "@c" },
      { kind: "tag_update", uuid: a, revision: await revision(a), parent: "@c" }])).rejects.toThrow(/own ancestor/);
    await expect(client.prepareChanges([{ kind: "tag_attach", uuid: "@later", noteUuid }, { kind: "tag_create", title: "L", ref: "@later" }])).rejects.toThrow(/Unknown tag @later/);
    await expect(client.prepareChanges([{ kind: "tag_create", title: "X", ref: "@x" }, { kind: "tag_create", title: "Y", ref: "@x" }])).rejects.toThrow(/used twice/);
    await expect(client.prepareChanges([{ kind: "tag_create", title: "Z", parent: note2 }])).rejects.toThrow(/Parent tag .* not found/);
    await expect(client.prepareChanges([{ kind: "tag_detach", uuid: "@x", revision: "r", noteUuid }])).rejects.toThrow(/Only tag_attach/);
    await put(note3, "Note", { title: "Secret", text: "s", protected: true });
    client = await createClientFromSession(config);
    await expect(client.prepareChanges([{ kind: "tag_create", title: "P", ref: "@p" }, { kind: "tag_attach", uuid: "@p", noteUuid: note3 }])).rejects.toThrow(/protected/);
    expect(writes).toHaveLength(1);
  });

  it("rechecks notes attached to a new tag at commit and sends nothing if one became protected", async () => {
    const { plans } = await client.prepareChanges([{ kind: "tag_create", title: "T", ref: "@t" }, { kind: "tag_attach", uuid: "@t", noteUuid: note2 }]);
    await edit(note2, { protected: true });
    await expect(client.commitChanges(plans)).rejects.toThrow(/protected/);
    expect(writes).toHaveLength(0);
  });

  it("merges notes into one from their current text, keeps their tags, trashes them, and undoes in one step", async () => {
    await put(tagUuid, "Tag", { title: "Tag", references: [{ uuid: note2, content_type: "Note" }] });
    client = await createClientFromSession(config);
    const sources = [{ uuid: noteUuid, revision: await revision() }, { uuid: note2, revision: await revision(note2) }, { uuid: note3, revision: await revision(note3) }];
    const { plans, preview } = await client.prepareChanges([{ kind: "note_merge", title: "All in one", sources }]);
    expect(preview.counts).toEqual({ note_merge: 1, note_trash: 3, tag_attach: 1 });
    const merged = plans[0]!.after.uuid;
    expect(preview.plan[0]).toMatchObject({ kinds: "note_merge", created: true, changes: {
      text: { from: null, to: "## Original\n\nBody\n\n## Second\n\nTwo\n\n## Third\n\nThree" } } });
    expect(preview.plan.at(-1)!.changes.references).toEqual({ removed: [], added: [{ uuid: merged, type: "Note", title: "All in one" }] });
    expect((await client.commitChanges(plans)).unconfirmed).toEqual([]);
    expect(await decryptItemContent(server.get(merged)!, keys)).toMatchObject({ title: "All in one", noteType: "markdown" });
    for (const s of sources) expect(await decryptItemContent(server.get(s.uuid)!, keys)).toMatchObject({ trashed: true });
    expect((await decryptItemContent(server.get(tagUuid)!, keys)).references).toEqual([{ uuid: note2, content_type: "Note" }, { uuid: merged, content_type: "Note" }]);
    const undo = await client.prepareRecoveries(plans);
    await client.commitChanges(undo.plans);
    expect(await decryptItemContent(server.get(merged)!, keys)).toMatchObject({ trashed: true });
    for (const s of sources) expect((await decryptItemContent(server.get(s.uuid)!, keys)).trashed).toBeUndefined();
    expect((await decryptItemContent(server.get(tagUuid)!, keys)).references).toEqual([{ uuid: note2, content_type: "Note" }]);
  });

  it("merges without headings or trashing, and refuses protected, structured, stale or locked-and-trashed sources", async () => {
    const two = async () => [{ uuid: noteUuid, revision: await revision() }, { uuid: note2, revision: await revision(note2) }];
    await expect(client.prepareChange({ kind: "note_merge", title: "One", sources: await two() })).rejects.toThrow(/writes_prepare_batch/);
    const plain = await client.prepareChanges([{ kind: "note_merge", title: "P", sources: await two(), headings: false, separator: "\n---\n", trashSources: false, noteType: "plain-text" }]);
    expect(plain.preview.counts).toEqual({ note_merge: 1 });
    expect(plain.preview.plan[0]!.changes.text).toEqual({ from: null, to: "Body\n---\nTwo" });
    await expect(client.prepareChanges([{ kind: "note_merge", title: "S", sources: [{ uuid: noteUuid, revision: "0".repeat(64) }, { uuid: note2, revision: await revision(note2) }], trashSources: false }])).rejects.toThrow(/Stale/);
    await edit(note2, { appData: { "org.standardnotes.sn": { locked: true } } });
    await expect(client.prepareChanges([{ kind: "note_merge", title: "L", sources: await two() }])).rejects.toThrow(/locked/);
    expect((await client.prepareChanges([{ kind: "note_merge", title: "L", sources: await two(), trashSources: false }])).plans).toHaveLength(1);
    await edit(note2, { noteType: "super", appData: {} });
    await expect(client.prepareChanges([{ kind: "note_merge", title: "X", sources: await two() }])).rejects.toThrow(/plain-text or markdown/);
    await edit(note2, { noteType: "plain-text", protected: true });
    await expect(client.prepareChanges([{ kind: "note_merge", title: "X", sources: await two(), trashSources: false }])).rejects.toThrow(/protected/);
    expect(writes).toHaveLength(0);
  });

  it("reads many notes with revisions from one sync and withholds protected notes", async () => {
    await edit(note3, { protected: true });
    mocks.sync.mockClear();
    const missingUuid = "77777777-7777-4777-8777-777777777777";
    const { notes, missing } = await client.getNotesWithRevision([noteUuid, note2, note3, missingUuid]);
    expect(syncs()).toBe(1);
    expect(notes.map((n) => [n.uuid, n.revision])).toEqual([[noteUuid, await revision()], [note2, await revision(note2)]]);
    expect(missing).toEqual([note3, missingUuid]);
  });
});
