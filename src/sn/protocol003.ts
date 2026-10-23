/**
 * Read-only support for legacy Standard Notes protocol 003 items.
 *
 * Payload: "003:<hmac_hex>:<uuid>:<iv_hex>:<ciphertext_b64>[:<account params b64>]".
 * AES-256-CBC, with HMAC-SHA256 over "003:<uuid>:<iv>:<ciphertext>" checked before
 * decrypting. The optional 6th segment is not covered by the MAC, so it is ignored.
 * Keys are never derived here: a 003 items key (itemsKey + dataAuthenticationKey) is
 * unwrapped under the 004 root key, and a 003 item's own key is wrapped under that.
 */

import { createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";

export interface LegacyKey {
  uuid: string;
  ek: Buffer;
  ak: Buffer;
}

export interface LegacyKeyring {
  keys: LegacyKey[];
  /** Read items whose MAC-covered uuid differs from the server's uuid. Never writable. */
  allowUuidMismatch: boolean;
}

export interface LegacyItemInput {
  uuid: string;
  content: string;
  enc_item_key: string;
  items_key_id?: string | null;
}

const HEX = /^[0-9a-f]+$/i;

export function isLegacyPayload(payload: string): boolean {
  return payload.startsWith("003:");
}

/** Returns null when the MAC does not verify, so callers can try another key. */
export function decrypt003(
  payload: string,
  key: { ek: Buffer; ak: Buffer },
  expectedUuid: string,
  allowUuidMismatch: boolean,
): { plaintext: string; uuidMismatch: boolean } | null {
  const parts = payload.split(":");
  if (parts.length < 5 || parts.length > 6 || parts[0] !== "003") {
    throw new Error("Invalid 003 payload");
  }
  const [, hash, uuid, iv, ciphertext] = parts as [string, string, string, string, string];
  if (!HEX.test(hash) || hash.length !== 64 || !HEX.test(iv) || iv.length !== 32) {
    throw new Error("Invalid 003 payload");
  }
  const mac = createHmac("sha256", key.ak).update(`003:${uuid}:${iv}:${ciphertext}`).digest();
  if (!timingSafeEqual(mac, Buffer.from(hash, "hex"))) return null;
  const uuidMismatch = uuid !== expectedUuid;
  if (uuidMismatch && !allowUuidMismatch) {
    throw new Error(`003 payload uuid mismatch for ${expectedUuid}`);
  }
  const decipher = createDecipheriv("aes-256-cbc", key.ek, Buffer.from(iv, "hex"));
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  return { plaintext: plain.toString("utf8"), uuidMismatch };
}

/** Decrypts a 003 item's content with whichever legacy key authenticates its wrapped item key. */
export function decryptLegacyItem(
  item: LegacyItemInput,
  ring: LegacyKeyring,
): { contentJson: string; uuidMismatch: boolean } {
  const candidates = item.items_key_id
    ? ring.keys.filter((k) => k.uuid === item.items_key_id)
    : ring.keys;
  if (candidates.length === 0) throw new Error(`No legacy items_key for ${item.uuid}`);
  for (const key of candidates) {
    const wrapped = decrypt003(item.enc_item_key, key, item.uuid, ring.allowUuidMismatch);
    if (!wrapped) continue;
    if (!/^[0-9a-f]{128}$/i.test(wrapped.plaintext)) {
      throw new Error(`Malformed 003 item key for ${item.uuid}`);
    }
    const itemKey = {
      ek: Buffer.from(wrapped.plaintext.slice(0, 64), "hex"),
      ak: Buffer.from(wrapped.plaintext.slice(64), "hex"),
    };
    const body = decrypt003(item.content, itemKey, item.uuid, ring.allowUuidMismatch);
    if (!body) throw new Error(`003 content for ${item.uuid} failed authentication`);
    return { contentJson: body.plaintext, uuidMismatch: wrapped.uuidMismatch || body.uuidMismatch };
  }
  throw new Error(`No legacy items_key authenticates ${item.uuid}`);
}
