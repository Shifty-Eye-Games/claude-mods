import type { Register } from 'claude-code'

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

export const register: Register = on => {
  // ponytail: plain module state, reset by a reload or restart; the worst case
  // is one extra bump. Not per repo: a fetch anywhere counts for 30 minutes.
  let fetchedAt = -Infinity
  let logoutAskedAt = -Infinity
  const bumpedAt = new Map<string, number>()

  on('tool.call', async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : undefined
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
