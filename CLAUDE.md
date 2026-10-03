# Instructions for Claude Code in this repository

This repository holds **`browser-cdp`**, a Claude Code skill that drives the user's real, logged-in
Chrome over the Chrome DevTools Protocol, plus an **optional self-improvement loop**. Someone who
opens Claude Code here almost always wants to **install it and make it their own**. Guide them with
the steps below. Talk to them in their language (these docs are in English; reply in whatever
language they write in) and in plain words.

## Ground rules

- **Windows only.** If the machine is not Windows, say so and stop; offer to explain what would
  have to be ported (`ensure-chrome.ps1`, `virtual-desktop.ps1`, the weekly task).
- **Never overwrite** anything in `~/.claude` without showing what is there and asking first.
- **`~/.claude/settings.json`**: back it up (`settings.json.bak-browser-cdp`), then *merge* — never
  replace — and show the exact change before writing it. Keep any hooks the user already has.
- Hooks go in **exec form** (`"command"` + `"args"`) with **absolute paths** built from the user's
  real home folder, so no shell quoting or execution policy can break them.
- Tell the user before anything opens a Chrome window.
- Do not invent answers the user did not give: ask.

## 1. Explain the two parts and let them choose

In a few sentences:

- **Part 1 — the skill.** Claude can operate their Chrome on sites where they are logged in. It uses
  separate Chrome profiles ("lanes"), so their everyday browser is never touched. It only starts when
  they explicitly ask for their browser.
- **Part 2 — self-improvement (optional).** Every session where the skill is used is saved locally;
  once a week a Windows scheduled task runs an agent that studies those sessions and improves the
  skill. Mention the two costs: it spends part of their Claude plan every week (Opus, max effort),
  and full transcripts of logged-in browsing stay on disk until analysed.

Ask: **only Part 1, or Parts 1 + 2?** (Use the AskUserQuestion tool if it is available.) They can
add Part 2 later.

## 2. Check the prerequisites

- Windows 10/11 and PowerShell (built in).
- `node --version` must be **22 or newer** (built-in `fetch` and `WebSocket`). If not, offer
  `winget install OpenJS.NodeJS.LTS` and wait for their OK.
