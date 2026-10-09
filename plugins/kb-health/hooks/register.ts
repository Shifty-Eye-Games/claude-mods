import type { EngineInterface, Register } from 'claude-code'

// KB health in the status line: the verdicts of the 30-minute kb-intelligence snapshot, whether the hourly
// kb-refresh still succeeds, and whether kb-serve runs the code on disk. It only reads files and asks lsof and
// ps (from the home folder): an untracked file in ~/.hermes would stop the hourly kb-refresh cycle.
const HOME = '/Users/tuncer'
const HERMES = `${HOME}/.hermes`
const SNAPSHOT_JOB = `${HOME}/Library/LaunchAgents/com.leela.kb-intelligence-snapshot.plist`
const SNAPSHOT = `${HERMES}/profiles/leela/wiki/kb-site/data/kb-intelligence.json`
const REFRESH_STATUS = `${HERMES}/state/kb-refresh/status.json`
// kb-serve's code: what serve_kb_site.py imports at start, and the chat_service it loads lazily.
const CODE_DIRS = [`${HERMES}/scripts/api`, `${HERMES}/scripts/lib`]
const CODE_FILES = [`${HERMES}/scripts/serve_kb_site.py`, `${HERMES}/scripts/chat_service.py`]
const PORT = '3901'
const CHECK_MS = 5 * 60_000
const SNAPSHOT_MAX_AGE_MS = 90 * 60_000 // the snapshot job runs every 30 minutes
const REFRESH_MAX_AGE_MS = 150 * 60_000 // kb-refresh runs hourly at :30 and skips 02:30
// kb-intelligence-status.py's healthy verdicts; every other status shows, UNKNOWN and new ones included.
const GOOD = new Set(['FRESH', 'IN_SYNC', 'INFO', 'OK'])
// Known, accepted verdicts. pr-deploy DIVERGED is the publish lane's standing lag (the served tree carries local
// publish commits origin/main doesn't have yet); a stuck hourly kb-refresh, the failure it could hide, shows as
// "kb-refresh last ok ... ago". Its other verdicts still show.
const ACCEPTED = new Set(['pr-deploy DIVERGED'])

type Snapshot = { generated_at?: unknown; workflows?: { id: string; status: string }[] }

const state = { timer: undefined as { cancel: () => void } | undefined, stale: new Set<string>() }

// `ps -o etime=` prints [[dd-]hh:]mm:ss.
function etimeSeconds(etime: string): number | undefined {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!m) {
    return undefined
  }
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])
}

// Python writes microseconds; keep milliseconds so Date.parse reads it everywhere.
const parseIso = (text: unknown) => Date.parse(String(text).replace(/(\.\d{3})\d+/, '$1'))

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

// Staleness counts on the second check in a row, so the minutes after the Mac wakes don't raise an alarm.
function confirmed(key: string, isStale: boolean): boolean {
  const wasStale = state.stale.has(key)
  if (isStale) {
    state.stale.add(key)
  } else {
    state.stale.delete(key)
  }
  return isStale && wasStale
}

async function snapshotProblems($: EngineInterface, now: number): Promise<string[]> {
  let snap: Snapshot
  try {
    snap = JSON.parse(String(await $.fs.read(SNAPSHOT))) as Snapshot
  } catch {
    return ['snapshot missing']
  }
  const workflows = Array.isArray(snap.workflows) ? snap.workflows : []
  if (workflows.length === 0) {
    return ['snapshot empty']
  }
  const problems = workflows
    .filter(w => !GOOD.has(w.status) && !ACCEPTED.has(`${w.id} ${w.status}`))
    .map(w => `${w.id} ${String(w.status).toLowerCase().replace(/_/g, ' ')}`)
  const age = now - parseIso(snap.generated_at)
  if (confirmed('snapshot', !(age <= SNAPSHOT_MAX_AGE_MS))) {
    problems.push(Number.isNaN(age) ? 'snapshot undated' : `snapshot ${ago(age)} old`)
  }
  return problems
}

async function refreshProblem($: EngineInterface, now: number): Promise<string | undefined> {
  let age = NaN
  try {
    age = now - parseIso((JSON.parse(String(await $.fs.read(REFRESH_STATUS))) as { last_successful_at?: unknown }).last_successful_at)
  } catch {
    age = NaN
  }
  if (!confirmed('refresh', !(age <= REFRESH_MAX_AGE_MS))) {
    return undefined
  }
  return Number.isNaN(age) ? 'kb-refresh status unreadable' : `kb-refresh last ok ${ago(age)} ago`
}

// The process listening on :3901 is kb-serve (launchd's PID can be a relaunch that never bound the port).
// ponytail: imports beyond CODE_DIRS/CODE_FILES are missed; add them if the server grows new ones.
async function kbServeProblem($: EngineInterface, now: number): Promise<string | undefined> {
  const listening = await $.process.run(['/usr/sbin/lsof', '-nP', '-t', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { cwd: HOME }).catch(() => undefined)
  const pid = listening?.stdout.trim().split('\n')[0]
  if (!pid) {
    return 'kb-serve down'
  }
  const ps = await $.process.run(['/bin/ps', '-o', 'etime=', '-p', pid], { cwd: HOME }).catch(() => undefined)
  const up = ps === undefined ? undefined : etimeSeconds(ps.stdout)
  if (up === undefined) {
    return 'kb-serve ?'
  }
  let newest = 0
  try {
    for (const dir of CODE_DIRS) {
      for (const entry of await $.fs.list(dir)) {
        if (entry.kind === 'file' && entry.name.endsWith('.py')) {
          newest = Math.max(newest, entry.mtimeMs)
        }
      }
    }
    for (const file of CODE_FILES) {
      newest = Math.max(newest, (await $.fs.stat(file)).mtimeMs)
    }
  } catch {
    return 'kb-serve ?'
  }
  return newest > now - up * 1000 + 2_000 ? 'kb-serve restart needed' : undefined
}

async function check($: EngineInterface) {
  const now = await $.clock.now()
  const problems = await snapshotProblems($, now)
  for (const problem of [await refreshProblem($, now), await kbServeProblem($, now)]) {
    if (problem) {
      problems.push(problem)
    }
  }
  const shown = problems.length > 4 ? [...problems.slice(0, 4), `+${problems.length - 4} more`] : problems
  $.ui.status(shown.length > 0 ? `KB: ${shown.join(' · ')}` : 'KB ok')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    // The snapshot job's plist marks the KB Mac; anywhere else the mod stays silent.
    if (await $.fs.exists(SNAPSHOT_JOB)) {
      state.timer?.cancel()
      state.timer = $.clock.every(CHECK_MS, () => void check($))
      void check($)
    }

    return ran
  })
}
