# Guest side of tests/vm/windows-run.sh: runs in a throwaway Windows VM only.
param([Parameter(Mandatory)][string]$Node)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Expand-Archive -Force "$HOME\node-$Node-win-x64.zip" "$HOME"
New-Item -ItemType Directory -Force "$HOME\sn" | Out-Null
tar -xf "$HOME\source.tar" -C "$HOME\sn"
$nodeDir = "$HOME\node-$Node-win-x64"
$env:Path = "$nodeDir;" + $env:Path
$env:SN_VM_TEST = "1"
# npm.cmd, not npm.ps1: the guest keeps its default script execution policy.
"Windows " + [Environment]::OSVersion.Version + ", " + $env:PROCESSOR_ARCHITECTURE + ", node " + (node --version) + ", npm " + (npm.cmd --version)
Set-Location "$HOME\sn"
function Step($name, [scriptblock]$run) { & $run; if ($LASTEXITCODE -ne 0) { "FAIL: $name ($LASTEXITCODE)"; exit 1 } }
Step "npm ci" { npm.cmd ci --no-audit --no-fund }
Step "typecheck" { npm.cmd run typecheck }
Step "build" { npm.cmd run build }
Step "unit tests" { npm.cmd test }
Step "private-fs timing" { node tests/private-fs-bench.mjs }

# Credential Manager refuses key-authenticated SSH logons ("A specified logon session does not exist"),
# so the e2e runs as a task in the tester's interactive desktop session.
$log = "$HOME\e2e.log"; $exit = "$HOME\e2e.exit"; $task = "$HOME\e2e-task.ps1"
Remove-Item -Force -ErrorAction SilentlyContinue $log, $exit
Set-Content $task @(
  "Set-Location '$HOME\sn'",
  "`$env:SN_VM_TEST = '1'",
  "`$env:Path = '$nodeDir;' + `$env:Path",
  "node tests/mcp-e2e.mjs *> '$log'",
  "Set-Content '$exit' `$LASTEXITCODE"
)
$action = New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$task`""
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName sn-e2e -Action $action -Principal $principal -Force | Out-Null
try {
  Start-ScheduledTask -TaskName sn-e2e
  $deadline = (Get-Date).AddMinutes(20)
  while (-not (Test-Path $exit) -and (Get-Date) -lt $deadline) { Start-Sleep 5 }
} finally { Unregister-ScheduledTask -TaskName sn-e2e -Confirm:$false }
if (Test-Path $log) { Get-Content $log }
if (-not (Test-Path $exit)) { "FAIL: e2e (timed out in the desktop session)"; exit 1 }
if ((Get-Content $exit).Trim() -ne "0") { "FAIL: e2e"; exit 1 }
"PASS: Windows x64 TypeScript checks, NTFS ACL tests, Credential Manager and MCP acceptance"
