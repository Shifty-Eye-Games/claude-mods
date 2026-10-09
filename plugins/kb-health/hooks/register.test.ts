import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-02T18:00:00Z')
const HOUR = 3_600_000
const FIVE_MIN = 5 * 60_000

const snapshot = (statuses: Record<string, string>, generatedAt = '2026-10-02T17:31:15.964159+00:00') =>
  JSON.stringify({ generated_at: generatedAt, map_schema_version: 1, workflows: Object.entries(statuses).map(([id, status]) => ({ id, status })) })

const ALL_GOOD = { 'doc-health': 'FRESH', schedule: 'IN_SYNC', nav: 'OK', 'schedule-roster-gap': 'INFO' }

type Setup = {
  snap?: string // absent: the file is missing
  refreshedAt?: string
  pid?: string // absent: nothing listens on :3901
  etime?: string
  codeMtime?: number
  isKbMac?: boolean
}

// Stands for the engine on the KB Mac: the snapshot and kb-refresh status files, lsof/ps, and the code's mtimes.
const engine = (on: On, o: Setup) => {
  const seen = { status: [] as (string | undefined)[] }
  const clock = mock.clock(on, { now: NOW })
  const result = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const code = o.codeMtime ?? NOW - 5 * HOUR
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: o.isKbMac ?? true }))
  on('fs.read', ($, e) => {
    if (e.path.endsWith('status.json')) {
      return { value: JSON.stringify({ last_successful_at: o.refreshedAt ?? '2026-10-02T17:35:55Z' }) }
    }
    if (o.snap === undefined) {
      throw new Error('ENOENT')
    }
    return { value: o.snap }
  })
  on('fs.list', () => ({ value: [{ name: 'contractor_access.py', kind: 'file' as const, size: 1, mtimeMs: code, isLink: false }] }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: code, isLink: false } }))
  on('process.run', ($, e) => (e.argv[0].endsWith('lsof') ? result(o.pid ? `${o.pid}\n` : '') : result(`${o.etime ?? '02:00:00'}\n`)))
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })

  return { clock, seen }
}

test('all healthy reads KB ok', async ($, on) => {
  const { clock, seen } = engine(on, { snap: snapshot(ALL_GOOD), pid: '57761' })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(seen.status.at(-1)).toBe('KB ok')
})

test('failing and unknown verdicts show by name; staleness only on the second check', async ($, on) => {
  const { clock, seen } = engine(on, {
    snap: snapshot({ ...ALL_GOOD, schedule: 'DRIFTED', levels: 'UNKNOWN' }, '2026-10-02T15:00:00+00:00'),
    pid: '57761',
  })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(seen.status.at(-1)).toBe('KB: schedule drifted · levels unknown')
  await clock.advance(FIVE_MIN)
  expect(seen.status.at(-1)).toBe('KB: schedule drifted · levels unknown · snapshot 3 h old')
})

test("pr-deploy's standing divergence is accepted", async ($, on) => {
  const { clock, seen } = engine(on, { snap: snapshot({ ...ALL_GOOD, 'pr-deploy': 'DIVERGED' }), pid: '57761' })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(seen.status.at(-1)).toBe('KB ok')
})

test('pr-deploy verdicts other than diverged show', async ($, on) => {
  const { clock, seen } = engine(on, { snap: snapshot({ ...ALL_GOOD, 'pr-deploy': 'UNKNOWN' }), pid: '57761' })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(seen.status.at(-1)).toBe('KB: pr-deploy unknown')
})

test('a stalled kb-refresh shows', async ($, on) => {
  const { clock, seen } = engine(on, { snap: snapshot(ALL_GOOD), pid: '57761', refreshedAt: '2026-10-02T14:00:00Z' })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  await clock.advance(FIVE_MIN)
  expect(seen.status.at(-1)).toBe('KB: kb-refresh last ok 4 h ago')
})

test('code newer than kb-serve (lib/ counts too) asks for a restart', async ($, on) => {
  const { clock, seen } = engine(on, { snap: snapshot(ALL_GOOD), pid: '57761', etime: '02:00:00', codeMtime: NOW - HOUR })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(seen.status.at(-1)).toBe('KB: kb-serve restart needed')
})

test('nothing listening on :3901 reads as down', async ($, on) => {
  const { clock, seen } = engine(on, { snap: snapshot(ALL_GOOD) })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(seen.status.at(-1)).toBe('KB: kb-serve down')
})

test('a day-long uptime with older code is fine', async ($, on) => {
  const { clock, seen } = engine(on, { snap: snapshot(ALL_GOOD), pid: '1', etime: '01-02:03:04', codeMtime: NOW - 27 * HOUR })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(seen.status.at(-1)).toBe('KB ok')
})

test('a missing snapshot is a problem, not silence', async ($, on) => {
  const { clock, seen } = engine(on, { pid: '57761' })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(seen.status.at(-1)).toBe('KB: snapshot missing')
})

test('off the KB Mac it stays silent', async ($, on) => {
  const { clock, seen } = engine(on, { isKbMac: false })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(seen.status.length).toBe(0)
})
