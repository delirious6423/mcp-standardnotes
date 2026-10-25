import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), load: vi.fn() }));
vi.mock("../sn/client.js", () => ({ createClientFromSession: mocks.create }));
vi.mock("../sn/session.js", () => ({ loadSession: mocks.load, resolveEmail: async () => "a@example.invalid", recoveryKey: async () => new Uint8Array(32) }));

const { withClient, resetClientCache } = await import("./account-context.js");
const { SnApiError, refreshSession } = await import("../sn/http.js");

const session = (access: string, refresh: string, masterKeyHex = "k".repeat(64)) => ({
  serverUrl: "https://api.standardnotes.com", email: "a@example.invalid", masterKeyHex, sessionPayload: { access_token: access, refresh_token: refresh } });
const fakeClient = () => {
  let tokens = { access: "", refresh: "" };
  let synced = true;
  return { sessionTokens: () => tokens, adoptTokens: vi.fn((access: string, refresh: string) => { tokens = { access, refresh }; }),
    setTokens: (access: string, refresh: string) => { tokens = { access, refresh }; },
    inSync: () => synced, setInSync: (value: boolean) => { synced = value; } };
};

let dir: string;
beforeEach(async () => {
  // A child directory, created by the connector itself: Windows refuses a pre-existing admin-owned one.
  dir = path.join(await mkdtemp(path.join(os.tmpdir(), "sn-context-")), "state");
  vi.stubEnv("SN_STATE_DIR", dir);
  vi.stubEnv("SN_SERVER_URL", "");
  resetClientCache();
  mocks.create.mockReset();
  mocks.load.mockReset();
});
afterEach(async () => { vi.unstubAllEnvs(); vi.useRealTimers(); await rm(path.dirname(dir), { recursive: true, force: true }); });

// Windows private-file checks launch PowerShell, about a second each.
describe("per-process client", { timeout: 120_000 }, () => {
  it("reuses one client, adopts rotated keychain tokens, and rebuilds after re-login or when it is out of sync", async () => {
    const first = fakeClient(); first.setTokens("a1", "r1");
    const second = fakeClient();
    mocks.create.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockImplementation(async () => fakeClient());
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
    // A local error (bad UUID, stale revision) keeps the synced client; no full re-sync follows.
    await expect(withClient(async () => { throw new Error("Note not found"); })).rejects.toThrow("not found");
    expect(await withClient(async (c) => c)).toBe(second);
    // A client whose state may be incomplete (failed sync, push without read-back) is dropped, error or not.
    await expect(withClient(async () => { second.setInSync(false); throw new Error("Conflict"); })).rejects.toThrow("Conflict");
    const third = await withClient(async (c) => c);
    expect(third).not.toBe(second);
    (third as unknown as ReturnType<typeof fakeClient>).setInSync(false);
    expect(await withClient(async (c) => c)).not.toBe(third);
    expect(mocks.create).toHaveBeenCalledTimes(4);
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

  it("records a 429 that a commit wrapped in its own error, or that a successful call swallowed", async () => {
    mocks.load.mockResolvedValue(session("a", "r"));
    mocks.create.mockResolvedValue(fakeClient());
    const limited = new SnApiError("Rate limited", "rate-limited", 429, { retryAfter: "60" });
    await expect(withClient(async () => { throw new Error("Operation x was not confirmed", { cause: new Error("uncertain", { cause: limited }) }); })).rejects.toThrow();
    const account = path.join(dir, (await readdir(dir))[0]!);
    expect(await readdir(account)).toContain("rate-limited-until.json");
    await rm(path.join(account, "rate-limited-until.json"));
    // A 429 seen by the HTTP layer counts even when the call itself swallows it and returns normally.
    const server = http.createServer((_req, res) => { res.writeHead(429, { "Retry-After": "60" }); res.end("{}"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await withClient(async () => {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        await refreshSession({ serverUrl: url }, "SYNTHETIC", "SYNTHETIC").catch(() => undefined);
      });
    } finally { await new Promise((r) => server.close(r)); }
    expect(await readdir(account)).toContain("rate-limited-until.json");
  });

  it("ignores a malformed or implausibly distant rate-limit marker", async () => {
    mocks.load.mockResolvedValue(session("a", "r"));
    mocks.create.mockResolvedValue(fakeClient());
    await withClient(async () => undefined);
    const account = path.join(dir, (await readdir(dir))[0]!);
    for (const body of ["not json", JSON.stringify({ until: Date.now() + 30 * 86400_000 })]) {
      await writeFile(path.join(account, "rate-limited-until.json"), body, { mode: 0o600 });
      await expect(withClient(async () => "ok")).resolves.toBe("ok");
    }
  });

  // Windows symlinks need elevation; its private-file checks are covered by the Windows VM gate.
  it.skipIf(process.platform === "win32")("writes the marker as a new private file and never follows a planted symlink", async () => {
    mocks.load.mockResolvedValue(session("a", "r"));
    mocks.create.mockResolvedValue(fakeClient());
    await withClient(async () => undefined);
    const account = path.join(dir, (await readdir(dir))[0]!);
    const marker = path.join(account, "rate-limited-until.json");
    const victim = path.join(path.dirname(dir), "victim.json");
    // A symlinked marker is not read: its target's valid-looking wait does not block calls.
    await writeFile(victim, JSON.stringify({ until: Date.now() + 60_000 }), { mode: 0o600 });
    await symlink(victim, marker);
    await expect(withClient(async () => "ok")).resolves.toBe("ok");
    const before = await readFile(victim, "utf8");
    // Planted after the call's own marker check removed the ignored one: the write must still not follow it.
    await expect(withClient(async () => {
      await symlink(victim, marker);
      throw new SnApiError("Rate limited", "rate-limited", 429, { retryAfter: "60" });
    })).rejects.toThrow();
    expect(await readFile(victim, "utf8")).toBe(before);
    const stat = await lstat(marker);
    expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    await expect(withClient(async () => "ok")).rejects.toThrow(/No request was sent/);
  });
});
