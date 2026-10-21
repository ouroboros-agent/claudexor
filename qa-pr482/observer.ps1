# PR482 window/process observer (QA only). Windows PowerShell 5.1 (Add-Type C# 5).
# Records, until <OutDir>\observer.stop exists:
#   observer-windows.jsonl   top-level window CREATE/SHOW events (SetWinEventHook, out of
#                            context, own message pump) plus a visible-window poll fallback
#   observer-processes.jsonl Win32_ProcessStartTrace / Win32_ProcessStopTrace (event based)
#   observer-host.json       OS, session, window station/desktop, console host and terminal
#                            delegation facts, so a result is never generalized beyond them.
# It infers nothing about console or handle inheritance: it records what happened.
param(
  [Parameter(Mandatory = $true)] [string] $OutDir,
  [int] $PollMs = 100,
  [int] $MaxSeconds = 3000,   # hard stop even if observer.stop never appears
  [int] $DrainSeconds = 5     # fixed post-stop time to deliver already-queued process events
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$windowsLog = Join-Path $OutDir 'observer-windows.jsonl'
$processLog = Join-Path $OutDir 'observer-processes.jsonl'
$hostFacts = Join-Path $OutDir 'observer-host.json'
$readyFile = Join-Path $OutDir 'observer.ready'
$stopFile = Join-Path $OutDir 'observer.stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Pr482Observer {
  delegate void WinEventProc(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern uint MsgWaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint ms, uint mask);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, int length, out int needed);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  static WinEventProc hookCallback;
  static EnumProc enumCallback;
  static StreamWriter writer;
  static readonly object gate = new object();
  // Handles visible at the previous poll: a window is recorded when it BECOMES visible, so a
  // hidden-then-shown window and a reused handle value are seen again.
  static HashSet<long> previousVisible = new HashSet<long>();
  static HashSet<long> currentVisible = new HashSet<long>();

  static string Esc(string value) {
    var text = new StringBuilder();
    foreach (char c in value ?? "") {
      if (c == '"' || c == '\\') { text.Append('\\'); text.Append(c); }
      else if (c < ' ') text.Append(string.Format("\\u{0:x4}", (int)c));
      else text.Append(c);
    }
    return text.ToString();
  }
  static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
  static void Write(string line) { lock (gate) { writer.WriteLine(line); writer.Flush(); } }

  static void Record(string source, uint evt, IntPtr hwnd) {
    var cls = new StringBuilder(256); GetClassName(hwnd, cls, 256);
    var title = new StringBuilder(512); GetWindowText(hwnd, title, 512);
    uint pid; uint tid = GetWindowThreadProcessId(hwnd, out pid);
    string image = "";
    try { image = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
    RECT rect; GetWindowRect(hwnd, out rect);
    Write("{\"at\":" + Now() + ",\"source\":\"" + source + "\",\"event\":" + evt + ",\"hwnd\":" + hwnd.ToInt64() +
      ",\"class\":\"" + Esc(cls.ToString()) + "\",\"title\":\"" + Esc(title.ToString()) + "\",\"visible\":" +
      (IsWindowVisible(hwnd) ? "true" : "false") + ",\"iconic\":" + (IsIconic(hwnd) ? "true" : "false") +
      ",\"style\":" + GetWindowLong(hwnd, -16) + ",\"pid\":" + pid + ",\"tid\":" + tid + ",\"image\":\"" + Esc(image) +
      "\",\"rect\":[" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom + "]}");
  }
  static void OnEvent(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    if (hwnd == IntPtr.Zero || idObject != 0 || idChild != 0) return;
    if (GetAncestor(hwnd, 2) != hwnd) return; // GA_ROOT: top-level windows only
    Record("hook", evt, hwnd);
  }
  static bool OnEnum(IntPtr hwnd, IntPtr param) {
    if (IsWindowVisible(hwnd)) {
      long handle = hwnd.ToInt64();
      currentVisible.Add(handle);
      if (!previousVisible.Contains(handle)) Record("poll", 0, hwnd);
    }
    return true;
  }
  static void Poll() {
    currentVisible = new HashSet<long>();
    EnumWindows(enumCallback, IntPtr.Zero);
    previousVisible = currentVisible;
  }
  static string ObjectName(IntPtr handle) {
    var name = new StringBuilder(256); int needed;
    return handle != IntPtr.Zero && GetUserObjectInformation(handle, 2, name, 512, out needed) ? name.ToString() : "";
  }
  public static string Desktop() { return ObjectName(GetThreadDesktop(GetCurrentThreadId())); }
  public static string WindowStation() { return ObjectName(GetProcessWindowStation()); }
  public static string InputDesktop() {
    IntPtr input = OpenInputDesktop(0, false, 0x0001);
    if (input == IntPtr.Zero) return "";
    try { return ObjectName(input); } finally { CloseDesktop(input); }
  }

  static void Loop(string path, string stopPath, int pollMs, int maxSeconds, ManualResetEvent ready) {
    writer = new StreamWriter(path, true, new UTF8Encoding(false));
    hookCallback = OnEvent;
    enumCallback = OnEnum;
    // EVENT_OBJECT_CREATE(0x8000)..EVENT_OBJECT_SHOW(0x8002); WINEVENT_SKIPOWNPROCESS.
    IntPtr hook = SetWinEventHook(0x8000, 0x8002, IntPtr.Zero, hookCallback, 0, 0, 0x0002);
    Write("{\"at\":" + Now() + ",\"source\":\"observer\",\"hookInstalled\":" + (hook != IntPtr.Zero ? "true" : "false") +
      ",\"desktop\":\"" + Esc(Desktop()) + "\"}");
    Poll(); // windows already visible before any scenario
    ready.Set();
    DateTime lastPoll = DateTime.UtcNow;
    DateTime giveUp = DateTime.UtcNow.AddSeconds(maxSeconds);
    while (!File.Exists(stopPath) && DateTime.UtcNow < giveUp) {
      MsgWaitForMultipleObjects(0, null, false, (uint)Math.Max(10, pollMs / 2), 0x04FF);
      MSG msg;
      while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
      if ((DateTime.UtcNow - lastPoll).TotalMilliseconds >= pollMs) { Poll(); lastPoll = DateTime.UtcNow; }
    }
    if (hook != IntPtr.Zero) UnhookWinEvent(hook);
    Write("{\"at\":" + Now() + ",\"source\":\"observer\",\"stopped\":true}");
    writer.Dispose();
  }

  public static Thread Start(string path, string stopPath, int pollMs, int maxSeconds) {
    var ready = new ManualResetEvent(false);
    var thread = new Thread(() => Loop(path, stopPath, pollMs, maxSeconds, ready));
    thread.IsBackground = true;
    thread.Start();
    ready.WaitOne(10000);
    return thread;
  }
}
'@

