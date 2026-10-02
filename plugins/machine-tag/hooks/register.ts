import type { EngineInterface, Register } from 'claude-code'

// Prefixes each session's title with this machine's tag, an emoji and one word ("💻 MBP · Fix the nav"), so
// pinned and listed sessions show which computer they run on. A new session gets its tag at the prompt after
// its title appears. `/machine-tag 🛸 Box` sets this machine's tag (kept in this machine's store).
const TAG = /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])* \S+$/u
const KINDS: [RegExp, string][] = [
  [/macbook pro/i, '💻 MBP'],
  [/macbook air/i, '🪶 Air'],
  [/therig/i, '🎮 Rig'],
  [/tuncerhomepc/i, '🔥 5090'],
  [/mac studio/i, '🖥️ Studio'],
  [/mac mini/i, '📦 mini'],
]
// Tags that may sit in front of a title and get replaced: every machine's default, the colored dots the first
// version used, and this machine's earlier custom tags. Anything else (the person's own "🐛 Bug ·") is kept.
const OLD_TAGS = ['🔵 MBP', '🟢 Air', '🔴 Rig', '🟡 5090', '🟠 Studio', '🟣 mini']
const GET = 'mcp__ccd_session_mgmt__get_session'
const SET = 'mcp__ccd_session_mgmt__set_session_title'

// asked: titles already handled in this load. Renaming a title the person set asks them first; asking once
// per title means a "no" (or nobody there to answer) is never asked again.
const state = { derived: undefined as string | undefined, asked: new Set<string>() }

async function machineTag($: EngineInterface): Promise<string> {
  const saved = await $.store.get('tag') // read each time, so /machine-tag reaches every open session
  if (typeof saved === 'string' && TAG.test(saved)) {
    return saved
  }
  if (state.derived === undefined) {
    const mac = await $.process.run(['/usr/sbin/scutil', '--get', 'ComputerName']).catch(() => undefined)
    const host = mac?.exitCode === 0 ? mac : await $.process.run(['hostname']).catch(() => undefined)
    const name = host?.stdout.trim() || 'this-machine'
    const kind = KINDS.find(([pattern]) => pattern.test(name))
    state.derived = kind ? kind[1] : `🖥️ ${name.split(/[\s.]/)[0].slice(0, 12)}`
  }
  return state.derived
}

function tagged(title: string, tag: string, known: readonly string[]): string | undefined {
  if (title.startsWith(`${tag} · `)) {
    return undefined
  }
  let bare = title
  for (let found = true; found; ) {
    const old = known.find(t => bare.startsWith(`${t} · `))
    found = old !== undefined
    bare = old === undefined ? bare : bare.slice(old.length + 3)
  }
  bare = bare.trim()
  return bare ? `${tag} · ${bare}` : undefined
}

async function knownTags($: EngineInterface): Promise<string[]> {
  const earlier = await $.store.get('earlier')
  return [...KINDS.map(([, t]) => t), ...OLD_TAGS, ...(Array.isArray(earlier) ? earlier.map(String) : [])]
}

// Only with an allow rule: in other modes the call would raise a dialog or a classifier check nobody asked for.
async function isAllowed($: EngineInterface, tool: string, input: Record<string, string>): Promise<boolean> {
  const verdict = await $.tool.check({ tool, input } as never).catch(() => undefined)
  return verdict?.decision === 'allow'
}

// The desktop app keeps its own copy of the title and pushes it back each turn, so rename it there too,
// reading it first so a title that already matches costs nothing. Elsewhere (the CLI) these tools don't exist.
async function renameInApp($: EngineInterface, title: string) {
  if (!(await isAllowed($, GET, { session_id: 'self' })) || !(await isAllowed($, SET, { session_id: 'self', title }))) {
    return
  }
  const info = await $.tool.call({ tool: GET, session_id: 'self' } as never).catch(() => undefined)
  let current: unknown
  try {
    current = (JSON.parse(info?.text ?? '') as { title?: unknown }).title
  } catch {
    return
  }
  if (current !== title) {
    await $.tool.call({ tool: SET, session_id: 'self', title } as never).catch(() => undefined)
  }
}

// Returns the engine title to set, if any, and schedules the app's rename outside the prompt's dispatch.
async function onTitle($: EngineInterface, title: string | undefined): Promise<string | undefined> {
  if (!title || state.asked.has(title)) {
    return undefined
  }
  state.asked.add(title)
  const wanted = tagged(title, await machineTag($), await knownTags($))
  const inApp = wanted ?? title
  $.clock.after(0, () => void renameInApp($, inApp))
  return wanted
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({
      name: 'machine-tag',
      description: "Show or set this machine's session tag, e.g. /machine-tag 🛸 Box",
      argumentHint: '[emoji word]',
      immediate: true,
    })

    return ran
  })

  on('command.run', { command: 'machine-tag' }, async ($, e) => {
    const wanted = e.args.trim()
    if (!wanted) {
      return { text: `This machine tags its sessions "${await machineTag($)}". Change it with /machine-tag <emoji> <word>, e.g. /machine-tag 🛸 Box` }
    }
    if (!TAG.test(wanted)) {
      return { text: 'A tag is one emoji and one word, e.g. /machine-tag 🛸 Box' }
    }
    const earlier = await $.store.get('earlier')
    await $.store.set('earlier', [...(Array.isArray(earlier) ? earlier : []), await machineTag($)].slice(-10))
    await $.store.set('tag', wanted)
    state.asked.clear()

    return { text: `This machine now tags its sessions "${wanted}". Each open session picks it up at its next prompt.` }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const ran = await next(e)
    const wanted = ran.sessionTitle === undefined ? await onTitle($, e.session_title) : undefined

    return wanted === undefined ? ran : { ...ran, sessionTitle: wanted }
  })

  on('classic.SessionStart', async ($, e, next) => {
    const ran = await next(e)
    const wanted = ran.sessionTitle === undefined ? await onTitle($, e.session_title) : undefined

    return wanted === undefined ? ran : { ...ran, sessionTitle: wanted }
  })
}
