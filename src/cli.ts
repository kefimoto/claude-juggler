#!/usr/bin/env bun
import {
  addAccount,
  removeAccount,
  listAccounts,
  currentAccount,
  activate,
  nextAccount,
  prevAccount,
  lowestUsageAccount,
  prime,
  install,
  uninstall,
  statusAll,
  listAllInstalls,
  listAccountsForInstall,
  getCurrentAccountForInstall,
  getAccountsForInstall,
  verifyStatus,
  withLock,
  getConfig,
  setThresholds,
  setClaudeDir,
} from "./lib";

function fmtResetsIn(resetsAt: number | null): string {
  if (!resetsAt) return "unknown";
  const mins = Math.round((resetsAt * 1000 - Date.now()) / 60000);
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

function printStatusTable() {
  const rows = statusAll();
  if (rows.length === 0) {
    console.log("No accounts saved yet. Run: claude-juggler add <name>");
    return;
  }
  for (const r of rows) {
    const marker = r.active ? "*" : " ";
    const pct = r.pct === null ? "?" : `${r.pct}%`;
    console.log(`${marker} ${r.name.padEnd(16)} ${r.label.padEnd(28)} ${pct.padStart(4)} used, resets in ${fmtResetsIn(r.resetsAt)}`);
  }
}

function usage(): void {
  console.error(`claude-juggler - switch between multiple Claude Code accounts

Usage:
  claude-juggler [--claude-dir <path>] <command> [options]

Global Options:
  --claude-dir <path>      Use a specific Claude installation directory (default: ~/.claude)
                           Can be used with any command to target a different Claude install

Commands:
  add <name>               Save the CURRENTLY LOGGED IN account as <name>
                           (run this right after \`claude auth login\`)
  remove <name>            Forget a saved account (must not be active)
  list                     List saved account names for current Claude install
  status                   Show all accounts' usage % and time-to-reset for current install
  use <name>               Switch to a specific account
  next                     Switch to the next account in rotation
  prev                     Switch to the previous account in rotation
  lowest                   Switch to the lowest-usage account
  current                  Print the currently active account name
  list-all-installs        List all Claude installations with saved accounts
  status-all-installs      Show status across all Claude installations
  install [OPTIONS]        Configure /swap and /accounts Claude Code commands and hook
                           Options:
                             --install-cron: setup cron job
                             --no-cron: don't setup cron job
  uninstall                Remove Claude Code integration and config
  config [show|set-warning|set-autoswap|set-strategy]
                           View or edit warning/autoswap thresholds
                           show: display current config
                           set-warning <pct>: set warning threshold
                           set-autoswap <pct|off>: set autoswap or disable
                           set-strategy <next|prev|lowest>: set autoswap behavior
  prime                    Check every account; ping any at 0% used
                           so its 5h window starts ticking (for cron)
  check-threshold [pct]    Exit 1 and print a warning if the active
                           account's usage is >= pct (default 95)
  hook-check [pct]         For use as a UserPromptSubmit hook: prints
                           additionalContext JSON when past threshold,
                           nothing otherwise. Never throws.
`);
}

function main(): void {
  const args = process.argv.slice(2);

  // Parse --claude-dir if provided and set it globally
  const claudeDirIdx = args.findIndex(arg => arg === "--claude-dir");
  if (claudeDirIdx !== -1 && claudeDirIdx + 1 < args.length) {
    setClaudeDir(args[claudeDirIdx + 1]);
    // Remove --claude-dir and its value from args
    args.splice(claudeDirIdx, 2);
  }

  const [cmd, ...rest] = args;

  switch (cmd) {
    case "add": {
      const name = rest[0];
      if (!name) return usage(), process.exit(1);
      const data = withLock(() => addAccount(name));
      console.log(`Saved current account as "${name}" (${data.label}).`);
      break;
    }
    case "remove": {
      const name = rest[0];
      if (!name) return usage(), process.exit(1);
      withLock(() => removeAccount(name));
      console.log(`Removed "${name}".`);
      break;
    }
    case "list": {
      const accounts = listAccounts();
      const active = currentAccount();
      if (accounts.length === 0) console.log("No accounts saved yet.");
      for (const name of accounts) console.log(name === active ? `* ${name}` : `  ${name}`);
      break;
    }
    case "status":
      printStatusTable();
      break;
    case "use": {
      const name = rest[0];
      if (!name) return usage(), process.exit(1);
      withLock(() => activate(name));
      verifyStatus();
      break;
    }
    case "next":
      withLock(() => activate(nextAccount()));
      verifyStatus();
      break;
    case "prev": {
      withLock(() => activate(prevAccount()));
      verifyStatus();
      break;
    }
    case "lowest": {
      withLock(() => activate(lowestUsageAccount()));
      verifyStatus();
      break;
    }
    case "current": {
      const name = currentAccount();
      console.log(name ?? "(none)");
      break;
    }
    case "list-all-installs": {
      const installs = listAllInstalls();
      if (installs.length === 0) {
        console.log("No Claude installations with saved accounts found.");
        break;
      }
      for (const install of installs) {
        const activeMarker = install.active ? " (active: " + install.active + ")" : "";
        console.log(`${install.claudeDir}: ${install.accountCount} account${install.accountCount === 1 ? "" : "s"}${activeMarker}`);
      }
      break;
    }
    case "status-all-installs": {
      const installs = listAllInstalls();
      if (installs.length === 0) {
        console.log("No Claude installations with saved accounts found.");
        break;
      }
      for (const install of installs) {
        console.log(`\n${install.claudeDir}:`);
        const accounts = getAccountsForInstall(install.claudeDir);
        const active = install.active;
        if (Object.keys(accounts).length === 0) {
          console.log("  (no accounts)");
          continue;
        }
        for (const [name, data] of Object.entries(accounts)) {
          const marker = name === active ? "*" : " ";
          console.log(`  ${marker} ${name.padEnd(16)} (${data.label})`);
        }
      }
      break;
    }
    case "prime":
      prime();
      break;
    case "install": {
      const installCron = rest.includes("--install-cron");
      const noCron = rest.includes("--no-cron");

      // Find --claude-dir value
      let claudeDir: string | undefined;
      const claudeDirIdx = rest.findIndex(arg => arg === "--claude-dir");
      if (claudeDirIdx !== -1 && claudeDirIdx + 1 < rest.length) {
        claudeDir = rest[claudeDirIdx + 1];
      }

      install({ installCron, noCron, claudeDir });
      break;
    }
    case "uninstall":
      uninstall();
      break;
    case "config": {
      const subCmd = rest[0];
      if (!subCmd || subCmd === "show") {
        const cfg = getConfig();
        console.log(`warningThreshold: ${cfg.warningThreshold}%`);
        console.log(`autoswapThreshold: ${cfg.autoswapThreshold === null ? "disabled" : cfg.autoswapThreshold + "%"}`);
        console.log(`autoswapStrategy: ${cfg.autoswapStrategy}`);
      } else if (subCmd === "set-warning") {
        const val = Number(rest[1]);
        if (isNaN(val) || val < 0 || val > 100) {
          console.error("Warning threshold must be 0-100");
          process.exit(1);
        }
        setThresholds(val);
      } else if (subCmd === "set-autoswap") {
        const val = rest[1] === "off" ? null : Number(rest[1]);
        if (val !== null && (isNaN(val) || val < 0 || val > 100)) {
          console.error("Autoswap threshold must be 0-100 or 'off'");
          process.exit(1);
        }
        setThresholds(undefined, val);
      } else if (subCmd === "set-strategy") {
        const strat = rest[1] as "next" | "prev" | "lowest";
        if (!["next", "prev", "lowest"].includes(strat)) {
          console.error("Strategy must be: next, prev, or lowest");
          process.exit(1);
        }
        setThresholds(undefined, undefined, strat);
      } else {
        console.error("Unknown config subcommand. Use: show, set-warning, set-autoswap, set-strategy");
        process.exit(1);
      }
      break;
    }
    case "check-threshold": {
      const threshold = rest[0] ? Number(rest[0]) : 95;
      const rows = statusAll();
      const active = rows.find((r) => r.active);
      if (!active || active.pct === null) process.exit(0);
      if (active.pct >= threshold) {
        console.log(
          `Active account "${active.name}" (${active.label}) is at ${active.pct}% usage ` +
            `(threshold ${threshold}%), resets in ${fmtResetsIn(active.resetsAt)}.\n` +
            rows.map((r) => `  ${r.name}: ${r.pct ?? "?"}% used, resets in ${fmtResetsIn(r.resetsAt)}`).join("\n")
        );
        process.exit(1);
      }
      process.exit(0);
      break;
    }
    case "hook-check": {
      // Emits the exact JSON a UserPromptSubmit hook needs on stdout: nothing
      // (silent no-op) when under threshold, or a hookSpecificOutput block
      // with additionalContext when the active account needs a swap or warning.
      // Never throws on missing accounts/tooling - a broken check must not break
      // every turn.
      try {
        const cfg = getConfig();
        const rows = statusAll();
        const active = rows.find((r) => r.active);
        if (active && active.pct !== null) {
          const breakdown = rows
            .map((r) => `  - ${r.name} (${r.label}): ${r.pct ?? "?"}% used, resets in ${fmtResetsIn(r.resetsAt)}`)
            .join("\n");

          // Autoswap if at or above autoswap threshold
          if (cfg.autoswapThreshold !== null && active.pct >= cfg.autoswapThreshold) {
            const context =
              `CRITICAL: Your active Claude account "${active.name}" (${active.label}) is at ${active.pct}% usage ` +
              `(resets in ${fmtResetsIn(active.resetsAt)}), past the autoswap threshold of ${cfg.autoswapThreshold}%.\n` +
              `Execute /swap immediately with strategy "${cfg.autoswapStrategy}" to switch accounts automatically.\n` +
              `All accounts:\n${breakdown}`;
            console.log(
              JSON.stringify({
                hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
              })
            );
          }
          // Warn if at or above warning threshold
          else if (active.pct >= cfg.warningThreshold) {
            const context =
              `Your active Claude account "${active.name}" (${active.label}) is at ${active.pct}% of its ` +
              `usage window (resets in ${fmtResetsIn(active.resetsAt)}), which is at or past the ${cfg.warningThreshold}% threshold.\n` +
              `All accounts:\n${breakdown}\n` +
              `Before doing further work, tell the user this and recommend switching accounts ` +
              `(e.g. /swap or \`claude-juggler next\`), naming a specific account below threshold if one exists.`;
            console.log(
              JSON.stringify({
                hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
              })
            );
          }
        }
      } catch {
        // no accounts configured yet, or a transient check failure - stay silent
      }
      process.exit(0);
      break;
    }
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
}

try {
  main();
} catch (e: any) {
  console.error(e.message ?? String(e));
  process.exit(1);
}
