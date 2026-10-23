import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({ access: vi.fn(), spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));
vi.mock("../security/account-context.js", () => ({ withAccount: vi.fn() }));
import { guiExecutable } from "./launcher.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const name = `standardnotes-connection${process.platform === "win32" ? ".exe" : ""}`;
describe("installed approval GUI lookup", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("SN_GUI_PATH", undefined); });
  afterEach(() => { expect(mocks.spawn).not.toHaveBeenCalled(); vi.unstubAllEnvs(); });
  it("never discovers a debug-only checkout implicitly", async () => {
    mocks.access.mockImplementation(async (file: string) => {
      if (file === path.join(root, "gui/target/debug", name)) return;
      throw new Error("missing");
    });
    await expect(guiExecutable()).rejects.toThrow("no approval was granted");
    expect(mocks.access.mock.calls.map(([file]) => file)).toEqual([path.join(root, "bin", name), path.join(root, name)]);
  });
  it("allows an explicit absolute development override without fallback", async () => {
    const file = path.join(root, "gui/target/debug", name);
    vi.stubEnv("SN_GUI_PATH", file); mocks.access.mockResolvedValue(undefined);
    expect(await guiExecutable()).toBe(file); expect(mocks.access).toHaveBeenCalledTimes(1);
  });
  it("fails closed for a missing explicit override or relative path", async () => {
    vi.stubEnv("SN_GUI_PATH", path.join(root, "missing")); mocks.access.mockRejectedValue(new Error("missing"));
    await expect(guiExecutable()).rejects.toThrow("no approval was granted");
    expect(mocks.access).toHaveBeenCalledTimes(1);
    vi.stubEnv("SN_GUI_PATH", "relative-gui"); mocks.access.mockClear();
    await expect(guiExecutable()).rejects.toThrow("must be absolute"); expect(mocks.access).not.toHaveBeenCalled();
  });
  it("finds the portable bundle executable", async () => {
    mocks.access.mockRejectedValueOnce(new Error("missing")).mockResolvedValue(undefined);
    expect(await guiExecutable()).toBe(path.join(root, name));
  });
});
