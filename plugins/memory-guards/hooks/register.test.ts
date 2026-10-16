import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Stands for the engine: every tool call succeeds unless its command says FAIL.
// The session runs in `cwd`; a folder ending in Repo is Graves23 by its git remote.
const engine = (on: On, cwd = '/Users/tuncer/Claude') => {
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: cwd }))
  on('process.run', ($, e) => {
    const dir = e.init?.cwd ?? cwd
    const remote = dir.endsWith('Repo')
      ? 'origin\thttps://dev.azure.com/ShiftyEye/Graves23/_git/Graves23 (fetch)\n'
      : dir.includes('.hermes')
        ? 'origin\thttps://github.com/Shifty-Eye-Games/knowledge-base.git (fetch)\n'
        : ''
    return {
      value: { exitCode: remote ? 0 : 128, stdout: remote, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('classic.WorktreeCreate', () => ({}))
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

test('copies of Graves23 and Castaway are refused from anywhere, every time', async ($, on) => {
  engine(on)
  for (const command of [
    String.raw`ssh therig "cd D:\Graves23 && git worktree add D:\Graves23_pr4692 origin/feature"`,
    'git -C D:/Graves23 worktree add --no-checkout ../Graves23_intel origin/develop',
    'git clone https://dev.azure.com/ShiftyEye/Graves23/_git/Graves23 D:/Graves23_copy',
    'git -C ~/Projects/Castaway archive HEAD -o /tmp/castaway.zip',
    'git --work-tree=D:/Graves23_x -C D:/Graves23 checkout origin/develop -- .',
    String.raw`robocopy D:\Graves23\MI\Library D:\Graves23_pr4692\MI\Library /E /MT:32`,
    String.raw`xcopy D:\Graves23 E:\Graves23_backup /E /I /H`,
    String.raw`powershell -Command "Copy-Item -Recurse 'D:\Graves23\MI\Assets' 'E:\assets'"`,
    'cp -R ~/.ub-test/graves23 /Volumes/T7/',
    'rsync -a ~/Projects/Castaway/ /Volumes/T7/Castaway/',
    'cp -r MI/Library /tmp/lib',
    'rsync -a D:/Graves23_GCC/MI/Assets/* /e/assets/',
    String.raw`cmd /c mklink /J D:\Graves23_shiftylogo\MI\Library D:\Graves23\MI\Library`,
    String.raw`New-Item -ItemType Junction -Path D:\G2 -Target D:\Graves23`,
    'ln -s ~/.ub-test/graves23/MI/Assets ~/g2assets',
    // robocopy D:\Graves23\MI\Library D:\Graves23_bikediff\MI\Library /E, sent as PowerShell -EncodedCommand
    'ssh therig powershell -NoProfile -EncodedCommand cgBvAGIAbwBjAG8AcAB5ACAARAA6AFwARwByAGEAdgBlAHMAMgAzAFwATQBJAFwATABpAGIAcgBhAHIAeQAgAEQAOgBcAEcAcgBhAHYAZQBzADIAMwBfAGIAaQBrAGUAZABpAGYAZgBcAE0ASQBcAEwAaQBiAHIAYQByAHkAIAAvAEUA',
  ]) {
    const { deny } = await $.tool.call(bash(command))
    expect(deny).toContain('big-project-branches.md')
    expect(deny).toContain("Tuncer's own yes")
    expect((await $.tool.call(bash(command))).deny).toBeDefined()
  }
})

test('look-alikes pass: reading branches, named files, KB worktrees, other repos', async ($, on) => {
  engine(on)
  for (const command of [
    'git -C D:/Graves23 show origin/develop:MI/Assets/Scripts/Player.cs',
    'git -C D:/Graves23 diff origin/develop origin/GCC/GCCDevelop -- MI/Assets/Scripts',
    'git -C D:/Graves23 commit -m "Fix clone of Graves23 weapon prefab"',
    'git -C D:/Graves23 fetch origin && git -C D:/Graves23 switch -c GCC/Tuncer/Feature origin/GCC/GCCDevelop',
    'cp D:/Graves23/MI/Assets/Scripts/Player.cs ./Player.cs',
    'cp ~/.ub-test/graves23/MI/Assets/Scripts/Foo.cs ~/Desktop/',
    String.raw`robocopy D:\Graves23\MI\Assets\Art D:\tmp hero.png`,
    String.raw`dir D:\Graves23\MI\Library`,
    'git -C ~/.hermes/profiles/leela/wiki worktree add /private/tmp/kb-wt origin/main',
    'git clone https://github.com/Shifty-Eye-Games/claude-mods ~/Claude/claude-mods-2',
    'cp -r ~/Claude/kb-dev /tmp/kb',
    'rg -n "git worktree add" ~/.claude/rules',
    // git -C D:\Graves23 status, sent as PowerShell -EncodedCommand
    'ssh pcwork powershell -EncodedCommand ZwBpAHQAIAAtAEMAIABEADoAXABHAHIAYQB2AGUAcwAyADMAIABzAHQAYQB0AHUAcwA=',
  ]) {
    expect((await $.tool.call(bash(command))).deny).toBeUndefined()
  }
  expect((await $.tool.call({ tool: 'EnterWorktree', name: 'kb-fix' })).deny).toBeUndefined()
  expect(
    (await $.tool.call({ tool: 'Agent', description: 'kb fix', prompt: 'fix it', isolation: 'worktree' })).deny,
  ).toBeUndefined()
})

test('inside a Graves23 checkout no worktree is made by shell, tool, agent, workflow or session', async ($, on) => {
  engine(on, String.raw`D:\Graves23`)
  expect((await $.tool.call(bash('git worktree add ../wt-feature origin/develop'))).deny).toContain(
    'big-project-branches.md',
  )
  expect((await $.tool.call(bash('git archive HEAD -o ../g.zip'))).deny).toBeDefined()
  expect((await $.tool.call(bash('git clone https://github.com/Shifty-Eye-Games/claude-mods /tmp/cm'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('git status'))).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'EnterWorktree', name: 'feature' })).deny).toContain('big-project-branches.md')
  expect((await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y', isolation: 'worktree' })).deny).toBeDefined()
  expect((await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' })).deny).toBeUndefined()
  const script = "export const meta = { name: 'x', description: 'y' }\nawait agent('fix', { isolation: 'worktree' })"
  expect((await $.tool.call({ tool: 'Workflow', script })).deny).toBeDefined()
  expect(
    (await $.tool.call({ tool: 'Workflow', script: script.replace("isolation: 'worktree'", "label: 'a'") })).deny,
  ).toBeUndefined()
  const session = { tool: 'mcp__ccd_session__start_session', title: 't', initiation: 'user_asked', prompt: 'p' }
  expect((await $.tool.call({ ...session, use_worktree: true } as never)).deny).toBeDefined()
  expect((await $.tool.call({ ...session, use_worktree: false } as never)).deny).toBeUndefined()
})

test('a renamed checkout counts by its git remote, a Mac one by its folder', async ($, on) => {
  engine(on, String.raw`C:\Users\tunce\Repo`)
  expect((await $.tool.call(bash(String.raw`git worktree add ..\Repo_kaela`))).deny).toBeDefined()
  expect((await $.tool.call({ tool: 'EnterWorktree', path: '/Users/tuncer/.ub-test/graves23-wt' })).deny).toBeDefined()
})

test('from a KB checkout worktrees are fine; entering a Graves23 worktree is not', async ($, on) => {
  engine(on, '/Users/tuncer/.hermes')
  expect((await $.tool.call(bash('git worktree add ../wt origin/main'))).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'EnterWorktree', name: 'kb-fix' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'EnterWorktree', path: 'D:/Graves23_pr4692' })).deny).toBeDefined()
})

test('the engine makes no worktree of a big project by any route', async ($, on) => {
  engine(on)
  const create = (cwd: string) => $.classic.WorktreeCreate({ name: 'agent-a1', cwd })
  expect((await create(String.raw`D:\Graves23\MI`)).block).toContain('big-project-branches.md')
  expect((await create('/Users/tuncer/Projects/Castaway')).block).toBeDefined()
  expect((await create(String.raw`C:\Users\tunce\Repo`)).block).toBeDefined()
  expect((await create('/Users/tuncer/.hermes')).block).toBeUndefined()
})
