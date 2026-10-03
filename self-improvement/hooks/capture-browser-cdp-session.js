'use strict'
/**
 * SessionEnd hook: saves the sessions in which the browser-cdp skill was used, for the weekly
 * optimizer (part of the OPTIONAL self-improvement loop).
 *
 * It is declared in ~/.claude/settings.json, so it runs when ANY session ends and the script itself
 * decides whether that session matters. (Declaring it in the skill's frontmatter would be more
 * elegant, but SessionEnd only runs hooks from settings files, managed policy and plugins.)
 *
 * Discarding an unrelated session costs milliseconds: lines are searched for the substring
 * `browser-cdp` and only those are parsed as JSON. When the session counts, it writes into
 * pending-sessions/ what the weekly optimizer consumes:
 *
 *   raw/<date>_<id>.jsonl     The complete transcript — internal reasoning, every tool call, every
 *                             result and every error — with the base64 blobs of screenshots
 *                             replaced by a marker (they are pixels, they add nothing to a text
 *                             analysis and they multiply the size by five).
 *   raw/<date>_<id>.subagents/agent-<id>.jsonl
 *                             The subagents and forks of that session that used the browser, just
 *                             as complete. Claude Code stores them apart (<session>/subagents/), not
 *                             in the main transcript, and without this the optimizer never saw them.
 *   <date>_<id>.md            Readable index of that same session (with one section per subagent),
 *                             so the optimizer can read all the sessions at once, spot where there
 *                             was friction and go down to the raw file only at those points.
 *
 * A session counts if the main conversation or any of its subagents used the skill. Idempotent:
 * resuming a session and closing it again rewrites its files with the most complete version.
 * Silent: SessionEnd cannot block anything, so any error is swallowed and it exits with 0.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

// BROWSER_CDP_SKILL_DIR only exists for tests or a skill installed somewhere else.
const SKILL_DIR = process.env.BROWSER_CDP_SKILL_DIR || path.join(os.homedir(), '.claude', 'skills', 'browser-cdp')
const DEST_DIR = path.join(SKILL_DIR, 'pending-sessions')
const RAW_DIR = path.join(DEST_DIR, 'raw')

// Base64 blobs of screenshots: only very long strings, so real data is never touched.
const B64_RE = /"data"\s*:\s*"[A-Za-z0-9+/]{500,}={0,2}"/g

// Commands that exercise the skill (the script that drives the browser).
const CDP_RE = /cdp\.js/i

// A real run of the CDP client, not a mere mention: either it is invoked with node, or it carries
// the lane flag. That way a session that only talks about the skill (or edits it) does not count.
const RUNS_CDP_RE = /node\s[^\n]*cdp\.js|--lane\b/i

const SLASH = '<command-name>/browser-cdp</command-name>'

// Truncation of long results in the index (the raw file keeps them whole).
const HEAD_CHARS = 2000
const TAIL_CHARS = 800

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
}

function parse(lines) {
  return lines.map(l => { try { return JSON.parse(l) } catch { return null } })
}

/**
 * Was browser-cdp used in this transcript?
 *
 * It looks at the message structure, not at the loose text of the line: the list of available
 * skills names 'browser-cdp' in practically every transcript, so searching the raw string would
 * always say yes. Three signals count: a slash command, a call to the Skill tool, or a shell
 * command that really runs the CDP client.
 */
function usesSkill(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('browser-cdp')) continue
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      const content = (rec.message || {}).content
      if (typeof content === 'string') {
        if (content.includes(SLASH)) return true
        continue
      }
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text') {
          if (String(block.text || '').includes(SLASH)) return true
        } else if (block.type === 'tool_use') {
          const input = block.input || {}
          if (block.name === 'Skill' && input.skill === 'browser-cdp') return true
          const command = String(input.command || '')
          if (command.includes('browser-cdp') && RUNS_CDP_RE.test(command)) return true
        }
      }
    }
  } catch {
    return false
  }
  return false
}

