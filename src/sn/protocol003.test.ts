import { createCipheriv, createHmac, randomBytes as nodeRandom } from "node:crypto";
import { describe, expect, it } from "vitest";
import { randomBytes, sodiumReady, toHex } from "./crypto.js";
import {
  decryptItemContent,
  decryptItemsKey,
  decryptItemsKeyMaterial,
  decryptNote,
  decryptTag,
  encryptString,
  rewriteItemContent,
  type EncryptedItemInput,
  type ItemKeys,
  type RootKey,
} from "./protocol004.js";
import { decrypt003, decryptLegacyItem, type LegacyKey } from "./protocol003.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

// Test-only encoder written from the published 003 format, independent of the decryptor.
function enc003(plain: string, ekHex: string, akHex: string, uuid: string, extra?: string): string {
  const iv = nodeRandom(16);
  const c = createCipheriv("aes-256-cbc", Buffer.from(ekHex, "hex"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
  const ivHex = iv.toString("hex");
  const mac = createHmac("sha256", Buffer.from(akHex, "hex")).update(`003:${uuid}:${ivHex}:${ct}`).digest("hex");
  return ["003", mac, uuid, ivHex, ct, ...(extra ? [extra] : [])].join(":");
}

const hex32 = () => nodeRandom(32).toString("hex");

function legacyFixture(uuid = UUID, opts: { embedded?: string; extra?: string } = {}) {
  const keyEk = hex32(), keyAk = hex32();
  const itemEk = hex32(), itemAk = hex32();
  const content = {
    title: "Old note", text: "legacy body", references: [], appData: { "org.standardnotes.sn": { client_updated_at: "2018-01-01T00:00:00.000Z" } },
    custom: { keep: true },
  };
  const item: EncryptedItemInput = {
    uuid,
    content_type: "Note",
    content: enc003(JSON.stringify(content), itemEk, itemAk, opts.embedded ?? uuid, opts.extra),
    enc_item_key: enc003(itemEk + itemAk, keyEk, keyAk, opts.embedded ?? uuid, opts.extra),
    items_key_id: null,
    created_at: "2018-01-01T00:00:00.000Z",
    updated_at: "2018-01-01T00:00:00.000Z",
    created_at_timestamp: 1,
    updated_at_timestamp: 1,
  } as EncryptedItemInput;
  const legacy: LegacyKey = { uuid: "kkkkkkkk-kkkk-4kkk-8kkk-kkkkkkkkkkkk", ek: Buffer.from(keyEk, "hex"), ak: Buffer.from(keyAk, "hex") };
  return { item, legacy, content, keyEk, keyAk, itemEk, itemAk };
}

const keysWith = (legacy: LegacyKey[], allowUuidMismatch = false): ItemKeys => {
  const m: ItemKeys = new Map();
  m.legacy = { keys: legacy, allowUuidMismatch };
  return m;
};

describe("decrypt003", () => {
  it("decrypts a 5-part payload", () => {
    const f = legacyFixture();
    expect(decrypt003(f.item.enc_item_key, { ek: Buffer.from(f.keyEk, "hex"), ak: Buffer.from(f.keyAk, "hex") }, UUID, false))
      .toEqual({ plaintext: f.itemEk + f.itemAk, uuidMismatch: false });
  });

  it("ignores an unauthenticated 6th segment", () => {
    const f = legacyFixture(UUID, { extra: Buffer.from('{"identifier":"x"}').toString("base64") });
    expect(f.item.content.split(":")).toHaveLength(6);
    const r = decryptLegacyItem(f.item, { keys: [f.legacy], allowUuidMismatch: false });
    expect(JSON.parse(r.contentJson)).toMatchObject({ text: "legacy body" });
  });

  it("returns null when the MAC does not verify (wrong key or tampering)", () => {
    const f = legacyFixture();
    const key = { ek: Buffer.from(f.keyEk, "hex"), ak: Buffer.from(f.keyAk, "hex") };
    const wrong = { ek: key.ek, ak: Buffer.from(hex32(), "hex") };
    expect(decrypt003(f.item.enc_item_key, wrong, UUID, false)).toBeNull();
    const parts = f.item.enc_item_key.split(":");
    parts[4] = Buffer.from("tampered ciphertext!!").toString("base64");
    expect(decrypt003(parts.join(":"), key, UUID, false)).toBeNull();
  });

  it("rejects malformed payloads", () => {
    const key = { ek: Buffer.alloc(32), ak: Buffer.alloc(32) };
    expect(() => decrypt003("003:a:b", key, UUID, false)).toThrow(/003/);
    expect(() => decrypt003("004:a:b:c:d", key, UUID, false)).toThrow(/003/);
  });

  it("refuses an embedded uuid that differs from the item uuid unless allowed, and flags it", () => {
    const f = legacyFixture(UUID, { embedded: OTHER });
    const key = { ek: Buffer.from(f.keyEk, "hex"), ak: Buffer.from(f.keyAk, "hex") };
    expect(() => decrypt003(f.item.enc_item_key, key, UUID, false)).toThrow(/uuid mismatch/);
    expect(decrypt003(f.item.enc_item_key, key, UUID, true)).toMatchObject({ uuidMismatch: true });
  });
});

describe("legacy items through the protocol entry points", () => {
  it("decryptNote reads a keyless 003 note and decryptItemContent keeps all metadata", async () => {
    const f = legacyFixture();
    const note = await decryptNote(f.item, keysWith([f.legacy]));
    expect(note).toMatchObject({ uuid: UUID, title: "Old note", text: "legacy body", trashed: false });
    expect(note.legacyUuidMismatch).toBeUndefined();
    expect(await decryptItemContent(f.item, keysWith([f.legacy]))).toEqual(f.content);
  });

  it("decryptTag reads a 003 tag", async () => {
    const f = legacyFixture();
    const tag = await decryptTag({ ...f.item, content_type: "Tag" } as EncryptedItemInput, keysWith([f.legacy]));
    expect(tag.title).toBe("Old note");
  });

  it("fails closed with no legacy key, a wrong key, or a mismatching uuid", async () => {
    const f = legacyFixture();
    await expect(decryptNote(f.item, new Map())).rejects.toThrow();
    const stranger: LegacyKey = { uuid: "s", ek: Buffer.from(hex32(), "hex"), ak: Buffer.from(hex32(), "hex") };
    await expect(decryptNote(f.item, keysWith([stranger]))).rejects.toThrow();
    const m = legacyFixture(UUID, { embedded: OTHER });
    await expect(decryptNote(m.item, keysWith([m.legacy]))).rejects.toThrow(/uuid mismatch/);
  });

  it("opt-in reads a mismatching note and flags it", async () => {
    const m = legacyFixture(UUID, { embedded: OTHER });
    const note = await decryptNote(m.item, keysWith([m.legacy], true));
    expect(note).toMatchObject({ text: "legacy body", legacyUuidMismatch: true });
  });

  it("honors items_key_id by using only the named legacy key", async () => {
    const f = legacyFixture();
    const keyed = { ...f.item, items_key_id: f.legacy.uuid } as EncryptedItemInput;
    await expect(decryptNote(keyed, keysWith([f.legacy]))).resolves.toBeTruthy();
    await expect(decryptNote({ ...keyed, items_key_id: "other-key" } as EncryptedItemInput, keysWith([f.legacy]))).rejects.toThrow();
  });
});

describe("legacy items key material", () => {
  it("unwraps a 003 items key under the root key but decryptItemsKey still refuses it", async () => {
    await sodiumReady();
    const masterKey = await randomBytes(32);
    const root = { masterKey, serverPassword: "", keyParams: {} } as unknown as RootKey;
    const wrap = await randomBytes(32);
    const ek = hex32(), ak = hex32();
    const aad = { u: UUID, v: "004", kp: "x" };
    const item = {
      uuid: UUID,
      content_type: "SN|ItemsKey",
      enc_item_key: await encryptString(await toHex(wrap), masterKey, aad),
      content: await encryptString(JSON.stringify({ version: "003", itemsKey: ek, dataAuthenticationKey: ak }), wrap, aad),
    } as EncryptedItemInput;
    const m = await decryptItemsKeyMaterial(item, root);
    expect(m).toMatchObject({ uuid: UUID, version: "003" });
    expect(Buffer.from((m as { itemsKey: Uint8Array }).itemsKey).toString("hex")).toBe(ek);
    expect(Buffer.from((m as { dataAuthenticationKey: Uint8Array }).dataAuthenticationKey).toString("hex")).toBe(ak);
    await expect(decryptItemsKey(item, root)).rejects.toThrow(/non-004/);
  });
});

describe("rewriteItemContent for legacy items", () => {
  it("re-encrypts a 003 item as 004 under the default items key, keeping every metadata field", async () => {
    await sodiumReady();
    const f = legacyFixture();
    const defaultKey = { uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", itemsKey: await randomBytes(32) };
    const keys = keysWith([f.legacy]);
    keys.set(defaultKey.uuid, defaultKey.itemsKey);
    const content = await decryptItemContent(f.item, keys);
    const next = { ...content, title: "Edited" };
    const out = await rewriteItemContent(f.item, next, keys, defaultKey);
    expect(out.content.startsWith("004:")).toBe(true);
    expect(out.enc_item_key.startsWith("004:")).toBe(true);
    expect(out.items_key_id).toBe(defaultKey.uuid);
    const after = { ...f.item, ...out } as EncryptedItemInput;
    expect(await decryptItemContent(after, keys)).toEqual(next);
    expect((await decryptItemContent(after, keys)).custom).toEqual({ keep: true });
  });

  it("refuses to rewrite a uuid-mismatching legacy item even with the read opt-in", async () => {
    await sodiumReady();
    const m = legacyFixture(UUID, { embedded: OTHER });
    const defaultKey = { uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", itemsKey: await randomBytes(32) };
    await expect(rewriteItemContent(m.item, {}, keysWith([m.legacy], true), defaultKey)).rejects.toThrow(/mismatch/);
  });

  it("keeps the 004 item key and ciphertext layout for 004 items", async () => {
    await sodiumReady();
    const itemsKey = await randomBytes(32);
    const keyUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const perItem = await randomBytes(32);
    const aad = { u: UUID, v: "004" };
    const item = {
      uuid: UUID, content_type: "Note", items_key_id: keyUuid,
      content: await encryptString(JSON.stringify({ title: "t" }), perItem, aad),
      enc_item_key: await encryptString(await toHex(perItem), itemsKey, aad),
    } as EncryptedItemInput;
    const keys: ItemKeys = new Map([[keyUuid, itemsKey]]);
    const out = await rewriteItemContent(item, { title: "u" }, keys, { uuid: keyUuid, itemsKey });
    expect(out.enc_item_key).toBe(item.enc_item_key);
    expect(out.items_key_id).toBe(keyUuid);
    expect(await decryptItemContent({ ...item, content: out.content } as EncryptedItemInput, keys)).toEqual({ title: "u" });
  });
});
