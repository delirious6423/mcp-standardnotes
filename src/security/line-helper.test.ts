import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { asciiJson, createLineHelper, type LineHelper } from "./line-helper.js";

// A stand-in for the PowerShell helper: echoes the decoded path, hangs or exits on request.
const fake = String.raw`
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!/^[\x00-\x7e]*$/.test(line)) { process.stdout.write("non-ascii request\n"); return; }
  const r = JSON.parse(line);
  if (r.action === "hang") return;
  if (r.action === "exit") process.exit(3);
  // Survives the timeout kill (SIGTERM) and answers too late, then leaves.
  if (r.action === "late") { process.on("SIGTERM", () => undefined); setTimeout(() => { process.stdout.write("late\n"); process.exit(0); }, 1200); return; }
  if (r.action === "slow") { setTimeout(() => process.stdout.write("ok " + process.pid + " " + r.path + "\n"), 500); return; }
  process.stdout.write("ok " + process.pid + " " + r.path + "\n");
});`;

let helper: LineHelper | undefined;
afterEach(() => helper?.close());

describe("line helper", () => {
  it("reuses one child, serializes requests and keeps non-ASCII paths intact", async () => {
    helper = createLineHelper(process.execPath, ["-e", fake], 5000);
    const replies = await Promise.all(["a", "b", "注音 ⟦x⟧"].map((path) => helper!.request({ action: "x", path })));
    expect(replies.map((r) => r.split(" ").slice(2).join(" "))).toEqual(["a", "b", "注音 ⟦x⟧"]);
    expect(new Set(replies.map((r) => r.split(" ")[1])).size).toBe(1);
    expect(asciiJson({ p: "é" })).toBe('{"p":"\\u00e9"}');
  });

  it("kills a hung or crashed child, fails that request only, and starts a new one", async () => {
    helper = createLineHelper(process.execPath, ["-e", fake], 300);
    const first = await helper.request({ action: "x", path: "a" });
    await expect(helper.request({ action: "hang", path: "" })).rejects.toThrow("Helper stopped");
    const second = await helper.request({ action: "x", path: "b" });
    expect(second.split(" ")[1]).not.toBe(first.split(" ")[1]);
    await expect(helper.request({ action: "exit", path: "" })).rejects.toThrow("Helper stopped");
    expect(await helper.request({ action: "x", path: "c" })).toMatch(/ c$/);
  });

  it.skipIf(process.platform === "win32")("never lets a killed child's late reply answer the next request", async () => {
    // Timeline: kill at 800 ms, stale "late" line at 1200 ms, real reply about 1300 ms (+ start-up).
    helper = createLineHelper(process.execPath, ["-e", fake], 800);
    await helper.request({ action: "x", path: "warm" });
    await expect(helper.request({ action: "late", path: "" })).rejects.toThrow("Helper stopped");
    expect(await helper.request({ action: "slow", path: "fresh" })).toMatch(/ fresh$/);
  });

  it("does not keep the parent process alive while idle", () => {
    const script = `
      const { createLineHelper } = await import(${JSON.stringify(new URL("./line-helper.ts", import.meta.url).href)});
      const h = createLineHelper(process.execPath, ["-e", ${JSON.stringify(fake)}], 5000);
      console.log(await h.request({ action: "x", path: "done" }));`;
    const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
    expect(out).toMatch(/ done\n$/);
  });
});
