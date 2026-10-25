import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("reads DATA_DIR from a dotfiles machine file as data only", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "sn-config-"));
    try {
      await mkdir(path.join(home, "code/dotfiles/machines"), { recursive: true });
      const file = path.join(home, "code/dotfiles/machines/test-host.env");
      vi.stubEnv("SN_STATE_DIR", "");
      vi.stubEnv("DATA_DIR", "");
      vi.spyOn(os, "homedir").mockReturnValue(home);
      vi.spyOn(os, "hostname").mockReturnValue("test-host");
      await writeFile(file, "# comment\nDATA_DIR=\"/data/drive\"\nOTHER=1\n");
      expect(await configureStateDirectory()).toBe(path.join("/data/drive", "standardnotes-mcp"));
      vi.stubEnv("SN_STATE_DIR", "");
      await writeFile(file, "DATA_DIR=$(echo /tmp)\n");
      await expect(configureStateDirectory()).rejects.toThrow(/absolute/);
    } finally {
      vi.restoreAllMocks();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a relative explicit path", async () => {
    vi.stubEnv("SN_STATE_DIR", "relative/dir");
    await expect(configureStateDirectory()).rejects.toThrow(/absolute/);
  });
});
