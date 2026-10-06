import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Stands for the desktop app: this session's row as get_session reports it, and set_remote_control flipping it.
const app = (on: On, row: { title?: string; pinned?: boolean; rc?: string; fromRemote?: boolean } = {}) => {
  const me = { title: row.title ?? '💻 MBP · Fix the nav', pinned: row.pinned ?? false, rc: row.rc ?? 'off', fromRemote: row.fromRemote ?? false }
  const calls: boolean[] = []
  const clock = mock.clock(on)
  mock.store(on)
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', ($, e) => {
    if (e.tool.endsWith('get_session')) {
      return {
        result: 'ok',
        text: JSON.stringify({
          sessionId: 'local_1',
          title: me.title,
          pinned: me.pinned,
          remoteControlState: me.rc,
          startedViaRemoteControl: me.fromRemote,
        }),
      }
    }
    const enabled = (e as unknown as { enabled: boolean }).enabled
    calls.push(enabled)
    me.rc = enabled ? 'on' : 'off'
    return { result: 'ok', text: JSON.stringify({ sessionId: 'local_1', remoteControlState: me.rc }) }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))

  return { me, calls, clock }
}

const turn = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

async function afterTurn($: Parameters<Parameters<typeof test>[1]>[0], clock: { advance: (ms: number) => Promise<void> }) {
  await $.turn.complete(turn as never)
  await clock.advance(0)
}

test('pinning a tagged session turns Remote Control on, and unpinning turns it off again', async ($, on) => {
  const { me, calls, clock } = app(on, { pinned: true })
  await afterTurn($, clock)
  expect(calls).toEqual([true])
  expect(me.rc).toBe('on')

  me.pinned = false
  await afterTurn($, clock)
  expect(calls).toEqual([true, false])
  expect(me.rc).toBe('off')
})

test('waits for the machine tag before publishing, so the shared title carries the icon', async ($, on) => {
  const { me, calls, clock } = app(on, { pinned: true, title: 'Fix the nav' })
  await afterTurn($, clock)
  expect(calls).toEqual([])

  me.title = '💻 MBP · Fix the nav'
  await afterTurn($, clock)
  expect(calls).toEqual([true])
})

test('Remote Control the person turned on is never turned off by an unpin', async ($, on) => {
  const { me, calls, clock } = app(on, { pinned: true, rc: 'on' })
  await afterTurn($, clock)
  me.pinned = false
  await afterTurn($, clock)
  expect(calls).toEqual([])
  expect(me.rc).toBe('on')
})

test('turning Remote Control off by hand on a pinned session is left alone', async ($, on) => {
  const { me, calls, clock } = app(on, { pinned: true })
  await afterTurn($, clock)
  me.rc = 'off'
  await afterTurn($, clock)
  await afterTurn($, clock)
  me.pinned = false
  await afterTurn($, clock)
  expect(calls).toEqual([true])
})

test('connecting, unavailable and phone-started sessions are not touched', async ($, on) => {
  const { me, calls, clock } = app(on, { pinned: true, rc: 'connecting' })
  await afterTurn($, clock)
  me.rc = 'unavailable'
  await afterTurn($, clock)
  me.rc = 'off'
  me.fromRemote = true
  await afterTurn($, clock)
  expect(calls).toEqual([])
})

test('the timer catches a pin made between turns', async ($, on) => {
  const { me, calls, clock } = app(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
  me.pinned = true
  await clock.advance(2 * 60_000)
  expect(calls).toEqual([true])
})

test("a Remote Control check raised by anyone but the mod is decided as usual", async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const self = await $.tool.check({ tool: 'mcp__ccd_session_mgmt__set_remote_control', input: { session_id: 'self', enabled: true } } as never)
  expect(self.decision).toBe('ask')
  const other = await $.tool.check({ tool: 'mcp__ccd_session_mgmt__set_remote_control', input: { session_id: 'local_2', enabled: true } } as never)
  expect(other.decision).toBe('ask')
})
