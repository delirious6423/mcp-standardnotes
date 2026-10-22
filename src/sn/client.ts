import { logger } from "../security/logger.js";
import * as http from "./http.js";
import {
  decryptItemsKey,
  decryptItemContent,
  replaceItemContent,
  decryptNote,
  decryptTag,
  deriveRootKey,
  encryptNote,
  encryptTag,
  generateItemsKeyRaw,
  normalizeSuperText,
  noteAccess,
  type DecryptedItemsKey,
  type DecryptedNote,
  type DecryptedTag,
  type KeyParams004,
  type RootKey,
  type TagReference,
} from "./protocol004.js";
import { loadSession, saveSession, type StoredSession } from "./session.js";
import { cacheTtlMs, ensureFresh } from "./cache.js";
import {
  makeParentRef,
  parentUuidOf,
  stripParentRefs,
  subtreeTagUuids,
  wouldCreateCycle,
} from "./tagHierarchy.js";
import type {
  Note,
  NoteSummary,
  NoteType,
  Tag,
  TagSummary,
  VaultStats,
} from "./types.js";
import { fromHex, toHex, sha256Hex } from "./crypto.js";

export type SafeChange =
  | { kind: "note_create"; title: string; text: string; noteType?: "plain-text" | "markdown" }
  | { kind: "note_update"; uuid: string; revision: string; title?: string; text?: string; append?: string }
  | { kind: "note_trash" | "note_restore"; uuid: string; revision: string }
  | { kind: "tag_create"; title: string }
  | { kind: "tag_update"; uuid: string; revision: string; title: string }
  | { kind: "tag_attach" | "tag_detach"; uuid: string; revision: string; noteUuid: string }
  | { kind: "recovery"; uuid: string; revision: string };

export interface PreparedChange {
  change: SafeChange;
  before: http.RawItem | null;
  after: http.RawItem;
  preview: unknown;
}

/** Revision includes ciphertext so even same-timestamp remote edits invalidate it. */
export function itemRevision(raw: http.RawItem): Promise<string> {
  return sha256Hex(JSON.stringify([
    raw.content, raw.enc_item_key, raw.items_key_id ?? null, raw.updated_at_timestamp,
  ]));
}

function sameCiphertext(a: http.RawItem, b: http.RawItem): boolean {
  return a.uuid === b.uuid && a.content_type === b.content_type &&
    a.deleted === b.deleted && a.content === b.content &&
    a.enc_item_key === b.enc_item_key && a.items_key_id === b.items_key_id;
}

export interface SnClient {
  prepareChange(change: SafeChange): Promise<PreparedChange>;
  commitChange(plan: PreparedChange, options?: { reconcileOnly?: boolean }): Promise<void>;
  getRevision(uuid: string): Promise<string>;
  getNoteWithRevision(uuid: string): Promise<(Note & { revision: string }) | null>;
  getTagWithRevision(uuid: string): Promise<(Tag & { revision: string }) | null>;
  getRawItem(uuid: string): Promise<http.RawItem | null>;
  prepareRecovery(plan: PreparedChange): Promise<PreparedChange>;
  listNotes(opts: {
    limit: number;
    offset: number;
    includeTrashed: boolean;
    tag?: string;
    // When filtering by tag, also match notes tagged with any descendant
    // (SN sidebar "folder" behavior). Off by default so existing callers
    // keep the strict direct-tag semantics.
    includeDescendants?: boolean;
  }): Promise<NoteSummary[]>;
  stats(): Promise<VaultStats>;
  searchNotes(query: string, limit: number): Promise<NoteSummary[]>;
  getNote(uuid: string): Promise<Note | null>;
  createNote(input: {
    title: string;
    text: string;
    noteType?: NoteType;
    tags?: string[];
  }): Promise<string>;
  createNotesBatch(
    inputs: Array<{
      title: string;
      text: string;
      noteType?: NoteType;
      tags?: string[];
    }>,
  ): Promise<Array<{ uuid: string; title: string }>>;
  updateNote(input: {
    uuid: string;
    title?: string;
    text?: string;
    noteType?: NoteType;
    tags?: string[];
  }): Promise<void>;
  deleteNote(uuid: string, permanent: boolean): Promise<void>;
  listTags(): Promise<TagSummary[]>;
  getTag(uuid: string): Promise<Tag | null>;
  createTag(input: { title: string; parent?: string }): Promise<string>;
  // `parent`: undefined = leave the parent link alone;
  //          string   = re-parent under that tag UUID;
  //          null     = move the tag back to the top level.
  updateTag(input: {
    uuid: string;
    title?: string;
    parent?: string | null;
  }): Promise<void>;
  deleteTag(uuid: string): Promise<void>;
  attachTag(noteUuid: string, tagUuid: string): Promise<void>;
  detachTag(noteUuid: string, tagUuid: string): Promise<void>;
  sync(): Promise<{ notes: number; tags: number; syncedAt: string }>;
}

export interface SnClientConfig {
  serverUrl: string;
  email: string;
}

interface ClientState {
  serverUrl: string;
  email: string;
  authToken: string;
  refreshToken: string;
  rootKey: RootKey;
  itemsKeys: Map<string, DecryptedItemsKey>;
  defaultItemsKeyUuid: string | null;
  notesCache: Map<string, DecryptedNote>;
  tagsCache: Map<string, DecryptedTag>;
  encryptedItemsRaw: Map<string, http.RawItem>;
  syncToken: string | null;
  // Timestamp (ms) of the last successful fullSync — drives ensureFresh's
  // TTL check. Set to 0 before the first sync so ensureFresh always fires.
  lastSyncAt: number;
  // UUIDs whose payload failed to decrypt on the most recent fullSync
  // pass. Reset at the start of every fullSync so a fix upstream (e.g. an
  // items_key that arrives on a later sync page) can clear the count.
  decryptFailedNotes: Set<string>;
  decryptFailedTags: Set<string>;
}

// Cache TTL policy lives in ./cache.ts so the ensureFresh helper can be
// unit-tested without spinning up the full crypto+http stack.