function Write-Json($path, $value) {
  ($value | ConvertTo-Json -Compress -Depth 6) | Out-File -FilePath $path -Append -Encoding utf8
}

# Host facts: what this observation can and cannot speak for.
$os = Get-CimInstance Win32_OperatingSystem
$delegation = Get-ItemProperty -Path 'HKCU:\Console\%%Startup' -ErrorAction SilentlyContinue
$terminalPackage = $null
try { $terminalPackage = Get-AppxPackage -Name Microsoft.WindowsTerminal -ErrorAction Stop | Select-Object -First 1 } catch { }
$facts = [ordered]@{
  observedAt          = (Get-Date).ToUniversalTime().ToString('o')
  osCaption           = $os.Caption
  osVersion           = $os.Version
  osBuild             = $os.BuildNumber
  productType         = $os.ProductType  # 1 workstation, 2 domain controller, 3 server
  powershell          = $PSVersionTable.PSVersion.ToString()
  userInteractive     = [Environment]::UserInteractive
  observerSessionId   = (Get-Process -Id $PID).SessionId
  windowStation       = [Pr482Observer]::WindowStation()
  desktop             = [Pr482Observer]::Desktop()
  inputDesktop        = [Pr482Observer]::InputDesktop()
  delegationConsole   = if ($delegation) { $delegation.DelegationConsole } else { $null }
  delegationTerminal  = if ($delegation) { $delegation.DelegationTerminal } else { $null }
  windowsTerminal     = if ($terminalPackage) { $terminalPackage.Version.ToString() } else { $null }
  conhostVersion      = (Get-Item "$env:SystemRoot\System32\conhost.exe").VersionInfo.FileVersion
  runningTerminalHost = @(Get-Process -Name WindowsTerminal, OpenConsole -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName })
}
($facts | ConvertTo-Json -Depth 4) | Out-File -FilePath $hostFacts -Encoding utf8

