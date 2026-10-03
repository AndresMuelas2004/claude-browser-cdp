# The self-improvement loop (optional)

The skill works perfectly well on its own. This optional add-on makes it **learn from your own
sessions**: every week an agent reads how the skill was actually used, finds where it failed or
wasted steps, and improves `SKILL.md` and `cdp.js` — with tests, conservative rules and a written
log of every change.

```
 your Claude Code sessions
          │  (session ends)
          ▼
 SessionEnd hook ── capture-browser-cdp-session.js ──►  pending-sessions/
   (did this session or its subagents use the skill?)      <date>_<id>.md        readable index
                                                            raw/<date>_<id>.jsonl full transcript
                                                            raw/<date>_<id>.subagents/
          │
          │  once a week (Windows scheduled task)
          ▼
 weekly-browser-cdp-improvement.ps1
   ├─ batches of 15 sessions, oldest first
   ├─ claude -p --agent browser-cdp-optimizer   (watched: cut after 30 min idle)
   ├─ integrity checks of the scripts after each batch
   ├─ deletes a batch's sessions only if it ended OK and wrote its improvement-log entry
   └─ log + Windows notification
          │
          ▼
 improved SKILL.md / scripts  +  improvement-log/<date>_<summary>.md
```

## The pieces

| File | Installed at | Role |
|---|---|---|
| `self-improvement/hooks/capture-browser-cdp-session.js` | `~/.claude/hooks/` | `SessionEnd` hook. Decides whether a session used the skill (main thread or any subagent/fork) and, if so, saves it to `pending-sessions/`. Touches `.last-heartbeat` on every run. |
| `self-improvement/agents/browser-cdp-optimizer.md` | `~/.claude/agents/` | The specialist. Reads a batch of sessions, finds patterns, fixes the skill, writes an entry in `improvement-log/`. Never meant to be invoked by hand. |
| `self-improvement/bin/weekly-browser-cdp-improvement.ps1` | `~/.claude/bin/` | The orchestrator the scheduled task runs. It lives outside the skill folder on purpose: the agent may edit the skill, never the mechanism that launches it. |
| `self-improvement/skill-folders/*` | `~/.claude/skills/browser-cdp/` | The `pending-sessions/` and `improvement-log/` folders with their READMEs. |

## Safety nets

- **Integrity checks** after every batch: `node cdp.js help` must work and both `.ps1` scripts must
  parse. A failure raises an alert and stops the remaining batches.
- **Evidence before deleting**: a batch's sessions are deleted only if the agent exited with code 0
  *and* wrote a new `improvement-log/` entry. Sessions rewritten during the analysis (a resumed
  conversation that ended meanwhile) are kept for next week.
- **Watchdog**: if the agent's transcript is not written for 30 minutes, the run is killed, nothing
  is deleted and you get a notification.
- **Dead-run warning**: if the previous run died halfway (PC shut down, logged off, 6 h limit), its
  lock is still there; the next run says so in the log and in a notification.
- **Heartbeat**: if the capture hook has not run for 8 days, the weekly run warns you — otherwise
  "no sessions" would look like "all good".
- **No self-feeding**: the weekly run sets `BROWSER_CDP_NO_CAPTURE=1`, so the optimizer's own
  session is never captured as usage.
- **Time cap**: no new batch starts after 4.5 hours.

## Cost and privacy — read before enabling

- **It uses your Claude plan.** Each batch is a `claude -p` run with Opus at maximum effort over
  large transcripts. A busy week can mean several batches. Change `-Model`/`-Effort` in the task's
  command line if you want it cheaper.
- **Full transcripts are stored locally** in `pending-sessions/` until analysed — including what was
  on screen in logged-in sites. They are deleted after a successful batch. If you version
  `~/.claude` with git, **exclude that folder** (see below).
- The agent is told not to copy personal data into `SKILL.md` or the log, and to describe patterns
  in the abstract.

## Installing it

The guided install (`CLAUDE.md`) does all of this for you. By hand:

1. Install the skill first (Part 1 of the README).
2. Copy the files to the places in the table above, and create
   `~/.claude/skills/browser-cdp/pending-sessions/` and `.../improvement-log/` from
   `self-improvement/skill-folders/`.
3. Add the hook to `~/.claude/settings.json` (merge it with any `SessionEnd` hooks you already
   have; use your real home path):

   ```json
   {
     "hooks": {
       "SessionEnd": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "node",
               "args": ["C:\\Users\\YOU\\.claude\\hooks\\capture-browser-cdp-session.js"],
               "timeout": 60
             }
           ]
         }
       ]
     }
   }
   ```

   `SessionEnd` hooks get only 1.5 s by default; the `"timeout": 60` raises that budget so long
   sessions can be saved.

4. Create the weekly scheduled task (PowerShell, as your normal user — no admin needed):

   ```powershell
   $script   = "$env:USERPROFILE\.claude\bin\weekly-browser-cdp-improvement.ps1"
   $action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
   $trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
   $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 6) `
                 -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
   Register-ScheduledTask -TaskName 'Claude - browser-cdp weekly improvement' -Action $action -Trigger $trigger `
       -Settings $settings -Description 'Improves the browser-cdp skill from the sessions where it was used.'
   ```

   It runs only while you are logged in (so notifications can show). If the PC is off at that time,
   `StartWhenAvailable` runs it at the next opportunity. **Do not shut down the PC while it runs**:
   a batch cut halfway is retried next week, but its work is lost.

5. If you version `~/.claude` with git, add to its `.gitignore`:

   ```gitignore
   /skills/browser-cdp/pending-sessions/
   /skills/browser-cdp/**/.cdp-*.json
   /bin/browser-cdp-improvement.log
   ```

## Day to day

- **Log**: `~/.claude/bin/browser-cdp-improvement.log` (each batch's summary, in plain language).
- **What changed**: `~/.claude/skills/browser-cdp/improvement-log/`.
- **Run it now**: `Start-ScheduledTask -TaskName 'Claude - browser-cdp weekly improvement'`.
- **Pause it**: `Disable-ScheduledTask -TaskName 'Claude - browser-cdp weekly improvement'`.
- **Remove it**: `Unregister-ScheduledTask -TaskName 'Claude - browser-cdp weekly improvement' -Confirm:$false`,
  remove the `SessionEnd` entry from `settings.json`, and delete the hook, agent and script files.

## Known limits

- Sessions that end abruptly (PC shut down or terminal killed with Claude open) never fire
  `SessionEnd`, so they are not captured.
- The optimizer only sees what happened in the transcripts: problems you noticed but never told
  Claude about cannot be learned.
