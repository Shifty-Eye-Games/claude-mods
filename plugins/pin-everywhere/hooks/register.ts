import type { EngineInterface, Hook, Register } from 'claude-code'

// A pinned session keeps its Remote Control on, so it shows on every other computer signed in to the same
// account (and the phone) with its title, machine icon included. Remote Control fixes the title it publishes when
// it connects, so the mod waits until machine-tag has put the machine's tag in the title before connecting.
// Unpinning turns Remote Control off again, but only when this mod turned it on. To keep a pinned session off
// Remote Control, unpin it; to publish a later rename, unpin and pin again.
//
// Remote Control drops when the desktop app restarts, so every running session sweeps all of this machine's
// pinned sessions every 2 minutes and reconnects any that are off, including ones nobody has opened since.
const PLUGIN = 'pin-everywhere'
const GET = 'mcp__ccd_session_mgmt__get_session'
const LIST = 'mcp__ccd_session_mgmt__list_sessions'
const SET_RC = 'mcp__ccd_session_mgmt__set_remote_control'
const LIST_LIMIT = 200
const TICK_MS = 2 * 60_000
const CALL_TIMEOUT_MS = 30_000
const RETRY_MS = 60 * 60_000
const TAGGED = /^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])* \S+ · /u

// pinned: true, false, or undefined when the app has not reported a pin for the session (never read as unpinned).
type Info = { id: string; title: string; pinned: boolean | undefined; rc: string; fromRemote: boolean; archived: boolean }
// One store key per pinned app session ("rc:<id>"): whether the mod turned Remote Control on (so an unpin turns it
// off), and when a refused or failed connect may be tried again (so a declined approval doesn't return every tick).
type Seen = { pinned: true; owned: boolean; retryAt?: number }

const state = { busy: false, warned: false, timer: undefined as { cancel: () => void } | undefined }

function parse(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? '')
  } catch {
    return undefined
  }
}

function toInfo(row: unknown): Info | undefined {
  if (!row || typeof row !== 'object') {
    return undefined
  }
  const r = row as Record<string, unknown>
  if (typeof r.sessionId !== 'string') {
    return undefined
  }

  return {
    id: r.sessionId,
    title: typeof r.title === 'string' ? r.title : '',
    pinned: typeof r.pinned === 'boolean' ? r.pinned : undefined,
    // get_session reports remoteControlState; list_sessions only a remoteControlActive flag, read as "on" or as
    // unknown (empty), which a get_session fills in when it matters.
    rc: typeof r.remoteControlState === 'string' ? r.remoteControlState : r.remoteControlActive === true ? 'on' : '',
    fromRemote: r.startedViaRemoteControl === true,
    archived: r.isArchived === true,
  }
}

// A tool call that settles within CALL_TIMEOUT_MS, so an approval dialog left open can't wedge the sweep. No
// $.tool.check first: a plugin's own query skips its own tool.check hook, so it would report the session's
// rules, not the allow allowMine gives the real call.
async function call($: EngineInterface, input: Record<string, unknown>) {
  const done = $.tool.call(input as never).catch(() => undefined)
  const late = $.clock.sleep(CALL_TIMEOUT_MS).then(() => undefined)

  return Promise.race([done, late])
}

// The session, 'gone' when the app answered that it can't report it, undefined when the call itself failed.
async function getSession($: EngineInterface, id: string): Promise<Info | 'gone' | undefined> {
  const got = await call($, { tool: GET, session_id: id })
  if (got?.isError) {
    return 'gone'
  }

  return toInfo(parse(got?.text))
}

async function listSessions($: EngineInterface): Promise<Info[]> {
  const rows = parse((await call($, { tool: LIST, limit: LIST_LIMIT }))?.text)

  return Array.isArray(rows) ? rows.map(toInfo).filter((r): r is Info => r !== undefined) : []
}

// Resolves to the state the app reports afterwards, or undefined when the call was refused, failed or timed out.
async function setRemoteControl($: EngineInterface, id: string, enabled: boolean): Promise<string | undefined> {
  const row = parse((await call($, { tool: SET_RC, session_id: id, enabled }))?.text) as Record<string, unknown> | undefined

  return typeof row?.remoteControlState === 'string' ? row.remoteControlState : undefined
}