export async function createClientFromLogin(
  config: SnClientConfig,
  password: string,
  mfaPrompt?: () => Promise<string>,
): Promise<SnClient> {
  if (!password) throw new Error("password required");
  const codeVerifier = http.generateCodeVerifier();
  const codeChallenge = http.computeCodeChallenge(codeVerifier);
  // Standard Notes verifies MFA inside the /v2/login-params handler — when 2FA
  // is enabled, this first call fails with `mfa-required` and we must re-call
  // login-params with `{ [mfa_key]: code }`. The /v2/login endpoint itself does
  // NOT recheck MFA, so the prompt belongs around this call, not around login().
  let params: http.LoginParamsResponse;
  try {
    params = await http.getLoginParams(
      { serverUrl: config.serverUrl },
      config.email,
      codeChallenge,
    );
  } catch (err) {
    if (!(err instanceof http.SnApiError) || err.tag !== "mfa-required") {
      throw err;
    }
    if (!mfaPrompt) {
      throw new Error(
        "Two-factor authentication is enabled on this account. " +
          "Run `npm run login` interactively (it wires the MFA prompt).",
      );
    }
    const mfaKey =
      (err.payload as { mfa_key?: string } | undefined)?.mfa_key ?? "";
    if (!mfaKey) {
      throw new Error(
        "Server requested 2FA but did not return an mfa_key field. " +
          "This is likely a server bug or a non-standard MFA flow.",
      );
    }
    const code = (await mfaPrompt()).trim();
    if (!code) {
      throw new Error("Empty 2FA code; aborting login.");
    }
    params = await http.getLoginParams(
      { serverUrl: config.serverUrl },
      config.email,
      codeChallenge,
      { [mfaKey]: code },
    );
  }
  const keyParams: KeyParams004 = {
    version: "004",
    identifier: params.identifier,
    pw_nonce: params.pw_nonce,
    origination: params.origination,
    created: params.created,
  };
  const rootKey = await deriveRootKey(password, keyParams);
  const loginRes = await http.login(
    { serverUrl: config.serverUrl },
    config.email,
    rootKey.serverPassword,
    codeVerifier,
  );

  const state: ClientState = {
    serverUrl: config.serverUrl,
    email: config.email,
    authToken: loginRes.session.access_token,
    refreshToken: loginRes.session.refresh_token,
    rootKey,
    itemsKeys: new Map(),
    defaultItemsKeyUuid: null,
    notesCache: new Map(),
    tagsCache: new Map(),
    encryptedItemsRaw: new Map(),
    syncToken: null,
    lastSyncAt: 0,
    decryptFailedNotes: new Set(),
    decryptFailedTags: new Set(),
  };

  await saveSession(config.email, {
    serverUrl: config.serverUrl,
    email: config.email,
    sessionPayload: {
      access_token: loginRes.session.access_token,
      refresh_token: loginRes.session.refresh_token,
    },
    masterKeyHex: await toHex(rootKey.masterKey),
    keyParams: loginRes.key_params ?? keyParams,
    savedAt: new Date().toISOString(),
  });

  await fullSync(state);
  return buildClient(state);
}

export async function createClientFromSession(
  config: SnClientConfig,
): Promise<SnClient> {
  const stored = await loadSession(config.email);
  if (!stored) {
    throw new Error(
      "No session found. Run `npm run login` to authenticate first.",
    );
  }
  if (!stored.masterKeyHex || !/^[0-9a-f]{64}$/i.test(stored.masterKeyHex)) {
    throw new Error(
      "Stored session is missing a valid masterKey; run `npm run login` again.",
    );
  }
  const keyParams = stored.keyParams as KeyParams004;
  const rootKey: RootKey = {
    masterKey: await fromHex(stored.masterKeyHex),
    serverPassword: "",
    keyParams,
  };
  const state: ClientState = {
    serverUrl: stored.serverUrl,
    email: stored.email,
    authToken: stored.sessionPayload.access_token,
    refreshToken: stored.sessionPayload.refresh_token,
    rootKey,
    itemsKeys: new Map(),
    defaultItemsKeyUuid: null,
    notesCache: new Map(),
    tagsCache: new Map(),
    encryptedItemsRaw: new Map(),
    // Always start with a null syncToken on cold boot — incremental sync
    // skips items_keys (they rarely change), and we have nothing in
    // encryptedItemsRaw to fall back on after a fresh process. The
    // stored syncToken remains in the persisted session for future
    // reuse if we ever start caching the encrypted vault snapshot too.
    syncToken: null,
    lastSyncAt: 0,
    decryptFailedNotes: new Set(),
    decryptFailedTags: new Set(),
  };
  await fullSync(state);
  return buildClient(state);
}

async function persistSession(state: ClientState): Promise<void> {
  await saveSession(state.email, {
    serverUrl: state.serverUrl,
    email: state.email,
    sessionPayload: {
      access_token: state.authToken,
      refresh_token: state.refreshToken,
    },
    masterKeyHex: await toHex(state.rootKey.masterKey),
    keyParams: state.rootKey.keyParams,
    syncToken: state.syncToken,
    savedAt: new Date().toISOString(),
  });
}

async function callSync(
  state: ClientState,
  params: Parameters<typeof http.sync>[1],
): Promise<http.SyncResponse> {
  try {
    return await http.sync(
      { serverUrl: state.serverUrl, authToken: state.authToken },
      params,
    );
  } catch (err) {
    if (
      !(err instanceof http.SnApiError) ||
      err.status !== 401 ||
      (params.items?.length ?? 0) > 0 ||
      !state.refreshToken
    ) {
      throw err;
    }
    logger.info("Access token rejected (401); refreshing");
    let fresh: http.SessionTokens;
    try {
      fresh = await http.refreshSession(
        { serverUrl: state.serverUrl },
        state.authToken,
        state.refreshToken,
      );
    } catch (refreshErr) {
      throw new Error(
        "Session refresh failed; run `npm run login` to re-authenticate. " +
          (refreshErr instanceof Error ? refreshErr.message : String(refreshErr)),
      );
    }
    state.authToken = fresh.access_token;
    state.refreshToken = fresh.refresh_token;
    await persistSession(state);
    return await http.sync(
      { serverUrl: state.serverUrl, authToken: state.authToken },
      params,
    );
  }
}