- Google Chrome in one of the usual places (`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  the `(x86)` one, or `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`); otherwise ask for the
  path and put it in `chromePath`.
- For Part 2: where `claude` lives (`(Get-Command claude).Source`); the weekly script finds it the
  same way.

## 3. Personalise the lanes

Ask, and explain why each matters:

1. **How many Chrome accounts** should Claude be able to use? One lane per account.
2. For each lane:
   - a **short name**, lowercase, no spaces (`personal`, `work`…) — it is what goes after `--lane`;
   - the **account** (an email or any label; only informative);
   - a **port**: suggest 9222, 9223, … and check it is free
     (`Get-NetTCPConnection -LocalPort <port> -ErrorAction SilentlyContinue`);
   - a **profile folder**: default `%LOCALAPPDATA%\browser-cdp\profiles\<name>`. It must be a folder
     of its own: Chrome locks a profile folder while it is open, so their everyday profile cannot be
     reused while they use their normal Chrome. A fresh folder plus logging in once is the way.
3. **Which lane is the default** (used when they do not name one).
4. **Virtual desktops**: do they work with several Windows virtual desktops and want new tabs to
   open on the desktop of the Claude session? (Default: no.)
5. **Who logs in** when a site asks for it:
   - (a) **they do** (default): Claude opens the login page and waits for them;
   - (b) **Claude does**, using a password manager they already use with Claude Code (ask for the
     skill or MCP name). Then use the template at the end of this file.

## 4. Install Part 1

1. Copy `skill/browser-cdp` to `~/.claude/skills/browser-cdp`. If it already exists, ask: back it up
   and replace, or stop.
2. Write `~/.claude/skills/browser-cdp/lanes.json` with their answers (`defaultLane`, `lanes`,
   `virtualDesktops`, `chromePath`). Keep `%LOCALAPPDATA%`-style paths: they are expanded at runtime.
3. Make the **lanes table in `SKILL.md` §1** match `lanes.json`: one row per lane, the default marked,
   flag `--lane <name>`.
4. If they chose login policy (b), replace the paragraph in `SKILL.md` §6 (template below).
5. Unblock the files (needed if the repo came as a ZIP):
   `Get-ChildItem -Recurse "$env:USERPROFILE\.claude\skills\browser-cdp" | Unblock-File`
6. Verify: `node "$env:USERPROFILE\.claude\skills\browser-cdp\scripts\cdp.js" help` and `… lanes`
   (lanes showing `down` is fine: they start on demand).
7. **Virtual desktops** (only if they said yes):
   - with their OK, `Install-Module VirtualDesktop -Scope CurrentUser` (PowerShell may ask to trust
     the gallery: they answer);
   - set `"virtualDesktops": true` in `lanes.json`;
   - merge this hook into `settings.json` (real path):
     ```json
     { "hooks": { "UserPromptSubmit": [ { "hooks": [ {
       "type": "command", "command": "powershell.exe",
       "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                "C:\\Users\\THEM\\.claude\\skills\\browser-cdp\\scripts\\virtual-desktop.ps1", "-Action", "note"],
       "timeout": 20, "async": true } ] } ] } }
     ```
   - check: `powershell -NoProfile -ExecutionPolicy Bypass -File "<skill>\scripts\virtual-desktop.ps1" -Action prepare -Port <port>`
     returns a `desktop` (it can only find this session's window from the next prompt on, once the
     hook has run).
8. **First login in each lane.** Explain, then let them do it: open Chrome *without* debugging on
   that lane's profile, log in to Google and to the sites they plan to use, and close every window
   of it:
   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="<expanded profile folder>" --profile-directory=Default
   ```
   (Google refuses logins in a browser started with a debugging port; other sites could also be
   logged in later through the lane itself.) Then test with
   `node "<skill>\scripts\cdp.js" --lane <name> session google`.

## 5. Install Part 2 (only if chosen)

1. Copy:
   - `self-improvement/hooks/capture-browser-cdp-session.js` → `~/.claude/hooks/`
   - `self-improvement/agents/browser-cdp-optimizer.md` → `~/.claude/agents/`
   - `self-improvement/bin/weekly-browser-cdp-improvement.ps1` → `~/.claude/bin/`
   - `self-improvement/skill-folders/pending-sessions/` and `…/improvement-log/` →
     `~/.claude/skills/browser-cdp/`
2. Merge the `SessionEnd` hook into `settings.json` (real path; `node` must be in the PATH):
   ```json
   { "hooks": { "SessionEnd": [ { "hooks": [ {
     "type": "command", "command": "node",
     "args": ["C:\\Users\\THEM\\.claude\\hooks\\capture-browser-cdp-session.js"],
     "timeout": 60 } ] } ] } }
   ```
3. Ask **when** the weekly run should happen (default: Sunday 03:00, while the PC is usually on and
   unused) and register the task with the commands in
   [docs/self-improvement.md](docs/self-improvement.md#installing-it), adjusting `-DaysOfWeek`/`-At`.
   If they want a cheaper model, append `-Model sonnet` (and/or `-Effort high`) after the script path
   in the task's `-Argument`.
4. If `~/.claude` is a git repository, add the `.gitignore` lines from that same section.
5. Tell them how to see it working: after this session ends,
   `~/.claude/skills/browser-cdp/pending-sessions/.last-heartbeat` appears; the weekly log is
   `~/.claude/bin/browser-cdp-improvement.log`; `Start-ScheduledTask -TaskName 'Claude - browser-cdp weekly improvement'`
   runs it now. And to leave the PC on while it runs.

## 6. Finish

Summarise what was installed and where, and how to use it: *"use my browser to …"*, *"connect to my
Chrome (work lane) and …"*, or `/browser-cdp <lane> <task>`. Remind them that the skill only starts
when they ask for their browser.

## Later requests

- **Add / change a lane**: edit `lanes.json` and the table in `SKILL.md` §1, then do the first login
  for the new lane (step 4.8).
- **Add Part 2 later**: step 5.
- **Uninstall**: delete `~/.claude/skills/browser-cdp`; for Part 2 also the hook, agent and script,
  the `SessionEnd`/`UserPromptSubmit` entries in `settings.json`, and the task
  (`Unregister-ScheduledTask -TaskName 'Claude - browser-cdp weekly improvement' -Confirm:$false`).
  The lane profiles stay in `%LOCALAPPDATA%\browser-cdp\profiles` until they delete them.

## Template — login with a password manager (`SKILL.md` §6)

Replace the paragraph that starts with **"By default, the user logs in."** with this, filling in the
names:

> **By default, you log in.** The credentials are in <PASSWORD MANAGER> (<skill `name` / MCP
> `name`>): fetch the user and password, fill them in and log in. If the form resets without an
> error message, it was a failed attempt, not a wall: retry before giving up. Only the second
> factor, when the entry has no TOTP, is asked from the user — and you ask for **the code**, not for
> them to do the whole login.

## Working on the repository itself

If instead of installing the user wants to change the code here: `node --check` and
`node skill/browser-cdp/scripts/cdp.js help` must pass after any change to `cdp.js`; parse the
`.ps1` files with `[System.Management.Automation.Language.Parser]::ParseFile()` (never run
`ensure-chrome.ps1` just to test: it launches Chrome); keep `SKILL.md` around 15 KB.
