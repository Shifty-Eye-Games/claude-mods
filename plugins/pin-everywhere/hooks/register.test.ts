import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

type Row = { title?: string; pinned?: boolean; rc?: string; fromRemote?: boolean; archived?: boolean; listed?: boolean }
type Session = { title: string; pinned?: boolean; rc: string; fromRemote: boolean; archived: boolean; listed: boolean }

// Stands for the desktop app: its sessions (local_1 is this one), get_session / list_sessions reporting them,
// and set_remote_control flipping one. `calls` records each switch as "<id>:on" or "<id>:off". A session with
// listed: false is one list_sessions leaves out (archived, or past its limit); a deleted one is just absent.
const app = (on: On, rows: Record<string, Row> = { local_1: {} }, store?: Record<string, unknown>) => {
  const sessions: Record<string, Session> = {}
  for (const [id, row] of Object.entries(rows)) {
    sessions[id] = {
      title: row.title ?? '💻 MBP · Fix the nav',
      pinned: 'pinned' in row ? row.pinned : false,
      rc: row.rc ?? 'off',
      fromRemote: row.fromRemote ?? false,
      archived: row.archived ?? false,
      listed: row.listed ?? !row.archived,
    }
  }
  const report = (id: string) => ({
    sessionId: id,
    title: sessions[id].title,
    ...(sessions[id].pinned === undefined ? {} : { pinned: sessions[id].pinned }),
    isArchived: sessions[id].archived,
    remoteControlState: sessions[id].rc,
    startedViaRemoteControl: sessions[id].fromRemote,
  })
  const calls: string[] = []
  const gets: string[] = []
  const flags = { refuse: false, hang: false }
  const clock = mock.clock(on)
  mock.store(on, store)
  on('tool.call', ($, e) => {
    const input = e as unknown as { session_id?: string; enabled?: boolean }
    if (e.tool.endsWith('list_sessions')) {
      const list = Object.keys(sessions)
        .filter(id => id !== 'local_1' && sessions[id].listed)
        .map(id => {
          const { remoteControlState, startedViaRemoteControl, ...row } = report(id)
          return { ...row, remoteControlActive: remoteControlState === 'on' }
        })
      return { result: 'ok', text: JSON.stringify(list) }
    }
    const id = input.session_id === 'self' ? 'local_1' : String(input.session_id)
    if (e.tool.endsWith('get_session')) {
      gets.push(id)
    }
    if (!sessions[id]) {
      return { isError: true, result: 'no such session', text: 'no such session' }
    }
    if (e.tool.endsWith('get_session')) {
      return { result: 'ok', text: JSON.stringify(report(id)) }
    }
    calls.push(`${id}:${input.enabled ? 'on' : 'off'}`)
    if (flags.hang) {
      return new Promise(() => {})
    }
    if (flags.refuse) {
      return { isError: true, result: 'declined', text: 'declined' }
    }
    sessions[id].rc = input.enabled ? 'on' : 'off'
    return { result: 'ok', text: JSON.stringify({ sessionId: id, remoteControlState: sessions[id].rc }) }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  return { me: sessions.local_1, sessions, calls, gets, clock, flags }
}

const turn = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

async function afterTurn($: Parameters<Parameters<typeof test>[1]>[0], clock: { advance: (ms: number) => Promise<void> }) {
  await $.turn.complete(turn as never)
  await clock.advance(0)
}

async function start($: Parameters<Parameters<typeof test>[1]>[0]) {
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
}

test('pinning a tagged session turns Remote Control on, and unpinning turns it off again', async ($, on) => {
  const { me, calls, clock } = app(on, { local_1: { pinned: true } })
  await afterTurn($, clock)
  expect(calls).toEqual(['local_1:on'])
  expect(me.rc).toBe('on')

  me.pinned = false
  await afterTurn($, clock)
  expect(calls).toEqual(['local_1:on', 'local_1:off'])
  expect(me.rc).toBe('off')
})

test('waits for the machine tag before publishing, so the shared title carries the icon', async ($, on) => {
  const { me, calls, clock } = app(on, { local_1: { pinned: true, title: 'Fix the nav' } })
  await afterTurn($, clock)
  expect(calls).toEqual([])

  me.title = '💻 MBP · Fix the nav'
  await afterTurn($, clock)
  expect(calls).toEqual(['local_1:on'])
})

test('Remote Control the person turned on is never turned off by an unpin', async ($, on) => {
  const { me, calls, clock } = app(on, { local_1: { pinned: true, rc: 'on' } })
  await afterTurn($, clock)
  me.pinned = false
  await afterTurn($, clock)
  expect(calls).toEqual([])
  expect(me.rc).toBe('on')
})

test('a pinned session stays on: switched off, it comes back; unpinned, it stays off', async ($, on) => {
  const { me, calls, clock } = app(on, { local_1: { pinned: true } })
  await afterTurn($, clock)
  me.rc = 'off'
  await afterTurn($, clock)
  expect(calls).toEqual(['local_1:on', 'local_1:on'])

  me.pinned = false
  await afterTurn($, clock)
  await afterTurn($, clock)
  expect(calls).toEqual(['local_1:on', 'local_1:on', 'local_1:off'])
  expect(me.rc).toBe('off')
})

test('after an app restart, a pinned session whose Remote Control dropped is reconnected and owned', async ($, on) => {
  // The store remembers the pin from before the restart, written by the old mod as not owned.
  const { me, calls, clock } = app(on, { local_1: { pinned: true } }, { 'rc:local_1': { pinned: true, owned: false } })
  await afterTurn($, clock)
  expect(calls).toEqual(['local_1:on'])
  expect(me.rc).toBe('on')

  me.pinned = false
  await afterTurn($, clock)
  expect(calls).toEqual(['local_1:on', 'local_1:off'])
})

test("the timer reconnects this machine's other pinned sessions, including ones nobody has opened", async ($, on) => {
  const { sessions, calls, clock } = app(on, {
    local_1: {},
    local_2: { pinned: true, title: '🎮 Rig · Unity scene' },
    local_3: { pinned: true, rc: 'on' },
    local_4: { pinned: false },
    local_5: { pinned: true, title: 'Untagged' },
  })
  await start($)
  await clock.advance(2 * 60_000)
  expect(calls).toEqual(['local_2:on'])
  expect(sessions.local_2.rc).toBe('on')

  sessions.local_2.pinned = false
  await clock.advance(2 * 60_000)
  expect(calls).toEqual(['local_2:on', 'local_2:off'])
})

test('tracked sessions the list leaves out are still reconnected; archived or deleted ones are forgotten', async ($, on) => {
  const { calls, gets, clock } = app(
    on,
    {
      local_1: {},
      local_2: { pinned: true, listed: false },
      local_3: { pinned: true, archived: true },
    },
    {
      'rc:local_2': { pinned: true, owned: true },
      'rc:local_3': { pinned: true, owned: true },
      'rc:local_9': { pinned: true, owned: true },
    },
  )
  await afterTurn($, clock)
  expect(calls).toEqual(['local_2:on'])

  // The archived and the deleted session were forgotten, so the next sweep no longer asks about them.
  gets.length = 0
  await afterTurn($, clock)
  expect(gets.filter(id => id === 'local_3' || id === 'local_9')).toEqual([])
  expect(gets).toContain('local_2')
})

test('a session with no pin reported is never read as unpinned', async ($, on) => {
  const { sessions, calls, clock } = app(on, { local_1: {}, local_2: { pinned: true } })
  await afterTurn($, clock)
  expect(calls).toEqual(['local_2:on'])

  sessions.local_2.pinned = undefined
  await afterTurn($, clock)
  expect(calls).toEqual(['local_2:on'])
  expect(sessions.local_2.rc).toBe('on')
})

test('connecting, unavailable and phone-started sessions are not touched', async ($, on) => {
  const { me, calls, clock } = app(on, { local_1: { pinned: true, rc: 'connecting' } })
  await afterTurn($, clock)
  me.rc = 'unavailable'
  await afterTurn($, clock)
  me.rc = 'off'
  me.fromRemote = true
  await afterTurn($, clock)
  expect(calls).toEqual([])
})

test('a refused connect is retried after an hour, not every tick', async ($, on) => {
  const { calls, clock, flags } = app(on, { local_1: { pinned: true } })
  // The app refuses (the approval was declined), so Remote Control stays off.
  flags.refuse = true
  await start($)
  await afterTurn($, clock)
  expect(calls).toEqual(['local_1:on'])
  await clock.advance(30 * 60_000)
  expect(calls).toEqual(['local_1:on'])
  await clock.advance(32 * 60_000)
  expect(calls).toEqual(['local_1:on', 'local_1:on'])
})

test('a call left hanging (an approval nobody answers) times out instead of stopping the sweep', async ($, on) => {
  const { sessions, calls, clock, flags } = app(on, { local_1: {}, local_2: { pinned: true }, local_3: { pinned: true } })
  flags.hang = true
  await start($)
  await clock.advance(2 * 60_000)
  expect(calls).toEqual(['local_2:on'])
  await clock.advance(30_000)
  await clock.advance(30_000)
  expect(calls).toEqual(['local_2:on', 'local_3:on'])

  // Once the app answers again, the next tick still sweeps.
  flags.hang = false
  sessions.local_4 = { title: '💻 MBP · New', pinned: true, rc: 'off', fromRemote: false, archived: false, listed: true }
  await clock.advance(2 * 60_000)
  expect(calls).toEqual(['local_2:on', 'local_3:on', 'local_4:on'])
})

test("a session-tool check raised by anyone but the mod is decided as usual", async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const rc = await $.tool.check({ tool: 'mcp__ccd_session_mgmt__set_remote_control', input: { session_id: 'local_2', enabled: true } } as never)
  expect(rc.decision).toBe('ask')
  const list = await $.tool.check({ tool: 'mcp__ccd_session_mgmt__list_sessions', input: {} } as never)
  expect(list.decision).toBe('ask')
})
