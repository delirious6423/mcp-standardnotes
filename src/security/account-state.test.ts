import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { atomicPrivateWrite, privateDirectory, unlockAbandonedAccount, withAccountLock } from "./account-state.js";
import { durablePrivateRename, openPrivateFile } from "./private-fs.js";
import { WriteJournal } from "./write-journal.js";
import type { PreparedChange, SnClient } from "../sn/client.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const helperMock = vi.hoisted(() => ({ created: [] as Array<{ command: string; args: string[]; timeoutMs: number }>, reply: vi.fn() }));
vi.mock("./line-helper.js", async (original) => {
  const actual = await original<typeof import("./line-helper.js")>();
  // Native Windows runs use the real helper; elsewhere the contract tests see a recording double.
  if (process.platform === "win32") return actual;
  return { ...actual, createLineHelper: (command: string, args: string[], timeoutMs: number) => {
    helperMock.created.push({ command, args, timeoutMs });
    return { request: helperMock.reply, close: () => undefined };
  } };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const actualChild = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const windows = process.platform === "win32";
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); });

async function fixture(action: (dir: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sn-private-test-"));
  try {
    const dir = path.join(root, "private");
    await privateDirectory(dir);
    await action(dir);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// Native Windows tests launch PowerShell: run only in a disposable Windows VM.
describe.runIf(!windows || process.env.SN_VM_TEST === "1")("private recovery filesystem", { timeout: 120_000 }, () => {
  it("atomically replaces a record, leaves no temp files, and reopens privately", async () => fixture(async (dir) => {
    const file = path.join(dir, "record.enc");
    await atomicPrivateWrite(file, "synthetic-first");
    await atomicPrivateWrite(file, "synthetic-second");
    const fh = await openPrivateFile(file);
    try { expect(await fh.readFile("utf8")).toBe("synthetic-second"); }
    finally { await fh.close(); }
    expect(await fs.readdir(dir)).toEqual(["record.enc"]);
    if (!windows) expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  }));

  it.each(["writeFile", "sync", "close"] as const)("cleans up temp files after %s fails without replacing the previous record", async (method) => fixture(async (dir) => {
    const file = path.join(dir, "record.enc");
    await atomicPrivateWrite(file, "synthetic-original");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const fh = await actualFs.open(...args);
      if (method === "close") {
        const close = fh.close.bind(fh);
        vi.spyOn(fh, "close").mockImplementationOnce(async () => { await close(); throw new Error("injected close failure"); });
      } else {
        vi.spyOn(fh, method).mockRejectedValueOnce(new Error(`injected ${method} failure`));
      }
      return fh;
    });
    await expect(atomicPrivateWrite(file, "synthetic-replacement")).rejects.toThrow(`injected ${method} failure`);
    expect(await fs.readdir(dir)).toEqual(["record.enc"]);
    expect(await fs.readFile(file, "utf8")).toBe("synthetic-original");
  }));

  it("keeps account exclusion, refuses live-owner recovery and releases after errors", async () => fixture(async (dir) => {
    await withAccountLock(dir, async () => {
      await expect(withAccountLock(dir, async () => undefined)).rejects.toThrow(/busy/);
      // This test double checks the live-owner path without sending a real process signal.
      vi.spyOn(process, "kill").mockReturnValue(true);
      await expect(unlockAbandonedAccount(dir)).rejects.toThrow(/alive/);
    });
    await expect(withAccountLock(dir, async () => { throw new Error("synthetic failure"); })).rejects.toThrow("synthetic failure");
    expect(await fs.readdir(dir)).toEqual([]);
  }));

  it.each(["inode", "contents"])("refuses crash recovery if lock %s changed even with the same token", async (changed) => fixture(async (dir) => {
    const lock = path.join(dir, "account.lock");
    const contents = JSON.stringify({ pid: 2147483647, token: "synthetic-token" });
    await atomicPrivateWrite(lock, contents);
    const replacement = path.join(dir, "replacement");
    if (changed === "inode") await atomicPrivateWrite(replacement, contents);
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (changed === "inode") renameSync(replacement, lock);
      else writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: "synthetic-token", changed: true }));
      throw Object.assign(new Error("synthetic dead owner"), { code: "ESRCH" });
    });
    await expect(unlockAbandonedAccount(dir)).rejects.toThrow(/changed/);
    expect(await fs.readdir(dir)).toContain("account.lock");
  }));

  it("rejects distinct 64-bit file identities that alias when converted to Number", async () => fixture(async (dir) => {
    const file = path.join(dir, "record.enc"), base = 2n ** 53n;
    await atomicPrivateWrite(file, "synthetic");
    vi.spyOn(fs, "lstat").mockImplementation(async (name, options: any) => {
      const st = await actualFs.lstat(name, options) as any;
      if (String(name) === file) st.ino = typeof st.ino === "bigint" ? base + 1n : Number(base + 1n);
      return st;
    });
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const fh = await actualFs.open(...args), stat = fh.stat.bind(fh);
      vi.spyOn(fh, "stat").mockImplementation(async (options: any) => {
        const st = await stat(options) as any;
        st.ino = typeof st.ino === "bigint" ? base : Number(base);
        return st;
      });
      return fh;
    });
    let opened: Awaited<ReturnType<typeof openPrivateFile>> | undefined;
    try {
      await expect(openPrivateFile(file).then((fh) => { opened = fh; return fh; })).rejects.toThrow(/regular file|changed/);
    } finally { await opened?.close(); }
  }));

  it("requires explicit incomplete-lock recovery and rechecks the file", async () => fixture(async (dir) => {
    await atomicPrivateWrite(path.join(dir, "account.lock"), "");
    await expect(unlockAbandonedAccount(dir)).rejects.toThrow(/Incomplete/);
    await unlockAbandonedAccount(dir, true);
    expect(await fs.readdir(dir)).toEqual([]);
  }));
});

