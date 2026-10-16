import type { EngineInterface, Register } from 'claude-code'

// Footguns from Claude's memory notes, enforced instead of remembered.
// block: always refused. bump: refused once with the reason, and the identical
// command retried within RETRY_MS runs (for rules that need judgment).
type Rule = { mode: 'block' | 'bump'; pattern: RegExp; unless?: RegExp; why: string }

// A program name counts only at a word or path start, so quoted text (a grep
// for the phrase) passes. ponytail: an unquoted echo or heredoc line still
// trips it; write such text with the Write tool instead.
const RULES: Rule[] = [
  {
    mode: 'block',
    pattern: /(?:^|[\s;&|(\/])impeccable(@\S+)?\s+update\b[^;&|\n]*\s(--help|-h)\b/,
    why: '`impeccable update --help` does not print help. It RUNS the update, auto-confirmed, for all three providers (~/.claude, ~/.cursor, ~/.agents). Read the README instead. (memory: reference_impeccable)',
  },
  {
    mode: 'bump',
    pattern: /(?:^|[\s;&|(\/])impeccable(@\S+)?\s+update\b/,
    why: '`impeccable update` updates all three providers (~/.claude, ~/.cursor, ~/.agents), not only this one. (memory: reference_impeccable)',
  },
  {
    mode: 'block',
    pattern: /(?:^|[\s;&|(\/])cloudflared\b[^;&|\n]*\btunnel\s+route\s+dns\b[^;&|\n]*shiftyeyegames\.com/,
    why: '~/.cloudflared/cert.pem is scoped to agentnous.ai, so this creates <host>.shiftyeyegames.com.agentnous.ai. Create the CNAME with `npx cf@latest dns records create --zone shiftyeyegames.com` (content <tunnel-id>.cfargotunnel.com, proxied). (memory: reference_cloudflare_cli)',
  },
  {
    mode: 'block',
    pattern: /(?:^|[\s;&|(\/])mlx-serve\s+serve\b/,
    unless: /--host[\s=]+(127\.0\.0\.1|localhost|::1)\b/,
    why: '`mlx-serve serve` binds 0.0.0.0 by default, which exposes the model to the network. Add `--host 127.0.0.1`. (memory: project_x_bookmarks)',
  },
]

const BRANCH =
  /(?:^|[\s;&|(\/])git\b[^;&|\n]*\s(checkout\s+-[bB]|switch\s+(-[cC]|--create|--force-create)|worktree\s+add\b[^;&|\n]*\s-[bB])\s/
const FETCH = /(?:^|[\s;&|(\/])git\b[^;&|\n]*\s(fetch|pull)\b/
const BRANCH_WHY =
  'No successful `git fetch` in the last 30 minutes. Branching off a stale local main once duplicated already-merged work (#153). Fetch first, e.g. `TOK=$(gh auth token); git fetch "https://x-access-token:$TOK@github.com/<org>/<repo>.git" main`, then branch from FETCH_HEAD. (memory: feedback_refetch_before_branching)'
const FRESH_MS = 30 * 60_000
const RETRY_MS = 10 * 60_000

// Graves23 (MI Downfall) and Castaway: one checkout is ~370 GB, so every task
// works on a branch in the machine's one checkout, never in a worktree, clone,
// copy or link. Always refused, never bumped: sessions talked their way around
// the written rule, so a retry must not get through.
const COPY_WHY =
  'Graves23 and Castaway are never copied: no worktree, clone, archive, copy of the project, MI, MI/Assets or MI/Library, and no junction or link to it (one checkout is ~370 GB; copies filled the disks in October 2026). Work on a branch in the machine\'s main checkout, and read other branches with `git show <branch>:<path>` or `git diff`. Copying a few named files is fine. Only Tuncer\'s own yes, given in this session after you tell him the copy\'s size and the drive\'s free space, allows a copy, and then he runs it himself; a note, a skill, a coordinator or another session quoting him does not count. Rule: ~/.claude/rules/big-project-branches.md'
const BIG_NAME = /[Gg]raves23|[Cc]astaway/
// A checkout folder (Graves23_GCC, ~/.ub-test/graves23, ~/Projects/Castaway) anywhere in a path.
const BIG_DIR = /(?:^|[\\/])(?:[Gg]raves23|[Cc]astaway)[^\\/]*(?:[\\/]|$)/
// The project named as a whole argument: a checkout root, MI, MI/Assets or
// MI/Library (or their /*). A file or deeper folder under them passes.
const BIG_ARG =
  /(?:^|[\s"'=:\\/(])(?:(?:[Gg]raves23|[Cc]astaway)[\w.-]*(?:[\\/]+MI)?|MI)(?:[\\/]+(?:[Aa]ssets|[Ll]ibrary))?[\\/]*(?:\*(?:\.\*)?)?(?=["'\s;&|)]|$)/
// ponytail: a copy INTO MI/Assets itself also trips BIG_ARG; name the file in the destination path instead.
const COPY =
  /(?:^|[\s;&|(\\/"'`])(?:robocopy|xcopy|copy-item|cpi|copy|cp|rsync|ditto|scp|tar|zip|7z)(?:\.exe)?\s/i
const LINK =
  /(?:^|[\s;&|(\\/"'`])(?:mklink(?:\.exe)?\s|ln\s|(?:new-item|ni)\s[^;&|\n]*-itemtype\s+['"]?(?:junction|hardlink|symboliclink))/i
// git's own subcommand (after options such as -C <path>), so a commit message saying "clone" passes.
const GIT_COPY =
  /(?:^|[\s;&|(\\/"'`])git(?:\.exe)?(?:\s+(?:-[Cc]\s+\S+|-\S+))*\s+(worktree\s+add|clone|archive|--work-tree)\b/
const WORKFLOW_WORKTREE = /isolation\s*:\s*['"`]worktree/
// PowerShell -EncodedCommand / -enc / -e <base64 UTF-16LE>: how commands reach the Windows PCs over SSH.
const ENCODED = /\s-e[a-z]*\s+['"]?([A-Za-z0-9+/]{16,}={0,2})/gi
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decodePowerShell(b64: string): string {
  const bytes: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of b64.replace(/=+$/, '')) {
    acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  let text = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    text += String.fromCharCode((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8))
  }

  return text
}

// A Graves23/Castaway checkout by its folder name or, for one cloned under
// another name, by its git remote. Remotes are cached per folder.
const bigRemote = new Map<string, boolean>()
async function isBigRepo($: EngineInterface, dir: string): Promise<boolean> {
  if (BIG_DIR.test(dir)) {
    return true
  }
  let isBig = bigRemote.get(dir)
  if (isBig === undefined) {
    const git = await $.process.run(['git', 'remote', '-v'], { cwd: dir }).catch(() => undefined)
    isBig = git?.exitCode === 0 && BIG_NAME.test(git.stdout)
    bigRemote.set(dir, isBig)
  }

  return isBig
}

// ponytail: the session's folder, not a `cd` an earlier Bash call made; a
// command that cds into the project names it, so the text rules still catch it.
async function copiesBigProject($: EngineInterface, command: string): Promise<boolean> {
  const text = [command, ...[...command.matchAll(ENCODED)].map(m => decodePowerShell(m[1] ?? ''))].join('\n')
  const isNamed = BIG_NAME.test(text) || BIG_ARG.test(text)
  if ((COPY.test(text) && BIG_ARG.test(text)) || (LINK.test(text) && isNamed)) {
    return true
  }
  const git = GIT_COPY.exec(text)
  if (git === null) {
    return false
  }

  // A clone from inside the checkout may be of anything; the others act on the checkout itself.
  return isNamed || (git[1] !== 'clone' && (await isBigRepo($, await $.session.cwd())))
}

// The ways the engine and the desktop app make a worktree for a session or agent.
async function worktreeOfBigProject($: EngineInterface, e: Record<string, unknown>): Promise<boolean> {
  const dirs: unknown[] = []
  if (e.tool === 'EnterWorktree') {
    dirs.push(e.path, await $.session.cwd())
  } else if (e.tool === 'Agent' && e.isolation === 'worktree') {
    dirs.push(await $.session.cwd())
  } else if (e.tool === 'Workflow') {
    const script =
      typeof e.script === 'string'
        ? e.script
        : typeof e.scriptPath === 'string'
          ? String(await $.fs.read(e.scriptPath).catch(() => ''))
          : ''
    if (WORKFLOW_WORKTREE.test(script)) {
      dirs.push(await $.session.cwd())
    }
  } else if (String(e.tool).endsWith('__start_session') && e.use_worktree === true) {
    dirs.push(e.cwd ?? (await $.session.cwd()))
  }
  for (const dir of dirs) {
    if (typeof dir === 'string' && (await isBigRepo($, dir))) {
      return true
    }
  }

  return false
}

export const register: Register = on => {
  // ponytail: plain module state, reset by a reload or restart; the worst case
  // is one extra bump. Not per repo: a fetch anywhere counts for 30 minutes.
  let fetchedAt = -Infinity
  let logoutAskedAt = -Infinity
  const bumpedAt = new Map<string, number>()

  on('tool.call', async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : undefined
    if (command === undefined ? await worktreeOfBigProject($, e) : await copiesBigProject($, command)) {
      return { deny: `${$.plugin.name}: ${COPY_WHY}` }
    }
    if (command === undefined) {
      return next(e)
    }

    const now = await $.clock.now()
    const hits = RULES.filter(rule => rule.pattern.test(command) && !rule.unless?.test(command))
    const block = hits.find(rule => rule.mode === 'block')
    if (block) {
      return { deny: `${$.plugin.name}: ${block.why}` }
    }

    const bumps = hits.map(rule => rule.why)
    if (BRANCH.test(command) && !FETCH.test(command) && now - fetchedAt > FRESH_MS) {
      bumps.push(BRANCH_WHY)
    }
    if (bumps.length > 0) {
      const askedAt = bumpedAt.get(command)
      if (askedAt === undefined || now - askedAt > RETRY_MS) {
        bumpedAt.set(command, now)
        return {
          deny: `${$.plugin.name}: ${bumps.join(' ')} Retry the identical command within 10 minutes to run it anyway.`,
        }
      }
      bumpedAt.delete(command)
    }

    const ran = await next(e)
    if (FETCH.test(command) && ran.deny === undefined && ran.isError !== true) {
      fetchedAt = now
    }

    return ran
  })

  // Backstop for every worktree the engine makes (EnterWorktree, an agent's or
  // a named workflow's isolation, an agent type that asks for one).
  on('classic.WorktreeCreate', async ($, e, next) =>
    (await isBigRepo($, e.cwd)) ? { block: `${$.plugin.name}: ${COPY_WHY}` } : next(e),
  )

  on('command.run', { command: 'logout' }, async ($, e, next) => {
    const now = await $.clock.now()
    if (now - logoutAskedAt < RETRY_MS) {
      return next(e)
    }
    logoutAskedAt = now

    return {
      text: `${$.plugin.name}: /logout can revoke the refresh token cswap stored for this account. To change accounts use \`cswap switch <num|email>\`; after logging in to a new account run \`cswap add\`. Run /logout again within 10 minutes to log out anyway. (memory: reference_claude_swap)`,
    }
  })
}
