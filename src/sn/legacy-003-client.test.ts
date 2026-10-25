import { createCipheriv, createHmac, randomBytes as nodeRandom } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sync: vi.fn(), loadSession: vi.fn(), saveSession: vi.fn() }));
vi.mock("./http.js", () => ({ sync: mocks.sync, SnApiError: class extends Error {} }));
vi.mock("./session.js", () => ({ loadSession: mocks.loadSession, saveSession: mocks.saveSession }));
vi.mock("../security/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { createClientFromSession, itemRevision, type SnClient } from "./client.js";
import { decryptItemContent, encryptString } from "./protocol004.js";
import { randomBytes, toHex } from "./crypto.js";
import type { RawItem } from "./http.js";

// Synthetic keys and records only; no account, keychain, or network.
const config = { serverUrl: "https://example.invalid", email: "test@example.invalid" };
const key004 = "11111111-1111-4111-8111-111111111111";
const key003 = "55555555-5555-4555-8555-555555555555";
const oldNote = "22222222-2222-4222-8222-222222222222";
const oddNote = "33333333-3333-4333-8333-333333333333";
const hex32 = () => nodeRandom(32).toString("hex");

function enc003(plain: string, ek: string, ak: string, uuid: string): string {
  const iv = nodeRandom(16);
  const c = createCipheriv("aes-256-cbc", Buffer.from(ek, "hex"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
  const mac = createHmac("sha256", Buffer.from(ak, "hex")).update(`003:${uuid}:${iv.toString("hex")}:${ct}`).digest("hex");
  return `003:${mac}:${uuid}:${iv.toString("hex")}:${ct}`;
}

let server: Map<string, RawItem>;
let writes: RawItem[][];
let keys: Map<string, Uint8Array>;
let client: SnClient;
let legacy: { ek: string; ak: string };

function envelope(uuid: string, content_type: string): RawItem {
  return { uuid, content_type, content: "", enc_item_key: "", items_key_id: null,
    created_at: "2018-01-01T00:00:00.000Z", updated_at: "2018-01-01T00:00:00.000Z",
    created_at_timestamp: 1, updated_at_timestamp: 10, deleted: false };
}

function put003(uuid: string, content: Record<string, unknown>, embedded = uuid): void {
  const ek = hex32(), ak = hex32();
  server.set(uuid, { ...envelope(uuid, "Note"),
    enc_item_key: enc003(ek + ak, legacy.ek, legacy.ak, embedded),
    content: enc003(JSON.stringify(content), ek, ak, embedded) });
}

async function putItemsKey(uuid: string, masterKey: Uint8Array, body: Record<string, unknown>): Promise<void> {
  const wrap = await randomBytes(32);
  const aad = { u: uuid, v: "004", kp: { version: "004" } };
  server.set(uuid, { ...envelope(uuid, "SN|ItemsKey"),
    enc_item_key: await encryptString(await toHex(wrap), masterKey, aad),
    content: await encryptString(JSON.stringify(body), wrap, aad) });
}

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.SN_ALLOW_LEGACY_UUID_MISMATCH;
  server = new Map();
  writes = [];
  const masterKey = await randomBytes(32);
  const itemsKey = await randomBytes(32);
  keys = new Map([[key004, itemsKey]]);
  legacy = { ek: hex32(), ak: hex32() };
  await putItemsKey(key004, masterKey, { version: "004", itemsKey: await toHex(itemsKey) });
  // Newer than the 004 key on purpose: a legacy key must never become the default.
  await putItemsKey(key003, masterKey, { version: "003", itemsKey: legacy.ek, dataAuthenticationKey: legacy.ak });
  server.set(key003, { ...server.get(key003)!, updated_at_timestamp: 99 });
  put003(oldNote, { title: "Old", text: "legacy body", references: [], noteType: "plain-text",
    appData: { "org.standardnotes.sn": { client_updated_at: "2018-01-01T00:00:00.000Z" } }, custom: { keep: true } });
  put003(oddNote, { title: "Odd", text: "mismatched", references: [] }, "99999999-9999-4999-8999-999999999999");
  mocks.loadSession.mockResolvedValue({ ...config, sessionPayload: { access_token: "fake", refresh_token: "fake" },
    masterKeyHex: await toHex(masterKey), keyParams: { version: "004", identifier: config.email, pw_nonce: "synthetic" } });
  mocks.saveSession.mockResolvedValue(undefined);
  mocks.sync.mockImplementation(async (_c: unknown, params: { items?: RawItem[] }) => {
    const response = { retrieved_items: [...server.values()].map((r) => ({ ...r })), saved_items: [] as RawItem[], conflicts: [] as unknown[], sync_token: "token" };
    if (!params.items?.length) return response;
    writes.push(params.items.map((r) => ({ ...r })));
    for (const item of params.items) {
      const saved = { ...item, updated_at_timestamp: item.updated_at_timestamp + 1 };
      server.set(saved.uuid, saved);
      response.saved_items.push({ ...saved });
    }
    return response;
  });
  client = await createClientFromSession(config);
});

afterEach(() => { delete process.env.SN_ALLOW_LEGACY_UUID_MISMATCH; });

describe("legacy 003 notes through the client", () => {
  it("reads a keyless 003 note and skips the mismatching one by default", async () => {
    expect(await client.getNoteWithRevision(oldNote)).toMatchObject({ title: "Old", text: "legacy body" });
    await expect(client.getNoteWithRevision(oddNote)).rejects.toThrow(/uuid mismatch/);
    expect((await client.listNotes({ limit: 50, offset: 0, includeTrashed: false })).map((n) => n.uuid)).toEqual([oldNote]);
  });

  it("edits a legacy note into 004 under the 004 default key and keeps its metadata", async () => {
    const before = await client.getNoteWithRevision(oldNote);
    const plan = await client.prepareChange({ kind: "note_update", uuid: oldNote, revision: before!.revision, append: " + edit" });
    expect(plan.after.content.startsWith("004:")).toBe(true);
    expect(plan.after.items_key_id).toBe(key004);
    await client.commitChange(plan);
    expect(writes).toHaveLength(1);
    const stored = server.get(oldNote)!;
    expect(stored.content.startsWith("004:") && stored.enc_item_key.startsWith("004:")).toBe(true);
    expect(stored.items_key_id).toBe(key004);
    expect(await decryptItemContent(stored, keys)).toMatchObject({
      text: "legacy body + edit", title: "Old", custom: { keep: true }, references: [],
    });
    expect(await client.getNoteWithRevision(oldNote)).toMatchObject({ text: "legacy body + edit" });
    expect(await itemRevision(stored)).toBe((await client.getNoteWithRevision(oldNote))!.revision);
  });

  it("undoes an edit of a legacy note by restoring its exact content as 004", async () => {
    const before = await client.getNoteWithRevision(oldNote);
    // The fixture's 003 plaintext, exactly.
    const original = { title: "Old", text: "legacy body", references: [], noteType: "plain-text",
      appData: { "org.standardnotes.sn": { client_updated_at: "2018-01-01T00:00:00.000Z" } }, custom: { keep: true } };
    const plan = await client.prepareChange({ kind: "note_update", uuid: oldNote, revision: before!.revision, append: " + edit" });
    await client.commitChange(plan);
    const undo = await client.prepareRecovery(plan);
    expect(undo.after.content.startsWith("004:") && undo.after.enc_item_key.startsWith("004:")).toBe(true);
    expect(undo.after.items_key_id).toBe(key004);
    await client.commitChange(undo);
    expect(writes).toHaveLength(2);
    expect(await decryptItemContent(server.get(oldNote)!, keys)).toEqual(original);
    expect(await client.getNoteWithRevision(oldNote)).toMatchObject({ text: "legacy body" });
  });

  it("never lets a legacy key become the default key for new notes", async () => {
    const plan = await client.prepareChange({ kind: "note_create", title: "New", text: "fresh" });
    expect(plan.after.items_key_id).toBe(key004);
    expect(plan.after.content.startsWith("004:")).toBe(true);
  });

  it("opt-in reads the mismatching note, flagged, but still refuses to write it", async () => {
    process.env.SN_ALLOW_LEGACY_UUID_MISMATCH = "1";
    const odd = await client.getNoteWithRevision(oddNote);
    expect(odd).toMatchObject({ text: "mismatched", legacyUuidMismatch: true });
    await expect(client.prepareChange({ kind: "note_update", uuid: oddNote, revision: odd!.revision, append: "x" }))
      .rejects.toThrow(/mismatch/);
    await expect(client.prepareChange({ kind: "note_trash", uuid: oddNote, revision: odd!.revision }))
      .rejects.toThrow(/mismatch/);
    expect(writes).toHaveLength(0);
  });
});
