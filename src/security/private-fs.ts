import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Paths are data in the child environment, never PowerShell source. No note data is sent.
const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$p = $env:SN_PRIVATE_PATH
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function CheckPath([string]$target) {
  if ($target.StartsWith('\\') -or -not [IO.Path]::IsPathRooted($target)) { throw 'Local absolute path required' }
  $root = [IO.Path]::GetPathRoot($target)
  if (([IO.DriveInfo]::new($root)).DriveFormat -ne 'NTFS') { throw 'NTFS required' }
  $cursor = $target
  while ($cursor) {
    try {
      $attrs = [IO.File]::GetAttributes($cursor)
      if (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point forbidden' }
    } catch {
      $cause = $_.Exception.GetBaseException()
      if ($cause -isnot [IO.FileNotFoundException] -and $cause -isnot [IO.DirectoryNotFoundException]) { throw }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
function NewSecurity([bool]$directory) {
  if ($directory) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
  } else {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  return $acl
}
function CheckAcl([string]$target, [bool]$directory, [bool]$protected) {
  CheckPath $target
  $attrs = [IO.File]::GetAttributes($target)
  if ((($attrs -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory) { throw 'Wrong file type' }
  $acl = if ($directory) { [IO.Directory]::GetAccessControl($target) } else { [IO.File]::GetAccessControl($target) }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Wrong owner' }
  if ($protected -and -not $acl.AreAccessRulesProtected) { throw 'Inherited ACL forbidden' }
  # Count raw ACEs too: GetAccessRules must not hide an unsupported/callback allow ACE.
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -ne 1 -or
      $raw.DiscretionaryAcl[0].AceType -ne [Security.AccessControl.AceType]::AccessAllowed) { throw 'Unexpected raw ACL entries' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1) { throw 'Unexpected ACL entries' }
  $rule = $rules[0]
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow' -or
      $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'Unexpected access rights' }
  $inherit = if ($directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  if ($rule.InheritanceFlags -ne $inherit) { throw 'Unexpected inheritance flags' }
}
CheckPath $p
switch ($env:SN_PRIVATE_ACTION) {
  'directory' {
    $missing = [Collections.Generic.Stack[string]]::new()
    $cursor = $p
    while (-not [IO.Directory]::Exists($cursor)) {
      $missing.Push($cursor)
      $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    while ($missing.Count -gt 0) {
      $next = $missing.Pop()
      [void][IO.Directory]::CreateDirectory($next, (NewSecurity $true))
      CheckAcl $next $true $true
    }
    CheckAcl $p $true $true
  }
  'file' {
    CheckAcl $p $false $false
    # Only inherited files depend on the private parent (e.g. an empty lock left by a crash).
    if (-not ([IO.File]::GetAccessControl($p)).AreAccessRulesProtected) {
      CheckAcl ([IO.Path]::GetDirectoryName($p)) $true $true
    }
  }
  'protect-file' {
    # Creation already inherited a user-only ACL from the verified private directory.
    CheckAcl $p $false $false
    [IO.File]::SetAccessControl($p, (NewSecurity $false))
    CheckAcl $p $false $true
  }
  'replace' {
    CheckAcl $p $false $true
    CheckPath $env:SN_PRIVATE_DESTINATION
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PrivateFileMove {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool MoveFileEx(string existing, string destination, uint flags);
}
'@
    # MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH; same-directory rename only.
    if (-not [PrivateFileMove]::MoveFileEx($p, $env:SN_PRIVATE_DESTINATION, 9)) {
      throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
  }
  default { throw 'Invalid action' }
}
`;

async function windowsPrivateFs(action: string, file: string, destination = ""): Promise<void> {
  if (!path.isAbsolute(file) || (destination && !path.isAbsolute(destination))) {
    throw new Error("Private NTFS operations require absolute paths");
  }
  const root = process.env.SystemRoot;
  if (!root || !path.isAbsolute(root)) throw new Error("Windows system directory is unavailable");
  try {
    await execFileAsync(path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsScript, "utf16le").toString("base64")],
      { env: { ...process.env, SN_PRIVATE_ACTION: action, SN_PRIVATE_PATH: file, SN_PRIVATE_DESTINATION: destination },
        timeout: 15_000, maxBuffer: 16_384, windowsHide: true });
  } catch {
    // Child errors may include filesystem paths; never forward native diagnostic output.
    throw new Error("Private NTFS operation failed: user ownership, restrictive ACLs and non-reparse paths are required");
  }
}

export async function privateDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return windowsPrivateFs("directory", dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) {
    throw new Error("State directory must be a real directory owned by this user");
  }
  if ((st.mode & 0o077) !== 0) throw new Error("State directory must have permissions 0700");
}

// NTFS identities can exceed 2^53; Number comparisons can accept a different file.
export function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function checkPrivateFile(file: string, fh: FileHandle): Promise<void> {
  const st = await fh.stat({ bigint: true });
  const named = await lstat(file, { bigint: true });
  if (!st.isFile() || !named.isFile() || named.isSymbolicLink() || !sameFile(st, named)) {
    throw new Error("File must be a private, user-owned regular file");
  }
  if (process.platform === "win32") {
    if (st.nlink !== 1n) throw new Error("Hard-linked private files are forbidden");
    await windowsPrivateFs("file", file);
    if (!sameFile(st, await lstat(file, { bigint: true }))) throw new Error("Private file changed during validation");
  } else if ((st.mode & 0o077n) !== 0n || (process.getuid && st.uid !== BigInt(process.getuid()))) {
    throw new Error("File must be a private, user-owned regular file");
  }
}

export async function openPrivateFile(file: string): Promise<FileHandle> {
  const named = await lstat(file);
  if (!named.isFile() || named.isSymbolicLink()) throw new Error("File must be a private, user-owned regular file");
  // O_NONBLOCK avoids hanging on a FIFO substituted between lstat and open.
  const fh = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try { await checkPrivateFile(file, fh); return fh; }
  catch (err) { await fh.close(); throw err; }
}

export async function protectNewPrivateFile(file: string, fh: FileHandle): Promise<void> {
  if (process.platform === "win32") {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || st.nlink !== 1n || !sameFile(st, await lstat(file, { bigint: true }))) {
      throw new Error("New private file was replaced or hard-linked");
    }
    await windowsPrivateFs("protect-file", file);
    if (!sameFile(st, await lstat(file, { bigint: true })) || (await fh.stat({ bigint: true })).nlink !== 1n) {
      throw new Error("New private file changed during ACL protection");
    }
    return;
  }
  await checkPrivateFile(file, fh);
}

export async function durablePrivateRename(temp: string, file: string): Promise<void> {
  if (process.platform === "win32") {
    if (path.dirname(temp) !== path.dirname(file)) throw new Error("Private rename must stay in one directory");
    await windowsPrivateFs("replace", temp, file);
    return;
  }
  await rename(temp, file);
  const parent = await open(path.dirname(file), constants.O_RDONLY);
  try { await parent.sync(); } finally { await parent.close(); }
}
