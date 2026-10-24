import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), load: vi.fn() }));
vi.mock("../sn/client.js", () => ({ createClientFromSession: mocks.create }));
vi.mock("../sn/session.js", () => ({ loadSession: mocks.load, resolveEmail: async () => "a@example.invalid", recoveryKey: async () => new Uint8Array(32) }));

const { withClient, resetClientCache } = await import("./account-context.js");
const { SnApiError } = await import("../sn/http.js");

const session = (access: string, refresh: string, masterKeyHex = "k".repeat(64)) => ({
  serverUrl: "https://api.standardnotes.com", email: "a@example.invalid", masterKeyHex, sessionPayload: { access_token: access, refresh_token: refresh } });
const fakeClient = () => {
  let tokens = { access: "", refresh: "" };
  return { sessionTokens: () => tokens, adoptTokens: vi.fn((access: string, refresh: string) => { tokens = { access, refresh }; }),
    setTokens: (access: string, refresh: string) => { tokens = { access, refresh }; } };
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sn-context-"));
  vi.stubEnv("SN_STATE_DIR", dir);
  vi.stubEnv("SN_SERVER_URL", "");
  resetClientCache();
  mocks.create.mockReset();
  mocks.load.mockReset();
});
afterEach(async () => { vi.unstubAllEnvs(); vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });

describe("per-process client", () => {
  it("reuses one client, adopts rotated keychain tokens, and rebuilds after re-login or an error", async () => {
    const first = fakeClient(); first.setTokens("a1", "r1");
    const second = fakeClient();
    mocks.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValue(fakeClient());
    mocks.load.mockResolvedValue(session("a1", "r1"));
    expect(await withClient(async (c) => c)).toBe(first);
    expect(await withClient(async (c) => c)).toBe(first);
    expect(first.adoptTokens).not.toHaveBeenCalled();
    mocks.load.mockResolvedValue(session("a2", "r2"));
    await withClient(async () => undefined);
    expect(first.adoptTokens).toHaveBeenCalledWith("a2", "r2");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    mocks.load.mockResolvedValue(session("a2", "r2", "m".repeat(64)));
    expect(await withClient(async (c) => c)).toBe(second);
    await expect(withClient(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withClient(async (c) => c)).not.toBe(second);
    expect(mocks.create).toHaveBeenCalledTimes(3);
  });

  it("after HTTP 429 sends nothing until Retry-After has passed, across processes sharing the state dir", async () => {
    mocks.load.mockResolvedValue(session("a", "r"));
    mocks.create.mockResolvedValue(fakeClient());
    await expect(withClient(async () => { throw new SnApiError("Rate limited", "rate-limited", 429, { retryAfter: "120" }); })).rejects.toThrow("Rate limited");
    const account = path.join(dir, (await readdir(dir))[0]!);
    expect(await readdir(account)).toContain("rate-limited-until.json");
    mocks.create.mockClear();
    const work = vi.fn();
    await expect(withClient(work)).rejects.toThrow(/No request was sent/);
    expect(work).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    vi.useFakeTimers({ now: Date.now() + 121_000, toFake: ["Date"] });
    await withClient(work);
    expect(work).toHaveBeenCalledOnce();
    expect(await readdir(account)).not.toContain("rate-limited-until.json");
  });

  it("ignores a malformed or implausibly distant rate-limit marker", async () => {
    mocks.load.mockResolvedValue(session("a", "r"));
    mocks.create.mockResolvedValue(fakeClient());
    await withClient(async () => undefined);
    const account = path.join(dir, (await readdir(dir))[0]!);
    for (const body of ["not json", JSON.stringify({ until: Date.now() + 30 * 86400_000 })]) {
      await writeFile(path.join(account, "rate-limited-until.json"), body);
      await expect(withClient(async () => "ok")).resolves.toBe("ok");
    }
  });
});