/** Transcripts of the session's subagents and forks: <dir>/<id>/subagents/agent-*.jsonl. */
function subagentsOf(origin) {
  const dir = path.join(path.dirname(origin), path.basename(origin, '.jsonl'), 'subagents')
  try {
    return fs.readdirSync(dir).filter(f => /^agent-.*\.jsonl$/.test(f)).sort().map(f => path.join(dir, f))
  } catch {
    return []
  }
}

/** 'fork: <description>' taken from the .meta.json that Claude Code leaves next to the transcript. */
function describeSubagent(file) {
  try {
    const meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    const type = String(meta.agentType || 'subagent')
    const desc = String(meta.description || '').trim()
    return desc ? `${type}: ${desc}` : type
  } catch {
    return 'subagent'
  }
}

/** Replaces the base64 image blobs with a marker carrying their size. */
function stripBase64(line) {
  return line.replace(B64_RE, m => `"data":"[screenshot omitted: ${Math.floor(m.length / 1024)} KB of base64]"`)
}

/** Atomic write (tmp + rename) of the transcript without the screenshots' pixels. */
function writeRaw(lines, dest) {
  const tmp = dest + '.tmp'
  try {
    fs.writeFileSync(tmp, lines.map(stripBase64).join('\n') + '\n', 'utf8')
    fs.renameSync(tmp, dest)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw e
  }
}

function truncate(text) {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS
  return text.slice(0, HEAD_CHARS) + `\n\n[... ${omitted} characters omitted, complete in the raw file ...]\n\n` + text.slice(-TAIL_CHARS)
}

/** Plain text of a `message.content` (string or list of blocks). */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b && typeof b === 'object' && b.type === 'text').map(b => String(b.text || '')).join('\n')
}

/** The content of a tool_result can be a string or a list of blocks. */
function textOfResult(block) {
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const sub of content) {
      if (!sub || typeof sub !== 'object') continue
      if (sub.type === 'text') parts.push(String(sub.text || ''))
      else if (sub.type === 'image') parts.push('[screenshot]')
    }
    return parts.join('\n')
  }
  return ''
}

function inputSummary(input) {
  for (const key of ['file_path', 'pattern', 'url', 'path', 'command', 'skill', 'prompt']) {
    const v = input[key]
    if (v) return String(v).replace(/\n/g, ' ').slice(0, 160)
  }
  return ''
}

