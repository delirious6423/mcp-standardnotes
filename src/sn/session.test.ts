import { beforeEach, describe, expect, it, vi } from "vitest";

// Keyed by service and account, like the OS keychain.
const store = new Map<string, string>();
const key = (s: string, a: string) => `${s}\u0000${a}`;

vi.mock("keytar", () => ({
  default: {
    setPassword: vi.fn(async (s: string, a: string, p: string) => { store.set(key(s, a), p); }),
    getPassword: vi.fn(async (s: string, a: string) => store.get(key(s, a)) ?? null),
    deletePassword: vi.fn(async (s: string, a: string) => store.delete(key(s, a))),
    findCredentials: vi.fn(async (s: string) => [...store].filter(([k]) => k.startsWith(`${s}\u0000`))
      .map(([k, password]) => ({ account: k.slice(s.length + 1), password }))),
  },
}));

import { deleteSession, loadSession, resolveEmail, saveSession, type StoredSession } from "./session.js";

const A = "https://api.standardnotes.com", B = "https://sn.example.test";
const session = (serverUrl: string, email = "a@b.co", token = "t"): StoredSession => ({
  serverUrl, email, sessionPayload: { access_token: token, refresh_token: token }, masterKeyHex: "00".repeat(32),
  keyParams: { version: "004" }, savedAt: "",
});
const SERVICE = "mcp-standardnotes";

describe("session storage", () => {
  beforeEach(() => { store.clear(); vi.unstubAllEnvs(); });

  it("keeps the same email on two servers apart, for load, resolve and logout", async () => {
    await saveSession(session(A, "a@b.co", "on-A"));
    await saveSession(session(B, "a@b.co", "on-B"));
    expect((await loadSession(A, "a@b.co"))?.sessionPayload.access_token).toBe("on-A");
    expect((await loadSession(B, "a@b.co"))?.sessionPayload.access_token).toBe("on-B");
    expect(await resolveEmail(A)).toBe("a@b.co");
    expect(await deleteSession(B, "a@b.co")).toBe(true);
    expect(await loadSession(B, "a@b.co")).toBeNull();
    expect((await loadSession(A, "a@b.co"))?.sessionPayload.access_token).toBe("on-A");
  });

  it("reads an email-only entry from before, only for its own server, and moves it on the next save", async () => {
    store.set(key(SERVICE, "a@b.co"), JSON.stringify(session(A, "a@b.co", "legacy")));
    expect((await loadSession(A, "a@b.co"))?.sessionPayload.access_token).toBe("legacy");
    expect(await loadSession(B, "a@b.co")).toBeNull();
    expect(await resolveEmail(A)).toBe("a@b.co");
    await expect(resolveEmail(B)).rejects.toThrow(/Log in/);
    await saveSession(session(A, "a@b.co", "rotated"));
    expect(store.has(key(SERVICE, "a@b.co"))).toBe(false);
    expect((await loadSession(A, "a@b.co"))?.sessionPayload.access_token).toBe("rotated");
    // Saving for another server leaves a legacy entry for the first server alone.
    store.set(key(SERVICE, "c@d.co"), JSON.stringify(session(A, "c@d.co", "legacy")));
    await saveSession(session(B, "c@d.co"));
    expect(store.has(key(SERVICE, "c@d.co"))).toBe(true);
    expect(await deleteSession(B, "c@d.co")).toBe(true);
    expect(store.has(key(SERVICE, "c@d.co"))).toBe(true);
    expect(await deleteSession(A, "c@d.co")).toBe(true);
    expect(store.has(key(SERVICE, "c@d.co"))).toBe(false);
  });

  it("does not return an entry whose contents name another account or server", async () => {
    store.set(key(SERVICE, `a@b.co (${A})`), JSON.stringify(session(B, "a@b.co")));
    expect(await loadSession(A, "a@b.co")).toBeNull();
    store.set(key(SERVICE, `a@b.co (${A})`), JSON.stringify(session(A, "x@y.co")));
    expect(await loadSession(A, "a@b.co")).toBeNull();
  });

  it("returns null when missing, throws on corrupt payload, rejects an empty email", async () => {
    expect(await loadSession(A, "missing@x.co")).toBeNull();
    store.set(key(SERVICE, `corrupt@x.co (${A})`), "{not json");
    await expect(loadSession(A, "corrupt@x.co")).rejects.toThrow(/corrupt/);
    await expect(loadSession(A, "")).rejects.toThrow(/email/);
    expect(await deleteSession(A, "missing@x.co")).toBe(false);
  });

  it("asks for SN_EMAIL when one server has several accounts", async () => {
    await saveSession(session(A, "a@b.co"));
    await saveSession(session(A, "c@d.co"));
    await expect(resolveEmail(A)).rejects.toThrow(/SN_EMAIL/);
    vi.stubEnv("SN_EMAIL", "c@d.co");
    expect(await resolveEmail(A)).toBe("c@d.co");
  });
});