async function readSeen($: EngineInterface, key: string): Promise<Seen | undefined> {
  const raw = await $.store.get(key)

  return raw && typeof raw === 'object' ? (raw as Seen) : undefined
}

async function keepOn($: EngineInterface, me: Info): Promise<void> {
  // 'connecting' means wait; 'unavailable' means this app can't; a phone-started session's switch is locked.
  if (me.fromRemote || (me.rc !== 'on' && me.rc !== 'off')) {
    return
  }
  const key = `rc:${me.id}`
  const seen = await readSeen($, key)
  if (me.rc === 'on') {
    if (!seen) {
      await $.store.set(key, { pinned: true, owned: false })
    }
    return
  }
  // Not tagged yet: wait, so the title Remote Control publishes already carries the machine icon.
  if (!TAGGED.test(me.title)) {
    return
  }
  const now = await $.clock.now()
  if (seen?.retryAt && now < seen.retryAt) {
    return
  }
  const after = await setRemoteControl($, me.id, true)
  if (after === 'on' || after === 'connecting') {
    await $.store.set(key, { pinned: true, owned: true })
    return
  }
  await $.store.set(key, { pinned: true, owned: seen?.owned === true, retryAt: now + RETRY_MS })
  if (!state.warned) {
    state.warned = true
    $.ui.toast('pin-everywhere: Remote Control could not be turned on for a pinned session; retrying in an hour.')
  }
}

async function drop($: EngineInterface, me: Info): Promise<void> {
  const key = `rc:${me.id}`
  const seen = await readSeen($, key)
  if (seen?.owned && me.rc === 'on') {
    await setRemoteControl($, me.id, false)
  }
  await $.store.delete(key)
}

async function sync($: EngineInterface): Promise<void> {
  if (state.busy) {
    return
  }
  state.busy = true
  try {
    const self = await getSession($, 'self')
    const listed = await listSessions($)
    const rows = self && self !== 'gone' ? [self, ...listed.filter(r => r.id !== self.id)] : listed
    const byId = new Map(rows.map(r => [r.id, r]))
    const tracked = new Set(await $.store.keys())
    // Sessions this mod tracks but the list didn't return (archived, deleted, or past the list's limit).
    for (const key of tracked) {
      const id = key.startsWith('rc:') ? key.slice(3) : ''
      if (!id || byId.has(id)) {
        continue
      }
      const me = await getSession($, id)
      if (me === 'gone' || me?.archived) {
        await $.store.delete(key)
      } else if (me) {
        byId.set(id, me)
      }
    }

    for (const row of byId.values()) {
      if (row.pinned === true) {
        // A list row only says whether Remote Control is up; ask for the full state when it is not.
        const me = row.rc === 'on' || row.rc === 'off' ? row : await getSession($, row.id)
        if (me && me !== 'gone' && me.pinned === true && !me.archived) {
          await keepOn($, me)
        }
      } else if (row.pinned === false && tracked.has(`rc:${row.id}`)) {
        // Only an explicit unpin counts: a session with no pin recorded is left alone.
        await drop($, row)
      }
    }
  } finally {
    state.busy = false
  }
}

function startTicking($: EngineInterface) {
  state.timer?.cancel()
  state.timer = $.clock.every(TICK_MS, () => void sync($))
}

// The mod's own calls to the app's session tools need no prompt; anything else (the model's calls) goes to the
// normal permission decision.
const allowMine: Hook<'tool.check'> = async ($, e, next) => {
  const mine = next.origin.plugin === PLUGIN || next.origin.plugin.startsWith(`${PLUGIN}@`)
  if (mine) {
    return { decision: 'allow', reason: 'pin-everywhere: Remote Control for pinned sessions' }
  }

  return next(e)
}

export const register: Register = on => {
  state.timer = undefined
  state.warned = false

  on('tool.check', { tool: GET }, allowMine)
  on('tool.check', { tool: LIST }, allowMine)
  on('tool.check', { tool: SET_RC }, allowMine)

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    startTicking($)

    return ran
  })

  // After each turn, outside the prompt's dispatch. A hot reload cancels the timer without a new session.start,
  // so the first turn after one starts it again.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (!state.timer) {
      startTicking($)
    }
    $.clock.after(0, () => void sync($))

    return ran
  })
}