function duration(first, last) {
  if (!first || !last) return '?'
  const s = Math.floor((Date.parse(last) - Date.parse(first)) / 1000)
  if (!Number.isFinite(s)) return '?'
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

/** Body of the index (list of markdown chunks) and its counters. */
function chronology(records, inSubagent = false) {
  const st = { invocations: [], cdpCommands: 0, errors: 0, interruptions: 0, models: new Set(), version: '', firstTs: null, lastTs: null }
  const pending = new Map()      // tool_use_id -> { tool, command, isCdp }
  const body = []

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    const type = rec.type
    if (rec.version) st.version = rec.version
    if (rec.timestamp) {
      if (st.firstTs === null) st.firstTs = rec.timestamp
      st.lastTs = rec.timestamp
    }
    // Subagent messages are marked so they are not mistaken for the main thread (inside a
    // subagent's own section the mark is redundant: everything is).
    const side = rec.isSidechain && !inSubagent ? ' *(subagent)*' : ''

    if (type === 'user') {
      const content = (rec.message || {}).content

      // Tool results: paired with their call. The same message can also carry text (an interruption
      // during a tool arrives as tool_result + "[Request interrupted…]"), so it is read below too.
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue
          const call = pending.get(block.tool_use_id) || { tool: 'tool', command: '', isCdp: false }
          pending.delete(block.tool_use_id)
          const failed = !!block.is_error
          const output = textOfResult(block).trim()
          if (failed) st.errors++
          if (call.isCdp || failed) body.push(`<!-- ${failed ? 'ERROR' : 'output'} -->\n\`\`\`\n${truncate(output) || '(empty)'}\n\`\`\`\n`)
        }
      }

      const text = textOf(content).trim()
      if (!text || rec.isMeta) continue

      // Explicit invocation of the skill by slash command.
      if (text.includes(SLASH)) {
        st.invocations.push('slash command /browser-cdp')
        const arg = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)
        body.push(`\n## [SKILL] Invoked with /browser-cdp${side}\n\n${arg ? arg[1].trim() : ''}\n`)
        continue
      }
      if (text.startsWith('<command-name>') || text.startsWith('<local-command')) continue

      // The user cutting Claude off mid-action is the most valuable friction signal in the
      // transcript: it is labelled apart so it is not mistaken for a request nor lost in the noise.
      if (text.startsWith('[Request interrupted')) {
        st.interruptions++
        body.push(`\n## [INTERRUPTED BY THE USER]${side}\n`)
        continue
      }
      if (text.startsWith('<task-notification') || text.startsWith('<system-reminder')) {
        body.push('\n> *(system notice)*\n')
        continue
      }
      body.push(`\n## [USER]${side}\n\n${truncate(text)}\n`)
    } else if (type === 'assistant') {
      const msg = rec.message || {}
      if (msg.model) st.models.add(msg.model)
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text') {
          const text = String(block.text || '').trim()
          if (text) body.push(`\n## [CLAUDE]${side}\n\n${truncate(text)}\n`)
        } else if (block.type === 'tool_use') {
          const name = block.name || '?'
          const input = block.input || {}
          if (name === 'Skill' && input.skill === 'browser-cdp') {
            st.invocations.push('Skill tool')
            body.push(`\n## [SKILL] Loaded by Claude${side}\n`)
            pending.set(block.id, { tool: 'Skill', command: '', isCdp: false })
            continue
          }
          const command = input.command || ''
          const isCdp = !!(command && CDP_RE.test(command))
          if (isCdp) {
            st.cdpCommands++
            body.push(`\n### [CDP #${st.cdpCommands}]${side}\n\n\`\`\`powershell\n${String(command).trim()}\n\`\`\`\n`)
          } else {
            body.push(`\n> \`${name}\` ${inputSummary(input)}\n`)
          }
          pending.set(block.id, { tool: name, command, isCdp })
        }
      }
    }
  }
  return { body, st }
}

function buildIndex(records, payload, base, rawDest, origin, captured, subDir) {
  const { body, st } = chronology(records)
  const sections = []
  let subCdp = 0, subErr = 0
  for (const { name, description, records: subRecords } of captured) {
    const { body: subBody, st: subSt } = chronology(subRecords, true)
    subCdp += subSt.cdpCommands
    subErr += subSt.errors
    sections.push([
      '', '---', '',
      `# Subagent \`${name.replace(/\.jsonl$/, '')}\` — ${description}`,
      '',
      '| | |',
      '|---|---|',
      `| cdp.js commands | ${subSt.cdpCommands} |`,
      `| Results with errors | ${subSt.errors} |`,
      `| Duration | ${duration(subSt.firstTs, subSt.lastTs)} |`,
      `| Raw | \`raw/${path.basename(subDir)}/${name}\` |`,
      '',
    ].join('\n') + subBody.join(''))
  }

  const header = [
    `# Session ${base}`,
    '',
    '| | |',
    '|---|---|',
    `| Session | \`${payload.session_id || '?'}\` |`,
    `| Date | ${st.firstTs || '?'} |`,
    `| Duration | ${duration(st.firstTs, st.lastTs)} |`,
    `| Directory | \`${payload.cwd || ''}\` |`,
    `| End reason | \`${payload.reason || '?'}\` |`,
    `| Claude Code | ${st.version || '?'} |`,
    `| Model | ${[...st.models].sort().join(', ') || '?'} |`,
    `| Skill invoked via | ${[...new Set(st.invocations)].sort().join(', ') || '(no explicit invocation recorded)'} |`,
    `| cdp.js commands | ${st.cdpCommands} |`,
    `| Results with errors | ${st.errors} |`,
    `| Times the user interrupted Claude | ${st.interruptions} |`,
  ]
  if (captured.length)
    header.push(`| Subagents using the browser | ${captured.length} (${subCdp} cdp.js commands, ${subErr} results with errors; sections at the end) |`)
  header.push(
    `| Original transcript | \`${origin}\` |`,
    '',
    `> Full detail (internal reasoning included) in \`raw/${path.basename(rawDest)}\`` +
      (captured.length ? `; the subagents', in \`raw/${path.basename(subDir)}/\`` : '') + '.',
    '',
    '---',
  )
  return header.join('\n') + '\n' + body.join('') + sections.join('') + '\n'
}

