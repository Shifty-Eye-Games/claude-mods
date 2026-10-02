import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Stands for the engine on a machine whose name the test picks ('win:NAME' = Windows, no scutil), with the
// desktop app's session tools allowed (or not) and an app title the test can preset.
const engine = (on: On, o: { computerName?: string; decision?: 'allow' | 'ask' | 'deny'; appTitle?: string } = {}) => {
  const name = o.computerName ?? 'MacBook Pro M5 Max'
  const seen = { renames: [] as string[], appTitle: o.appTitle ?? 'Fix the nav' }
  const clock = mock.clock(on)
  mock.store(on)
  const result = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'machine-tag' } }))
  on('process.run', ($, e) => {
    if (e.argv[0].endsWith('scutil')) {
      if (name.startsWith('win:')) {
        throw new Error('ENOENT')
      }
      return result(0, `${name}\n`)
    }
    return result(0, `${name.replace('win:', '')}\r\n`)
  })
  on('tool.check', () => ({ decision: o.decision ?? 'allow' }))
  on('tool.call', ($, e) => {
    if (e.tool.endsWith('get_session')) {
      return { result: 'ok', text: JSON.stringify({ title: seen.appTitle }) }
    }
    seen.appTitle = 'title' in e ? String(e.title) : seen.appTitle
    seen.renames.push(seen.appTitle)
    return { result: 'renamed' }
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.SessionStart', () => ({}))

  return { clock, seen }
}

const prompt = (title?: string) => ({ prompt: 'hi', ...(title === undefined ? {} : { session_title: title }) })

test('a titled session gets the tag in the engine and the desktop app', async ($, on) => {
  const { clock, seen } = engine(on)
  expect((await $.classic.UserPromptSubmit(prompt('Fix the nav'))).sessionTitle).toBe('💻 MBP · Fix the nav')
  await clock.advance(0)
  expect(seen.renames).toEqual(['💻 MBP · Fix the nav'])
})

test('a title that is already tagged costs one app check and no rename once it matches', async ($, on) => {
  const { clock, seen } = engine(on, { appTitle: '💻 MBP · Fix the nav' })
  expect((await $.classic.UserPromptSubmit(prompt())).sessionTitle).toBeUndefined()
  expect((await $.classic.UserPromptSubmit(prompt('💻 MBP · Fix the nav'))).sessionTitle).toBeUndefined()
  await clock.advance(0)
  expect(seen.renames).toEqual([])
})

test('after a "no" the same title is never asked about again', async ($, on) => {
  const { clock, seen } = engine(on)
  await $.classic.UserPromptSubmit(prompt('My named session'))
  await clock.advance(0)
  seen.appTitle = 'My named session' // the person declined; the app pushes its title back
  expect((await $.classic.UserPromptSubmit(prompt('My named session'))).sessionTitle).toBeUndefined()
  await clock.advance(0)
  expect(seen.renames).toEqual(['💻 MBP · My named session'])
})

test('known machine tags and the old dots are replaced; the person\'s own emoji label is kept', async ($, on) => {
  engine(on)
  expect((await $.classic.UserPromptSubmit(prompt('🪶 Air · Fix the nav'))).sessionTitle).toBe('💻 MBP · Fix the nav')
  expect((await $.classic.UserPromptSubmit(prompt('🔵 MBP · Interesting post'))).sessionTitle).toBe('💻 MBP · Interesting post')
  expect((await $.classic.UserPromptSubmit(prompt('🐛 Bug · login crash'))).sessionTitle).toBe('💻 MBP · 🐛 Bug · login crash')
})

test('without an allow rule the desktop app is left alone; the engine title still gets the tag', async ($, on) => {
  const { clock, seen } = engine(on, { decision: 'ask' })
  expect((await $.classic.UserPromptSubmit(prompt('Fix the nav'))).sessionTitle).toBe('💻 MBP · Fix the nav')
  await clock.advance(0)
  expect(seen.renames).toEqual([])
})

test('a resumed session is tagged at start', async ($, on) => {
  engine(on, { computerName: 'Mac Studio' })
  expect((await $.classic.SessionStart({ source: 'resume', session_title: 'KB audit' })).sessionTitle).toBe('🖥️ Studio · KB audit')
})

test('an unknown machine gets a computer icon; /machine-tag takes one emoji and one word and replaces the old tag', async ($, on) => {
  engine(on, { computerName: 'renderbox' })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  expect((await $.classic.UserPromptSubmit(prompt('Render'))).sessionTitle).toBe('🖥️ renderbox · Render')
  expect((await $.command.run({ command: 'machine-tag', args: '🟡 Home PC' })).text).toContain('one emoji and one word')
  expect((await $.command.run({ command: 'machine-tag', args: '🛸 Box' })).text).toContain('🛸 Box')
  expect((await $.classic.UserPromptSubmit(prompt('🖥️ renderbox · Render'))).sessionTitle).toBe('🛸 Box · Render')
})

test('the PCs fall back to hostname and get their tags', async ($, on) => {
  engine(on, { computerName: 'win:THERIG' })
  expect((await $.classic.UserPromptSubmit(prompt('Unity build'))).sessionTitle).toBe('🎮 Rig · Unity build')
})

test('the 5090 PC reports a mixed-case name', async ($, on) => {
  engine(on, { computerName: 'win:TuncerHomePC' })
  expect((await $.classic.UserPromptSubmit(prompt('Render'))).sessionTitle).toBe('🔥 5090 · Render')
})
