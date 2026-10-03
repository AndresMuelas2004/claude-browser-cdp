# How the skill works

## Why raw CDP and not a browser MCP

Chrome speaks the **Chrome DevTools Protocol** (CDP) over a local WebSocket when it is started with
`--remote-debugging-port`. `cdp.js` talks to it directly with the `fetch` and `WebSocket` built into
Node 22+, so there is nothing to install and every command takes ~100 ms. Talking CDP directly lets
the skill do things generic browser tools struggle with: falling back to a DOM click when an overlay
covers a button, piercing shadow DOM, intercepting file dialogs, emulating exact device metrics for
screenshots, handling native `alert`/`confirm` dialogs before they freeze a tab.

## Lanes

A **lane** is a dedicated Chrome profile folder with its own debugging port and its own logins:

```json
{
  "defaultLane": "main",
  "lanes": [
    { "name": "main", "port": 9222, "profileDir": "%LOCALAPPDATA%\\browser-cdp\\profiles\\main", "account": "me@example.com" },
    { "name": "work", "port": 9223, "profileDir": "%LOCALAPPDATA%\\browser-cdp\\profiles\\work", "account": "me@company.com" }
  ],
  "virtualDesktops": false,
  "chromePath": ""
}
```

- Lanes are separate from each other **and from your everyday Chrome**: the skill never touches
  your personal browser, and you can keep using it normally.
- Each lane remembers its logins between restarts, like any Chrome profile.
- `cdp.js --lane work …` picks a lane; without `--lane` it uses `defaultLane`. `--port` also works.
- If a lane is not running, `cdp.js` launches it through `ensure-chrome.ps1` — with no window
  (`--no-startup-window`), the internal profile fixed to `Default`, and the flags that keep Chrome
  rendering when its window is on another virtual desktop.
- `chromePath` is only needed if Chrome is not in one of the usual install locations.

## Logging in

You log in to each lane once, like in any browser; the session then persists in that profile.

- **Most sites**: the skill opens the login page in the lane and asks you to log in there (or, if
  you configured it, fills your credentials from your password manager).
- **Google** blocks logins in a browser started with a debugging port ("This browser or app may not
  be secure"). The skill closes the lane and asks you to open that same profile once **without**
  debugging (`chrome.exe --user-data-dir="<profile>" --profile-directory=Default`), log in to
  Google, and close it. After that the lane keeps the Google session.

`node cdp.js session google` tells you, without opening anything, whether a lane is logged in.

## Your tab, and only yours

Every session pins its own tab (`use new:<url>`) in a small file, `.cdp-<port>.json`, inside the
session's scratchpad (`CDP_PIN_DIR`). That way several Claude sessions can share a lane without
stepping on each other's tabs or on yours.

## Virtual desktops (optional)

If you work with several Windows virtual desktops, set `"virtualDesktops": true`. Then a new tab
opens on the desktop where the **Claude session's terminal** is, not on whichever desktop you happen
to be looking at. It needs the `VirtualDesktop` PowerShell module (`Install-Module VirtualDesktop
-Scope CurrentUser`) and a `UserPromptSubmit` hook that notes which terminal window you typed in
(the guided install sets it up):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe",
            "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                     "C:\\Users\\YOU\\.claude\\skills\\browser-cdp\\scripts\\virtual-desktop.ps1", "-Action", "note"],
            "timeout": 20,
            "async": true
          }
        ]
      }
    ]
  }
}
```

## Safety rules built in

- The skill only starts when **you ask for it** (the description says so explicitly).
- Irreversible buttons (publish, send, pay, delete) are never pressed unless you asked for that.
- Native "Are you sure?" dialogs are **dismissed** by default; accepting needs `--dialog accept`.
- Logging out or switching accounts counts as irreversible.
- `@text` targets act only when the match is unique.
- Password values never appear in the element inventory.
- To recover a stuck lane it only kills the Chrome processes of **that lane's profile**, never
  `chrome.exe` as a whole.

## Commands

`node cdp.js help` prints them all. The main ones: `lanes`, `tabs`, `use`, `goto`, `snap`, `text`,
`table`, `session`, `click`, `fill`, `press`, `upload`, `pick`, `shot`, `eval`, `wait`, `run`,
`close`. `SKILL.md` explains how Claude combines them (the `snap` → act by `#n` → verify loop, and
multi-step `run` scripts).

## Limits

- **Windows only.** The launcher, the virtual-desktop support and the weekly task are PowerShell and
  Windows-specific. `cdp.js` itself is portable, but nothing else has been made or tested for macOS
  or Linux.
- It drives Chrome (Chromium-based browsers with CDP may work with `chromePath`, untested).
- Headless mode is never used: you need to see the window to log in.