async function fullSync(state: ClientState, reset = false): Promise<void> {
  if (reset) {
    state.syncToken = null;
    state.encryptedItemsRaw.clear();
    state.notesCache.clear();
    state.tagsCache.clear();
    state.itemsKeys.clear();
    state.defaultItemsKeyUuid = null;
  }
  // Reset the failure counters at the top so a fix upstream (e.g. an
  // items_key that arrives on a later page) doesn't leave stale entries.
  state.decryptFailedNotes.clear();
  state.decryptFailedTags.clear();
  let cursorToken: string | undefined;
  let syncToken: string | undefined = state.syncToken ?? undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await callSync(state, { syncToken, cursorToken, limit: 150 });
    for (const item of res.retrieved_items) {
      if (item.deleted) {
        state.encryptedItemsRaw.delete(item.uuid);
        state.notesCache.delete(item.uuid);
        state.tagsCache.delete(item.uuid);
        state.itemsKeys.delete(item.uuid);
        continue;
      }
      state.encryptedItemsRaw.set(item.uuid, item);
    }
    syncToken = res.sync_token;
    cursorToken = res.cursor_token;
    if (!cursorToken) break;
  }
  state.syncToken = syncToken ?? null;

  // First pass: decrypt items_keys
  let mostRecentTs = -Infinity;
  for (const item of state.encryptedItemsRaw.values()) {
    if (item.content_type !== "SN|ItemsKey") continue;
    try {
      const k = await decryptItemsKey(item, state.rootKey);
      state.itemsKeys.set(k.uuid, k);
      const ts = item.updated_at_timestamp ?? 0;
      if (ts >= mostRecentTs) {
        mostRecentTs = ts;
        state.defaultItemsKeyUuid = k.uuid;
      }
    } catch (err) {
      logger.warn(`Failed to decrypt items_key ${item.uuid}`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (state.itemsKeys.size === 0) {
    throw new Error(
      "No items_key decrypted — likely wrong password or account not on protocol 004.",
    );
  }

  const itemsKeyBytesByUuid = new Map<string, Uint8Array>();
  for (const [u, k] of state.itemsKeys.entries()) {
    itemsKeyBytesByUuid.set(u, k.itemsKey);
  }

  // Second pass: decrypt notes
  for (const item of state.encryptedItemsRaw.values()) {
    if (item.content_type !== "Note") continue;
    try {
      const note = await decryptNote(item, itemsKeyBytesByUuid);
      state.notesCache.set(note.uuid, note);
    } catch (err) {
      state.notesCache.delete(item.uuid);
      state.decryptFailedNotes.add(item.uuid);
      logger.warn(`Failed to decrypt note ${item.uuid}`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Third pass: decrypt tags
  for (const item of state.encryptedItemsRaw.values()) {
    if (item.content_type !== "Tag") continue;
    try {
      const tag = await decryptTag(item, itemsKeyBytesByUuid);
      state.tagsCache.set(tag.uuid, tag);
    } catch (err) {
      state.decryptFailedTags.add(item.uuid);
      logger.warn(`Failed to decrypt tag ${item.uuid}`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  state.lastSyncAt = Date.now();

  logger.info("Sync complete", {
    notes: state.notesCache.size,
    tags: state.tagsCache.size,
    itemsKeys: state.itemsKeys.size,
    decryptFailedNotes: state.decryptFailedNotes.size,
    decryptFailedTags: state.decryptFailedTags.size,
  });

  try {
    await persistSession(state);
  } catch (err) {
    logger.warn("Failed to persist sync_token to keychain", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function toSummary(n: DecryptedNote): NoteSummary {
  return {
    uuid: n.uuid,
    title: n.title,
    updatedAt: n.updatedAt,
    preview: n.text.slice(0, 200),
    trashed: n.trashed,
    protected: n.protected,
    locked: n.locked,
    noteType: n.noteType,
  };
}

function tagsForNote(
  noteUuid: string,
  tagsCache: Map<string, DecryptedTag>,
): string[] {
  const titles: string[] = [];
  for (const tag of tagsCache.values()) {
    if (tag.references.some((r) => r.uuid === noteUuid)) {
      titles.push(tag.title);
    }
  }
  return titles.sort((a, b) => a.localeCompare(b));
}

function toFullNote(
  n: DecryptedNote,
  tagsCache: Map<string, DecryptedTag>,
): Note {
  return {
    uuid: n.uuid,
    title: n.title,
    text: n.text,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    trashed: n.trashed,
    protected: n.protected,
    locked: n.locked,
    tags: tagsForNote(n.uuid, tagsCache),
    noteType: n.noteType,
  };
}

function toTagSummary(t: DecryptedTag): TagSummary {
  return {
    uuid: t.uuid,
    title: t.title,
    updatedAt: t.updatedAt,
    noteCount: t.references.filter((r) => r.content_type === "Note").length,
    parentUuid: parentUuidOf(t),
  };
}

function toFullTag(t: DecryptedTag): Tag {
  return {
    uuid: t.uuid,
    title: t.title,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    noteUuids: t.references
      .filter((r) => r.content_type === "Note")
      .map((r) => r.uuid),
    parentUuid: parentUuidOf(t),
  };
}

function buildClient(state: ClientState): SnClient {
  const defaultItemsKey = (): DecryptedItemsKey => {
    const uuid = state.defaultItemsKeyUuid;
    if (!uuid) throw new Error("No default items_key available");
    const k = state.itemsKeys.get(uuid);
    if (!k) throw new Error(`Default items_key ${uuid} missing from state`);
    return k;
  };

  const pushItems = async (items: unknown[]): Promise<http.SyncResponse> => {
    if (items.some((item) => (item as { deleted?: unknown })?.deleted === true)) {
      throw new Error("Permanent deletion is disabled");
    }
    const res = await callSync(state, {
      syncToken: state.syncToken ?? undefined,
      items,
      limit: 150,
    });
    for (const saved of res.saved_items) {
      state.encryptedItemsRaw.set(saved.uuid, saved);
    }
    state.syncToken = res.sync_token ?? state.syncToken;
    return res;
  };

  const submitNoteUpdate = async (
    uuid: string,
    merged: {
      uuid: string;
      title: string;
      text: string;
      trashed: boolean;
      noteType: NoteType;
    },
  ): Promise<http.RawItem> => {
    const raw = state.encryptedItemsRaw.get(uuid);
    if (!raw) throw new Error(`Note ${uuid} has no encrypted record`);
    const encrypted = await encryptNote(merged, {
      uuid: defaultItemsKey().uuid,
      itemsKey: defaultItemsKey().itemsKey,
    });
    const res = await pushItems([
      {
        ...raw,
        content: encrypted.content,
        enc_item_key: encrypted.enc_item_key,
        items_key_id: encrypted.items_key_id,
        updated_at: new Date().toISOString(),
        updated_at_timestamp: raw.updated_at_timestamp,
      },
    ]);
    const saved = res.saved_items.find((i) => i.uuid === uuid);
    if (saved) return saved;

    const conflict = res.conflicts.find((c) => {
      const cc = c as {
        server_item?: { uuid?: string };
        unsaved_item?: { uuid?: string };
      };
      return (
        cc.server_item?.uuid === uuid || cc.unsaved_item?.uuid === uuid
      );
    });
    if (!conflict) {
      throw new Error(
        `Server did not save note ${uuid} and reported no conflict`,
      );
    }
    const cc = conflict as {
      type?: string;
      server_item?: http.RawItem;
    };
    throw new Error(
      `Conflict on note ${uuid} (type=${cc.type ?? "unknown"}). Reconcile before retry; no automatic retry.`,
    );
  };

  const pushTag = async (
    existing: DecryptedTag | null,
    next: { uuid: string; title: string; references: TagReference[] },
  ): Promise<DecryptedTag> => {
    const raw = state.encryptedItemsRaw.get(next.uuid);
    const encrypted = await encryptTag(next, {
      uuid: defaultItemsKey().uuid,
      itemsKey: defaultItemsKey().itemsKey,
    });
    const nowIso = new Date().toISOString();
    const item = raw
      ? {
          ...raw,
          content: encrypted.content,
          enc_item_key: encrypted.enc_item_key,
          items_key_id: encrypted.items_key_id,
          updated_at: nowIso,
          updated_at_timestamp: raw.updated_at_timestamp,
        }
      : {
          uuid: next.uuid,
          content_type: "Tag",
          content: encrypted.content,
          enc_item_key: encrypted.enc_item_key,
          items_key_id: encrypted.items_key_id,
          created_at: nowIso,
          updated_at: nowIso,
          created_at_timestamp: 0,
          updated_at_timestamp: 0,
          deleted: false,
        };
    const res = await pushItems([item]);
    const saved = res.saved_items.find((i) => i.uuid === next.uuid);
    if (!saved) {
      const conflict = res.conflicts.find(
        (c) =>
          (c as { unsaved_item?: { uuid?: string } }).unsaved_item?.uuid ===
          next.uuid,
      );
      throw new Error(
        `Server did not save tag ${next.uuid}` +
          (conflict ? ` (conflict: ${JSON.stringify(conflict)})` : ""),
      );
    }
    const stored: DecryptedTag = {
      uuid: next.uuid,
      title: next.title,
      references: next.references,
      createdAt: saved.created_at ?? existing?.createdAt ?? nowIso,
      updatedAt: saved.updated_at ?? nowIso,
      created_at_timestamp:
        saved.created_at_timestamp ?? existing?.created_at_timestamp ?? 0,
      updated_at_timestamp:
        saved.updated_at_timestamp ?? existing?.updated_at_timestamp ?? 0,
    };
    state.tagsCache.set(next.uuid, stored);
    return stored;
  };

  const attachTagInternal = async (
    noteUuid: string,
    tagUuid: string,
  ): Promise<void> => {
    if (!state.notesCache.has(noteUuid)) {
      throw new Error(`Note ${noteUuid} not found`);
    }
    const tag = state.tagsCache.get(tagUuid);
    if (!tag) throw new Error(`Tag ${tagUuid} not found`);
    if (tag.references.some((r) => r.uuid === noteUuid)) return;
    const nextRefs: TagReference[] = [
      ...tag.references,
      { uuid: noteUuid, content_type: "Note" },
    ];
    await pushTag(tag, { uuid: tag.uuid, title: tag.title, references: nextRefs });
  };

  const detachTagInternal = async (
    noteUuid: string,
    tagUuid: string,
  ): Promise<void> => {
    const tag = state.tagsCache.get(tagUuid);
    if (!tag) throw new Error(`Tag ${tagUuid} not found`);
    if (!tag.references.some((r) => r.uuid === noteUuid)) return;
    const nextRefs = tag.references.filter((r) => r.uuid !== noteUuid);
    await pushTag(tag, { uuid: tag.uuid, title: tag.title, references: nextRefs });
  };

  const syncTagsToNote = async (
    noteUuid: string,
    tagUuids: string[],
  ): Promise<void> => {
    const desired = new Set(tagUuids);
    for (const uuid of desired) {
      if (!state.tagsCache.has(uuid)) {
        throw new Error(`Tag ${uuid} not found`);
      }
    }
    for (const tag of state.tagsCache.values()) {
      const hasRef = tag.references.some((r) => r.uuid === noteUuid);
      if (desired.has(tag.uuid) && !hasRef) {
        await attachTagInternal(noteUuid, tag.uuid);
      } else if (!desired.has(tag.uuid) && hasRef) {
        await detachTagInternal(noteUuid, tag.uuid);
      }
    }
  };

  const contentKeys = () => new Map(
    [...state.itemsKeys].map(([uuid, key]) => [uuid, key.itemsKey]),
  );
  const writableNote = async (uuid: string): Promise<void> => {
    const raw = state.encryptedItemsRaw.get(uuid);
    if (!raw || raw.deleted || raw.content_type !== "Note") {
      throw new Error(`Note ${uuid} not found`);
    }
    const content = await decryptItemContent(raw, contentKeys());
    const access = noteAccess(content);
    if (access.protected || access.locked) {
      throw new Error(`Note ${uuid} is protected or locked`);
    }
  };
  const objectMap = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Malformed content metadata; refusing to replace it");
    }
    return value as Record<string, unknown>;
  };

  const writableTagTargets = async (before: http.RawItem, after: http.RawItem): Promise<void> => {
    const oldContent = await decryptItemContent(before, contentKeys());
    const newContent = await decryptItemContent(after, contentKeys());
    const noteTargets = (value: unknown): Set<string> => {
      if (value !== undefined && !Array.isArray(value)) throw new Error("Malformed tag references");
      return new Set((Array.isArray(value) ? value : []).flatMap((ref: unknown) => {
        if (!ref || typeof ref !== "object") return [];
        const r = ref as Record<string, unknown>;
        return r.content_type === "Note" && typeof r.uuid === "string" ? [r.uuid] : [];
      }));
    };
    const oldTargets = noteTargets(oldContent.references);
    const newTargets = noteTargets(newContent.references);
    for (const uuid of new Set([...oldTargets, ...newTargets])) {
      if (oldTargets.has(uuid) !== newTargets.has(uuid)) await writableNote(uuid);
    }
  };

  const reviewPreview = async (kind: SafeChange["kind"], before: http.RawItem | null, after: http.RawItem) => ({
    kind,
    uuid: after.uuid,
    before: before ? await decryptItemContent(before, contentKeys()) : null,
    after: await decryptItemContent(after, contentKeys()),
  });

  return {
    async getNoteWithRevision(uuid) {
      await fullSync(state);
      const raw = state.encryptedItemsRaw.get(uuid);
      if (!raw || raw.deleted || raw.content_type !== "Note") return null;
      const note = toFullNote(await decryptNote(raw, contentKeys()), state.tagsCache);
      return { ...note, revision: await itemRevision(raw) };
    },

    async getTagWithRevision(uuid) {
      await fullSync(state);
      const raw = state.encryptedItemsRaw.get(uuid);
      if (!raw || raw.deleted || raw.content_type !== "Tag") return null;
      const tag = toFullTag(await decryptTag(raw, contentKeys()));
      return { ...tag, revision: await itemRevision(raw) };
    },

    async getRevision(uuid) {
      await fullSync(state);
      const raw = state.encryptedItemsRaw.get(uuid);
      if (!raw) throw new Error(`Item ${uuid} not found`);
      return itemRevision(raw);
    },

    async getRawItem(uuid) {
      await fullSync(state);
      const raw = state.encryptedItemsRaw.get(uuid);
      return raw ? { ...raw } : null;
    },

    async prepareRecovery(plan) {
      await fullSync(state);
      const current = state.encryptedItemsRaw.get(plan.after.uuid);
      if (!current || !sameCiphertext(current, plan.after)) {
        throw new Error("Recovery conflict: item no longer matches the applied plan");
      }
      if (current.content_type === "Note") await writableNote(current.uuid);
      if (plan.change.kind === "tag_attach" || plan.change.kind === "tag_detach") {
        await writableNote(plan.change.noteUuid);
      }
      if (!plan.before) {
        if (current.content_type !== "Note") throw new Error("Tag creation cannot be undone safely");
        return this.prepareChange({ kind: "note_trash", uuid: current.uuid, revision: await itemRevision(current) });
      }
      if (plan.before.deleted || plan.before.uuid !== current.uuid ||
          plan.before.content_type !== current.content_type) throw new Error("Invalid recovery source");
      const after = { ...current, content: plan.before.content, enc_item_key: plan.before.enc_item_key,
        items_key_id: plan.before.items_key_id };
      if (current.content_type === "Tag") await writableTagTargets(current, after);
      return {
        change: { kind: "recovery", uuid: current.uuid, revision: await itemRevision(current) },
        before: { ...current },
        after,
        preview: await reviewPreview("recovery", current, after),
      };
    },

    async prepareChange(change) {
      if (change.kind === "recovery") throw new Error("Recovery is internal; use prepareRecovery");
      await fullSync(state);
      const now = new Date().toISOString();
      const creating = change.kind === "note_create" || change.kind === "tag_create";
      if (creating) {
        const uuid = crypto.randomUUID();
        const key = defaultItemsKey();
        const note = change.kind === "note_create";
        if (note && change.noteType !== undefined &&
            change.noteType !== "plain-text" && change.noteType !== "markdown") {
          throw new Error("Only plain-text and markdown note creation is supported");
        }
        if (change.kind === "note_create" && Buffer.byteLength(change.text, "utf8") > 10 * 1024 * 1024) {
          throw new Error("Final note text exceeds 10 MiB UTF-8 limit");
        }
        const encrypted = change.kind === "note_create"
          ? await encryptNote({ uuid, title: change.title, text: change.text,
              noteType: change.noteType ?? "plain-text" }, key)
          : await encryptTag({ uuid, title: change.title, references: [] }, key);
        const after: http.RawItem = { uuid, content_type: note ? "Note" : "Tag", ...encrypted,
          created_at: now, updated_at: now, created_at_timestamp: 0,
          updated_at_timestamp: 0, deleted: false };
        return {
          change: { ...change },
          before: null,
          after,
          preview: await reviewPreview(change.kind, null, after),
        };
      }
      // The union's create variants have returned above.
      if (!("uuid" in change)) throw new Error("Invalid change");
      const raw = state.encryptedItemsRaw.get(change.uuid);
      const expectedType = change.kind.startsWith("note_") ? "Note" : "Tag";
      if (!raw || raw.deleted || raw.content_type !== expectedType) {
        throw new Error(`Item ${change.uuid} not found or has wrong type`);
      }
      if (await itemRevision(raw) !== change.revision) {
        throw new Error("Stale revision; reconcile before retry");
      }
      if (expectedType === "Note") await writableNote(raw.uuid);
      if (change.kind === "tag_attach" || change.kind === "tag_detach") {
        await writableNote(change.noteUuid);
      }
      const content = await decryptItemContent(raw, contentKeys());
      switch (change.kind) {
        case "note_update": {
          if (change.text !== undefined && change.append !== undefined) {
            throw new Error("Specify text or append, not both");
          }
          if (change.text !== undefined || change.append !== undefined) {
            const type = content.noteType ?? "plain-text";
            const editor = content.editorIdentifier;
            if ((type !== "plain-text" && type !== "markdown") ||
                (editor !== undefined && editor !== "org.standardnotes.advanced-markdown-editor") ||
                (content.text !== undefined && typeof content.text !== "string")) {
              throw new Error("Body edits require a known plain-text or markdown note");
            }
            const nextText = change.text ?? ((content.text as string | undefined) ?? "") + change.append;
            if (Buffer.byteLength(nextText, "utf8") > 10 * 1024 * 1024) {
              throw new Error("Final note text exceeds 10 MiB UTF-8 limit");
            }
            content.text = nextText;
            content.preview_plain = nextText.slice(0, 160);
            // These are known text derivatives, not opaque application metadata.
            delete content.preview_html;
          }
          if (change.title !== undefined) content.title = change.title;
          break;
        }
        case "note_trash": content.trashed = true; break;
        case "note_restore": content.trashed = false; break;
        case "tag_update": content.title = change.title; break;
        case "tag_attach":
        case "tag_detach": {
          if (content.references !== undefined && !Array.isArray(content.references)) {
            throw new Error("Malformed tag references");
          }
          const refs = (content.references ?? []) as unknown[];
          const matches = (ref: unknown) => ref !== null && typeof ref === "object" &&
            (ref as Record<string, unknown>).uuid === change.noteUuid &&
            (ref as Record<string, unknown>).content_type === "Note";
          content.references = change.kind === "tag_detach"
            ? refs.filter((ref) => !matches(ref))
            : refs.some(matches) ? refs : [...refs, { uuid: change.noteUuid, content_type: "Note" }];
          break;
        }
        default: throw new Error("Unsupported change");
      }
      const appData = content.appData === undefined ? {} : objectMap(content.appData);
      const domain = appData["org.standardnotes.sn"] === undefined
        ? {} : objectMap(appData["org.standardnotes.sn"]);
      content.appData = { ...appData, "org.standardnotes.sn": { ...domain, client_updated_at: now } };
      const after = { ...raw, content: await replaceItemContent(raw, content, contentKeys()), updated_at: now };
      return {
        change: { ...change },
        before: { ...raw },
        after,
        preview: await reviewPreview(change.kind, raw, after),
      };
    },

    async commitChange(plan, options) {
      const { before, after } = plan;
      if (after.deleted !== false || !["Note", "Tag"].includes(after.content_type) ||
          !after.content.startsWith("004:") || !after.enc_item_key.startsWith("004:") ||
          (before && (before.uuid !== after.uuid || before.content_type !== after.content_type || before.deleted))) {
        throw new Error("Invalid prepared change; permanent deletion is disabled");
      }
      await fullSync(state);
      const current = state.encryptedItemsRaw.get(after.uuid);
      if (current && sameCiphertext(current, after)) return;
      if (options?.reconcileOnly) {
        throw new Error("Write not confirmed; reconciliation only, no write sent");
      }
      if (before ? !current || !sameCiphertext(current, before) ||
          await itemRevision(current) !== await itemRevision(before) : current !== undefined) {
        throw new Error("Conflict: expected item changed, disappeared, or UUID collided; reconcile before retry");
      }
      if (before?.content_type === "Note") await writableNote(before.uuid);
      if (plan.change.kind === "tag_attach" || plan.change.kind === "tag_detach") {
        await writableNote(plan.change.noteUuid);
      }
      // Recovery may restore a tag's old references. Check all changed Note targets
      // from ciphertext rather than trusting optional presentation metadata.
      if (before?.content_type === "Tag") await writableTagTargets(before, after);
      // Authenticate both ciphertext fields before transmitting even a restored plan.
      await decryptItemContent(after, contentKeys());
      try {
        const res = await pushItems([after]);
        if (res.conflicts.length > 0) throw new Error("Conflict; no automatic retry");
        const saved = res.saved_items.find((item) => item.uuid === after.uuid);
        if (!saved || !sameCiphertext(saved, after)) throw new Error("Saved item identity not confirmed");
        // Fetch from a null token, not from our just-written local cache.
        await fullSync(state, true);
        const readback = state.encryptedItemsRaw.get(after.uuid);
        if (!readback || !sameCiphertext(readback, after)) throw new Error("Readback identity not confirmed");
      } catch {
        throw new Error("Write outcome uncertain or conflicted; reconcile before retry. No automatic retry.");
      }
    },

    async listNotes({ limit, offset, includeTrashed, tag, includeDescendants }) {
      await ensureFresh(state, cacheTtlMs(), () => fullSync(state));
      let allowedNoteUuids: Set<string> | null = null;
      if (tag !== undefined && tag !== "") {
        const matched =
          state.tagsCache.get(tag) ??
          [...state.tagsCache.values()].find(
            (t) => t.title.toLowerCase() === tag.toLowerCase(),
          );
        if (!matched) {
          throw new Error(`Tag not found: ${tag}`);
        }
        // With includeDescendants, walk the sub-tree from the matched tag
        // and union the note refs of every tag inside it. Mirrors the SN
        // sidebar: clicking a parent folder shows every note filed under
        // any child, grandchild, etc.
        const tagUuids = includeDescendants
          ? subtreeTagUuids(state.tagsCache, matched.uuid)
          : new Set([matched.uuid]);
        allowedNoteUuids = new Set<string>();
        for (const uuid of tagUuids) {
          const t = state.tagsCache.get(uuid);
          if (!t) continue;
          for (const r of t.references) {
            if (r.content_type === "Note") allowedNoteUuids.add(r.uuid);
          }
        }
      }
      const all = [...state.notesCache.values()]
        .filter((n) => includeTrashed || !n.trashed)
        .filter((n) => !allowedNoteUuids || allowedNoteUuids.has(n.uuid))
        .sort((a, b) => b.updated_at_timestamp - a.updated_at_timestamp);
      return all.slice(offset, offset + limit).map(toSummary);
    },

    async stats() {
      await ensureFresh(state, cacheTtlMs(), () => fullSync(state));
      const notes = [...state.notesCache.values()];
      const active = notes.filter((n) => !n.trashed);
      const byNoteType: Record<string, number> = {};
      let totalTextBytes = 0;
      let largest: VaultStats["largest"] = null;
      let oldestTs = Infinity;
      let oldest: VaultStats["oldest"] = null;
      let newestTs = -Infinity;
      let newest: VaultStats["newest"] = null;
      for (const n of active) {
        byNoteType[n.noteType] = (byNoteType[n.noteType] ?? 0) + 1;
        const bytes = Buffer.byteLength(n.text, "utf8");
        totalTextBytes += bytes;
        if (!largest || bytes > largest.bytes) {
          largest = { uuid: n.uuid, title: n.title, bytes };
        }
        if (n.created_at_timestamp > 0 && n.created_at_timestamp < oldestTs) {
          oldestTs = n.created_at_timestamp;
          oldest = { uuid: n.uuid, title: n.title, createdAt: n.createdAt };
        }
        if (n.updated_at_timestamp > newestTs) {
          newestTs = n.updated_at_timestamp;
          newest = { uuid: n.uuid, title: n.title, updatedAt: n.updatedAt };
        }
      }
      return {
        notes: {
          total: notes.length,
          active: active.length,
          trashed: notes.length - active.length,
        },
        tags: state.tagsCache.size,
        byNoteType,
        totalTextBytes,
        averageTextBytes:
          active.length === 0 ? 0 : Math.round(totalTextBytes / active.length),
        largest,
        oldest,
        newest,
        syncedAt: new Date(state.lastSyncAt).toISOString(),
        cacheAgeMs: Date.now() - state.lastSyncAt,
        decryptFailures: {
          notes: state.decryptFailedNotes.size,
          tags: state.decryptFailedTags.size,
        },
      };
    },

    async searchNotes(query, limit) {
      await ensureFresh(state, cacheTtlMs(), () => fullSync(state));
      const q = query.toLowerCase();
      const hits: DecryptedNote[] = [];
      for (const n of state.notesCache.values()) {
        if (n.trashed || n.protected) continue;
        if (n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q)) {
          hits.push(n);
          if (hits.length >= limit * 4) break;
        }
      }
      return hits
        .sort((a, b) => b.updated_at_timestamp - a.updated_at_timestamp)
        .slice(0, limit)
        .map(toSummary);
    },

    async getNote(uuid) {
      await ensureFresh(state, cacheTtlMs(), () => fullSync(state));
      const n = state.notesCache.get(uuid);
      return n ? toFullNote(n, state.tagsCache) : null;
    },

    async createNote({ title, text, noteType, tags }) {
      const uuid = crypto.randomUUID();
      const resolvedType: NoteType = noteType ?? "markdown";
      const resolvedText =
        resolvedType === "super" ? normalizeSuperText(text) : text;
      const encrypted = await encryptNote(
        {
          uuid,
          title,
          text: resolvedText,
          trashed: false,
          noteType: resolvedType,
        },
        { uuid: defaultItemsKey().uuid, itemsKey: defaultItemsKey().itemsKey },
      );
      const nowIso = new Date().toISOString();
      const res = await pushItems([
        {
          uuid,
          content_type: "Note",
          content: encrypted.content,
          enc_item_key: encrypted.enc_item_key,
          items_key_id: encrypted.items_key_id,
          created_at: nowIso,
          updated_at: nowIso,
          created_at_timestamp: 0,
          updated_at_timestamp: 0,
          deleted: false,
        },
      ]);
      const saved = res.saved_items.find((i) => i.uuid === uuid);
      if (!saved) {
        const conflict = res.conflicts.find(
          (c) => (c as { unsaved_item?: { uuid?: string } }).unsaved_item?.uuid === uuid,
        );
        throw new Error(
          `Server did not save note ${uuid}` +
            (conflict ? ` (conflict: ${JSON.stringify(conflict)})` : ""),
        );
      }
      state.notesCache.set(uuid, {
        uuid,
        title,
        text: resolvedText,
        trashed: false,
        protected: false,
        locked: false,
        noteType: resolvedType,
        createdAt: saved.created_at ?? nowIso,
        updatedAt: saved.updated_at ?? nowIso,
        created_at_timestamp: saved.created_at_timestamp ?? 0,
        updated_at_timestamp: saved.updated_at_timestamp ?? 0,
      });
      if (tags && tags.length > 0) {
        for (const tagUuid of tags) {
          await attachTagInternal(uuid, tagUuid);
        }
      }
      return uuid;
    },

    async createNotesBatch(inputs) {
      if (inputs.length === 0) return [];
      const nowIso = new Date().toISOString();
      type Prepared = {
        uuid: string;
        title: string;
        text: string;
        noteType: NoteType;
        tags: string[];
      };
      const prepared: Prepared[] = inputs.map((input) => {
        const resolvedType: NoteType = input.noteType ?? "markdown";
        const resolvedText =
          resolvedType === "super"
            ? normalizeSuperText(input.text)
            : input.text;
        return {
          uuid: crypto.randomUUID(),
          title: input.title,
          text: resolvedText,
          noteType: resolvedType,
          tags: input.tags ?? [],
        };
      });
      const items = await Promise.all(
        prepared.map(async (p) => {
          const encrypted = await encryptNote(
            {
              uuid: p.uuid,
              title: p.title,
              text: p.text,
              trashed: false,
              noteType: p.noteType,
            },
            {
              uuid: defaultItemsKey().uuid,
              itemsKey: defaultItemsKey().itemsKey,
            },
          );
          return {
            uuid: p.uuid,
            content_type: "Note",
            content: encrypted.content,
            enc_item_key: encrypted.enc_item_key,
            items_key_id: encrypted.items_key_id,
            created_at: nowIso,
            updated_at: nowIso,
            created_at_timestamp: 0,
            updated_at_timestamp: 0,
            deleted: false,
          };
        }),
      );
      const res = await pushItems(items);
      const savedByUuid = new Map(res.saved_items.map((i) => [i.uuid, i]));
      const failed: string[] = [];
      for (const p of prepared) {
        const saved = savedByUuid.get(p.uuid);
        if (!saved) {
          failed.push(p.uuid);
          continue;
        }
        state.notesCache.set(p.uuid, {
          uuid: p.uuid,
          title: p.title,
          text: p.text,
          trashed: false,
          protected: false,
          locked: false,
          noteType: p.noteType,
          createdAt: saved.created_at ?? nowIso,
          updatedAt: saved.updated_at ?? nowIso,
          created_at_timestamp: saved.created_at_timestamp ?? 0,
          updated_at_timestamp: saved.updated_at_timestamp ?? 0,
        });
      }
      if (failed.length > 0) {
        throw new Error(
          `Server did not save ${failed.length} note(s) in batch: ${failed.join(", ")}`,
        );
      }
      for (const p of prepared) {
        for (const tagUuid of p.tags) {
          await attachTagInternal(p.uuid, tagUuid);
        }
      }
      return prepared.map((p) => ({ uuid: p.uuid, title: p.title }));
    },

    async updateNote({ uuid, title, text, noteType, tags }) {
      // Sync inconditionnel avant mutation : sinon on peut écraser une
      // révision plus récente produite par une autre instance du serveur
      // (cf. intakes/mcp-standardnotes-cache-staleness.md).
      await ensureFresh(state, 0, () => fullSync(state));
      const existing = state.notesCache.get(uuid);
      if (!existing) throw new Error(`Note ${uuid} not found`);
      const raw = state.encryptedItemsRaw.get(uuid);
      if (!raw) throw new Error(`Note ${uuid} has no encrypted record`);
      const contentChanged =
        title !== undefined || text !== undefined || noteType !== undefined;
      if (contentChanged) {
        const nextType: NoteType = noteType ?? existing.noteType;
        const nextTextRaw = text ?? existing.text;
        const nextText =
          nextType === "super" && text !== undefined
            ? normalizeSuperText(text)
            : nextTextRaw;
        const merged = {
          uuid,
          title: title ?? existing.title,
          text: nextText,
          trashed: existing.trashed,
          noteType: nextType,
        };
        const saved = await submitNoteUpdate(uuid, merged);
        state.notesCache.set(uuid, {
          ...existing,
          ...merged,
          createdAt: saved.created_at ?? existing.createdAt,
          updatedAt: saved.updated_at ?? existing.updatedAt,
          created_at_timestamp:
            saved.created_at_timestamp ?? existing.created_at_timestamp,
          updated_at_timestamp:
            saved.updated_at_timestamp ?? existing.updated_at_timestamp,
        });
      }
      if (tags !== undefined) {
        await syncTagsToNote(uuid, tags);
      }
    },

    async deleteNote(uuid, permanent) {
      await ensureFresh(state, 0, () => fullSync(state));
      const raw = state.encryptedItemsRaw.get(uuid);
      if (!raw) throw new Error(`Note ${uuid} not found`);
      if (permanent) throw new Error("Permanent deletion is disabled");
      {
        const existing = state.notesCache.get(uuid);
        if (!existing) throw new Error(`Note ${uuid} not found in cache`);
        const merged = { ...existing, trashed: true };
        const encrypted = await encryptNote(
          {
            uuid,
            title: merged.title,
            text: merged.text,
            trashed: true,
            noteType: merged.noteType,
          },
          {
            uuid: defaultItemsKey().uuid,
            itemsKey: defaultItemsKey().itemsKey,
          },
        );
        const res = await pushItems([
          {
            ...raw,
            content: encrypted.content,
            enc_item_key: encrypted.enc_item_key,
            items_key_id: encrypted.items_key_id,
            updated_at: new Date().toISOString(),
            updated_at_timestamp: raw.updated_at_timestamp,
          },
        ]);
        const saved = res.saved_items.find((i) => i.uuid === uuid);
        state.notesCache.set(uuid, {
          ...merged,
          updatedAt: saved?.updated_at ?? existing.updatedAt,
          updated_at_timestamp:
            saved?.updated_at_timestamp ?? existing.updated_at_timestamp,
        });
      }
    },

    async listTags() {
      await ensureFresh(state, cacheTtlMs(), () => fullSync(state));
      return [...state.tagsCache.values()]
        .sort((a, b) => a.title.localeCompare(b.title))
        .map(toTagSummary);
    },

    async getTag(uuid) {
      await ensureFresh(state, cacheTtlMs(), () => fullSync(state));
      const t = state.tagsCache.get(uuid);
      return t ? toFullTag(t) : null;
    },

    async createTag({ title, parent }) {
      // Sync forcé : le duplicate-title-under-same-parent check ne vaut
      // rien sur un cache périmé.
      await ensureFresh(state, 0, () => fullSync(state));
      if (parent !== undefined && !state.tagsCache.has(parent)) {
        throw new Error(`Parent tag ${parent} not found`);
      }
      // SN allows same-title tags under different parents (like folders), so
      // scope the duplicate check to actual siblings, not the whole vault.
      const sibling = [...state.tagsCache.values()].find(
        (t) => t.title === title && parentUuidOf(t) === (parent ?? null),
      );
      if (sibling) {
        throw new Error(
          `Tag with title "${title}" already exists under the same parent (uuid=${sibling.uuid})`,
        );
      }
      const uuid = crypto.randomUUID();
      const references: TagReference[] =
        parent !== undefined ? [makeParentRef(parent)] : [];
      await pushTag(null, { uuid, title, references });
      return uuid;
    },

    async updateTag({ uuid, title, parent }) {
      await ensureFresh(state, 0, () => fullSync(state));
      const existing = state.tagsCache.get(uuid);
      if (!existing) throw new Error(`Tag ${uuid} not found`);
      if (title === undefined && parent === undefined) {
        throw new Error(
          `updateTag on ${uuid}: provide at least one of { title, parent }`,
        );
      }
      let references = existing.references;
      if (parent !== undefined) {
        if (parent !== null) {
          if (!state.tagsCache.has(parent)) {
            throw new Error(`Parent tag ${parent} not found`);
          }
          if (wouldCreateCycle(state.tagsCache, uuid, parent)) {
            throw new Error(
              `Cannot make tag ${uuid} a child of ${parent}: would create a cycle`,
            );
          }
        }
        references = stripParentRefs(references);
        if (parent !== null) references = [...references, makeParentRef(parent)];
      }
      const nextTitle = title ?? existing.title;
      // Same sibling-uniqueness check as createTag, using whatever parent the
      // tag will end up with after this update.
      const nextParent =
        parent !== undefined ? parent : parentUuidOf(existing);
      const sibling = [...state.tagsCache.values()].find(
        (t) =>
          t.uuid !== uuid &&
          t.title === nextTitle &&
          parentUuidOf(t) === (nextParent ?? null),
      );
      if (sibling) {
        throw new Error(
          `Tag with title "${nextTitle}" already exists under the same parent (uuid=${sibling.uuid})`,
        );
      }
      await pushTag(existing, {
        uuid,
        title: nextTitle,
        references,
      });
    },

    async deleteTag() {
      throw new Error("Permanent tag deletion is disabled");
    },

    async attachTag(noteUuid, tagUuid) {
      await ensureFresh(state, 0, () => fullSync(state));
      await attachTagInternal(noteUuid, tagUuid);
    },

    async detachTag(noteUuid, tagUuid) {
      await ensureFresh(state, 0, () => fullSync(state));
      await detachTagInternal(noteUuid, tagUuid);
    },

    async sync() {
      await fullSync(state);
      return {
        notes: state.notesCache.size,
        tags: state.tagsCache.size,
        syncedAt: new Date().toISOString(),
      };
    },
  };
}

// Keep unused imports from triggering errors while some helpers are reserved
// for future session-resume or rotation work.
void generateItemsKeyRaw;
export type { StoredSession };
