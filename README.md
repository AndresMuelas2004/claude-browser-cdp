# claude-browser-cdp

**Let Claude Code drive your real, logged-in Chrome** — directly over the Chrome DevTools Protocol,
with zero dependencies — **plus an optional loop that improves the skill every week from your own
sessions.**

> **Windows only** · Node.js ≥ 22 · Google Chrome · [Claude Code](https://code.claude.com/docs)

Ask Claude *"use my browser to download last month's invoice"* and it opens a tab in a Chrome
profile where you are already logged in, reads the page, clicks, fills forms, uploads files, scrapes
tables or takes pixel-exact screenshots — without installing an MCP server or any package.

## What's in this repository

Two independent parts. **Part 1 is the skill; Part 2 is optional.** Install only the first, or both.

| | Part 1 — the skill `browser-cdp` | Part 2 — self-improvement (optional) |
|---|---|---|
| **What it does** | Claude drives your Chrome on sites where you are logged in: navigate, click, type, upload files, scrape tables, exact mobile/desktop screenshots, multi-step flows. | Saves the sessions where the skill was used and, once a week, an agent studies them and improves the skill's instructions and code, keeping a log of every change. |
| **You need** | Node.js 22+, Chrome | Part 1 + a Windows scheduled task. It spends some of your Claude plan every week. |
| **Lives in** | [`skill/browser-cdp/`](skill/browser-cdp) | [`self-improvement/`](self-improvement) |
| **Read more** | [docs/how-it-works.md](docs/how-it-works.md) | [docs/self-improvement.md](docs/self-improvement.md) |

## Install (guided, recommended)

1. Clone the repository and open Claude Code inside it:

   ```powershell
   git clone https://github.com/AndresMuelas2004/claude-browser-cdp.git
   cd claude-browser-cdp
   claude
   ```

2. Say **"install this"**. Claude follows [`CLAUDE.md`](CLAUDE.md): it explains both parts, lets
   you choose, asks a few questions and sets everything up for you:
   - **Which parts** you want (skill only, or skill + self-improvement).
   - **Your lanes**: one per Chrome account you want Claude to use (a short name, the account, a
     port and a profile folder).
   - Whether you use several **Windows virtual desktops** (optional extra).
   - **Who logs in** when a site asks for it: you (default), or Claude using a password manager you
     already use with Claude Code.
   - For self-improvement: when the weekly run should happen.

It never overwrites your files or your `settings.json` without showing you the change first.

## Install by hand

**Part 1 — the skill**

1. Copy `skill/browser-cdp` to `%USERPROFILE%\.claude\skills\browser-cdp`.
2. Edit `lanes.json` there (one entry per Chrome account; see
   [docs/how-it-works.md](docs/how-it-works.md#lanes)) and the lanes table in section 1 of
   `SKILL.md` to match.
3. If you downloaded a ZIP instead of cloning, unblock the scripts:
   `Get-ChildItem -Recurse "$env:USERPROFILE\.claude\skills\browser-cdp" | Unblock-File`
4. Check it: `node "$env:USERPROFILE\.claude\skills\browser-cdp\scripts\cdp.js" lanes`
5. Log in once in each lane (see [Logging in](docs/how-it-works.md#logging-in)).
6. Optional: [virtual desktops](docs/how-it-works.md#virtual-desktops-optional).

**Part 2 — self-improvement:** follow [docs/self-improvement.md](docs/self-improvement.md#installing-it).

## Use it

In any Claude Code session:

- *"Use my browser and check whether my order has shipped."*
- *"Connect to my Chrome (work lane) and download the latest invoice from the billing page."*
- *"Open my Google Cloud console and enable the Drive API for this project."*
- *"Take an exact 1080x1920 mobile screenshot of my landing page."*
- *"Scrape every row of this table into a CSV."*
- or `/browser-cdp work download the latest invoice`

By design the skill **only starts when you explicitly ask for your browser**: it is acting with your
logged-in accounts. If you would rather let Claude use it on its own, change the `description` in
`SKILL.md`.

## Make it yours

| To change | Edit |
|---|---|
| Accounts, ports, profile folders, default lane | `lanes.json` (+ the table in `SKILL.md` §1) |
| Who logs in when a session expires | `SKILL.md` §6 |
| When the skill triggers | `description` / `when_to_use` in `SKILL.md` |
| Rules Claude follows on tricky sites | `SKILL.md` §5 — or let Part 2 grow them for you |

Or just ask Claude Code, from this folder: *"I want to add a lane for my second Google account."*

## Safety and privacy

- Claude acts in a browser where **you are logged in**. The skill is built to be careful —
  irreversible buttons only when you asked, "Are you sure?" dialogs dismissed by default, ambiguous
  targets refused, passwords never printed — but stay in charge of what you ask for, especially on
  sites that can send, publish or pay. See [the built-in rules](docs/how-it-works.md#safety-rules-built-in).
- Each lane is a **separate Chrome profile**: your everyday Chrome is never touched.
- Part 2 keeps **full transcripts on your disk** until they are analysed (then deletes them) and
  uses your Claude plan once a week. Read [cost and privacy](docs/self-improvement.md#cost-and-privacy--read-before-enabling)
  before enabling it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `LAUNCH_TIMEOUT` | A Chrome **without** debugging is holding that lane's profile (often a login window left open). Close it and retry. |
| Google says *"This browser or app may not be secure"* | Log in to Google once with that profile opened without debugging: [Logging in](docs/how-it-works.md#logging-in). |
| `Node … has no built-in WebSocket` | Install Node.js 22 or newer. |
| Scripts blocked by the execution policy | `Unblock-File` (see above); the hooks already run PowerShell with `-ExecutionPolicy Bypass`. |
| The tab opens on the wrong virtual desktop | See "unknown desktop" in `SKILL.md` §6. |

## Updating

Pull the repository and copy the files again, **keeping your `lanes.json`** and any changes you or
Part 2 made to `SKILL.md` and `scripts/` (compare before overwriting: with Part 2 on, your copy
evolves on its own).

## License

[MIT](LICENSE)
