---
name: browser-cdp
argument-hint: "optional lane name + the site and the action to automate"
description: ONLY ON EXPLICIT USER REQUEST — never invoke it on your own initiative, not even when the task seems to fit. It activates only if the user explicitly asks to use this skill, their browser or their Chrome; if you think it would help, suggest it and wait for their answer. Drives the user's real, logged-in Chrome by speaking CDP directly — no MCP, nothing to install. One or more "lanes" (dedicated Chrome profiles, each with its own logins and debugging port) that the skill launches by itself. Use it for any request to operate their browser on sites where they are logged in — "use my browser", "connect to my Chrome", "open my Google Cloud console and navigate it yourself", "click the buttons for me" —, uploading files to a site, exact mobile screenshots with deviceScaleFactor, or scraping tables. NOT for anonymous browsing without a session.
when_to_use: "ONLY if the user explicitly asks for it — never on your own initiative; if you think it fits, suggest it and wait for an answer. Examples: «use my browser», «connect to my Chrome», «open my Google Cloud console and navigate it yourself», «click the buttons on this logged-in site for me», «upload this file to the site», «take an exact 1080x1920 mobile screenshot», «scrape every row of this table»."
---

# Browser automation over CDP

**If you got here on your own and the user did not ask for their browser, stop and suggest it before running a single command.** «Reading a logged-in page» is not reason enough.

You attach over CDP to the user's **real, logged-in Chrome** and drive it with `cdp.js`. It handles what a browser MCP cannot: stubborn Material controls, overlays that intercept the click, file uploads, iframes, shadow DOM and screenshots with device scale.

**No installation, no dependencies.** `cdp.js` uses the built-in `fetch` and `WebSocket` of Node ≥ 22: no `npm i`, nothing to copy to the scratchpad. ~100 ms per command. The scripts live in this skill's folder, `${CLAUDE_SKILL_DIR}` (if you ever see that placeholder unexpanded, it is `~/.claude/skills/browser-cdp`).

## 1. Lanes

| Lane | Port | Flag | Profile folder | Account |
|---|---|---|---|---|
| main (default) | `9222` | `--lane main` (or none) | `%LOCALAPPDATA%\browser-cdp\profiles\main` | — |

The source of truth is `lanes.json`, next to this file; `node $cdp lanes` lists the lanes, the default one, and which are up. Each lane is a profile **dedicated to automation**, separate from the other lanes and from the user's everyday Chrome: that is where each account's logins persist between restarts. Lanes are independent: they can be active at the same time from different Claude sessions.

A lane always starts with the internal profile `Default` fixed (`--profile-directory=Default`) and **with no window** (`--no-startup-window`): no "Who's using Chrome?" picker and no stray window on the wrong desktop. The window is opened by `use new:` when needed.

## 2. Open the lane and pin YOUR tab

```powershell
$cdp = "${CLAUDE_SKILL_DIR}\scripts\cdp.js"; $env:CDP_PIN_DIR = "<this session's scratchpad>"
node $cdp use new:https://console.cloud.google.com/          # default lane; another one: --lane <name>
```

If the lane is down, `cdp.js` launches it by itself with `scripts/ensure-chrome.ps1`. If it does not start or the site asks for a login, go to section 6.

Only with `"virtualDesktops": true` in `lanes.json`: **the tab opens on the Windows virtual desktop where THIS session's terminal is**, not the one the user is looking at. If the lane already has a window on that desktop the tab goes inside it; otherwise a new window that `scripts/virtual-desktop.ps1` moves there (it shows for an instant on the active desktop: unavoidable). The answer says so in `desktop:`. If it says `unknown desktop` with a warning, the tab went wherever Chrome wanted: tell the user and see the end of section 6.

**`CDP_PIN_DIR` goes in EVERY call.** That is where your tab is recorded (`.cdp-<port>.json`), and the PowerShell tool **does not keep variables between calls**: every command must bring its own `$env:CDP_PIN_DIR` (and its `$cdp`) or the file ends up in the current directory, shared with other sessions. Always work on the tab you pinned with `use`; without a pinned tab the command warns and uses the first one, which may belong to another session or to the user.

## 3. Commands

`cdp.js help` lists them all with their flags. The everyday ones:

