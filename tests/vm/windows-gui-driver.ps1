param([ValidateSet('auth','approve','reject','close')][string]$Mode)
# Synthetic native-VM input only. Never log credentials, clipboard contents or OCR text.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:failure = $null
$script:assertions = 0
function Fail([string]$Message) { $script:failure = $Message; throw [InvalidOperationException]::new($Message) }
function Assert([bool]$Condition,[string]$Message) { if (-not $Condition) { Fail $Message }; $script:assertions++ }
function Eventually([scriptblock]$Check,[string]$Message) {
  $end = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $end) { $value = & $Check; if ($value) { return $value }; Start-Sleep -Milliseconds 200 }
  Fail $Message
}
try {
  Assert ($env:SN_VM_TEST -eq '1') 'Windows GUI driver is VM-only'
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  Assert (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'Windows GUI driver requires a limited desktop token'
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SnWindowsGui {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBOARD { public ushort Vk,Scan; public uint Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSE { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Explicit,Size=32)] public struct UNION { [FieldOffset(0)] public KEYBOARD Key; [FieldOffset(0)] public MOUSE Mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint Type; public UNION Value; }
  [DllImport("shell32.dll",SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command,out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Arguments(string command) {
    int count; var pointer=CommandLineToArgvW(command,out count);
    if(pointer==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { var args=new string[count]; for(int i=0;i<count;i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*IntPtr.Size)); return args; }
    finally { LocalFree(pointer); }
  }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
  static void Send(INPUT[] inputs) { if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT)))!=inputs.Length) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Type(string text) {
    foreach(char c in text) {
      var down=new INPUT {Type=1}; down.Value.Key.Scan=c; down.Value.Key.Flags=4;
      var up=down; up.Value.Key.Flags=6; Send(new[]{down,up});
    }
  }
  public static void Click(bool right) {
    var down=new INPUT(); down.Value.Mouse.Flags=right?8u:2u;
    var up=down; up.Value.Mouse.Flags=right?16u:4u; Send(new[]{down,up});
  }
}
'@
  [SnWindowsGui]::SetProcessDPIAware() | Out-Null
  $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  $script:ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  Assert ($null -ne $script:ocr) 'Windows on-device OCR language is unavailable'
  $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  function Await($Operation,[Type]$ResultType) {
    $task = $script:asTask.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
    return $task.GetAwaiter().GetResult()
  }
  function ImageWords([IO.Stream]$Memory) {
    $stream = [IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($Memory)
    $bitmap = $null
    try {
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $result = Await ($script:ocr.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      foreach ($line in $result.Lines) { foreach ($word in $line.Words) {
        [pscustomobject]@{text=$word.Text;left=$word.BoundingRect.X;top=$word.BoundingRect.Y;width=$word.BoundingRect.Width;height=$word.BoundingRect.Height}
      } }
    } finally { if ($bitmap) { $bitmap.Dispose() }; $stream.Dispose() }
  }
  if ($env:SN_GUI_DRIVER_SELFTEST_IMAGE) {
    $image = [IO.File]::OpenRead($env:SN_GUI_DRIVER_SELFTEST_IMAGE)
    try { $text = (@(ImageWords $image) | ForEach-Object { $_.text }) -join ' ' } finally { $image.Dispose() }
    Assert ($text.Contains('Standard Notes Agent Connection')) 'Native OCR self-test did not read captured application heading'
    Assert (-not $text.Contains('Could not run the local backend') -and -not $text.Contains('Contacting the local backend')) 'Native portable backend did not finish successfully'
    Write-Output 'PASS: Windows on-device OCR reads native GUI framebuffer'
    exit 0
  }
  $script:gui = $null
  $script:parent = $null
  if ($Mode -ne 'auth') {
    Assert ($env:SN_GUI_TEST_OPERATION_ID -match '^[a-f0-9-]{36}$') 'Exact owned operation identifier is required'
  }
  if (-not $env:SN_GUI_TEST_PID) {
    Assert ($Mode -ne 'auth') 'Authentication requires an explicit owned GUI PID'
    $parentId=0
    Assert ([int]::TryParse($env:SN_GUI_TEST_PARENT_PID,[ref]$parentId) -and $parentId -gt 1) 'Observed MCP server PID is required'
    $script:parent=Get-Process -Id $parentId
    $null=$script:parent.Handle
  }
  function Window {
    if ($script:gui) { if ($script:gui.HasExited) { return $null }; $script:gui.Refresh(); return $script:gui }
    $candidates = if ($env:SN_GUI_TEST_PID) {
      $number = 0
      Assert ([int]::TryParse($env:SN_GUI_TEST_PID,[ref]$number) -and $number -gt 1) 'Invalid owned GUI process observation'
      @(Get-Process -Id $number -ErrorAction SilentlyContinue)
    } else {
      $name = [IO.Path]::GetFileNameWithoutExtension($env:SN_GUI_PATH)
      @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object {
        [string]::Equals($_.MainModule.FileName,$env:SN_GUI_PATH,[StringComparison]::OrdinalIgnoreCase)
      })
    }
    $eligible=@(foreach ($candidate in $candidates) {
      $null=$candidate.Handle
      if ($candidate.HasExited) { continue }
      Assert ([string]::Equals($candidate.MainModule.FileName,$env:SN_GUI_PATH,[StringComparison]::OrdinalIgnoreCase)) 'Owned GUI executable identity differs'
      $metadata=Get-CimInstance Win32_Process -Filter ('ProcessId='+$candidate.Id)
      if (-not $metadata) { continue }
      if ($script:parent) {
        Assert (-not $script:parent.HasExited) 'Owned MCP server exited before GUI selection'
        if ($metadata.ParentProcessId -ne $script:parent.Id) { continue }
      }
      if ($Mode -ne 'auth') {
        $arguments=[SnWindowsGui]::Arguments($metadata.CommandLine)
        if ($arguments.Count -ne 3 -or $arguments[1] -cne '--approve' -or $arguments[2] -cne $env:SN_GUI_TEST_OPERATION_ID) { continue }
      }
      if ($candidate.MainWindowHandle -ne [IntPtr]::Zero -and $candidate.MainWindowTitle -eq 'Standard Notes Agent Connection') { $candidate }
    })
    Assert ($eligible.Count -le 1) 'Ambiguous GUI ownership for this operation'
    if ($eligible.Count -eq 1) { $script:gui=$eligible[0]; return $script:gui }
    return $null
  }
  $script:formRow = $null; $script:buttonRow = $null
  # Keep the existing cross-platform fixture's diagnostic destination test-owned.
  New-Item -ItemType Directory -Path C:\tmp\sn-gui-test -Force | Out-Null
  function Words {
    $w = Window
    if (-not $w) { return @() }
    $rect = New-Object SnWindowsGui+RECT
    Assert ([SnWindowsGui]::GetWindowRect($w.MainWindowHandle,[ref]$rect)) 'Native window rectangle unavailable'
    $bitmap = [Drawing.Bitmap]::new(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $memory = [IO.MemoryStream]::new()
    try {
      $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size)
      $bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png)
      $memory.Position=0
      return @(ImageWords $memory)
    } finally { $graphics.Dispose(); $bitmap.Dispose(); $memory.Dispose() }
  }
  function Screen { return ((@(Words) | ForEach-Object { $_.text }) -join ' ') }
  function Has([string]$Text) { return (Screen).IndexOf($Text,[StringComparison]::OrdinalIgnoreCase) -ge 0 }
  function Focus {
    $w = Window
    Assert ($null -ne $w) 'Owned GUI window disappeared'
    $foreground = [uint32]0
    [SnWindowsGui]::GetWindowThreadProcessId([SnWindowsGui]::GetForegroundWindow(),[ref]$foreground) | Out-Null
    if ($foreground -ne $w.Id) {
      [SnWindowsGui]::SetForegroundWindow($w.MainWindowHandle) | Out-Null
      Start-Sleep -Milliseconds 100
      [SnWindowsGui]::GetWindowThreadProcessId([SnWindowsGui]::GetForegroundWindow(),[ref]$foreground) | Out-Null
    }
    Assert ($foreground -eq $w.Id) 'Input target is not the owned GUI process'
  }
  function Point([int]$X,[int]$Y,[bool]$Right=$false) {
    Focus
    [SnWindowsGui]::SetCursorPos($X,$Y) | Out-Null
    [SnWindowsGui]::Click($Right)
    Start-Sleep -Milliseconds 200
  }
  function Click([string]$Label,[bool]$Bottom=$false) {
    $target = Eventually {
      $items = @(Words)
      if ($null -eq $script:formRow) { $p = $items | Where-Object { $_.text -ceq 'Password' } | Select-Object -First 1; if ($p) { $script:formRow = $p.top+$p.height/2 } }
      if ($null -eq $script:buttonRow) { $p = $items | Where-Object { $_.text -ceq 'Sign' } | Select-Object -First 1; if ($p) { $script:buttonRow = $p.top+$p.height/2 } }
      $row = if ($Label -in @('Email','Password','MFA')) { $script:formRow } elseif ($Label -in @('Sign','Check','Enable','Disconnect')) { $script:buttonRow } else { $null }
      $matches = @($items | Where-Object { $_.text -ceq $Label -and ($null -eq $row -or [Math]::Abs($_.top+$_.height/2-$row) -le [Math]::Max(8,$_.height)) } | Sort-Object top,left)
      if ($matches.Count) { if ($Bottom) { $matches[-1] } else { $matches[0] } }
    } ('Native control not rendered: '+$Label)
    $w = Window; $rect = New-Object SnWindowsGui+RECT
    Assert ([SnWindowsGui]::GetWindowRect($w.MainWindowHandle,[ref]$rect)) 'Native control window rectangle unavailable'
    $script:lastX = [int]($rect.Left+$target.left+$target.width/2); $script:lastY = [int]($rect.Top+$target.top+$target.height/2)
    Point $script:lastX $script:lastY
  }
  function Keys([string]$Chord) { Focus; [Windows.Forms.SendKeys]::SendWait($Chord); Start-Sleep -Milliseconds 100 }
  function TypeText([string]$Text) { Focus; [SnWindowsGui]::Type($Text); Start-Sleep -Milliseconds 200 }
  function Clipboard { return [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText) }
  $script:sentinel = 'sn-gui-clipboard-sentinel'; $script:sequence = $null
  function ClipboardStable {
    Assert ((Clipboard) -ceq $script:sentinel) 'Masked field changed clipboard contents'
    Assert ([SnWindowsGui]::GetClipboardSequenceNumber() -eq $script:sequence) 'Masked field transiently changed clipboard ownership or contents'
  }
  function SettleClipboard {
    for ($i=0;$i -lt 10;$i++) { Start-Sleep -Milliseconds 100; ClipboardStable }
  }
  function CopyBlocked {
    $fieldX=$script:lastX; $fieldY=$script:lastY
    if ($null -eq $script:sequence) {
      [Windows.Forms.Clipboard]::SetText($script:sentinel,[Windows.Forms.TextDataFormat]::UnicodeText)
      Assert ((Clipboard) -ceq $script:sentinel) 'Clipboard sentinel was not initialized'
      $script:sequence = [SnWindowsGui]::GetClipboardSequenceNumber()
      Assert ($script:sequence -gt 0) 'Clipboard sequence unavailable'
    }
    foreach ($action in @('^c','^x')) { Keys '^a'; Keys $action; SettleClipboard }
    foreach ($action in @('Copy','Cut')) {
      Keys '^a'; Point $fieldX $fieldY $true
      Click $action
      SettleClipboard
      Keys '{ESC}'
    }
    Keys '{END}'
  }
  function CloseWindow {
    $w=Window
    Assert ($null -ne $w) 'Owned window missing before normal close'
    Assert ([SnWindowsGui]::PostMessage($w.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)) 'Normal window close failed'
  }
  function UncheckedApprove {
    Click 'Approve' $true
    for ($i=0;$i -lt 3;$i++) {
      Assert ($null -ne (Window)) 'Unchecked Approve closed the window'
      $text=Screen
      Assert ($text.IndexOf('Saved preview loaded',[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $text.IndexOf('Contacting the local backend',[StringComparison]::OrdinalIgnoreCase) -lt 0) 'Unchecked Approve changed the verified preview state'
      Start-Sleep -Milliseconds 200
    }
  }
  $null = Eventually { Window } 'Native GPUI window did not open'
  Assert ($script:gui.MainWindowTitle -eq 'Standard Notes Agent Connection') 'Native window title missing'
  $null = Eventually { Has 'Standard Notes Agent Connection' } 'Framebuffer does not show the application heading'
  if ($Mode -eq 'auth') {
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    $credentials = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $null = Eventually { (Has 'Enter saved account email') -and -not (Has 'Contacting the local backend') } 'Initial saved-session lookup did not finish'
    Click 'Email' $true; TypeText $credentials.email
    [Windows.Forms.Clipboard]::SetText('sn-email-keyboard-control',[Windows.Forms.TextDataFormat]::UnicodeText)
    $keyboardSequence=[SnWindowsGui]::GetClipboardSequenceNumber()
    Keys '^a'; Keys '^c'
    $null = Eventually { (Clipboard) -ceq $credentials.email } 'Positive control: ordinary email Copy failed'
    Assert ([SnWindowsGui]::GetClipboardSequenceNumber() -ne $keyboardSequence) 'Positive keyboard Copy did not change the clipboard'
    $emailX=$script:lastX; $emailY=$script:lastY
    [Windows.Forms.Clipboard]::SetText('sn-email-context-control',[Windows.Forms.TextDataFormat]::UnicodeText)
    $emailSequence=[SnWindowsGui]::GetClipboardSequenceNumber()
    Keys '^a'; Point $emailX $emailY $true; Click 'Copy'
    $null = Eventually { (Clipboard) -ceq $credentials.email } 'Positive control: context-menu email Copy failed'
    Assert ([SnWindowsGui]::GetClipboardSequenceNumber() -ne $emailSequence) 'Positive context-menu Copy did not change the clipboard'
    Keys '{ESC}'
    Click 'Password'; TypeText $credentials.password
    Assert (-not (Screen).Contains($credentials.password)) 'Password is visible in the framebuffer'
    CopyBlocked
    Write-Output 'PASS: password keyboard/context Copy and Cut preserve exact clipboard contents and sequence'
    Click 'Sign'
    $null = Eventually { Has 'Multi-factor' } 'Native sign-in did not show the MFA challenge'
    ClipboardStable
    Click 'MFA'; TypeText $credentials.mfa
    $text=Screen
    $compact=$text -replace '\s',''
    Assert (-not $compact.Contains(($credentials.password -replace '\s','')) -and -not $compact.Contains(($credentials.mfa -replace '\s',''))) 'Password or MFA is visible in the framebuffer'
    CopyBlocked
    Write-Output 'PASS: password and MFA are masked; MFA keyboard/context Copy and Cut preserve clipboard contents and sequence'
    Click 'Sign'
    $null = Eventually { Has '0 notes, 0 tags' } 'GUI login/MFA did not verify exact counts'
    ClipboardStable
    Click 'Check'; $null = Eventually { Has '0 notes, 0 tags' } 'GUI keychain reconnect failed'
    Click 'Enable'; $null = Eventually { Has 'Agent connection enabled' } 'GUI agent configuration failed'
    Write-Output 'PASS: native GUI login/MFA, exact verified counts, keychain reconnect and agent configuration'
    Click 'Disconnect'; $null = Eventually { Has 'Confirm' } 'Disconnect did not require confirmation'
    Click 'Confirm'; $null = Eventually { Has 'Disconnected.' } 'GUI disconnect did not finish'
    ClipboardStable
    CloseWindow
  } elseif ($Mode -eq 'close') {
    $null = Eventually { Has 'Saved preview loaded' } 'Preview was not loaded before dismiss'
    $null = Eventually { (Has 'Approval account (pinned)') -and (Has $env:SN_EMAIL) -and -not (Has 'Approval account unavailable') } 'Approval window must show the backend-bound pinned account'
    UncheckedApprove
    CloseWindow
  } else {
    $null = Eventually { Has 'Saved preview loaded' } 'Saved preview is missing'
    $null = Eventually { (Has 'Approval account (pinned)') -and (Has $env:SN_EMAIL) -and -not (Has 'Approval account unavailable') } 'Approval window must show the backend-bound pinned account'
    Assert (Has 'Complete plain JSON preview') 'Complete preview must be visibly labeled'
    if ($Mode -eq 'approve') {
      UncheckedApprove
      Click 'reviewed' $true; Click 'Approve' $true
    } else { Click 'Reject' $true }
  }
  $null = Eventually { -not (Window) } 'GUI did not close after its decision'
  Write-Output ('PASS: native Windows GUI '+$Mode+'; '+$script:assertions+' strict assertions')
  exit 0
} catch {
  if ($script:failure) { Write-Error $script:failure } else { Write-Error ('Windows GUI fixture failed: '+$_.Exception.GetType().FullName) }
  exit 1
}
