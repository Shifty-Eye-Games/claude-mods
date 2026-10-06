import type { EngineInterface, Register } from 'claude-code'

// Pinning a session in the desktop app turns on its Remote Control, so the session shows on every other
// computer signed in to the same account (and the phone) with its title, machine icon included. Remote Control
// fixes the title it publishes when it connects, so the mod waits until machine-tag has put the machine's tag
// in the title before connecting. Unpinning turns Remote Control off again, but only when this mod turned it on.
//
// It acts on changes only (a pin or an unpin it has not seen yet), so turning Remote Control off by hand on a
// pinned session is left alone. To publish a later rename, unpin and pin again.
const PLUGIN = 'pin-everywhere'
const GET = 'mcp__ccd_session_mgmt__get_session'
const SET_RC = 'mcp__ccd_session_mgmt__set_remote_control'
const TICK_MS = 2 * 60_000
const TAGGED = /^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])* \S+ · /u

type Info = { id: string; title: string; pinned: boolean; rc: string; fromRemote: boolean }
// One store key per app session ("rc:<id>"), written only for pinned sessions: what the mod last saw and
// whether it was the one that turned Remote Control on.
type Seen = { pinned: boolean; owned: boolean }

const state = { busy: false, warned: false, timer: undefined as { cancel: () => void } | undefined }

function parse(text: string | undefined): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text ?? '')
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

async function readSelf($: EngineInterface): Promise<Info | undefined> {
  const verdict = await $.tool.check({ tool: GET, input: { session_id: 'self' } } as never).catch(() => undefined)
  if (verdict?.decision !== 'allow') {
    return undefined
  }
  const got = await $.tool.call({ tool: GET, session_id: 'self' } as never).catch(() => undefined)
  const row = parse(got?.text)
  if (!row || typeof row.sessionId !== 'string') {
    return undefined
  }

  return {
    id: row.sessionId,
    title: typeof row.title === 'string' ? row.title : '',
    pinned: row.pinned === true,
    rc: typeof row.remoteControlState === 'string' ? row.remoteControlState : '',
    fromRemote: row.startedViaRemoteControl === true,
  }
}

// Resolves to the state the app reports afterwards, or undefined when the call was refused or failed.
async function setRemoteControl($: EngineInterface, enabled: boolean): Promise<string | undefined> {
  const done = await $.tool.call({ tool: SET_RC, session_id: 'self', enabled } as never).catch(() => undefined)
  const row = parse(done?.text)

  return typeof row?.remoteControlState === 'string' ? row.remoteControlState : undefined
}

async function sync($: EngineInterface): Promise<void> {
  if (state.busy) {
    return
  }
  state.busy = true
  try {
    const me = await readSelf($)
    // Only explicit states: 'connecting' means wait; 'unavailable' or a missing field means this app can't.
    if (!me || me.fromRemote || (me.rc !== 'on' && me.rc !== 'off')) {
      return
    }
    const key = `rc:${me.id}`
    const raw = await $.store.get(key)
    const seen: Seen | undefined = raw && typeof raw === 'object' ? (raw as Seen) : undefined
    const wasPinned = seen?.pinned === true

    if (me.pinned && !wasPinned) {
      if (me.rc === 'on') {
        await $.store.set(key, { pinned: true, owned: false })
      } else if (TAGGED.test(me.title)) {
        const after = await setRemoteControl($, true)
        const ok = after === 'on' || after === 'connecting'
        await $.store.set(key, { pinned: true, owned: ok })
        if (!ok && !state.warned) {
          state.warned = true
          $.ui.toast('pin-everywhere: Remote Control could not be turned on for this pinned session.')
        }
      }
      // Not tagged yet: wait, so the title Remote Control publishes already carries the machine icon.
      return
    }
    if (!me.pinned && wasPinned) {
      if (seen?.owned && me.rc === 'on') {
        await setRemoteControl($, false)
      }
      await $.store.delete(key)
      return
    }
    // Still pinned, and the person turned Remote Control off by hand: stop owning it, never turn it back on.
    if (me.pinned && seen?.owned && me.rc === 'off') {
      await $.store.set(key, { pinned: true, owned: false })
    }
  } finally {
    state.busy = false
  }
}

function startTicking($: EngineInterface) {
  state.timer?.cancel()
  state.timer = $.clock.every(TICK_MS, () => void sync($))
}

export const register: Register = on => {
  // The mod's own Remote Control calls on this session need no prompt; anything else (the model's calls,
  // another session's id) goes to the normal permission decision.
  on('tool.check', { tool: SET_RC }, async ($, e, next) => {
    const input = (e.input ?? {}) as { session_id?: unknown }
    const mine = next.origin.plugin === PLUGIN || next.origin.plugin.startsWith(`${PLUGIN}@`)
    if (mine && input.session_id === 'self') {
      return { decision: 'allow', reason: 'pin-everywhere: Remote Control for this pinned session' }
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    startTicking($)

    return ran
  })

  // After each turn, outside the prompt's dispatch.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    $.clock.after(0, () => void sync($))

    return ran
  })
}
