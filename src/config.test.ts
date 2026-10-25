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
      // Common shell forms resolve to the same directory the old sourcing launcher used; the last assignment wins.
      for (const body of ["export DATA_DIR=/data/drive\n", "DATA_DIR=/data/drive  # storage\n", "DATA_DIR='/data/drive'\n",
        "DATA_DIR=/old\nexport DATA_DIR=\"/data/drive\" # moved\n"]) {
        vi.stubEnv("SN_STATE_DIR", "");
        await writeFile(file, body);
        expect(await configureStateDirectory(), body).toBe(path.join("/data/drive", "standardnotes-mcp"));
      }
      // Anything needing a shell is refused, never run and never replaced by another directory.
      for (const body of ["DATA_DIR=$(echo /tmp)\n", "DATA_DIR=$HOME/data\n", 'DATA_DIR="/a/$USER"\n', "DATA_DIR=/a b\n"]) {
        vi.stubEnv("SN_STATE_DIR", "");
        await writeFile(file, body);
        await expect(configureStateDirectory(), body).rejects.toThrow(/without a shell/);
      }
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
