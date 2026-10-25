import { z } from "zod";
import type { SnClient } from "../sn/client.js";
import type { NoteSummary } from "../sn/types.js";

export const uuidSchema = z.string().uuid();

export const listInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  includeTrashed: z.boolean().default(false),
  tag: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Filter by tag UUID or title (case-insensitive)"),
  includeDescendants: z
    .boolean()
    .default(false)
    .describe(
      "When `tag` is set, also include notes filed under any descendant tag (SN folder behavior). Off by default.",
    ),
  archived: z.boolean().optional().describe("true: only archived notes; false: only unarchived; unset: both"),
});

export const statsInput = z.object({});

export const searchInput = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(20),
});

export const getInput = z.object({ uuid: uuidSchema });

export const getBatchInput = z.object({ uuids: z.array(uuidSchema).min(1).max(200) });

// `protected` (SN top-level content flag) = the user has marked the note as
// requiring re-auth to view. We surface it as a masked summary in listings and
// refuse to read/update/delete the content via MCP — pushing the body into an
// LLM context would defeat the protection the user explicitly asked for.
// `locked` (SN appData edit-lock) = read-only. Content stays visible, only
// writes are refused.
function maskProtected<T extends NoteSummary>(n: T): T {
  return n.protected ? { ...n, title: "[Protected]", preview: "" } : n;
}

export function registerNoteHandlers(client: SnClient) {
  return {
    notes_list: async (raw: unknown) => {
      const args = listInput.parse(raw);
      const notes = await client.listNotes(args);
      return notes.map(maskProtected);
    },
    notes_search: async (raw: unknown) => {
      const { query, limit } = searchInput.parse(raw);
      const hits = await client.searchNotes(query, limit);
      return hits.map(maskProtected);
    },
    notes_stats: async (raw: unknown) => {
      statsInput.parse(raw ?? {});
      return client.stats();
    },
  };
}

export type NoteHandlers = ReturnType<typeof registerNoteHandlers>;
