import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

const uuid = "11111111-1111-4111-8111-111111111111";
const note = (over: Record<string, unknown>) => ({ uuid, title: "Secret", text: "body", protected: false, locked: false, revision: "r", ...over });
const fake = {
  getNoteWithRevision: vi.fn(),
  getNote: vi.fn(),
  stats: vi.fn(),
};
vi.mock("./security/account-context.js", () => ({
  withClient: async (fn: (c: unknown, j: unknown) => unknown) => fn(fake, async () => { throw new Error("no journal in this test"); }),
  withAccount: async () => { throw new Error("no account in this test"); },
}));

const { buildServer } = await import("./server.js");

async function connect(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;

describe("MCP server", () => {
  it("offers only reads and approval-gated writes", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "notes_get", "notes_get_batch", "notes_list", "notes_search", "notes_stats", "tags_get", "tags_list",
      "writes_commit", "writes_prepare", "writes_prepare_batch", "writes_status", "writes_undo_prepare",
    ]);
  });

  it("notes_get refuses a protected note's body and returns a locked (read-only) one", async () => {
    const client = await connect();
    fake.getNoteWithRevision.mockResolvedValueOnce(note({ protected: true, text: "SYNTHETIC-SECRET" }));
    const refused = await client.callTool({ name: "notes_get", arguments: { uuid } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/protected/);
    expect(text(refused)).not.toContain("SYNTHETIC-SECRET");
    fake.getNoteWithRevision.mockResolvedValueOnce(note({ locked: true, text: "recipe body" }));
    const locked = await client.callTool({ name: "notes_get", arguments: { uuid } });
    expect(locked.isError).toBeFalsy();
    expect(JSON.parse(text(locked))).toMatchObject({ text: "recipe body", locked: true });
  });

  it("notes_stats masks a protected note's title", async () => {
    const client = await connect();
    fake.stats.mockResolvedValueOnce({ largest: { uuid, title: "Secret" }, oldest: null, newest: null });
    fake.getNote.mockResolvedValueOnce(note({ protected: true }));
    const stats = JSON.parse(text(await client.callTool({ name: "notes_stats", arguments: {} })));
    expect(stats.largest).toEqual({ uuid, title: "[Protected]" });
  });
});
