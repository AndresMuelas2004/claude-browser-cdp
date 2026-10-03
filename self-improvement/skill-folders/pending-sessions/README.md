# Pending sessions

The Claude Code sessions in which the browser-cdp skill was used land here automatically. They are
written by the `SessionEnd` hook in `~/.claude/settings.json`
(`hooks/capture-browser-cdp-session.js`): it runs when any session ends, and the script itself
detects whether that session, or one of its subagents, invoked the skill or really ran `cdp.js`.
Only then does it write here — when the session ends, not while it is being used.

Each session leaves:

| | |
|---|---|
| `<date>_<id>.md` | Readable chronology: what was asked, what Claude answered, every browser command with its output, the errors and the times the user cut Claude off. At the end, one section per subagent or fork that used the browser. |
| `raw/<date>_<id>.jsonl` | That same session, complete, internal reasoning included. Only the screenshots' pixels are removed. |
| `raw/<date>_<id>.subagents/` | The subagents and forks of that session that used the browser, just as complete (only if there were any). |

Once a week the scheduled task launches the `browser-cdp-optimizer` agent in batches of 15
sessions, oldest first. Each batch reads them, improves the skill with what it learns and leaves its
entry in `../improvement-log/`; then that batch's sessions are deleted: they have done their job.

**Keep this folder out of version control** — these are complete transcripts of browsing with
logged-in sessions, and they weigh megabytes.

**You do not need to touch anything here.** If you delete a file by hand, that session simply will
not be taken into account.