describe.skipIf(windows)("POSIX protection regressions", () => {
  it("rejects broad directory/file permissions and symlink files/directories", async () => fixture(async (dir) => {
    const file = path.join(dir, "record.enc");
    await atomicPrivateWrite(file, "synthetic");
    await expect(openPrivateFile(dir)).rejects.toThrow(/regular file/);
    await fs.chmod(file, 0o644);
    await expect(openPrivateFile(file)).rejects.toThrow(/private/);
    await fs.chmod(file, 0o600);
    const link = path.join(dir, "link");
    await fs.symlink(file, link);
    await expect(openPrivateFile(link)).rejects.toThrow();
    const directoryLink = path.join(dir, "directory-link");
    await fs.symlink(dir, directoryLink);
    await expect(privateDirectory(directoryLink)).rejects.toThrow(/real directory/);
    await fs.chmod(dir, 0o755);
    await expect(privateDirectory(dir)).rejects.toThrow(/0700/);
    await fs.chmod(dir, 0o700);
  }));

  it("rejects files and directories owned by another UID", async () => fixture(async (dir) => {
    const file = path.join(dir, "record.enc");
    await atomicPrivateWrite(file, "synthetic");
    vi.spyOn(process, "getuid").mockReturnValue((await fs.stat(file)).uid + 1);
    await expect(openPrivateFile(file)).rejects.toThrow(/user-owned/);
    await expect(privateDirectory(dir)).rejects.toThrow(/owned by this user/);
  }));

  it("propagates directory fsync failures, rather than pretending the rename is durable", async () => fixture(async (dir) => {
    const source = path.join(dir, "temp");
    const destination = path.join(dir, "record.enc");
    await fs.writeFile(source, "synthetic", { mode: 0o600 });
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const fh = await actualFs.open(...args);
      vi.spyOn(fh, "sync").mockRejectedValueOnce(Object.assign(new Error("injected directory sync I/O failure"), { code: "EIO" }));
      return fh;
    });
    await expect(durablePrivateRename(source, destination)).rejects.toThrow(/directory sync I\/O/);
  }));
});

