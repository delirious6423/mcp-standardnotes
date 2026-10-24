import { z } from "zod";

const uuid = z.string().uuid();
const revision = z.string().regex(/^[0-9a-f]{64}$/, "Use the opaque revision returned by notes_get/tags_get");
const body = z.string().max(10 * 1024 * 1024).refine((s) => Buffer.byteLength(s, "utf8") <= 10 * 1024 * 1024, "Body exceeds 10 MiB");
const title = z.string().max(500);
const tagTitle = z.string().min(1).max(256);

// 'recovery' is internal-only: agents can never submit raw encrypted payloads.
export const changeInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note_create"), title, text: body, noteType: z.enum(["plain-text", "markdown"]).optional() }).strict(),
  z.object({ kind: z.literal("note_update"), uuid, revision, title: title.optional(), text: body.optional(), append: body.optional() }).strict(),
  z.object({ kind: z.literal("note_trash"), uuid, revision }).strict(),
  z.object({ kind: z.literal("note_restore"), uuid, revision }).strict(),
  z.object({ kind: z.literal("note_flags"), uuid, revision, archived: z.boolean().optional(), pinned: z.boolean().optional(), starred: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("tag_create"), title: tagTitle }).strict(),
  z.object({ kind: z.literal("tag_update"), uuid, revision, title: tagTitle }).strict(),
  z.object({ kind: z.literal("tag_attach"), uuid, revision, noteUuid: uuid }).strict(),
  z.object({ kind: z.literal("tag_detach"), uuid, revision, noteUuid: uuid }).strict(),
]).refine((v) => v.kind !== "note_update" || ((v.title !== undefined || v.text !== undefined || v.append !== undefined) && !(v.text !== undefined && v.append !== undefined)), "Provide title, text or append; do not combine text and append")
  .refine((v) => v.kind !== "note_flags" || v.archived !== undefined || v.pinned !== undefined || v.starred !== undefined, "note_flags needs archived, pinned or starred");

// One approval for up to 200 changes. Several changes to one item compose into one write.
export const batchInput = z.object({ changes: z.array(changeInput).min(1).max(200) }).strict();

export const operationInput = z.object({ operationId: uuid }).strict();
