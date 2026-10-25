import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

// The launcher is a Bash script; Windows uses `node dist/index.js` directly.
describe.skipIf(process.platform === "win32")("bin/standardnotes-mcp", () => {
  it("finds its checkout when called through a chain of absolute and relative symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sn-launcher-"));
    dirs.push(dir);
    const root = join(dir, "checkout");
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "dist", "index.js"), "");
    const launcher = join(root, "bin", "standardnotes-mcp");
    await copyFile(new URL("../../bin/standardnotes-mcp", import.meta.url), launcher);
    await chmod(launcher, 0o755);
    await mkdir(join(dir, "local", "bin"), { recursive: true });
    await symlink(launcher, join(dir, "local", "bin", "standardnotes-mcp"));
    await symlink(join("local", "bin", "standardnotes-mcp"), join(dir, "relative-link"));
    for (const entry of [launcher, join(dir, "local", "bin", "standardnotes-mcp"), join(dir, "relative-link")]) {
      // An unknown command gets past the "not built" check only if ROOT is the checkout.
      let stderr = "";
      try {
        execFileSync(entry, ["no-such-command"], { env: { PATH: process.env.PATH, HOME: dir, SN_STATE_DIR: dir }, stdio: "pipe" });
      } catch (error) {
        stderr = String((error as { stderr: Buffer }).stderr);
      }
      expect(stderr).toContain("Unknown command");
    }
  });

  it("never runs a machine settings file as shell code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sn-launcher-"));
    dirs.push(dir);
    const root = join(dir, "checkout");
    await mkdir(join(root, "bin"), { recursive: true });
    const launcher = join(root, "bin", "standardnotes-mcp");
    await copyFile(new URL("../../bin/standardnotes-mcp", import.meta.url), launcher);
    await chmod(launcher, 0o755);
    const machines = join(dir, "code", "dotfiles", "machines");
    await mkdir(machines, { recursive: true });
    const marker = join(dir, "executed");
    await writeFile(join(machines, `${hostname()}.env`), `touch '${marker}'\nDATA_DIR=$(touch '${marker}')\n`);
    try {
      execFileSync(launcher, ["no-such-command"], { env: { PATH: process.env.PATH, HOME: dir }, stdio: "pipe" });
    } catch { /* not built: expected */ }
    expect(existsSync(marker)).toBe(false);
  });
});
