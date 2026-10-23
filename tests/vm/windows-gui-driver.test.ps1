# Pure ownership/parser regressions; no real processes, windows, clipboard or credentials.
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$source=Join-Path $PSScriptRoot 'windows-gui-driver.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
function Assert([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message} }
Assert ($errors.Count -eq 0) 'Driver must parse'
$native=$ast.Find({param($a) $a -is [Management.Automation.Language.StringConstantExpressionAst] -and $a.Value.Contains('public static class SnWindowsGui')},$true)
Add-Type -TypeDefinition $native.Value
$window=$ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Window'},$true)
Set-Item function:Window $window.Body.GetScriptBlock()
$env:SN_GUI_PATH='C:\owned\standardnotes-connection.exe'
$expected='00000000-0000-0000-0000-000000000001'
$stale='00000000-0000-0000-0000-000000000002'
$env:SN_GUI_TEST_OPERATION_ID=$expected
$Mode='close'
$script:metadata=@{}
function Candidate([int]$Number,[int]$Parent,[string]$Operation) {
  $script:metadata[$Number]=[pscustomobject]@{ParentProcessId=$Parent;CommandLine=('"'+$env:SN_GUI_PATH+'" --approve '+$Operation)}
  $p=[pscustomobject]@{Id=$Number;Handle=[IntPtr]1;HasExited=$false;MainWindowHandle=[IntPtr]1;MainWindowTitle='Standard Notes Agent Connection';MainModule=[pscustomobject]@{FileName=$env:SN_GUI_PATH}}
  $p | Add-Member ScriptMethod Refresh {}
  return $p
}
function Get-Process {
  param([int]$Id,[string]$Name)
  if($PSBoundParameters.ContainsKey('Id')){return @($script:candidates|Where-Object {$_.Id -eq $Id})}
  return $script:candidates
}
function Get-CimInstance {
  param([string]$ClassName,[string]$Filter)
  return $script:metadata[[int](($Filter -split '=')[1])]
}
function Reset {
  $script:gui=$null
  $script:parent=[pscustomobject]@{Id=500;HasExited=$false}
  $env:SN_GUI_TEST_PID=''
}
Reset
$script:candidates=@(Candidate 101 500 $stale)
Assert ($null -eq (Window)) 'Same executable/title/server but stale operation must not be selected'
Reset
$script:candidates=@(Candidate 102 501 $expected)
Assert ($null -eq (Window)) 'Matching operation under a different server must not be selected'
Reset
$script:candidates=@((Candidate 101 500 $stale),(Candidate 102 501 $expected),(Candidate 103 500 $expected))
Assert ((Window).Id -eq 103) 'Only exact operation and observed server ancestry may select a GUI'
Reset
$script:parent=$null; $env:SN_GUI_TEST_PID='104'
$script:candidates=@((Candidate 103 500 $expected),(Candidate 104 501 $expected))
Assert ((Window).Id -eq 104) 'An explicit owned PID must not fall back to another window'
Reset
$script:candidates=@((Candidate 105 500 $expected),(Candidate 106 500 $expected))
$failed=$false
try { $null=Window } catch { $failed=$true }
Assert $failed 'Ambiguous operation ownership must fail closed'
$words=$ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Words'},$true)
$saves=@($words.FindAll({param($a) $a -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $a.Member.Value -eq 'Save'},$true))
Assert ($saves.Count -eq 1 -and $saves[0].Arguments[0].Extent.Text -eq '$memory') 'Captured pixels must only be encoded to a memory stream'
Write-Output 'PASS: five GUI ownership regressions and in-memory-only framebuffer encoding'