// Native Windows exercises the real helper in the acceptance suite below instead.
describe.skipIf(windows)("Windows native tool-call contract (test doubles only)", () => {
  const windowsFake = () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", path.resolve("synthetic-windows"));
  };
  const script = () => Buffer.from(helperMock.created[0]!.args.at(-1)!, "base64").toString("utf16le");

  it("starts one PowerShell helper from a fixed encoded script and sends paths only as request data", async () => {
    windowsFake();
    helperMock.reply.mockResolvedValue("ok");
    const file = path.resolve("synthetic ' $() & path");
    await privateDirectory(file);
    await privateDirectory(`${file}-other`);
    expect(helperMock.created).toHaveLength(1);
    const [{ command, args, timeoutMs }] = helperMock.created as [typeof helperMock.created[0]];
    expect(path.isAbsolute(command)).toBe(true);
    expect(command).toMatch(/WindowsPowerShell/);
    expect(args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(timeoutMs).toBe(30_000);
    expect(script()).not.toContain(file);
    for (const piece of ["GetCurrent().User", "SetAccessRuleProtection($true, $false)", "ReparsePoint", "DriveFormat -ne 'NTFS'",
      "$rules.Count -ne 1", "GetOwner", "[Console]::In.ReadLine()", "$null = Invoke-Private"]) expect(script()).toContain(piece);
    expect(helperMock.reply.mock.calls).toEqual([[{ action: "directory", path: file, destination: "" }],
      [{ action: "directory", path: `${file}-other`, destination: "" }]]);
  });

  it("uses write-through native replacement instead of attempting directory fsync on Windows", async () => {
    windowsFake();
    helperMock.reply.mockResolvedValue("ok");
    const temp = path.resolve("synthetic-dir", "temp");
    const file = path.resolve("synthetic-dir", "record.enc");
    await durablePrivateRename(temp, file);
    expect(script()).toContain("MoveFileEx($p, $destination, 9)");
    expect(helperMock.reply).toHaveBeenLastCalledWith({ action: "replace", path: temp, destination: file });
    expect(fs.open).not.toHaveBeenCalled();
    await expect(durablePrivateRename(temp, path.resolve("another-dir", "record.enc"))).rejects.toThrow(/one directory/);
  });

  it("fails closed and does not forward native errors that may contain filesystem paths", async () => {
    windowsFake();
    for (const outcome of [() => helperMock.reply.mockResolvedValueOnce("fail"), () => helperMock.reply.mockResolvedValueOnce("SYNTHETIC_PATH_MUST_NOT_LEAK"),
      () => helperMock.reply.mockRejectedValueOnce(new Error("SYNTHETIC_PATH_MUST_NOT_LEAK"))]) {
      outcome();
      const error = await privateDirectory(path.resolve("synthetic")).catch((e: Error) => e);
      expect(String(error)).toMatch(/Private NTFS operation failed:/);
      expect(String(error)).not.toContain("SYNTHETIC_PATH_MUST_NOT_LEAK");
    }
  });
});

async function windowsTestScript(script: string, file: string): Promise<void> {
  const root = process.env.SystemRoot!;
  await promisify(actualChild.execFile)(path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, "utf16le").toString("base64")],
    { timeout: 15000, windowsHide: true, env: { ...process.env, SN_TEST_PATH: file } });
}

