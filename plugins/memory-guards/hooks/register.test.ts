import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Stands for the engine: every tool call succeeds unless its command says FAIL.
const engine = (on: On) => {
  const clock = mock.clock(on)
  on('tool.call', ($, e) =>
    'command' in e && String(e.command).includes('FAIL')
      ? { isError: true as const, result: 'failed' }
      : { result: 'ok' },
  )
  on('command.run', () => ({ text: 'logged out' }))

  return clock
}

const bash = (command: string) => ({ tool: 'Bash' as const, command })

test('hard blocks refuse every time; safe variants pass', async ($, on) => {
  engine(on)
  for (const command of [
    'npx impeccable@latest update --help',
    'cloudflared tunnel route dns kb-tunnel kb.shiftyeyegames.com',
    '~/tools/mlx-serve/mlx-serve-macos-arm64/mlx-serve serve --port 11234',
  ]) {
    expect((await $.tool.call(bash(command))).deny).toBeDefined()
    expect((await $.tool.call(bash(command))).deny).toBeDefined()
  }
  for (const command of [
    'ls -la',
    'cloudflared tunnel route dns kb-tunnel kb.agentnous.ai',
    'mlx-serve serve --host 127.0.0.1 --port 11234',
    'grep -n "mlx-serve serve" notes.md',
    'rg "git checkout -b" docs',
  ]) {
    expect((await $.tool.call(bash(command))).deny).toBeUndefined()
  }
})

test('a bump refuses once, then the identical retry runs', async ($, on) => {
  engine(on)
  const command = 'npx impeccable@latest update'
  expect((await $.tool.call(bash(command))).deny).toContain('all three providers')
  expect((await $.tool.call(bash(command))).deny).toBeUndefined()
})

test('branching needs a successful fetch in the last 30 minutes', async ($, on) => {
  const clock = engine(on)
  expect((await $.tool.call(bash('git checkout -b feat/a'))).deny).toContain('git fetch')
  expect((await $.tool.call(bash('git fetch origin main FAIL'))).isError).toBe(true)
  expect((await $.tool.call(bash('git switch -c feat/b'))).deny).toBeDefined()
  await $.tool.call(bash('git fetch origin main'))
  expect((await $.tool.call(bash('git switch -c feat/c'))).deny).toBeUndefined()
  await clock.advance(31 * 60_000)
  expect((await $.tool.call(bash('git worktree add ../wt -b feat/d'))).deny).toBeDefined()
  expect(
    (await $.tool.call(bash('git fetch origin main && git checkout -b feat/e FETCH_HEAD'))).deny,
  ).toBeUndefined()
})

test('/logout warns once, then runs', async ($, on) => {
  engine(on)
  expect((await $.command.run({ command: 'logout' })).text).toContain('cswap')
  expect((await $.command.run({ command: 'logout' })).text).toBe('logged out')
})
