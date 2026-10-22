import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sync: vi.fn(), loadSession: vi.fn(), saveSession: vi.fn() }));
vi.mock("./http.js", () => ({ sync: mocks.sync, SnApiError: class extends Error {} }));
vi.mock("./session.js", () => ({ loadSession: mocks.loadSession, saveSession: mocks.saveSession }));
vi.mock("../security/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { createClientFromSession, itemRevision, type SnClient } from "./client.js";
import { decryptItemContent, encryptString, replaceItemContent } from "./protocol004.js";
import { randomBytes, toHex } from "./crypto.js";
import type { RawItem } from "./http.js";

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
    await expect(client.deleteNote(noteUuid, true)).rejects.toThrow(/disabled/);
    await expect(client.deleteTag(tagUuid)).rejects.toThrow(/disabled/);
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
