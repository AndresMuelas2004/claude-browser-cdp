# ensure-chrome.ps1
# Makes sure a Chrome with remote debugging is running for the requested lane.
#
# The lanes (name, port, profile folder) live in ..\lanes.json. Each lane is a dedicated automation
# profile, separate from the other lanes and from the user's everyday Chrome; that is where each
# account's logins persist between restarts.
#
# cdp.js calls it only when the port does not answer. It can also be run by hand BEFORE opening
# Claude Code to have a lane ready from the start:  ensure-chrome.ps1 -Port 9222
#
# Output (stdout, one keyword) + exit code:
#   ALREADY_UP       (0) -> the CDP endpoint was already answering; nothing was done.
#   LAUNCHED_UP      (0) -> Chrome was launched and the endpoint answers.
#   CHROME_NOT_FOUND (2) -> the Chrome executable was not found.
#   LAUNCH_TIMEOUT   (3) -> Chrome was launched but the endpoint did not answer in time.
#   PORT_UNKNOWN     (4) -> the requested port is not a lane in lanes.json.

param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'

$lanesFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'lanes.json'
$lanes = @()
$chromeOverride = ''
if (Test-Path $lanesFile) {
    $cfg = Get-Content $lanesFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $lanes = @($cfg.lanes)
    if ($cfg.chromePath) { $chromeOverride = [Environment]::ExpandEnvironmentVariables([string]$cfg.chromePath) }
}
if ($lanes.Count -eq 0) {
    $lanes = @([pscustomobject]@{ name = 'main'; port = 9222; profileDir = '%LOCALAPPDATA%\browser-cdp\profiles\main' })
}
$lane = $lanes | Where-Object { [int]$_.port -eq $Port } | Select-Object -First 1
if (-not $lane) { Write-Output "PORT_UNKNOWN: $Port"; exit 4 }

$profileDir = if ($lane.profileDir) { [string]$lane.profileDir } else { "%LOCALAPPDATA%\browser-cdp\profiles\$($lane.name)" }
# no trailing backslash: before a closing quote it would escape the quote on the command line
$userDataDir = [Environment]::ExpandEnvironmentVariables($profileDir).TrimEnd('\')

$candidates = @(
    $chromeOverride,
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ }
$chrome = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

$endpoint = "http://127.0.0.1:$Port/json/version"

function Test-CdpUp {
    try {
        $r = Invoke-WebRequest -Uri $endpoint -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

if (Test-CdpUp) { Write-Output 'ALREADY_UP'; exit 0 }

if (-not $chrome) { Write-Output "CHROME_NOT_FOUND: $($candidates -join ' | ')"; exit 2 }

New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null

# --user-data-dir goes in quotes: Windows PowerShell does not quote arguments with spaces by itself,
#   and a profile under C:\Users\Jane Doe\... would reach Chrome split in two.
# --profile-directory=Default: a profile folder can hold more than one Chrome profile; without
#   fixing it, Chrome may show the "Who's using Chrome?" picker and the first tab can land in the
#   wrong profile.
# --no-startup-window: Chrome starts with no window (the debugging port keeps it alive). cdp.js
#   opens the window when needed; a startup window would appear on the active virtual desktop,
#   which is often not the one the session runs on.
# --disable-backgrounding-occluded-windows (+ renderer-backgrounding, background-timer-throttling):
#   without them Chrome treats a window that is on ANOTHER virtual desktop (or covered) as hidden
#   — document.visibilityState = hidden —, stops rendering and the site stays on «loading» or with
#   menus that do not open. They are the same ones Puppeteer uses by default. They only apply at
#   launch: a lane that is already up keeps running without them until it is closed.
Start-Process -FilePath $chrome -ArgumentList "--remote-debugging-port=$Port", "--user-data-dir=`"$userDataDir`"",
    '--profile-directory=Default', '--no-startup-window', '--no-first-run', '--no-default-browser-check',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'

for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    if (Test-CdpUp) { Write-Output 'LAUNCHED_UP'; exit 0 }
}

Write-Output 'LAUNCH_TIMEOUT'; exit 3
