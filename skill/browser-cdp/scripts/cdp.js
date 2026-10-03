'use strict'
/**
 * cdp.js — engine of the browser-cdp skill. Drives the dedicated Chrome of each "lane": a Chrome
 * profile with its own logins and its own remote-debugging port, as configured in ../lanes.json.
 *
 * ZERO dependencies: it uses the built-in `fetch` and `WebSocket` of Node >= 22, so there is no
 * `npm i` and nothing to copy anywhere. The skill calls it directly:
 *
 *   node "<skill dir>\scripts\cdp.js" <command> [args]
 *
 * Lane: --lane <name> (or CDP_LANE), or --port <n> (or CDP_PORT); with neither, the default lane.
 * Tab: one is pinned per session (file .cdp-<port>.json in CDP_PIN_DIR, or in the cwd) so a session
 * never steps on the tabs of other Claude sessions or on the user's own.
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const vm = require('vm')

// ───────────────────────────── CLI ─────────────────────────────

// Value-less flags: they never consume the next token (otherwise `--json snap` would read json="snap").
const BOOL_FLAGS = new Set(['json', 'all', 'hidden', 'mobile', 'full', 'keys', 'dom', 'idle', 'new', 'page', 'help'])

function parseArgs(argv) {
  const rest = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { rest.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (!BOOL_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) { flags[key] = next; i++ }
      else flags[key] = true
    } else rest.push(a)
  }
  return { rest, flags }
}

const USAGE = `cdp.js — browser automation over CDP (no MCP, no dependencies)

  lanes                           configured lanes (lanes.json), which one is the default, which are up
  tabs [--all]                    lists the lane's tabs (--all includes iframes/workers)
  use <n|url-text|new:URL>        pins this session's tab (new: opens a new one)
  goto <url> [--new]              navigates the pinned tab and waits for it to load
  snap [--filter re] [--max n]    compact inventory of interactive elements (numbers them)
       [--hidden] [--all] [--page] --hidden includes hidden ones; --all does not cut at 80;
                                  --page ignores the open modal and inventories the whole page
  text [sel] [--max n] [--grep re] visible text of the page or of a container
  table <sel> [--max n]           dumps a table/list of rows as TSV
  session [domain]                does the lane have a live login? (key cookies and expiry; needs no tab)
  click <#n|sel|@text>            robust click (real -> DOM fallback if an overlay covers it)
  fill <#n|sel|@text> <value>     types into a field (--keys = real typing, key by key)
  press <Key|Ctrl+A> [--times n]  Enter, Tab, Escape, ArrowDown, a single letter, Shift+Tab...
  upload <#n|sel> <file...>       setFileInputFiles on an input[type=file] (even if hidden)
  pick <#n|sel|@text> <file...>   clicks a button and intercepts its file dialog
  shot <out.png> [--mobile]       screenshot (--mobile = 1080x1920; --px 1080x1920; --dsf 2; --full;
                                  --sel <selector>; --quality 80 = JPEG instead of PNG)
  eval <expr|@file.js>            runs JS in the page and prints the result
  wait [--text t|--sel s|--gone s|--idle] [--timeout ms]   (--sel/--gone: #n, @text or CSS)
  run <script.js>                 runs a multi-step script with the API already connected
  close                           closes the pinned tab

--filter and --grep match by substring or by regex (case-insensitive): "Save|Send".

Global: --lane <name> (or CDP_LANE) · --port <n> (or CDP_PORT) · --frame <url-substring> · --json
        --dialog accept [--dialog-text t]  accepts alert/confirm/prompt instead of dismissing them`

// ───────────────────────────── lanes ─────────────────────────────

const LANES_FILE = path.join(__dirname, '..', 'lanes.json')
let CONFIG = null

/** lanes.json, read once. Without the file there is a single default lane, so it works out of the box. */
function config() {
  if (CONFIG) return CONFIG
  let cfg = {}
  if (fs.existsSync(LANES_FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(LANES_FILE, 'utf8').replace(/^﻿/, '')) }
    catch (e) { throw new Error(`lanes.json is not valid JSON (${e.message}): fix ${LANES_FILE}`) }
  }
  const lanes = (Array.isArray(cfg.lanes) && cfg.lanes.length ? cfg.lanes
    : [{ name: 'main', port: 9222, profileDir: '%LOCALAPPDATA%\\browser-cdp\\profiles\\main' }])
    .map(l => ({ ...l, name: String(l.name), port: Number(l.port) }))
  CONFIG = { lanes, defaultLane: cfg.defaultLane || lanes[0].name, virtualDesktops: cfg.virtualDesktops === true }
  return CONFIG
}

const laneByPort = port => config().lanes.find(l => l.port === port)
const laneLabel = port => { const l = laneByPort(port); return l ? `lane ${l.name}` : 'not a configured lane' }

/** --port > --lane > CDP_PORT > CDP_LANE > the default lane. */
function resolvePort(flags) {
  if (flags.port) return Number(flags.port)
  const name = flags.lane || (!process.env.CDP_PORT && process.env.CDP_LANE) || null
  if (name) {
    const l = config().lanes.find(x => x.name.toLowerCase() === String(name).toLowerCase())
    if (!l) throw new Error(`unknown lane "${name}". Configured lanes: ${config().lanes.map(x => x.name).join(', ')} (see lanes.json)`)
    return l.port
  }
  if (process.env.CDP_PORT) return Number(process.env.CDP_PORT)
  const d = config().lanes.find(x => x.name === config().defaultLane) || config().lanes[0]
  return d.port
}

// ─────────────────────────── CDP client ───────────────────────────

class Conn {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.waiters = []
    this.listeners = new Map()
    ws.onmessage = ev => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.id !== undefined) {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.error) p.rej(new Error(`CDP ${p.method}: ${m.error.message}${m.error.data ? ' — ' + m.error.data : ''}`))
        else p.res(m.result)
        return
      }
      for (const w of [...this.waiters]) {
        if (w.event !== m.method) continue
        if (w.pred && !w.pred(m.params)) continue
        this.waiters.splice(this.waiters.indexOf(w), 1)
        clearTimeout(w.timer)
        w.res(m.params)
      }
      for (const fn of this.listeners.get(m.method) || []) fn(m.params)
    }
    const die = () => {
      const err = new Error('CDP: connection closed by the browser (tab closed?)')
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.rej(err) }
      for (const w of this.waiters) { clearTimeout(w.timer); w.rej(err) }
      this.pending.clear()
      this.waiters.length = 0
    }
    ws.onclose = die
    ws.onerror = die
  }

  static async open(wsUrl, timeout = 10000) {
    if (typeof WebSocket === 'undefined')
      throw new Error(`Node ${process.versions.node} has no built-in WebSocket: Node >= 22 is required`)
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP: timeout opening the WebSocket')), timeout)
      ws.onopen = () => { clearTimeout(t); res() }
      ws.onerror = () => { clearTimeout(t); rej(new Error('CDP: could not open the WebSocket')) }
    })
    return new Conn(ws)
  }

  send(method, params = {}, timeout = 30000) {
    return new Promise((res, rej) => {
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rej(new Error(`CDP ${method}: no response in ${timeout}ms`))
      }, timeout)
      this.pending.set(id, { res, rej, timer, method })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, [])
    this.listeners.get(event).push(fn)
  }

  waitEvent(event, pred, timeout = 30000) {
    return new Promise((res, rej) => {
      const w = { event, pred, res, rej }
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w)
        if (i > -1) this.waiters.splice(i, 1)
        rej(new Error(`CDP: event ${event} did not arrive in ${timeout}ms`))
      }, timeout)
      w.timer.unref()   // the loser of a race (goto waits for two events) must not keep the process alive
      this.waiters.push(w)
    })
  }

  close() { try { this.ws.close() } catch {} }
}

// ─────────────────── tab discovery / pin ───────────────────

const HTTP_TIMEOUT = 4000

async function http(port, path, method = 'GET') {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(HTTP_TIMEOUT) })
  const body = await r.text()
  try { return JSON.parse(body) } catch { return body }
}

function ensureChrome(port) {
  if (!laneByPort(port)) return null            // a port that is not a lane: nothing to launch
  // the launcher lives next to this file: it does not depend on USERPROFILE or on where the skill is
  const ps1 = path.join(__dirname, 'ensure-chrome.ps1')
  if (!fs.existsSync(ps1)) return null
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Port', String(port)],
    { encoding: 'utf8', timeout: 45000, windowsHide: true })
  return String(r.stdout || '').trim().split(/\r?\n/).pop()
}

