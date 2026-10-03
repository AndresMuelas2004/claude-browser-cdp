# virtual-desktop.ps1
# OPTIONAL ("virtualDesktops": true in lanes.json). Windows virtual desktops: which one the Claude
# session running the skill is on, and how to bring the lane's Chrome window there. Called by
# cdp.js (use new: / goto --new) and by the UserPromptSubmit hook; no need to run it by hand.
#
#   -Action note                 (hook) notes the window that has the focus when the prompt is sent
#                                —the terminal where it was typed— in %LOCALAPPDATA%\browser-cdp\desktops\<session_id>.json
#   -Action prepare -Port N      JSON {desktop:{index,name}|null, source, reason, windows:[{hwnd,title,inSession}]}
#                                desktop = this session's; windows = the lane's, inSession if they are on it
#   -Action place -Port N -Known h1,h2   waits for the lane's new window (the one not in -Known), moves
#                                it to the session's desktop; JSON {hwnd, moved, reason, desktop}
#
# Why the hook is needed: Windows Terminal runs all its windows in a single process, so the process
# tree does not say which window (or desktop) this session lives in. The hook notes, on every prompt,
# the window that had the focus when Enter was pressed. Without a note (hook not installed, prompt
# sent from a phone) it falls back to the main window of the first ancestor that has one.
#
# Moving another process's window to another desktop is not allowed by the public Windows API
# (E_ACCESSDENIED): it uses MScholtes' VirtualDesktop module (Install-Module VirtualDesktop), which
# talks to the shell's internal interface. If it is missing or stops working after a Windows update,
# this returns desktop=null with the reason and cdp.js places nothing (it only warns).

param(
    [ValidateSet('note', 'prepare', 'place')] [string]$Action = 'prepare',
    [int]$Port = 9222,
    [string]$Known = '',
    [string]$SessionId = $env:CLAUDE_CODE_SESSION_ID
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$registry = Join-Path $env:LOCALAPPDATA 'browser-cdp\desktops'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinInfo { public long Hwnd; public string Title; }

public static class Win {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public static uint Pid(long hwnd) { uint p; GetWindowThreadProcessId(new IntPtr(hwnd), out p); return p; }

    // top-level, visible, ownerless windows of process pid with the given class
    public static List<WinInfo> Windows(uint pid, string cls) {
        var r = new List<WinInfo>();
        EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != pid || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
            var c = new StringBuilder(64); GetClassName(h, c, 64);
            if (c.ToString() != cls) return true;
            var t = new StringBuilder(512); GetWindowText(h, t, 512);
            r.Add(new WinInfo { Hwnd = h.ToInt64(), Title = t.ToString() });
            return true;
        }, IntPtr.Zero);
        return r;
    }
}
'@

# a single WMI query (they are slow): table pid -> process
$processes = @{}
Get-CimInstance Win32_Process | ForEach-Object { $processes[[uint32]$_.ProcessId] = $_ }

function Get-Ancestors {
    $r = @(); $p = $processes[[uint32]$PID]
    for ($i = 0; $p -and $i -lt 15; $i++) { $r += [uint32]$p.ProcessId; $p = $processes[[uint32]$p.ParentProcessId] }
    $r
}

# pid of the browser process (the parent, without --type=) of the lane
function Get-LanePid($port) {
    $p = $processes.Values | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match "--remote-debugging-port=$port\b" -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
    if ($p) { [uint32]$p.ProcessId } else { 0 }
}

function Get-LaneWindows($port) {
    $lanePid = Get-LanePid $port
    if (-not $lanePid) { return @() }
    [Win]::Windows($lanePid, 'Chrome_WidgetWin_1')
}

# hwnd of this session's window: the one noted by the hook if it still exists; otherwise the main
# window of the first ancestor that has one (Windows Terminal, VS Code, the desktop app...)
function Get-SessionWindow {
    if ($SessionId) {
        $f = Join-Path $registry "$SessionId.json"
        if (Test-Path $f) {
            $h = [long](Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json).hwnd
            if ($h -and [Win]::IsWindow([IntPtr]$h)) { return @{ hwnd = $h; source = 'hook' } }
        }
    }
    foreach ($id in Get-Ancestors) {
        $h = (Get-Process -Id $id -ErrorAction SilentlyContinue).MainWindowHandle
        if ($h -and $h -ne 0) { return @{ hwnd = [long]$h; source = 'ancestor' } }
    }
    $null
}