function main() {
  // Heartbeat: touched EVERY time the hook gets to run, also when it decides not to capture, so the
  // weekly run can tell «there were no sessions of the skill» from «the hook has not even started
  // for weeks» (e.g. because node disappeared from the PATH).
  try {
    fs.mkdirSync(DEST_DIR, { recursive: true })
    fs.writeFileSync(path.join(DEST_DIR, '.last-heartbeat'), new Date().toISOString())
  } catch {}

  // The weekly run exports this variable before launching its claude -p: that session runs cdp.js
  // to check it ("node .../cdp.js help") and, without this early exit, the hook would capture it as
  // real use and the optimizer would end up analysing its own analyses week after week.
  if (process.env.BROWSER_CDP_NO_CAPTURE) return

  let payload
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '').trim()) } catch { return }

  const transcript = payload.transcript_path
  const sessionId = payload.session_id || 'unknown'
  if (!transcript || !fs.existsSync(transcript)) return
  const origin = transcript

  // Fast exit: the vast majority of sessions never touch this skill. Subagents count even if the
  // main conversation did not use it (a fork driving the browser while the main thread coordinates).
  const mainUses = usesSkill(origin)
  let subagents = subagentsOf(origin).filter(usesSkill)
  if (!mainUses && !subagents.length) return

  let lines
  try { lines = readLines(origin) } catch { return }
  if (!lines.length) return
  const records = parse(lines)

  // --- File name: date of the first message + short session id ---
  let date = null
  for (const rec of records) {
    if (rec && typeof rec === 'object' && rec.timestamp) { date = String(rec.timestamp).slice(0, 10); break }
  }
  if (!date) date = new Date().toISOString().slice(0, 10)
  const base = `${date}_${String(sessionId).slice(0, 8)}`

  try { fs.mkdirSync(RAW_DIR, { recursive: true }) } catch { return }

  // --- 1. Complete raw transcript, without the screenshots' pixels ---
  const rawDest = path.join(RAW_DIR, `${base}.jsonl`)
  try { writeRaw(lines, rawDest) } catch { return }

  // --- 1b. Raw transcripts of the subagents that used the browser ---
  const subDir = path.join(RAW_DIR, `${base}.subagents`)
  const captured = []
  if (subagents.length) {
    try { fs.mkdirSync(subDir, { recursive: true }) } catch { subagents = [] }
  }
  for (const sub of subagents) {
    try {
      const subLines = readLines(sub)
      writeRaw(subLines, path.join(subDir, path.basename(sub)))
      captured.push({ name: path.basename(sub), description: describeSubagent(sub), records: parse(subLines) })
    } catch {}
  }
  // Leftovers of an earlier capture of this same session that no longer apply.
  if (fs.existsSync(subDir)) {
    const current = new Set(captured.map(c => c.name))
    for (const f of fs.readdirSync(subDir)) {
      if (!current.has(f)) { try { fs.rmSync(path.join(subDir, f), { force: true }) } catch {} }
    }
    if (!current.size) { try { fs.rmdirSync(subDir) } catch {} }
  }

  // --- 2. Readable index ---
  try {
    const md = buildIndex(records, payload, base, rawDest, origin, captured, subDir)
    const mdDest = path.join(DEST_DIR, `${base}.md`)
    fs.writeFileSync(mdDest + '.tmp', md, 'utf8')
    fs.renameSync(mdDest + '.tmp', mdDest)
  } catch {}
}

if (require.main === module) {
  try { main() } catch {}
  process.exit(0)
}

module.exports = { usesSkill, subagentsOf, chronology, buildIndex, stripBase64, main, paths: { SKILL_DIR, DEST_DIR, RAW_DIR } }