async function listTargets(port, { autoEnsure = true } = {}) {
  let list
  try {
    list = await http(port, '/json/list')
  } catch (e) {
    if (!autoEnsure) throw e
    const res = ensureChrome(port)
    if (res === 'ALREADY_UP' || res === 'LAUNCHED_UP') {
      warn(`the Chrome of port ${port} was not answering; ensure-chrome -> ${res}`)
      list = await http(port, '/json/list')
    } else {
      throw new Error(
        `CDP port ${port} (${laneLabel(port)}) is not answering ` +
        `(ensure-chrome -> ${res || 'not available'}). See the section «Lane down or login expired» ` +
        `of the browser-cdp skill.`)
    }
  }
  // the port can be taken by another program: it answers, but not with CDP JSON
  if (!Array.isArray(list))
    throw new Error(`port ${port} answers but it is not a CDP endpoint (is another program using it?): ` +
      String(typeof list === 'string' ? list : JSON.stringify(list)).slice(0, 120))
  return list
}

const pinFile = port => path.resolve(process.env.CDP_PIN_DIR || process.cwd(), `.cdp-${port}.json`)

function readPin(port) {
  try { return JSON.parse(fs.readFileSync(pinFile(port), 'utf8')) } catch { return null }
}

/** Refreshes the pin's url/title after navigating, so `tabs` and `close` can tell which tab is yours. */
function updatePin(port, patch) {
  const pin = readPin(port)
  if (!pin) return
  try { fs.writeFileSync(pinFile(port), JSON.stringify({ ...pin, ...patch })) } catch {}
}

function writePin(port, target) {
  const data = { targetId: target.id, wsUrl: target.webSocketDebuggerUrl, url: target.url, title: target.title }
  try { fs.writeFileSync(pinFile(port), JSON.stringify(data)) } catch {}
  return data
}

// ─────────────── new tab on this session's virtual desktop (optional) ───────────────
//
// Only with "virtualDesktops": true in lanes.json. Chrome opens new windows on the ACTIVE virtual
// desktop (wherever the user happens to be looking) and new tabs in the last window it used,
// wherever that is. What we want instead: the tab on the desktop where THIS session's terminal
// lives. If the lane already has a window on that desktop, the tab goes inside it (window.open
// from one of its tabs); otherwise, a new window that virtual-desktop.ps1 moves there.

/** This Claude session's id: the hook notes the window under that name. If the variable were
 *  missing, the scratchpad (CDP_PIN_DIR) carries the id in its path. */
function sessionId() {
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(process.env.CDP_PIN_DIR || '')
  return m ? m[0] : ''
}

/** Calls virtual-desktop.ps1 and returns its JSON, or null if it does not answer (never throws). */
function virtualDesktop(action, port, extra = []) {
  const ps1 = path.join(__dirname, 'virtual-desktop.ps1')
  if (!fs.existsSync(ps1)) return null
  const sid = sessionId()
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
    '-Action', action, '-Port', String(port), ...(sid ? ['-SessionId', sid] : []), ...extra],
    { encoding: 'utf8', timeout: 30000, windowsHide: true })
  const line = String(r.stdout || '').trim().split(/\r?\n/).pop()
  try { return JSON.parse(line) } catch { return null }
}

async function browserConn(port) {
  const v = await http(port, '/json/version')
  return Conn.open(v.webSocketDebuggerUrl)
}

/** The /json/list target with that id (it carries the webSocketDebuggerUrl), polling a little. */
async function targetById(port, targetId) {
  for (let i = 0; i < 20; i++) {
    const t = (await listTargets(port, { autoEnsure: false }).catch(() => [])).find(x => x.id === targetId)
    if (t && t.webSocketDebuggerUrl) return t
    await sleep(150)
  }
  return null
}

/**
 * A tab that lives in one of those lane windows (HWND). The only bridge between an HWND and CDP is
 * the title: the window is titled «<active tab> - Google Chrome». If several tabs with that title
 * sit in different CDP windows there is no way to know which one it is: null.
 */
async function tabOfWindow(bconn, windows) {
  const { targetInfos } = await bconn.send('Target.getTargets')
  const pages = targetInfos.filter(t => t.type === 'page')
  for (const w of windows) {
    const m = /^(.*?) - Google Chrome(?: - .*)?$/.exec(w.title || '')
    const title = m ? m[1] : w.title
    const cands = pages.filter(p => p.title === title)
    if (!cands.length) continue
    const wins = new Set()
    for (const c of cands) {
      const r = await bconn.send('Browser.getWindowForTarget', { targetId: c.targetId }).catch(() => null)
      if (r) wins.add(r.windowId)
    }
    if (wins.size === 1) return cands[0]
  }
  return null
}

/** window.open(url) from `opener`: the new tab lands in the same window. Returns its target or null. */
async function openFrom(bconn, port, opener, url) {
  const conn = await Conn.open(`ws://127.0.0.1:${port}/devtools/page/${opener.targetId}`, 5000).catch(() => null)
  if (!conn) return null
  let ok = false
  try {
    const r = await conn.send('Runtime.evaluate',
      { expression: `!!window.open(${JSON.stringify(url)}, '_blank')`, userGesture: true }, 5000).catch(() => null)
    ok = !!(r && r.result && r.result.value === true)
  } finally { conn.close() }
  if (!ok) return null
  for (let i = 0; i < 20; i++) {
    const { targetInfos } = await bconn.send('Target.getTargets')
    const t = targetInfos.find(x => x.type === 'page' && x.openerId === opener.targetId && x.url !== opener.url)
    if (t) return targetById(port, t.targetId)
    await sleep(150)
  }
  return null
}

/** New tab without looking at desktops: Chrome puts it in its last active window. */
async function newTabViaHttp(port, url) {
  const create = () => http(port, `/json/new?${encodeURIComponent(url)}`, 'PUT').catch(() => null)
  let t = await create()
  if (!t || !t.webSocketDebuggerUrl) {
    // the lane can go down between the listing and the creation (an earlier interrupted call takes
    // down the Chrome it launched itself). This used to die with a bare «fetch failed»; one retry
    // going through ensure-chrome again solves it.
    await sleep(700)
    await listTargets(port)
    t = await create()
  }
  return t
}

/** Creates the tab (on the session's desktop if enabled). Returns { target, placement } (placement: text for the user, or null). */
async function createTab(port, url) {
  await listTargets(port)                        // launches the lane through ensure-chrome if it was down
  if (!config().virtualDesktops) return { target: await newTabViaHttp(port, url), placement: null }
  const prep = virtualDesktop('prepare', port)
  if (!prep || !prep.desktop) {
    warn(`I do not know which desktop this session is on (${(prep && prep.reason) || 'virtual-desktop.ps1 does not answer'}): ` +
      'the tab opens wherever Chrome decides')
    return { target: await newTabViaHttp(port, url), placement: 'unknown desktop' }
  }
  const where = `${prep.desktop.name} (desktop ${prep.desktop.index + 1})`
  const bconn = await browserConn(port)
  try {
    const inSession = prep.windows.filter(w => w.inSession)
    if (inSession.length) {
      const opener = await tabOfWindow(bconn, inSession)
      const t = opener && await openFrom(bconn, port, opener, url)
      if (t) return { target: t, placement: `tab in the window already on ${where}` }
      warn('the lane has a window on this desktop but I cannot identify its tabs; opening a new window')
    }
    const { targetId } = await bconn.send('Target.createTarget', { url, newWindow: true })
    const known = prep.windows.map(w => w.hwnd).join(',')
    const placed = virtualDesktop('place', port, known ? ['-Known', known] : [])
    if (!placed || !placed.moved)
      warn(`new window opened but I could not move it to ${where}: ${(placed && placed.reason) || 'virtual-desktop.ps1 does not answer'}`)
    return { target: await targetById(port, targetId), placement: placed && placed.moved ? `new window on ${where}` : 'new window, not moved' }
  } finally { bconn.close() }
}