| | |
|---|---|
| `use <n\|url-text\|new:URL>` · `tabs` · `lanes` | pin your tab / see the lane's tabs / see the lanes |
| `goto <url>` | navigate and wait for the load |
| `snap [--filter regex] [--hidden] [--page]` | compact, **numbered** inventory of what is interactive. With a modal open it inventories only the modal; `--page` ignores it and goes back to the whole page |
| `text [sel] [--grep regex]` · `table <sel>` | read text / dump rows as TSV |
| `session [domain]` | is the lane logged in? session cookies and expiry (tiktok, google, instagram…); needs no tab |
| `click <#n\|sel\|@text>` | robust click |
| `fill <#n\|sel\|@text> <value> [--keys]` | type into a field; on a `<select>` it picks the option by value or text |
| `press <Key\|Ctrl+A>` · `wait --text\|--sel\|--gone\|--idle` | keys and combinations / waits (`--sel`/`--gone` accept `#n`, `@text` or CSS) |
| `upload <#n\|sel> <file>` · `pick <button> <file>` | upload files |
| `shot <out.png> [--mobile\|--px 1080x1920] [--dsf n] [--full] [--sel]` | screenshots |
| `eval <expr\|@file.js>` · `run <script.js>` | arbitrary JS / multi-step flow |
| `close` | closes your tab (works even when it hangs on a modal) |

Global: `--lane <name>`/`--port`, `--frame <url-substring>`, `--json`, `--dialog accept`.

## 4. How to work

The loop is **`snap` → act by `#n` → verify**:

```powershell
# this first line goes in EVERY PowerShell call: its variables do not survive between calls
$cdp = "${CLAUDE_SKILL_DIR}\scripts\cdp.js"; $env:CDP_PIN_DIR = "<scratchpad>"
node $cdp snap --filter Save          # → #14 button "Save"
node $cdp click '#14'                 # → via: real click | dom-click (covered by ...)
node $cdp wait --text "Changes saved"
```

`click` already tells you **what** element it touched and **how**, so that counts as verifying the action; after saving something critical, reload and read the value back.

**When you chain 3+ actions, do it in a single `run`** (one connection, ~5x faster and half the calls):

```js
// $env:CDP_PIN_DIR\steps.js  →  node $cdp run "$env:CDP_PIN_DIR\steps.js" [arg1 arg2…]
// Write it with `Write` in an EARLIER message: in the same one, the run arrives before the file.
module.exports = async (page, { args }) => {          // args: whatever follows the file on the command line
  await page.fill('#name', 'My project', { keys: true })
  await page.click('@Save')
  await page.wait({ text: 'Changes saved' })
  return await page.text('#summary')
}
```
The `page` API is the same as the commands: `snap fill click press upload pick wait goto text table eval shot`. Also, `page.send('Domain.method', {…})` sends raw CDP (it does not exist as a console command).

## 5. Rules learned (the hard way)