# Desktop object (from the module) of the session's desktop, or null + reason
function Get-SessionDesktop {
    try { Import-Module VirtualDesktop -DisableNameChecking -ErrorAction Stop }
    catch { return @{ desktop = $null; reason = "VirtualDesktop module not available: $($_.Exception.Message)" } }
    $w = Get-SessionWindow
    if (-not $w) { return @{ desktop = $null; reason = 'no ancestor process has a window' } }
    try { $d = [VirtualDesktop.Desktop]::FromWindow([IntPtr]$w.hwnd) }
    catch { return @{ desktop = $null; reason = "FromWindow($($w.hwnd)) failed: $($_.Exception.Message)" } }
    if (-not $d) { return @{ desktop = $null; reason = "window $($w.hwnd) is not on any desktop" } }
    @{ desktop = $d; source = $w.source; index = (Get-DesktopIndex $d); name = [VirtualDesktop.Desktop]::DesktopNameFromDesktop($d) }
}

switch ($Action) {
    'note' {
        try { $sid = ([Console]::In.ReadToEnd() | ConvertFrom-Json).session_id } catch { $sid = $null }
        if (-not $sid) { $sid = $SessionId }
        if (-not $sid) { exit 0 }
        $h = [long][Win]::GetForegroundWindow()
        # it only counts if the focus belongs to this session's terminal (an ancestor): if the prompt
        # arrived another way (phone, another app in front) the previous note is kept
        if (-not $h -or (Get-Ancestors) -notcontains [Win]::Pid($h)) { exit 0 }
        New-Item -ItemType Directory -Force $registry | Out-Null
        @{ hwnd = $h; when = (Get-Date).ToString('s') } | ConvertTo-Json -Compress |
            Set-Content (Join-Path $registry "$sid.json") -Encoding UTF8
        # notes from old sessions: out
        Get-ChildItem $registry -Filter '*.json' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
    'prepare' {
        $s = Get-SessionDesktop
        $windows = @(Get-LaneWindows $Port | ForEach-Object {
            @{ hwnd = $_.Hwnd; title = $_.Title; inSession = [bool]($s.desktop -and $s.desktop.HasWindow([IntPtr]$_.Hwnd)) }
        })
        $out = @{ desktop = $null; source = $s.source; reason = $s.reason; windows = $windows }
        if ($s.desktop) { $out.desktop = @{ index = $s.index; name = $s.name } }
        $out | ConvertTo-Json -Compress -Depth 4
    }
    'place' {
        $knownList = @($Known -split ',' | Where-Object { $_ } | ForEach-Object { [long]$_ })
        $new = $null
        for ($i = 0; $i -lt 40 -and -not $new; $i++) {
            $new = Get-LaneWindows $Port | Where-Object { $knownList -notcontains $_.Hwnd } | Select-Object -First 1
            if (-not $new) { Start-Sleep -Milliseconds 150 }
        }
        if (-not $new) { @{ hwnd = 0; moved = $false; reason = 'no new lane window appeared' } | ConvertTo-Json -Compress; exit 0 }
        $s = Get-SessionDesktop
        if (-not $s.desktop) { @{ hwnd = $new.Hwnd; moved = $false; reason = $s.reason } | ConvertTo-Json -Compress; exit 0 }
        try {
            if (-not $s.desktop.HasWindow([IntPtr]$new.Hwnd)) { $s.desktop.MoveWindow([IntPtr]$new.Hwnd) }
            @{ hwnd = $new.Hwnd; moved = $true; desktop = @{ index = $s.index; name = $s.name } } | ConvertTo-Json -Compress
        } catch {
            @{ hwnd = $new.Hwnd; moved = $false; reason = "MoveWindow failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress
        }
    }
}
