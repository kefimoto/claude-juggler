# claude-juggler

Switch between multiple Claude Code accounts instantly, in the same session, no browser required. Built after discovering that Claude Code's own account identity lives in two files on disk (`~/.claude/.credentials.json` for the OAuth token, `~/.claude.json` for a display-only identity cache) and that swapping the token takes effect **live**, even mid-conversation.

- **CLI**: `claude-juggler` — works standalone, outside Claude Code too. Also aliased as `juggler`.
- **Claude Code commands**: `/swap`, `/accounts` (installed via `install` command).
- **Optional hook**: automatically warns you (and recommends a swap) once your active account crosses a usage threshold (default 95%).
- **Per-account priming**: keep individual accounts' 5h usage windows "warm" so refresh tokens don't go dormant and expire.
- **Multi-install support**: manage accounts across multiple Claude installations on the same machine.

## How it works

Claude Code stores your OAuth token and a separate identity cache. This tool saves a copy of each account's token under `~/.claude-juggler/` and, on swap, does a careful read-modify-write of just the token field in both live files — never a full overwrite, and it aborts loudly instead of silently corrupting an account if its bookkeeping and the real live token ever disagree.

**One counter-intuitive detail worth knowing**: the identity cache (`~/.claude.json`'s `oauthAccount`, which things like `claude auth status` read) can lag behind the real token for a bit, because Claude Code's own running process periodically rewrites it from memory. The *token* is what actually governs billing and rate limits, and it swaps reliably and immediately — the display name catching up is cosmetic and can trail by a turn or two.

## Install

### Quick install (recommended)

```bash
bunx claude-juggler@beta install
# or
npx claude-juggler@beta install
# or (if globally installed)
claude-juggler install
```

This will:
- Create `/swap` and `/accounts` Claude Code commands
- Set up a usage-threshold hook (warns when usage is high)
- Optionally create a cron job to keep accounts "warm"

**Important**: The installation method you use is remembered. If you run `bunx claude-juggler@beta install`, all future commands (hooks, cron jobs, etc.) will use `bunx claude-juggler@beta`. If you don't specify a version (e.g., `bunx claude-juggler install`), it will automatically use the latest version.

### Set up your accounts

For each account you want to switch between: log in normally, then save it.

```bash
claude auth login                    # or /login inside Claude Code
claude-juggler add personal          # save current account as "personal"
```

Log into your next account (`claude auth logout` then `claude auth login` again) and save it:

```bash
claude-juggler add work
```

You'll be asked whether to enable automatic priming for each account (recommended for accounts you don't use frequently).

**Disable priming for specific accounts** (e.g., to save quota):

```bash
claude-juggler set-priming work off
```

Repeat for as many accounts as you have. Names can be anything alphanumeric (`personal`, `work`, `client-a`, ...).

## CLI usage

### Account management

```bash
claude-juggler list                  # saved account names (current install)
claude-juggler status                # usage % + time-to-reset for all
claude-juggler use work              # switch to a specific account
claude-juggler next                  # rotate to the next account
claude-juggler prev                  # rotate to the previous account
claude-juggler lowest                # switch to lowest-usage account
claude-juggler current               # which account is active now
claude-juggler version               # show version
```

### Per-account priming

```bash
claude-juggler add work --priming         # enable priming when adding
claude-juggler add side --no-priming      # disable priming when adding
claude-juggler set-priming work on        # enable priming for existing account
claude-juggler set-priming work off       # disable priming for existing account
```

### Multiple Claude installations

If you have multiple Claude installations (e.g., `~/.claude`, `~/.claude-beta`):

```bash
claude-juggler --claude-dir ~/.claude-beta add beta-work
claude-juggler --claude-dir ~/.claude-beta status
claude-juggler list-all                    # see all accounts across all installs
claude-juggler status-all                  # see status for all installs
```

### Setup and teardown

```bash
claude-juggler install                     # set up commands, hooks, and cron
claude-juggler uninstall                   # remove from current install
claude-juggler uninstall-all               # remove from all installs
```

### Configuration

```bash
claude-juggler config show                 # view warning/autoswap settings
claude-juggler config set-warning 90       # warn at 90% usage (hook shows warning, you decide)
claude-juggler config set-autoswap 99      # auto-swap at 99% (automatically switch accounts)
claude-juggler config set-strategy lowest  # auto-swap strategy: next, prev, or lowest
```

**Warning vs. Auto-swap:**
- **Warning threshold** (default 95%): the hook shows you a warning and recommends switching, but you stay on the current account until you act
- **Auto-swap threshold** (default 99%): claude-juggler automatically switches to a different account when you hit this usage level, then tells you which account you're on now

### Account removal

```bash
claude-juggler remove personal              # forget an account (can be active)
```

### Maintenance

```bash
claude-juggler prime                       # check all accounts' usage, ping ones at 0%
```

## Claude Code commands

Inside any Claude Code session:

- `/swap` — swaps accounts interactively. With two accounts it toggles; with three or more it asks which you want.
- `/accounts` — shows every account's usage % and time-to-reset.

These are created automatically by `claude-juggler install` in `~/.claude/commands/claude-juggler/`.

## Auto-stop hook (automatic)

Created automatically by `install`. Warns you once your active account crosses a usage threshold (95% by default), showing every account's remaining usage so you can pick a fresh one. Customize thresholds with:

```bash
claude-juggler config set-warning 90       # warn at 90%
claude-juggler config set-autoswap 95      # auto-swap at 95%
```

## Keeping accounts warm (automatic)

`prime` checks every saved account's `/usage` (free — it's a local report, not a model call) and sends a trivial ping only to ones sitting at 0%, so a window is never left idle. Useful both to avoid surprises, and to keep infrequently-used accounts' refresh tokens exercised so they don't expire.

Enabled by default during `install`. Respects per-account priming settings (skip with `--no-priming` when adding, or `set-priming <name> off` to disable for existing accounts).

Runs via cron every 20 minutes (configured during `install`).

## Config location

Everything lives under `~/.claude-juggler/`:

- `accounts.json` — all saved accounts, indexed by Claude installation directory
- `state.json` — active account per installation
- `prime.log` — priming cron job history
- `config.json` — warning/autoswap thresholds and strategy

Override `CLAUDE_JUGGLER_DIR` environment variable to use a different location. Account data includes real OAuth tokens — files are written `chmod 600`, but treat that directory like any other credential store.

## Limitations

- Linux and macOS only (relies on POSIX file locking primitives available via `fs.mkdirSync`; not tested on Windows).
- If you go long enough without ever activating a saved account, its refresh token can expire on its own — `prime` (above) is the mitigation. If it does happen, just `claude auth login` again and re-run `add <name>`.
- The identity-cache lag described above means `claude auth status` right after a swap can briefly show the *previous* account's email even though billing has already moved to the new one. This is cosmetic only.

## Troubleshooting

### "installation check warning" when running commands

This means `install` hasn't been run yet. Run:

```bash
claude-juggler install
```

### Hooks/cron not showing bunx or npx

Make sure you're running `install` via the same method you plan to use:

```bash
bunx claude-juggler@beta install      # if you'll use bunx
# or
npx claude-juggler@beta install       # if you'll use npx
```

This ensures hooks and cron jobs capture the right invocation method.

### Account stuck at high usage

If an account gets stuck above your warning threshold:

```bash
claude-juggler lowest                  # switch to lowest-usage account
```

Or manually set a lower warning threshold temporarily:

```bash
claude-juggler config set-warning 100
```

## License

MIT
