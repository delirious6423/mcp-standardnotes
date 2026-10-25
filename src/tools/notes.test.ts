import { describe, expect, it, vi } from "vitest";
import type { SnClient } from "../sn/client.js";
import type { NoteSummary } from "../sn/types.js";
import { registerNoteHandlers } from "./notes.js";

function summary(over: Partial<NoteSummary> = {}): NoteSummary {
  return {
    uuid: "11111111-1111-4111-8111-111111111111",
    title: "t",
    updatedAt: "2026-04-15T00:00:00Z",
    preview: "preview text",
    trashed: false,
    protected: false,
    locked: false,
    noteType: "plain-text",
    ...over,
  };
}

function fakeClient(): SnClient {
  return ({
    listNotes: vi.fn(async () => []),
    searchNotes: vi.fn(async () => []),
    getNote: vi.fn(async () => null),
    stats: vi.fn(async () => ({
      notes: { total: 0, active: 0, trashed: 0 },
      tags: 0,
      byNoteType: {},
      totalTextBytes: 0,
      averageTextBytes: 0,
      largest: null,
      oldest: null,
      newest: null,
    })),
    listTags: vi.fn(async () => []),
    getTag: vi.fn(async () => null),
    sync: vi.fn(async () => ({
      notes: 0,
      tags: 0,
      syncedAt: "2026-04-15T00:00:00Z",
    })),
  }) as unknown as SnClient;
}

describe("tool input validation", () => {
  it("notes_list applies defaults", async () => {
    const c = fakeClient();
    const h = registerNoteHandlers(c);
    await h.notes_list({});
    expect(c.listNotes).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      includeTrashed: false,
      includeDescendants: false,
    });
  });

  it("notes_list rejects limit > 200", async () => {
    const h = registerNoteHandlers(fakeClient());
    await expect(h.notes_list({ limit: 500 })).rejects.toThrow();
  });

  it("notes_list forwards includeDescendants to the client", async () => {
    const c = fakeClient();
    const h = registerNoteHandlers(c);
    await h.notes_list({ tag: "Knowledge Base", includeDescendants: true });
    expect(c.listNotes).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      includeTrashed: false,
      tag: "Knowledge Base",
      includeDescendants: true,
    });
  });

  it("notes_list rejects a non-boolean includeDescendants", async () => {
    const h = registerNoteHandlers(fakeClient());
    await expect(
      h.notes_list({ includeDescendants: "yes" as unknown as boolean }),
    ).rejects.toThrow();
  });

  it("notes_list forwards tag filter", async () => {
    const c = fakeClient();
    const h = registerNoteHandlers(c);
    await h.notes_list({ tag: "Recettes" });
    expect(c.listNotes).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "Recettes" }),
    );
  });

  it("notes_stats calls client.stats", async () => {
    const c = fakeClient();
    const h = registerNoteHandlers(c);
    const res = await h.notes_stats({});
    expect(c.stats).toHaveBeenCalled();
    expect(res).toMatchObject({ notes: { total: 0 } });
  });

});

// The user-facing protection policy. The protocol layer reports flags
// faithfully — these tests pin the *behavior* the tool layer must enforce:
// protected = info-disclosure protection (masked in listings; notes_get and
// writes refuse it, see server.test.ts and safe-write.test.ts), locked = edit-lock only.
describe("protected/locked enforcement", () => {
  const uuid = "11111111-1111-4111-8111-111111111111";

  it("notes_list masks protected notes (title + preview) and leaves locked notes intact", async () => {
    const c = fakeClient();
    (c.listNotes as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      summary({ uuid, title: "Secret", preview: "very sensitive", protected: true }),
      summary({
        uuid: "22222222-2222-4222-8222-222222222222",
        title: "Recipe",
        preview: "flour, eggs",
        locked: true,
      }),
    ]);
    const h = registerNoteHandlers(c);
    const result = await h.notes_list({}) as NoteSummary[];
    expect(result[0]).toMatchObject({
      uuid,
      title: "[Protected]",
      preview: "",
      protected: true,
    });
    expect(result[1]).toMatchObject({
      title: "Recipe",
      preview: "flour, eggs",
      locked: true,
    });
  });

  it("notes_search masks protected matches the same way notes_list does", async () => {
    const c = fakeClient();
    (c.searchNotes as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      summary({ uuid, title: "Secret", preview: "very sensitive", protected: true }),
    ]);
    const h = registerNoteHandlers(c);
    const result = await h.notes_search({ query: "x" }) as NoteSummary[];
    expect(result[0]).toMatchObject({ title: "[Protected]", preview: "" });
  });

});