# Event-based process lifetime (requires an elevated session, as on hosted runners).
$processCapture = 'registered'
try {
  Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier pr482start -MessageData $processLog -Action {
    $e = $Event.SourceEventArgs.NewEvent
    # Event actions run in their own scope: keep this conversion inline.
    $at = ([DateTimeOffset][DateTime]::FromFileTimeUtc([long]$e.TIME_CREATED)).ToUnixTimeMilliseconds()
    # No Get-CimInstance command-line lookup here: a synchronous WMI query per start
    # delays every queued event. Attribution uses pid/ppid; argv is in the harness's
    # native call log.
    $line = [ordered]@{ kind = 'start'; at = $at; pid = [int]$e.ProcessID; ppid = [int]$e.ParentProcessID; name = $e.ProcessName; session = [int]$e.SessionID }
    ($line | ConvertTo-Json -Compress) | Out-File -FilePath $Event.MessageData -Append -Encoding utf8
  } | Out-Null
  Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace -SourceIdentifier pr482stop -MessageData $processLog -Action {
    $e = $Event.SourceEventArgs.NewEvent
    $at = ([DateTimeOffset][DateTime]::FromFileTimeUtc([long]$e.TIME_CREATED)).ToUnixTimeMilliseconds()
    $line = [ordered]@{ kind = 'stop'; at = $at; pid = [int]$e.ProcessID; ppid = [int]$e.ParentProcessID; name = $e.ProcessName; exitStatus = [long]$e.ExitStatus }
    ($line | ConvertTo-Json -Compress) | Out-File -FilePath $Event.MessageData -Append -Encoding utf8
  } | Out-Null
} catch {
  $processCapture = "unavailable: $($_.Exception.Message)"
}
Write-Json $processLog ([ordered]@{ kind = 'observer'; processCapture = $processCapture; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() })

$thread = [Pr482Observer]::Start($windowsLog, $stopFile, $PollMs, $MaxSeconds)
'ready' | Out-File -FilePath $readyFile -Encoding ascii
# Event actions only run while the engine services events. Every wait below is bounded:
# the whole observation by $MaxSeconds, the post-stop drain by $DrainSeconds.
$giveUp = (Get-Date).AddSeconds($MaxSeconds)
while (-not (Test-Path $stopFile) -and (Get-Date) -lt $giveUp) { Wait-Event -Timeout 1 | Out-Null }
$thread.Join(5000) | Out-Null
# Drain: keep servicing the event queue for a fixed, bounded time so start/stop events
# queued behind a slow action reach their handler before the subscriptions go away.
$drainEnd = (Get-Date).AddSeconds($DrainSeconds)
while ((Get-Date) -lt $drainEnd) { Wait-Event -Timeout 1 | Out-Null }
Write-Json $processLog ([ordered]@{ kind = 'observer'; stopped = $true; stopFile = (Test-Path $stopFile); at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() })
Get-EventSubscriber -ErrorAction SilentlyContinue | Unregister-Event -ErrorAction SilentlyContinue
