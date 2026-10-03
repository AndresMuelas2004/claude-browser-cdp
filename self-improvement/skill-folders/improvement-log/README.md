# Improvement log of browser-cdp

A record of every batch of the weekly optimizer, one file per batch: `<date>_<short-summary>.md`
(e.g. `2026-08-23_regex-filters.md`), with which sessions it analysed, what it detected and what it
changed. It exists so improvements are not repeated, earlier ones are not undone, and a problem that
was discarded for lack of evidence can be picked up again when it shows up a second time.

The `browser-cdp-optimizer` agent writes it when it closes each batch; the weekly task checks that a
new entry has appeared before calling the batch good and deleting its sessions.
