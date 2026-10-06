# claude-mods

Private Claude Code marketplace for Tuncer's mods: function-hook plugins that run inside every Claude Code session on his machines (MacBook Pro, MacBook Air, therig, the 5090 PC).

| Plugin | What it does |
| --- | --- |
| `memory-guards` | Refuses the footgun commands Claude's memory notes warn about (for example `impeccable update --help`, routing shiftyeyegames.com DNS through cloudflared, `/logout` before `cswap add`) and says why, with the safe alternative. |
| `kb-health` | Shows KB health in the status line on the machine that runs the KB. It stays quiet on machines without the KB snapshot job. |
| `machine-tag` | Prefixes session titles with the machine's emoji tag (💻 MBP, 🪶 Air, 🎮 Rig, 🔥 5090), so pinned sessions show which computer they run on. `/machine-tag <emoji> <word>` overrides it per machine. |
| `pin-everywhere` | Pinning a session turns on its Remote Control once machine-tag has put the machine icon in the title, so the session shows by name and icon on every other computer and the phone. Unpinning turns it back off when this mod turned it on. A title is published when Remote Control connects, so after renaming a pinned session, unpin and pin it again to publish the new name. |

## Install on a machine

```bash
claude plugin marketplace add Shifty-Eye-Games/claude-mods
claude plugin install memory-guards@claude-mods
claude plugin install kb-health@claude-mods
claude plugin install machine-tag@claude-mods
claude plugin install pin-everywhere@claude-mods
```

Then turn on auto-update: in `/plugin`, open Marketplaces, pick `claude-mods` and enable auto-update, or set it in `~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "claude-mods": {
    "source": { "source": "github", "repo": "Shifty-Eye-Games/claude-mods" },
    "autoUpdate": true
  }
}
```

Each session start then pulls `main`. No versions are set, so every commit is an update.

The repo is private, so each machine needs GitHub access without a prompt: an SSH key GitHub knows (Claude Code tries `ssh -T git@github.com` first), or stored HTTPS credentials (`gh auth login` then `gh auth setup-git`, or Git Credential Manager on Windows). Without them the clone and the updates fail silently and the machine keeps its last copy.

Machines that loaded these mods from local folders before must drop those folders from `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, or each mod loads twice.

## Change a mod

1. Edit it under `plugins/<name>/`.
2. Check it: `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>`.
3. Push to `main`. Versions are left unset on purpose, so each commit reaches every machine at its next session start.

How mods work, and the engine rules that bite, are in Claude's memory note on Claude Code mods.

## Security

Auto-update is on, so whatever lands on `main` runs in every session on all four machines. Only org admins can push here (the org's default member permission is read). Keep it that way: never give anyone else write access.