/** Returns the connection to this session's tab (pin), or to the most recent one if there is no pin. */
async function attach(port, { create } = {}) {
  if (create) {
    const { target: t, placement } = await createTab(port, create)
    if (!t || !t.webSocketDebuggerUrl)
      throw new Error(`port ${port} (${laneLabel(port)}) does not let me open a new tab. ` +
        `See the section «Lane down or login expired» of the browser-cdp skill.`)
    writePin(port, t)
    return { conn: await Conn.open(t.webSocketDebuggerUrl), target: t, fresh: true, placement }
  }

  const pin = readPin(port)
  if (pin && pin.wsUrl) {
    try { return { conn: await Conn.open(pin.wsUrl, 3000), target: pin } } catch {}
  }

  let targets = await listTargets(port)
  const onlyPages = ts => ts.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)
  let pages = onlyPages(targets)
  // A freshly launched Chrome answers /json/version — which is what ensure-chrome waits for —
  // before registering its first tab as a target. Listing in that gap gave «no tabs» with the
  // window opening right there; poll a little before giving up.
  for (let i = 0; !pages.length && i < 10; i++) {
    await sleep(400)
    targets = await listTargets(port, { autoEnsure: false }).catch(() => [])
    pages = onlyPages(targets)
  }
  if (!pages.length) throw new Error(`no tabs on port ${port} — open one with: use new:<url>`)
  const previous = pin && pages.find(p => p.id === pin.targetId)
  const t = previous || pages[0]
  if (!pin) warn(`no pinned tab: using "${(t.title || t.url).slice(0, 50)}". Pin one with: use <n|new:URL>`)
  else if (!previous) warn(`your pinned tab no longer exists; switching to "${(t.title || t.url).slice(0, 50)}". Check with: tabs`)
  writePin(port, t)
  return { conn: await Conn.open(t.webSocketDebuggerUrl), target: t }
}

// ────────────────── JS injected into the page ──────────────────

const PAGE_LIB = `
const __t = s => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
const __vis = el => {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
};
const __name = el => {
  let n = __t(el.getAttribute && el.getAttribute('aria-label'));
  if (!n && el.getAttribute) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) n = __t(lb.split(/\\s+/).map(id => (document.getElementById(id) || {}).innerText || '').join(' '));
  }
  if (!n && el.labels && el.labels[0]) n = __t(el.labels[0].innerText);
  if (!n) n = __t(el.innerText);
  if (!n) n = __t((el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'))) || '');
  if (!n && el.value && el.type !== 'password') n = __t(el.value);
  return n.slice(0, 90);
};
const __role = el => {
  const r = el.getAttribute && el.getAttribute('role');
  if (r) return r;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'input') return 'input:' + (el.type || 'text');
  return tag;
};
const __hint = el => {
  for (const a of ['data-testid', 'data-test-id', 'debug-id', 'data-debug-id', 'name', 'id']) {
    const v = el.getAttribute && el.getAttribute(a);
    if (v && v.length < 40) return a + '=' + v;
  }
  return '';
};
const __SEL = 'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick]';
// Search that goes through the shadow DOM. It is ALWAYS used for the inventory: on component-based
// sites the real controls live inside a shadow root and used to be left out, because the search
// only went down when the light DOM gave nothing — and it always gives something (the search bar,
// the user menu…). It walks in document order and goes down into the shadow root at the point
// where its host is: listing the whole light DOM first and the components' insides afterwards
// put the #n out of step with what is on screen.
const __deep = (root, sel, extra) => {
  const out = [];
  const walk = r => {
    for (const el of r.querySelectorAll('*')) {
      if (el.matches(sel) || (extra && extra(el))) out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
};
// Hand-made controls: a <div>/<span> with no role or label whose click is wired from JavaScript.
// No attribute gives them away (React's onClick never reaches the HTML), but there is a reliable
// fingerprint: the stylesheet gives them cursor:pointer. Since the cursor is inherited, only the
// OUTERMOST element of each pointer area counts; and if it wraps a real control it is discarded,
// because then the thing to touch is the inner one.
const __NOPTR = { HTML: 1, BODY: 1, SVG: 1, PATH: 1, USE: 1, G: 1, CIRCLE: 1, RECT: 1, LINE: 1, IMG: 1, SCRIPT: 1, STYLE: 1 };
const __pointer = el => {
  if (__NOPTR[el.tagName]) return false;
  if (getComputedStyle(el).cursor !== 'pointer') return false;
  const p = el.parentElement;
  if (p && getComputedStyle(p).cursor === 'pointer') return false;
  return !el.querySelector(__SEL);
};
const __interactive = (root, includeHidden) => {
  // A <label> only counts as a control when the input it points to is NOT visible: the pattern
  // «invisible checkbox + styled label» (hand-made switches and chips), where the only clickable
  // thing with text is the label. If the input is visible the label is redundant and would only
  // clutter the inventory with a duplicate of every form field. Exception: a
  // <label role=radio|button|tab> IS the control and duplicates nothing.
  const els = __deep(root || document, __SEL, __pointer)
    .filter(el => el.tagName !== 'LABEL' || el.hasAttribute('role') || (el.control && !__vis(el.control)));
  return includeHidden ? els : els.filter(__vis);
};
// querySelectorAll that explains the most expensive failure when writing a selector from
// PowerShell: the inner double quotes get lost on the way and [action="/x/y"] arrives as
// [action=/x/y], which is not a valid selector and throws a SyntaxError that does not look like it.
const __css = (root, sel) => {
  try { return [...root.querySelectorAll(sel)] }
  catch {
    throw new Error('the selector is not valid: ' + sel +
      ' — if it had double quotes, PowerShell strips them on the way to node: use single quotes inside and double outside, or use run script.js');
  }
};
const __resolve = ref => {
  if (ref[0] === '#' && /^#\\d+$/.test(ref)) {
    const q = '[data-cdp="' + ref.slice(1) + '"]';
    const el = document.querySelector(q) || __deep(document, q)[0];
    if (!el) throw new Error('reference ' + ref + ' no longer exists in the DOM — run snap again');
    return el;
  }
  if (ref[0] === '@') {
    const q = ref.slice(1).toLowerCase();
    const cands = __interactive(null, false).filter(el => __name(el).toLowerCase().includes(q));
    const exact = cands.filter(el => __name(el).toLowerCase() === q);
    const pick = exact.length ? exact : cands;
    if (!pick.length) throw new Error('no visible interactive element contains the text "' + ref.slice(1) + '"');
    if (pick.length > 1) throw new Error(pick.length + ' candidates for "' + ref.slice(1) + '": ' +
      pick.slice(0, 6).map(el => __role(el) + ' "' + __name(el) + '"').join(' | ') + ' — use #n after a snap, or a CSS selector');
    return pick[0];
  }
  let els = __css(document, ref);
  if (!els.length) els = __deep(document, ref);
  if (!els.length) {
    // the shadow DOM hint only applies when there is a real descendant COMBINATOR ( >~+ between
    // two tokens): comma lists (a, b) and spaces inside [attr="a b"] used to trigger it falsely
    // and pointed at the wrong cause
    const desc = ref.replace(/\\[[^\\]]*\\]/g, 'X').split(',').some(g => /\\S[ >~+]+\\S/.test(g.trim()));
    throw new Error('no match for the selector: ' + ref +
      (desc ? ' — note: a descendant selector does not cross the shadow DOM boundary; use the bare selector of the final element' : ''));
  }
  // with several matches the first VISIBLE one wins: forms often carry a hidden input with the
  // same name before the real one, and filling the hidden one does nothing.
  // If none is visible the first one is returned (a hidden input[type=file] is the norm).
  return els.find(__vis) || els[0];
};
// DOM click. An <svg> (the icon of a MUI checkbox, e.g.) has no .click(): the command used to die
// with «__resolve(...).click is not a function»; the event is dispatched by hand instead.
const __click = el => {
  if (typeof el.click === 'function') el.click();
  else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
};
// How many VISIBLE elements match a reference (#n, @text or CSS). Never throws: wait uses it and
// needs to tell «not there yet» from «gone».
const __count = ref => {
  if (ref[0] === '#' && /^#\\d+$/.test(ref)) {
    const q = '[data-cdp="' + ref.slice(1) + '"]';
    const el = document.querySelector(q) || __deep(document, q)[0];
    return el && __vis(el) ? 1 : 0;
  }
  if (ref[0] === '@') {
    const q = ref.slice(1).toLowerCase();
    return __interactive(null, false).filter(el => __name(el).toLowerCase().includes(q)).length;
  }
  let els = __css(document, ref);
  if (!els.length) els = __deep(document, ref);
  return els.filter(__vis).length;
};
`

// ──────────────────────── high-level API ────────────────────────

// Warnings go to STDOUT on purpose: any line on stderr makes PowerShell 5.1 treat the command as
// failed (NativeCommandError, «exit code 255») and, with a `2>&1` in front, swallow the first lines
// of the next Select-Object. With --json they are not printed.
function warn(msg) { if (!global.__CDP_JSON) console.log('· ' + msg) }