describe.runIf(windows && process.env.SN_VM_TEST === "1")("native Windows NTFS acceptance (VM only)", { timeout: 120_000 }, () => {
  it("round-trips encrypted journal preparation, approval and durable commit", async () => fixture(async (dir) => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const started = Date.now(), command = [...args[1]];
      const script = Buffer.from(command.at(-1), "base64").toString("utf16le");
      const diagnostic = `try {\n${script}\n} catch {\n$e = $_.Exception.GetBaseException()\n$code = if ($e -is [ComponentModel.Win32Exception]) { $e.NativeErrorCode } else { $e.HResult }\n[Console]::Error.WriteLine('NATIVE_ERROR_ENUM=' + $e.GetType().FullName + ':' + $code)\nexit 1\n}`;
      command[command.length - 1] = Buffer.from(diagnostic, "utf16le").toString("base64");
      return actualChild.execFile(args[0], command, args[2], (error, stdout, stderr) => {
        if (error) console.warn(JSON.stringify({ nativeAction: args[2].env.SN_PRIVATE_ACTION, code: error.code, signal: error.signal,
          killed: error.killed, elapsedMs: Date.now() - started, nativeEnum: String(stderr).match(/NATIVE_ERROR_ENUM=([A-Za-z0-9_.]+:-?\d+)/)?.[1] ?? "unavailable" }));
        args[args.length - 1](error, stdout, stderr);
      });
    });
    const plan = { before: null, after: { uuid: "11111111-1111-4111-8111-111111111111", content: "synthetic ciphertext" }, preview: { title: "synthetic title" } } as unknown as PreparedChange;
    const client = { prepareChange: vi.fn(async () => plan), commitChange: vi.fn(async () => undefined) } as unknown as SnClient;
    const key = new Uint8Array(32).fill(17);
    const journal = new WriteJournal(dir, key);
    const { operationId } = await journal.prepare(client, { kind: "note_create", title: "synthetic title", text: "synthetic text" }) as { operationId: string };
    const sealed = await fs.readFile(path.join(dir, `${operationId}.enc`), "utf8");
    expect(sealed).not.toContain("synthetic");
    await new WriteJournal(dir, key).approve(operationId);
    await journal.commit(client, operationId);
    expect(await new WriteJournal(dir, key).status(operationId)).toMatchObject({ status: "committed" });
    expect(client.commitChange).toHaveBeenCalledTimes(1);
  }));

  it("recovers a crash immediately after lock creation, before its inherited user-only ACL is protected", async () => fixture(async (dir) => {
    const lock = path.join(dir, "account.lock");
    await fs.writeFile(lock, "", { flag: "wx" });
    await windowsTestScript(String.raw`
$acl = [IO.File]::GetAccessControl($env:SN_TEST_PATH)
if ($acl.AreAccessRulesProtected) { throw 'Expected freshly inherited lock ACL' }`, lock);
    await expect(unlockAbandonedAccount(dir)).rejects.toThrow(/Incomplete/);
    await unlockAbandonedAccount(dir, true);
    expect(await fs.readdir(dir)).toEqual([]);
  }));

  it("rejects a broad explicit file ACE rather than trusting chmod bits", async () => fixture(async (dir) => {
    const file = path.join(dir, "record.enc");
    await atomicPrivateWrite(file, "synthetic");
    await windowsTestScript(String.raw`
$p = $env:SN_TEST_PATH
$acl = [IO.File]::GetAccessControl($p)
if (-not $acl.AreAccessRulesProtected) { throw 'Journal write must disable file ACL inheritance before writing' }
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow'))
[IO.File]::SetAccessControl($p, $acl)`, file);
    await expect(openPrivateFile(file)).rejects.toThrow(/Private NTFS operation failed/);
  }));

  it("rejects inheritance-enabled directories", async () => fixture(async (dir) => {
    await windowsTestScript(String.raw`
$p = $env:SN_TEST_PATH
$acl = [IO.Directory]::GetAccessControl($p)
$acl.SetAccessRuleProtection($false, $true)
[IO.Directory]::SetAccessControl($p, $acl)`, dir);
    await expect(privateDirectory(dir)).rejects.toThrow(/Private NTFS operation failed/);
  }));

  it("rejects junctions in the path and hard-linked records", async () => fixture(async (dir) => {
    const file = path.join(dir, "record.enc");
    await atomicPrivateWrite(file, "synthetic");
    const junction = path.join(dir, "junction");
    await fs.symlink(dir, junction, "junction");
    await expect(privateDirectory(junction)).rejects.toThrow(/Private NTFS operation failed/);
    await expect(openPrivateFile(path.join(junction, "record.enc"))).rejects.toThrow(/Private NTFS operation failed/);
    await fs.rm(junction);
    await fs.link(file, path.join(dir, "hardlink.enc"));
    await expect(openPrivateFile(file)).rejects.toThrow(/Hard-linked/);
  }));
});
