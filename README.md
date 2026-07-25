# claude-accounts

Switch between multiple Claude Code accounts instantly, in the same session,
no browser required. Built after discovering that Claude Code's own account
identity lives in two files on disk (`~/.claude/.credentials.json` for the
OAuth token, `~/.claude.json` for a display-only identity cache) and that
swapping the token takes effect **live**, even mid-conversation.

- **CLI**: `claude-accounts` — works standalone, outside Claude Code too.
- **Claude Code commands**: `/swap`, `/accounts`.
- **Optional hook**: automatically warns you (and recommends a swap) once
  your active account crosses a usage threshold (default 95%).
- **Cron-friendly priming**: keep every account's 5h usage window "warm" so
  refresh tokens don't go dormant and expire.

## How it works

Claude Code stores your OAuth token and a separate identity cache. This tool
saves a copy of each account's token under `~/.claude-accounts/accounts/`
and, on swap, does a careful read-modify-write of just the token field in
both live files — never a full overwrite, and it aborts loudly instead of
silently corrupting an account if its bookkeeping and the real live token
ever disagree.

**One counter-intuitive detail worth knowing**: the identity cache
(`~/.claude.json`'s `oauthAccount`, which things like `claude auth status`
read) can lag behind the real token for a bit, because Claude Code's own
running process periodically rewrites it from memory. The *token* is what
actually governs billing and rate limits, and it swaps reliably and
immediately — the display name catching up is cosmetic and can trail by a
turn or two.

## Install

Requires [Bun](https://bun.sh).

```bash
git clone <this-repo> ~/claude-accounts
cd ~/claude-accounts
bun link   # makes `claude-accounts` available on your PATH
```

### Set up your accounts

For each account you want to switch between: log in normally, then save it.

```bash
claude auth login          # or /login inside a Claude Code session
claude-accounts add personal
```

Log into your next account (`claude auth logout` then `claude auth login`
again) and save it under a different name:

```bash
claude-accounts add work
```

Repeat for as many accounts as you have. Names can be anything
alphanumeric (`personal`, `work`, `client-a`, ...).

### CLI usage

```bash
claude-accounts list              # saved account names
claude-accounts status            # usage % + time-to-reset for all of them
claude-accounts use work          # switch to a specific account
claude-accounts next              # rotate to the next one
claude-accounts current           # which one is active right now
```

### Claude Code commands

Copy (or symlink) the command files into your commands directory:

```bash
cp claude/commands/*.md ~/.claude/commands/
```

Now, inside any Claude Code session:

- `/swap` — swaps accounts. With exactly two accounts it just toggles; with
  three or more it asks which one you want.
- `/accounts` — shows every account's usage % and time-to-reset.

### Auto-stop hook (optional)

Warns you automatically once your active account crosses a usage threshold
(95% by default), showing every account's remaining usage so you can pick a
fresh one. Add to `~/.claude/settings.json` (merge, don't replace, if you
already have a `hooks` key):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/claude-accounts/claude/hooks/check-usage-hook.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Override the threshold with `CLAUDE_ACCOUNT_SWAP_THRESHOLD=90` in your
environment if 95% is too close for comfort.

### Keeping accounts warm (optional)

Claude's usage windows are rolling 5-hour periods that start on your first
message. `prime` checks every saved account's `/usage` (free — it's a local
report, not a model call) and sends a trivial ping only to ones sitting at
0%, so a window is never left idle without you noticing. Useful both to
avoid "wait, is my quota actually running yet" surprises, and to keep
infrequently-used accounts' refresh tokens exercised so they don't expire.

Add to cron (adjust the path):

```
*/20 * * * * /absolute/path/to/claude-accounts/bin/prime-cron.sh
```

Cron runs jobs with a minimal `PATH` — no `bun`, no `claude-accounts`.
Don't point cron directly at `src/cli.ts`; its `#!/usr/bin/env bun` shebang
needs `bun` on `PATH` just to start the process, which a bare cron
environment doesn't have. `bin/prime-cron.sh` runs everything through a login
shell (`bash -lc`) instead, so it resolves the same way your interactive
shell does (as long as your `.bashrc`/`.zshrc` is what puts `bun` and
`claude` on `PATH` — true for nvm/bun's default install instructions).

## Config location

Everything lives under `~/.claude-accounts/` (override with the
`CLAUDE_ACCOUNT_SWAP_DIR` environment variable): one JSON file per saved
account, `state.json` tracking which is active, and `prime.log` for the
priming cron job's history. Account files hold real OAuth tokens — they're
written `chmod 600`, but treat that directory like any other credential
store.

## Limitations

- Linux and macOS only (relies on POSIX file locking primitives available
  via `fs.mkdirSync`; not tested on Windows).
- If you go long enough without ever activating a saved account, its refresh
  token can expire on its own — `prime` (above) is the mitigation. If it
  does happen, just `claude auth login` again and re-run `add <name>`.
- The identity-cache lag described above means `claude auth status` right
  after a swap can briefly show the *previous* account's email even though
  billing has already moved to the new one. This is cosmetic only.

## License

MIT