- **Numbering**: the `#n` belong to the last `snap` **on that same page**. If the DOM is rebuilt (navigation, a React re-render), `snap` again — if the `#n` no longer exists the command fails clearly, it does not click blindly.
- **`@text`** only acts if the match is unique; if there are several, it lists the candidates instead of choosing for you. With ambiguous names, use `#n` or a CSS selector.
- **Overlays** ("unsaved changes" snackbars, banners): `click` detects that something covers the point and switches to a DOM click by itself. Nothing to do.
- **Rich-text editors** (Reddit, Notion, Gmail): if `fill` does not stick, repeat with `--keys` (real typing, key by key).
- **Native dialogs** (`confirm`, `alert`): dismissed automatically, with a warning. To accept them, repeat the action with `--dialog accept`. **Never let one open without `cdp.js` attached**: a modal opened with no CDP client blocks the tab irrecoverably (it cannot even be closed over CDP; close the tab with `close`).
- **Iframes**: `--frame <url-substring>`. There, clicks always go through the DOM (mouse coordinates belong to the main viewport, not the frame).
- **Shadow DOM** (Reddit, Google consoles, LinkedIn's modal): `snap`, `@text` and selectors always go through it. What does **not** cross the boundary is a descendant selector — `shreddit-composer textarea` does not match; use the final element's selector alone (`textarea[part=textarea-input]`). In `eval`/`run`, `document.querySelector` does not cross either: inside `eval` you have `__deep(document, sel)` (it goes through) and `__resolve('#n')`.
- **Hidden tab** (another tab active in its window, or minimized): the site does not render and real mouse/keyboard input does not reach it — menus that do not open, endless «loading», `wait` running out. `snap`/`click`/`fill`/`press`/`wait` bring it to the front by themselves and say so. Several forks on the same lane steal the front from each other: each one with its own `CDP_PIN_DIR` (a subfolder of the scratchpad) and its steps grouped in `run`.
- **Emulation does not survive the command**: the viewport of `shot --px` is cleared when the connection closes, so measuring afterwards measures the real window. If you need to work at a given width (a site that collapses to mobile, a navigation drawer covering the form), do everything inside one `run` with `page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })`.
- **Screenshots**: `shot` brings the tab to the front (with the window behind, the capture hangs) and clears the emulation when done. It reports the pixels **read from the PNG**, not the ones requested. Activating the window can switch the user to another virtual desktop: do not take screenshots «just to look» — only when they are needed.
- **Internal search boxes that do not filter as you type**: do not insist — `table`/`text` to dump everything and select by exact text.
- **Quotes through PowerShell**: double outside, **single inside** — in the `eval` JS and in selectors too (`click "form[action='/x/y'] button"`). PowerShell strips inner double quotes even if you escape them with `\"`, and the error that follows does not look like it. If the argument needs both, pass it with `eval @file.js` or `run`.
- **Waiting**: `wait --text|--sel|--gone|--idle` (with `--timeout` if needed), never `Start-Sleep` — a fixed wait is either too short or too long.

## 6. Lane down or login expired

**`LAUNCH_TIMEOUT` — the profile is held by a Chrome without debugging.** Usually a login window left open: the instance with the port hands off to it and never opens the port. Close **only** that lane's processes and retry once:

```powershell
$lane = 'main'   # the lane to close
$cfg = Get-Content "${CLAUDE_SKILL_DIR}\lanes.json" -Raw | ConvertFrom-Json
$dir = [Environment]::ExpandEnvironmentVariables(($cfg.lanes | Where-Object name -eq $lane).profileDir).TrimEnd('\')
$p = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match ([regex]::Escape($dir) + '(?=["\s]|$)') })
"Closing $($p.Count) processes"; $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
```

The look-ahead keeps `profiles\main` from also matching `profiles\main2`. **Never kill `chrome.exe` bare** — you would take down the user's personal browser. If the filter returns 0 processes and it still fails, ask the user to close any Chrome of that profile by hand.

**Login expired** (`session <domain>` says `guest`, or the login screen appears).

**By default, the user logs in.** Open the login page in the lane, tell them which lane and site, and wait until they say it is done; then check with `session <domain>` and carry on. Do not type passwords yourself unless the user explicitly asks you to.

⚠️ **Google is special:** it detects `--remote-debugging-port` and blocks the login ("This browser or app may not be secure"). There, STOP: **close that lane's processes yourself** (the `LAUNCH_TIMEOUT` block; closing the window is not enough: the lane stays alive without it, and a Chrome without debugging would open inside it) and ask the user this, with the real paths filled in:

> 1. Open Chrome **without** debugging: `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="<lane profile folder>" --profile-directory=Default`
> 2. Log in to Google with that lane's account — password + 2FA — and close Chrome.
> 3. Tell me and I will relaunch the lane; the login stays saved in that profile.

Check a login without opening anything with `session <domain>`. **Never** use `--headless`: the user needs to see the window to log in.

**The lane answers but no window is visible**: normal, it starts without one (section 1). Do not restart it; `use new:` opens it.

**`unknown desktop`** when opening a tab (only with `virtualDesktops` on). `virtual-desktop.ps1` needs two things: the `UserPromptSubmit` hook in `~/.claude/settings.json` (it notes the focused window in `%LOCALAPPDATA%\browser-cdp\desktops\<session_id>.json`) and the PowerShell module `VirtualDesktop` (MScholtes). Run `powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}\scripts\virtual-desktop.ps1" -Action prepare -Port <port>` and read `reason`: if the module is missing, `Install-Module VirtualDesktop -Scope CurrentUser`; if it fails after a Windows update, `Update-Module VirtualDesktop`.

## 7. Safety

- NEVER press buttons that publish/send/pay irreversibly unless the user explicitly asked for it. When in doubt, stop and ask.
- **Switching accounts or logging out also counts as irreversible**: the logged-in session is all the lane is worth; on Google you cannot log back in yourself (section 6) and elsewhere it costs credentials and a second factor. Not even «just to see which accounts there are», nor by **navigating to a logout URL** to test a theory: that logs out too.
- That is why `--dialog accept` is opt-in: the "Are you sure you want to delete?" is cancelled by default.
- **Never fire synthetic events (`dispatchEvent`, `element.click()`, `requestSubmit()`) on an element found by text without first checking that it is unique and which one it is.** An `eval` skips the `@text` protection and does not warn. If a button «does nothing», diagnose through the network (`Network.enable`) and hidden iframes before trying blind clicks — an ambiguous «Edit» once ended up pressing the «Submit» of an irreversible tax form.
- The "saved as draft" / "Changes saved" state is the right end of every form unless told otherwise.