/**
 * Text filter of `snap --filter` and `text --grep`. Matches by substring OR by regular expression:
 * alternation patterns (`Save|Send`) are what one types by instinct and they used to return zero
 * results silently. Since both forms are accepted, no pattern that worked before stops working.
 * Case-insensitive.
 */
function makeMatch(pat) {
  const q = String(pat).toLowerCase()
  let re = null
  try { re = new RegExp(pat, 'i') } catch {}
  return s => String(s).toLowerCase().includes(q) || (re ? re.test(s) : false)
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const compilesAsBody = src => { try { new AsyncFunction(src); return true } catch { return false } }
const compilesAsScript = src => { try { new vm.Script(src); return true } catch { return false } }

/**
 * Decides how to wrap the JS that reaches `eval`/`page.eval`. Checked by compiling here, in Node,
 * without running anything and without round trips to the browser:
 *   1. a single expression        -> return (code)
 *   2. a top-level `return`       -> as is (it compiles as a function body but not as a loose
 *                                    script, which is exactly what gives that return away)
 *   3. several statements         -> return eval(code): returns the value of the last one
 * Case 1 is the one that used to break: it was decided with a /return/ over the TEXT, so any
 * `return` inside a nested function — `(() => { ... return x })()` — was taken for a body, the
 * value was not returned and the command printed absolutely nothing.
 */
function wrapCode(code) {
  const expr = `return (${code})`
  if (compilesAsBody(expr)) return expr
  if (!compilesAsBody(code)) return code                // real syntax error: let the page report it
  if (!compilesAsScript(code)) return code              // top-level return (or loose await)
  if (/\bawait\b/.test(code)) return code               // direct eval() does not accept await
  return `return eval(${JSON.stringify(code)})`
}

class Page {
  constructor(conn, port, target) {
    this.conn = conn
    this.port = port
    this.target = target
    this.ctxId = undefined      // execution context of an iframe, if --frame was given
    this._pageEnabled = false
  }

  send(m, p, t) { return this.conn.send(m, p, t) }

  async enablePage() {
    if (!this._pageEnabled) { await this.send('Page.enable'); this._pageEnabled = true }
  }

  /** Sets the execution context to an iframe whose URL contains `sub` (isolated world). */
  async useFrame(sub) {
    await this.enablePage()
    const { frameTree } = await this.send('Page.getFrameTree')
    const flat = []
    const walk = n => { flat.push(n.frame); (n.childFrames || []).forEach(walk) }
    walk(frameTree)
    const f = flat.find(fr => fr.url && fr.url.includes(sub))
    if (!f) throw new Error(`no iframe with "${sub}" in its URL. Frames: ${flat.map(x => x.url).join(' | ').slice(0, 300)}`)
    const { executionContextId } = await this.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'cdpjs' })
    this.ctxId = executionContextId
  }

  /** Evaluates JS in the page. Accepts an expression, a body with `return`, or several statements. */
  async eval(code, { raw = false } = {}) {
    const wrap = body => `(async () => { ${PAGE_LIB}\n${body} })()`
    const run = expression => this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      ...(this.ctxId !== undefined ? { contextId: this.ctxId } : {}),
    })
    const isSyntax = res => {
      const ex = res.exceptionDetails && res.exceptionDetails.exception
      return !!ex && (ex.className === 'SyntaxError' || /^SyntaxError/.test(String(ex.description || '')))
    }

    const r = await run(raw ? code : wrap(wrapCode(code)))
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      const detail = d.exception ? (d.exception.description || d.exception.value) : d.text
      // keep only the message: the stack belongs to the injected JS and adds nothing
      let msg = String(detail).split('\n')[0].replace(/^(Uncaught )?Error: /, '')
      // The quotes hint only applies to a COMPILE-time SyntaxError. Runtime ones are SyntaxErrors
      // too (a JSON.parse over an HTML response is the typical case) and there it misled: they give
      // themselves away by carrying a stack, and a compile failure does not.
      const hasStack = /\n\s+at\s/.test(String(detail))
      if (isSyntax(r) && !hasStack && !code.includes('"'))
        msg += ' — if the JS had double quotes, PowerShell strips them on the way to node: ' +
          'use single quotes inside, or use `eval @file.js` / `run script.js`'
      throw new Error(msg)
    }
    return r.result.value
  }

  async info() { return this.eval(`({ url: location.href, title: document.title })`) }

  /**
   * Waits until a JUST-CREATED tab holds the document that was requested.
   * `/json/new?URL` returns before the navigation has committed, so reading the URL at that moment
   * gave `about:blank` and an empty title — and whatever came next (a `run`, a `snap`) worked on the
   * blank page without a warning. `settle` did not cover it: if the request went out before
   * Network.enable, it sees nothing in flight and declares the load finished after 500 ms.
   */
  async waitForNewTab(url, maxMs = 20000) {
    const target = String(url || '')
    if (target && target !== 'about:blank') {
      const t0 = Date.now()
      let ready = false
      while (Date.now() - t0 < maxMs) {
        const i = await this.info().catch(() => null)
        if (i && i.url && i.url !== 'about:blank') { ready = true; break }
        await sleep(150)
      }
      if (!ready) warn(`the new tab is still blank after ${Math.round(maxMs / 1000)}s; ` +
        `is ${target.slice(0, 60)} answering? Retry with: goto <url>`)
    }
    await this.settle(4000)
    return this.info()
  }

  async goto(url, { timeout = 45000 } = {}) {
    await this.enablePage()
    let mainFrame = null
    // whichever arrives first: the document's load, or the end of loading of the MAIN frame
    // (without filtering by frameId, a fast subframe would end the wait too early)
    const load = this.conn.waitEvent('Page.loadEventFired', null, timeout).catch(() => null)
    const stopped = this.conn.waitEvent('Page.frameStoppedLoading', p => p.frameId === mainFrame, timeout).catch(() => null)
    const r = await this.send('Page.navigate', { url })
    if (r.errorText) throw new Error(`navigation failed: ${r.errorText}`)
    mainFrame = r.frameId
    await Promise.race([load, stopped])
    await this.settle(3000)
    return this.info()
  }

  /**
   * Arms the handling of alert/confirm/prompt BEFORE touching anything.
   * Prevention is mandatory: if a native modal opens while no CDP client had Page.enable, the tab
   * stays blocked and cannot be rescued (Page.handleJavaScriptDialog answers "No dialog is showing"
   * and even Page.enable hangs). By default it is DISMISSED, the safe option for an "Are you sure
   * you want to delete?".
   */
  async armDialogs(accept = false, promptText) {
    this.conn.on('Page.javascriptDialogOpening', p => {
      this.send('Page.handleJavaScriptDialog', { accept, ...(promptText !== undefined ? { promptText } : {}) }).catch(() => {})
      warn(`${p.type} ${accept ? 'accepted' : 'dismissed'}: "${String(p.message || '').slice(0, 90)}"` +
        (accept ? '' : ' — if you wanted to accept it, repeat with --dialog accept'))
    })
    await this.enablePage()
  }

  /** Waits until no network requests are in flight (with a short cap). */
  async settle(maxMs = 3000) {
    const started = Date.now()
    await this.send('Network.enable').catch(() => {})
    let inflight = 0
    const bump = d => { inflight = Math.max(0, inflight + d) }
    const onEvt = { 'Network.requestWillBeSent': 1, 'Network.loadingFinished': -1, 'Network.loadingFailed': -1 }
    const hook = ev => { const d = onEvt[ev.method]; if (d) bump(d) }
    const orig = this.conn.ws.onmessage
    this.conn.ws.onmessage = e => { try { hook(JSON.parse(e.data)) } catch {} ; orig(e) }
    let quiet = 0
    while (Date.now() - started < maxMs) {
      await sleep(120)
      quiet = inflight === 0 ? quiet + 120 : 0
      if (quiet >= 400) break
    }
    this.conn.ws.onmessage = orig
    await this.send('Network.disable').catch(() => {})
  }

  /**
   * A tab that is not visible (another tab active in its window, minimized window) does not receive
   * the mouse and keyboard that Input.* sends — `click` said «real click» and nothing happened — and
   * sites stop rendering: menus that do not open, lists stuck on «loading», `wait` running out.
   * document.visibilityState is checked and, if needed, the tab is brought to the front before
   * acting. Several sessions on the same lane steal the front from each other: that is why it runs
   * on every command and not only when opening. Returns true if it had to bring it.
   */
  async bringToFrontIfHidden() {
    const vis = await this.eval('document.visibilityState', { raw: true }).catch(() => 'visible')
    if (vis !== 'hidden') return false
    await this.send('Page.bringToFront').catch(() => {})
    let now = vis
    for (let i = 0; i < 10 && now === 'hidden'; i++) {
      await sleep(100)
      now = await this.eval('document.visibilityState', { raw: true }).catch(() => 'hidden')
    }
    warn(now === 'hidden'
      ? 'the tab is still hidden after bringing it to the front (minimized window?): the site may not respond'
      : 'the tab was hidden (another tab active in its window, or the window covered): I brought it to the front')
    return true
  }

  async snap({ filter, max = 80, hidden = false, all = false, page = false } = {}) {
    await this.bringToFrontIfHidden()
    const data = await this.eval(`
      // deep cleanup: otherwise an old data-cdp inside a shadow root would survive the new snap and
      // __resolve could end up resolving a #n to an element from the previous pass
      __deep(document, '[data-cdp]').forEach(e => e.removeAttribute('data-cdp'));
      const dialogs = ${page ? '[]' : "[...__deep(document, '[role=dialog],[role=alertdialog],dialog[open]')].filter(__vis)"};
      const scope = dialogs.length ? dialogs[dialogs.length - 1] : null;
      // The WHOLE set is always numbered (hidden ones included): that way the #n of one snap stays
      // valid even if the next one uses --filter or --hidden. If the numbering depended on the
      // filter, a reused #n would click a different element.
      const els = __interactive(scope, true);
      const rows = [];
      let n = 0;
      for (const el of els) {
        el.setAttribute('data-cdp', String(++n));
        if (!${hidden} && !__vis(el)) continue;
        const r = el.getBoundingClientRect();
        const st = [];
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') st.push('disabled');
        if (el.checked || el.getAttribute('aria-checked') === 'true') st.push('checked');
        const exp = el.getAttribute('aria-expanded'); if (exp) st.push('expanded=' + exp);
        if (!__vis(el)) st.push('hidden');
        else if (r.bottom < 0 || r.top > innerHeight) st.push('out-of-view');
        // the value of a password is NEVER dumped: Chrome autofills those fields and the inventory
        // ended up writing the password in clear text into the session transcript
        const val = !el.value || el.type === 'file' || el.type === 'button' ? ''
          : el.type === 'password' ? ' =(filled, ' + String(el.value).length + ' characters)'
          : ' ="' + __t(el.value).slice(0, 40) + '"';
        rows.push('#' + n + '  ' + __role(el).padEnd(12) + ' "' + __name(el) + '"' + val +
          (st.length ? '  (' + st.join(',') + ')' : '') + (__hint(el) ? '  [' + __hint(el) + ']' : ''));
      }
      return { url: location.href, title: document.title, dialog: scope ? __t(scope.innerText).slice(0, 120) : null, rows };
    `)
    let rows = data.rows
    const inPage = rows.length
    if (filter) rows = rows.filter(makeMatch(filter))
    const total = rows.length
    if (!all && rows.length > max) rows = rows.slice(0, max)
    return { ...data, rows, total, shown: rows.length, inPage }
  }

  async text(sel = 'body', { max = 4000, grep } = {}) {
    let t = await this.eval(`__t(__resolve(${JSON.stringify(sel)}).innerText).length ? __resolve(${JSON.stringify(sel)}).innerText : ''`)
    t = String(t || '').split('\n').map(l => l.trim()).filter(Boolean).join('\n')
    if (grep) {
      const match = makeMatch(grep)
      const lines = t.split('\n')
      t = lines.filter(match).join('\n')
      if (!t) return `(none of the ${lines.length} lines matches "${grep}"; without --grep you get the whole text)`
    }
    return t.length > max ? t.slice(0, max) + `\n… (cut, ${t.length} characters)` : t
  }

  async table(sel, { max = 200 } = {}) {
    return this.eval(`
      const root = __resolve(${JSON.stringify(sel)});
      let rows = [...root.querySelectorAll('tr')];
      if (!rows.length) rows = [...root.children];
      return rows.slice(0, ${max}).map(r => {
        const cells = [...r.querySelectorAll('th,td')];
        return (cells.length ? cells.map(c => __t(c.innerText)) : [__t(r.innerText)]).join('\\t');
      });
    `)
  }

  /** Real click by coordinates; if an overlay covers the point, falls back to the DOM el.click(). */
  async click(ref, { dom = false } = {}) {
    const brought = await this.bringToFrontIfHidden()
    const probe = await this.eval(`
      const el = __resolve(${JSON.stringify(ref)});
      // 'instant' is mandatory: with scroll-behavior:smooth in the CSS, the rect read right after
      // would be the one from BEFORE scrolling, and we would click at the wrong coordinates
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      // elementFromPoint stops at the host of a shadow root: keep going down, otherwise an
      // encapsulated component would always look covered.
      let top = document.elementFromPoint(x, y);
      while (top && top.shadowRoot) {
        const inner = top.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === top) break;
        top = inner;
      }
      const blocked = !top || !(top === el || el.contains(top) || top.contains(el));
      return { x, y, blocked, w: r.width, h: r.height,
               label: __role(el) + ' "' + __name(el) + '"',
               blocker: blocked && top ? (top.tagName.toLowerCase() + (top.className && typeof top.className === 'string' ? '.' + top.className.split(' ')[0] : '')) : null };
    `)
    if (probe.w < 1 || probe.h < 1) throw new Error(`the element has no size (hidden?): ${probe.label}`)

    // Inside an iframe the coordinates are relative to the frame, but Input.dispatchMouseEvent works
    // on the viewport of the main page: a real click is no good there, it goes through the DOM.
    const inFrame = this.ctxId !== undefined
    const front = brought ? ' (tab brought to the front: it was hidden)' : ''
    if (dom || inFrame || probe.blocked) {
      await this.eval(`__click(__resolve(${JSON.stringify(ref)})); return 1`)
      const why = probe.blocked ? ` (covered by ${probe.blocker})` : inFrame ? ' (iframe)' : ''
      return { ...probe, via: 'dom-click' + why + front }
    }
    const base = { x: probe.x, y: probe.y, button: 'left', clickCount: 1, buttons: 1 }
    // The first event goes with a short timeout on purpose: with DevTools open on that tab
    // (especially with device mode on) Input.dispatchMouseEvent never answers. Since the mouseMoved
    // has not clicked anything yet, falling back to the DOM click is safe there; if a later event
    // hangs, it no longer is.
    try {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 }, 6000)
    } catch (e) {
      if (!/no response/.test(e.message)) throw e
      warn('the real mouse does not respond (usually DevTools open on that tab); going through the DOM')
      await this.eval(`__click(__resolve(${JSON.stringify(ref)})); return 1`)
      return { ...probe, via: 'dom-click (the real mouse did not respond)' + front }
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
    return { ...probe, via: 'real click' + front }
  }

  async fill(ref, value, { keys = false } = {}) {
    const val = String(value)
    await this.bringToFrontIfHidden()
    const prep = await this.eval(`
      const el = __resolve(${JSON.stringify(ref)});
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const label = __role(el) + ' "' + __name(el) + '"';
      // a <select> reacts neither to insertText nor to typing: the option has to be chosen by hand
      // and input/change dispatched, or the form keeps the old value without a warning
      if (el.tagName === 'SELECT') {
        const q = ${JSON.stringify(val)}.toLowerCase();
        const opts = [...el.options];
        const opt = opts.find(o => o.value.toLowerCase() === q || __t(o.textContent).toLowerCase() === q)
                 || opts.find(o => __t(o.textContent).toLowerCase().includes(q));
        if (!opt) throw new Error('the <select> has no option "' + ${JSON.stringify(val)} +
          '". Options: ' + opts.slice(0, 12).map(o => __t(o.textContent)).join(' | '));
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { select: true, label, value: __t(opt.textContent) };
      }
      el.focus();
      if (el.select) el.select();
      else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      return { select: false, label };
    `)
    const info = prep.label
    if (prep.select) return { target: info, value: prep.value, via: 'select' }
    if (keys) {
      await this.eval(`const el = __resolve(${JSON.stringify(ref)}); if ('value' in el) el.value = ''; else el.textContent = ''; return 1`)
      for (const ch of String(value)) {
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch })
      }
    } else {
      await this.send('Input.insertText', { text: String(value) })
    }
    const read = () => this.eval(`const el = __resolve(${JSON.stringify(ref)}); return 'value' in el ? el.value : el.textContent`)
    let now = await read()
    // Typing that leaves nothing: it happens when the site repaints the field between the focus and
    // the first key (Turbo, React) or when it is out of view. Since the field is EMPTY, assigning the
    // value and dispatching input/change cannot write it twice.
    if (keys && val && !String(now)) {
      await this.eval(`
        const el = __resolve(${JSON.stringify(ref)});
        el.focus();
        if ('value' in el) el.value = ${JSON.stringify(val)}; else el.textContent = ${JSON.stringify(val)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 1;
      `)
      now = await read()
      return { target: info, value: now,
        via: String(now) ? 'value assigned (typing left nothing in the field)'
                         : 'the field stays empty both typing and assigning: the page is clearing it' }
    }
    return { target: info, value: now }
  }

  async press(key, { times = 1 } = {}) {
    await this.bringToFrontIfHidden()
    const K = {
      Enter: { keyCode: 13, code: 'Enter', text: '\r' }, Tab: { keyCode: 9, code: 'Tab' },
      Escape: { keyCode: 27, code: 'Escape' }, Backspace: { keyCode: 8, code: 'Backspace' },
      Delete: { keyCode: 46, code: 'Delete' }, ArrowDown: { keyCode: 40, code: 'ArrowDown' },
      ArrowUp: { keyCode: 38, code: 'ArrowUp' }, ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
      ArrowRight: { keyCode: 39, code: 'ArrowRight' }, Home: { keyCode: 36, code: 'Home' },
      End: { keyCode: 35, code: 'End' }, PageDown: { keyCode: 34, code: 'PageDown' },
      // `key` is the DOM value of the event: for the space it is " ", not "Space" (otherwise a
      // listener comparing e.key === ' ' never hears the key press)
      PageUp: { keyCode: 33, code: 'PageUp' }, Space: { keyCode: 32, code: 'Space', text: ' ', key: ' ' },
    }
    // Combinations with a modifier: `Ctrl+A`, `Shift+Tab`, `Alt+Enter`… They were asked for daily
    // (select all before typing) and died with «unsupported key».
    const MOD = { ctrl: 2, control: 2, alt: 1, shift: 8, meta: 4, cmd: 4, command: 4, win: 4 }
    const MODK = { 1: { keyCode: 18, code: 'AltLeft', key: 'Alt' }, 2: { keyCode: 17, code: 'ControlLeft', key: 'Control' },
                   4: { keyCode: 91, code: 'MetaLeft', key: 'Meta' }, 8: { keyCode: 16, code: 'ShiftLeft', key: 'Shift' } }
    const parts = String(key).split('+').filter(Boolean)
    const base = parts.pop()
    let modifiers = 0
    for (const p of parts) {
      const m = MOD[p.toLowerCase()]
      if (!m) throw new Error(`unsupported modifier: ${p}. Valid: Ctrl, Alt, Shift, Meta`)
      modifiers |= m
    }
    let k = K[base] || K[Object.keys(K).find(n => n.toLowerCase() === base.toLowerCase())]
    if (!k && base.length === 1) {
      // a single letter/digit: 'a' -> KeyA/65, '5' -> Digit5/53
      const up = base.toUpperCase()
      k = { keyCode: up.charCodeAt(0), key: base, text: base,
            code: /[A-Z]/.test(up) ? 'Key' + up : /[0-9]/.test(up) ? 'Digit' + up : '' }
    }
    if (!k) throw new Error(`unsupported key: ${key}. Available: ${Object.keys(K).join(', ')}, ` +
      `a single letter or digit, and combinations like Ctrl+A / Shift+Tab`)
    const domKey = k.key || base
    // with Ctrl/Alt/Meta held, `text` is NOT sent: otherwise the browser inserts the character
    // instead of running the shortcut (Ctrl+A would type an "a" instead of selecting all)
    const text = modifiers & 7 ? undefined : k.text
    const mods = Object.keys(MODK).map(Number).filter(m => modifiers & m)
    for (let i = 0; i < times; i++) {
      for (const m of mods) {
        const mk = MODK[m]
        await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: mk.keyCode, nativeVirtualKeyCode: mk.keyCode, code: mk.code, key: mk.key, modifiers })
      }
      const evt = { windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, code: k.code, key: domKey, modifiers }
      await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...evt, text })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...evt })
      for (const m of mods.slice().reverse()) {
        const mk = MODK[m]
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: mk.keyCode, nativeVirtualKeyCode: mk.keyCode, code: mk.code, key: mk.key, modifiers: modifiers & ~m })
      }
    }
    return { key, times }
  }

  async upload(ref, files) {
    // from a `run` it is natural to pass ONE file as a string; the console command sends an array
    const abs = (Array.isArray(files) ? files : [files]).map(f => path.resolve(f))
    for (const f of abs) if (!fs.existsSync(f)) throw new Error(`file does not exist: ${f}`)
    await this.send('DOM.enable').catch(() => {})
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { ${PAGE_LIB}\nreturn __resolve(${JSON.stringify(ref)}) })()`,
      ...(this.ctxId !== undefined ? { contextId: this.ctxId } : {}),
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    await this.send('DOM.setFileInputFiles', { files: abs, objectId: r.result.objectId })
    return { files: abs, via: 'setFileInputFiles' }
  }

  /** Clicks a button that opens the system dialog and injects the files in its place. */
  async pick(ref, files) {
    const abs = (Array.isArray(files) ? files : [files]).map(f => path.resolve(f))
    for (const f of abs) if (!fs.existsSync(f)) throw new Error(`file does not exist: ${f}`)
    await this.enablePage()
    await this.send('DOM.enable').catch(() => {})
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true })
    try {
      const ev = this.conn.waitEvent('Page.fileChooserOpened', null, 15000)
      await this.click(ref)
      let backendNodeId
      try { ({ backendNodeId } = await ev) }
      catch (e) {
        // The button did not open the system dialog (an overlay covered it, or the site uploads by
        // drag and drop). The way that works is the input[type=file] behind it: they are marked
        // here so they can be targeted — finding them otherwise costs three commands.
        if (!/fileChooserOpened/.test(String(e.message))) throw e
        const ins = await this.eval(`
          const ins = __deep(document, 'input[type=file]');
          ins.forEach((el, i) => el.setAttribute('data-cdp-file', String(i)));
          return ins.map((el, i) => i + ': accept=' + String(el.getAttribute('accept') || '*').slice(0, 50));
        `).catch(() => [])
        throw new Error(`clicking ${ref} opened no file dialog within 15 s. ` + (ins.length
          ? `There are ${ins.length} input[type=file] on the page and I have marked them — upload with ` +
            `upload "[data-cdp-file='0']" <file>. They are: ${ins.join(' | ')}`
          : 'and there is no input[type=file] in sight: open the upload panel first (its tab or its button) and repeat.'))
      }
      if (backendNodeId === undefined)
        throw new Error('the file dialog opened but Chrome does not expose the associated input; ' +
          'find the input[type=file] with `snap --hidden` and use `upload <#n|selector>`')
      await this.send('DOM.setFileInputFiles', { files: abs, backendNodeId })
      return { files: abs, via: 'file chooser intercepted' }
    } finally {
      await this.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
    }
  }

  async wait({ text, sel, gone, idle, timeout = 20000 } = {}) {
    if (idle) { await this.settle(timeout); return { ok: true, via: 'network idle' } }
    // --sel/--gone accept the same as click/fill (#n, @text or CSS) and count only what is VISIBLE:
    // only pure CSS used to work, and a `wait --gone @Loading` burned the whole timeout because
    // querySelector threw and the error was swallowed in the catch of every round.
    const cond = text
      ? `document.body.innerText.includes(${JSON.stringify(text)})`
      : sel ? `__count(${JSON.stringify(sel)}) > 0`
        : gone ? `__count(${JSON.stringify(gone)}) === 0`
          : null
    if (!cond) throw new Error('wait needs --text, --sel, --gone or --idle')
    await this.bringToFrontIfHidden()   // hidden, the site does not render and the condition would never arrive
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      let ok
      try {
        ok = await this.eval(cond)
      } catch (e) {
        // a mistyped selector is never satisfied: better to say so now than to wait for the timeout
        // («selector is not valid» is the message of __css, which wraps the browser's error)
        if (/selector is not valid|valid selector|SyntaxError/i.test(e.message))
          throw new Error(`wait: invalid selector "${sel || gone}" (${e.message})`)
        ok = false
      }
      if (ok) return { ok: true, ms: Date.now() - t0 }
      await sleep(150)
    }
    throw new Error(`wait: condition not met in ${timeout}ms (${text || sel || gone})`)
  }

  /**
   * ALWAYS capture after bringing the tab to the front. With the window in the background the
   * capture never answers, and the `fromSurface:false` alternative is not good as the normal mode:
   * it comes from the renderer ignoring the deviceScaleFactor and the clip, i.e. it returns an image
   * of the wrong size (verified: --px 1440x2560 gave 720x1280). It stays only as a last resort,
   * warning that the sizes may not be the requested ones.
   */
  async capture(args) {
    await this.send('Page.bringToFront').catch(() => {})
    try {
      return await this.send('Page.captureScreenshot', args, 20000)
    } catch (e) {
      warn('the screenshot does not respond (minimized window?); retrying from the renderer: ' +
        'the image may come out without the requested scale or clip')
      return this.send('Page.captureScreenshot', { ...args, fromSurface: false }, 20000)
    }
  }

  async shot(out, { mobile, px, dsf, full, sel, quality } = {}) {
    let metrics = null
    if (mobile || px) {
      let W = 360, H = 640, scale = 3
      if (px) {
        const m = /^(\d+)x(\d+)$/.exec(String(px))
        if (!m) throw new Error('--px must be WidthxHeight in real pixels, e.g. --px 1080x1920')
        const pw = +m[1], ph = +m[2]
        // Automatic scale ONLY when the request looks like a phone screen in portrait
        // (1080x1920 -> 360x640 @3x, 1170x2532 -> 390x844 @3x). The old criterion was plain
        // divisibility and it ruined any desktop size: --px 1440x900 ended up laying out at
        // 480x300 CSS, i.e. the mobile layout.
        scale = dsf ? +dsf
          : [3, 2].find(s => pw % s === 0 && ph % s === 0 &&
                             pw / s >= 320 && pw / s <= 480 && ph / s > pw / s) || 1
        W = pw / scale; H = ph / scale
        if (W < 240) warn(`--px are the PNG's pixels and they are split by --dsf ${scale}: ` +
          `the page is laid out at ${Math.round(W)}x${Math.round(H)} CSS. Did you mean --px ${pw * scale}x${ph * scale}?`)
      } else if (dsf) scale = +dsf
      // `mobile: true` makes Chrome obey the <meta viewport> and present itself as touch. That is
      // what is needed at 360 CSS wide, and exactly what is NOT wanted in a desktop capture: with
      // --px 1440x900 the scale was already right but the site still believed it was on a phone.
      metrics = { width: Math.round(W), height: Math.round(H), deviceScaleFactor: scale, mobile: !!mobile || W <= 480 }
    } else if (dsf) {
      const vp = await this.eval(`({ w: innerWidth, h: innerHeight })`)
      metrics = { width: vp.w, height: vp.h, deviceScaleFactor: +dsf, mobile: false }
    }

    const apply = async m => { await this.send('Emulation.setDeviceMetricsOverride', m); await sleep(250) }

    try {
      if (metrics) await apply(metrics)   // the sleep gives time for the relayout

      // Full page: instead of captureBeyondViewport, a viewport as tall as the document is emulated.
      // That way the capture comes from the renderer and does not depend on the window being in
      // front (with the window behind, the surface capture hangs).
      if (full && !sel) {
        const doc = await this.eval(`({ w: innerWidth, h: Math.min(16384, Math.max(document.documentElement.scrollHeight, innerHeight)) })`)
        metrics = {
          width: metrics ? metrics.width : doc.w,
          height: doc.h,
          deviceScaleFactor: metrics ? metrics.deviceScaleFactor : (dsf ? +dsf : 1),
          mobile: metrics ? metrics.mobile : false,
        }
        await apply(metrics)
      }
      // typical cleanups before capturing
      await this.eval(`document.querySelectorAll('nextjs-portal').forEach(el => el.remove()); return 1`).catch(() => {})

      let clip
      if (sel) {
        const r = await this.eval(`
          const el = __resolve(${JSON.stringify(sel)});
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const b = el.getBoundingClientRect();
          return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height };
        `)
        clip = { ...r, scale: 1 }
      } else if (metrics) {
        clip = { x: 0, y: 0, width: metrics.width, height: metrics.height, scale: 1 }
      }

      const args = { format: quality ? 'jpeg' : 'png', ...(quality ? { quality: +quality } : {}), ...(clip ? { clip } : {}) }
      const { data } = await this.capture(args)
      const buf = Buffer.from(data, 'base64')
      fs.writeFileSync(out, buf)
      // the sizes are read from the PNG written, not computed: what is reported is exactly what is
      // in the file even if the browser ignores some parameter
      const real = buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG'
        ? `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}` : null
      return {
        file: path.resolve(out),
        kb: Math.round(buf.length / 1024),
        ...(real ? { px: real } : {}),
        ...(metrics ? { css: `${metrics.width}x${metrics.height}`, dsf: metrics.deviceScaleFactor, mobile: metrics.mobile } : {}),
      }
    } finally {
      if (metrics) await this.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Cookies that only exist when the account is REALLY logged in (not as a guest).
// Key = domain substring; tried in order, the first match wins.
const SESSION_MARKERS = [
  ['tiktok', ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt']],
  ['instagram', ['sessionid', 'ds_user_id']],
  ['youtube', ['SID', 'SAPISID', '__Secure-1PSID']],
  ['google', ['SID', 'SAPISID', '__Secure-1PSID']],
  ['facebook', ['c_user', 'xs']],
  ['linkedin', ['li_at']],
  ['twitter', ['auth_token']],
  ['x.com', ['auth_token']],
]

/**
 * Tells whether the lane has a live login on a domain (or on all the known ones). It reads the
 * cookies through the BROWSER target, not through a tab: the lane starts without a window, and
 * `session` as a first command used to die with «no tabs».
 */
async function sessionReport(port, domainArg) {
  await listTargets(port)                        // launches the lane if it was down
  const bconn = await browserConn(port)
  let cookies
  try { ({ cookies } = await bconn.send('Storage.getCookies')) } finally { bconn.close() }
  // The domain arrives as a short key («google»), as a domain («google.com») or as a host with a
  // subdomain, even a URL («accounts.google.com», «https://www.tiktok.com/…»). Matching only as a
  // substring of the cookie's domain left out the account cookies, which live on the parent domain
  // (.google.com), whenever a subdomain was given: «no cookies» while logged in.
  const host = domainArg ? String(domainArg).toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/:?#]/)[0] : ''
  const applies = (c, dom) => {
    const base = String(c.domain || '').toLowerCase().replace(/^\./, '')
    if (!dom.includes('.')) return base.includes(dom)
    return base === dom || base.endsWith('.' + dom) || dom.endsWith('.' + base)
  }
  const pairs = host
    ? [[host, (SESSION_MARKERS.find(([d]) => host.includes(d)) || [null, []])[1]]]
    : SESSION_MARKERS
  const date = exp => exp > 0 ? new Date(exp * 1000).toISOString().slice(0, 10) : 'session'
  const rows = []
  for (const [dom, marks] of pairs) {
    const cs = cookies.filter(c => applies(c, dom))
    if (!cs.length && !host) continue             // without a domain, skip the ones that do not appear
    const key = cs.filter(c => marks.includes(c.name))
    // generic fallback when the domain has no known markers
    const gen = marks.length ? [] : cs.filter(c => /sess|sid|auth|token|login/i.test(c.name))
    const hit = key.length ? key : gen
    const state = !cs.length ? 'no cookies' : hit.length ? 'LOGGED IN' : 'guest (no session cookies)'
    const detail = hit.slice(0, 6).map(c => `${c.name}@${c.domain} exp=${date(c.expires)}`)
    rows.push(`${dom.padEnd(11)} ${state.padEnd(38)} (${cs.length} cookies)` + (detail.length ? '\n    ' + detail.join('\n    ') : ''))
  }
  return rows.length ? rows.join('\n') : (host ? `${host}: no cookies in the lane` : 'no known domain with cookies in the lane')
}

// ──────────────────────────── output ────────────────────────────

function out(value) {
  if (global.__CDP_JSON) { console.log(JSON.stringify(value)); return }
  if (value == null) return
  // any primitive, not only strings: with a bare `typeof === 'string'`, an `eval "1+1"` fell into
  // the objects branch (Object.entries(2) === []) and printed absolutely nothing
  if (typeof value !== 'object') { console.log(String(value)); return }
  // an array of objects (what an eval/run with .map(el => ({...})) returns) came out as a string of
  // "[object Object]" and the command had to be repeated wrapped in JSON.stringify
  if (Array.isArray(value)) { console.log(value.map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)).join('\n')); return }
  if (value.rows) {                      // snap
    console.log(`${value.title || ''}  —  ${value.url}`)
    if (value.dialog) console.log(`⧉ modal open: this inventory covers ONLY the modal — close it ` +
      `(press Escape or its button), or use \`snap --page\` if what you want is behind it (Material ` +
      `navigation drawers also announce themselves as a modal): ${value.dialog}`)
    if (value.rows.length) console.log(value.rows.join('\n'))
    else console.log(value.inPage
      ? `(the filter matches none of the ${value.inPage} elements of the inventory; ` +
        `--filter accepts regex: "Save|Send")`
      : `(no visible interactive element: try --hidden, or --frame <url> if it is inside an iframe)`)
    if (value.shown < value.total) console.log(`… ${value.total - value.shown} more elements (use --filter or --all)`)
    return
  }
  console.log(Object.entries(value).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'))
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  const { rest, flags } = parseArgs(process.argv.slice(2))
  const cmd = rest[0]
  if (!cmd || cmd === 'help' || flags.help) { console.log(USAGE); return }

  global.__CDP_JSON = !!flags.json

  if (cmd === 'lanes') {
    const cfg = config()
    const rows = []
    for (const l of cfg.lanes) {
      const up = await http(l.port, '/json/version').then(() => 'up', () => 'down')
      rows.push(`${l.name === cfg.defaultLane ? '►' : ' '} ${l.name.padEnd(12)} port ${l.port}  ${up.padEnd(4)}  ` +
        `${l.account || '-'}  ${l.profileDir || ''}`)
    }
    out(rows)
    return
  }

  const port = resolvePort(flags)

  // Commands that need no attached tab
  if (cmd === 'tabs') {
    const targets = await listTargets(port)
    const pin = readPin(port)
    const list = targets.filter(t => flags.all || t.type === 'page')
    // the index counts ONLY pages, which is what `use <n>` indexes: numbering the whole list, with
    // --all the iframe/worker targets shifted the numbers and `use 3` went to another tab
    let n = 0
    out(list.map(t => {
      const idx = t.type === 'page' ? String(n++).padStart(2) : ' ·'
      return `${t.id === (pin && pin.targetId) ? '►' : ' '}${idx}  [${t.type}] ${(t.title || '').slice(0, 45).padEnd(45)} ${(t.url || '').slice(0, 90)}`
    }))
    return
  }
  if (cmd === 'use') {
    const arg = rest[1]
    if (!arg) throw new Error('use needs <n|url-text|new:URL>')
    if (arg.startsWith('new:')) {
      const url = arg.slice(4) || 'about:blank'
      const { conn, target, placement } = await attach(port, { create: url })
      const p = new Page(conn, port, target)
      // the page loads while we wait: without this, an alert() during the load would block the tab
      await p.armDialogs(flags.dialog === 'accept', flags['dialog-text'])
      const info = await p.waitForNewTab(url)
      conn.close()
      updatePin(port, { url: info.url, title: info.title })
      out({ pinned: info.title, url: info.url, new: true, ...(placement ? { desktop: placement } : {}) })
      return
    }
    const targets = (await listTargets(port)).filter(t => t.type === 'page')
    const t = /^\d+$/.test(arg) ? targets[+arg] : targets.find(x => (x.url + ' ' + x.title).toLowerCase().includes(arg.toLowerCase()))
    if (!t) throw new Error(`cannot find the tab "${arg}". List them with: tabs`)
    writePin(port, t)
    out({ pinned: t.title, url: t.url })
    return
  }

  if (cmd === 'session') { out(await sessionReport(port, rest[1])); return }

  if (cmd === 'close') {
    // over HTTP and without attaching: that way it works even with the tab hung by a modal
    const pin = readPin(port)
    if (!pin) throw new Error('there is no pinned tab to close')
    await http(port, `/json/close/${pin.targetId}`)
    try { fs.unlinkSync(pinFile(port)) } catch {}
    out({ closed: pin.title || pin.url })
    return
  }

  const create = cmd === 'goto' && flags.new ? rest[1] : undefined
  const { conn, target, placement } = await attach(port, { create })
  const page = new Page(conn, port, target)
  await page.armDialogs(flags.dialog === 'accept', flags['dialog-text'])
  if (flags.frame) await page.useFrame(String(flags.frame))

  try {
    switch (cmd) {
      case 'goto': {
        if (!rest[1]) throw new Error('goto needs a URL')
        const info = create ? await page.waitForNewTab(create) : await page.goto(rest[1])
        updatePin(port, { url: info.url, title: info.title })
        out(create && placement ? { ...info, desktop: placement } : info)
        break
      }
      case 'snap':
        out(await page.snap({ filter: flags.filter, max: +(flags.max || 80), hidden: !!flags.hidden, all: !!flags.all, page: !!flags.page }))
        break
      case 'text':
        out(await page.text(rest[1] || 'body', { max: +(flags.max || 4000), grep: flags.grep }))
        break
      case 'table':
        if (!rest[1]) throw new Error('table needs a selector')
        out(await page.table(rest[1], { max: +(flags.max || 200) }))
        break
      case 'click':
        if (!rest[1]) throw new Error('click needs <#n|selector|@text>')
        out(await page.click(rest[1], { dom: !!flags.dom }))
        break
      case 'fill': {
        if (rest.length < 3) throw new Error('fill needs <#n|selector|@text> <value>')
        out(await page.fill(rest[1], rest.slice(2).join(' '), { keys: !!flags.keys }))
        break
      }
      case 'press':
        out(await page.press(rest[1] || 'Enter', { times: +(flags.times || 1) }))
        break
      case 'upload':
        if (rest.length < 3) throw new Error('upload needs <#n|selector> <file...>')
        out(await page.upload(rest[1], rest.slice(2)))
        break
      case 'pick':
        if (rest.length < 3) throw new Error('pick needs <#n|selector|@text> <file...>')
        out(await page.pick(rest[1], rest.slice(2)))
        break
      case 'shot':
        out(await page.shot(rest[1] || 'shot.png', {
          mobile: !!flags.mobile, px: flags.px, dsf: flags.dsf, full: !!flags.full, sel: flags.sel, quality: flags.quality,
        }))
        break
      case 'eval': {
        let code = rest.slice(1).join(' ')
        if (code.startsWith('@')) code = fs.readFileSync(code.slice(1), 'utf8')
        if (!code) throw new Error('eval needs an expression or @file.js')
        const v = await page.eval(code)
        // without this an undefined printed NOTHING and it looked as if the command had done nothing.
        // And with several statements + `await` the wrapper cannot guess which one is the value
        // (`const r = await fetch(u); r.status` returns nothing), so it says what is missing.
        if (v === undefined && !global.__CDP_JSON) console.log('(undefined: the JS returned no value' +
          (/\breturn\b/.test(code) ? ')' : ' — if you expected one, put `return` before the final statement)'))
        else out(typeof v === 'object' && v !== null && !Array.isArray(v) && !v.rows ? JSON.stringify(v, null, 1) : v)
        break
      }
      case 'wait':
        out(await page.wait({ text: flags.text, sel: flags.sel, gone: flags.gone, idle: !!flags.idle, timeout: +(flags.timeout || 20000) }))
        break
      case 'run': {
        if (!rest[1]) throw new Error('run needs a .js file')
        const mod = require(path.resolve(rest[1]))
        const fn = typeof mod === 'function' ? mod : (mod.default || mod.main)
        if (typeof fn !== 'function') throw new Error('the script must export an async function: module.exports = async (page) => {...}')
        const r = await fn(page, { sleep, out, args: rest.slice(2) })
        if (r !== undefined) out(r)
        break
      }
      default:
        throw new Error(`unknown command: ${cmd}\n\n${USAGE}`)
    }
  } finally {
    conn.close()
  }
}

// Exit WITHOUT an immediate process.exit(): on Windows, process.exit() right after a quick fetch +
// WebSocket sequence (`session`, or any command that had to list the tabs first) hits a libuv
// assertion («Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c») because
// Node still has background work going: the output was right, but the command ended with a crash
// code and that line on stderr (`session`, every single time). Letting the event loop empty by itself
// avoids it; the unref'd timer is only a safety net in case something kept the process alive.
function finish(code) {
  process.exitCode = code
  setTimeout(() => process.exit(code), 3000).unref()
}

main().then(
  () => finish(0),
  e => {
    // also through stdout (see warn): exit code 1 already says it failed, and that way a `2>&1` or a
    // `| Select-Object` neither turns the message into red noise nor swallows it
    const msg = e && e.message ? e.message : String(e)
    console.log(global.__CDP_JSON ? JSON.stringify({ error: msg }) : 'ERROR: ' + msg)
    finish(1)
  }
)
