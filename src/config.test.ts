import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureStateDirectory } from "./config.js";

describe("state directory", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("treats empty variables as unset and falls back to DATA_DIR, then the OS default", async () => {
    vi.stubEnv("SN_STATE_DIR", "");
    vi.stubEnv("DATA_DIR", "/data");
    expect(await configureStateDirectory()).toBe(path.join("/data", "standardnotes-mcp"));
    vi.stubEnv("SN_STATE_DIR", "");
    vi.stubEnv("DATA_DIR", "");
    vi.spyOn(os, "hostname").mockReturnValue("no-such-machine-file");
    expect(path.isAbsolute(await configureStateDirectory())).toBe(true);
  });

  it("rejects a relative explicit path", async () => {
    vi.stubEnv("SN_STATE_DIR", "relative/dir");
    await expect(configureStateDirectory()).rejects.toThrow(/absolute/);
  });
});
