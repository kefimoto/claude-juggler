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
  statusAllInstalls,
  listAllInstalls,
  listAccountsForInstall,
  getAccountsForInstall,
  verifyStatus,
  withLock,
  getConfig,
  setThresholds,
  setClaudeDir,
  isInstalled,
  setPriming,
  checkUsage,
  getAccountsForCurrentDir,
  allAccountsAboveThreshold,
  shouldWarnNow,
  selectAccountByLoadBalancing,
  recordSwap,
  setAccountAutoswapEnabled,
  isAccountAutoswapEnabled,
} from "./lib";
import type { StatusRow } from "./lib";

function fmtResetsIn(resetsAt: number | null): string {
  if (!resetsAt) return "unknown";
  const mins = Math.round((resetsAt * 1000 - Date.now()) / 60000);
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  // 7d windows routinely sit dozens of hours out; "2d3h" beats "51h12m".
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`;
  return `${hours}h${mins % 60}m`;
}

function fmtUsageBar(pct: number | null): string {
  if (pct === null) return "?";
  const barWidth = 20;
  const filled = Math.round((pct / 100) * barWidth);
  let color = "\x1b[32m"; // green
  if (pct >= 90) color = "\x1b[31m"; // red
  else if (pct >= 75) color = "\x1b[33m"; // yellow
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  return `${color}${bar}\x1b[0m ${pct}%`;
}

/** Render one account: name line, then its 5h and 7d usage bars.
 * `indent` shifts the whole block for the nested `status-all` listing. */
function printAccountRow(r: StatusRow, indent = ""): void {
  const marker = r.active ? "*" : " ";
  const bold = r.active ? "\x1b[1m" : "";
  const reset = r.active ? "\x1b[0m" : "";
  console.log(`${indent}${marker} ${bold}${r.name.padEnd(16)}${reset} ${r.label}`);
  console.log(`${indent}  5h  ${fmtUsageBar(r.pct)}  resets in ${fmtResetsIn(r.resetsAt)}`);
  if (r.weeklyPct !== undefined && r.weeklyPct !== null) {
    console.log(`${indent}  7d  ${fmtUsageBar(r.weeklyPct)}  resets in ${fmtResetsIn(r.weeklyResetsAt ?? null)}`);
  }
}

function printStatusTable() {
  const rows = statusAll();
  const cfg = getConfig();
  if (rows.length === 0) {
    console.log("No accounts saved yet. Run: claude-juggler add <name>");
    return;
  }
  for (const r of rows) printAccountRow(r);
  if (cfg.loadBalancingStrategy !== "off") {
    console.log(
      `\n📊 Load balancing enabled: ${cfg.loadBalancingStrategy}` +
        (cfg.loadBalancingStrategy === "smart-lowest"
          ? ` (interval: ${cfg.loadBalancingMinSwapInterval}s, delta: ${cfg.loadBalancingMinUsageDelta}%)`
          : "")
    );
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
  add <name> [--priming|--no-priming]
                           Save the CURRENTLY LOGGED IN account as <name>
                           (run this right after \`claude auth login\`)
                           --priming: enable priming (default: ask if omitted)
                           --no-priming: disable priming (default: ask if omitted)
  remove <name>            Forget a saved account (must not be active)
  set-priming <name> <on|off>
                           Enable/disable automatic priming for an account
  set-autoswap-enabled <name> <on|off>
                           Enable/disable account for autoswap and load-balancing
                           (off = manual-only account)
  list                     List saved account names for current Claude install
  status                   Show all accounts' usage % and time-to-reset for current install
  use <name>               Switch to a specific account
  next                     Switch to the next account in rotation
  prev                     Switch to the previous account in rotation
  lowest                   Switch to the lowest-usage account
  current                  Print the currently active account name
  version                  Show version
  list-all                 List all Claude installations with saved accounts
  status-all               Show status across all Claude installations
  install [OPTIONS]        Configure /swap and /accounts Claude Code commands and hook
                           Options:
                             --install-cron: setup cron job
                             --no-cron: don't setup cron job
  uninstall                Remove Claude Code integration for current installation
  uninstall-all            Remove Claude Code integration for all installations
  config [show|set-warning|set-autoswap|set-strategy|set-cache-ttl|set-warning-throttle|set-lb-strategy|set-lb-interval|set-lb-delta|set-hook-verbosity]
                           View or edit config
                           show: display current config
                           set-warning <pct>: set warning threshold
                           set-autoswap <pct|off>: set autoswap or disable
                           set-strategy <next|prev|lowest>: set autoswap behavior
                           set-cache-ttl <seconds>: set usage cache TTL (default 30)
                           set-warning-throttle <seconds>: min seconds between warnings (default 300)
                           set-lb-strategy <off|drain-near-reset|smart-lowest>: load balancing strategy
                             drain-near-reset: prioritize high-usage accounts to drain quota before reset
                               (set autoswap=100 for aggressive draining)
                             smart-lowest: use lowest account with timing/delta heuristics
                           Reliability: If an account hits 100% usage, the swap is guaranteed to be
                             reported on the next hook call. The model will be notified.
                           set-lb-interval <seconds>: min seconds between swaps for smart-lowest (default 600)
                           set-lb-delta <percent>: min usage % difference for smart-lowest swap (default 5)
                           set-hook-verbosity <silent|on-autoswap|always-notify>: hook notification level (default on-autoswap)
  prime                    Check every account; ping any at 0% used
                           so its 5h window starts ticking (for cron)
  check-threshold [pct]    Exit 1 and print a warning if the active
                           account's usage is >= pct (default 95)
  hook-check [warn-pct] [autoswap-pct]
                           For use as a UserPromptSubmit hook: prints
                           additionalContext JSON when past threshold,
                           nothing otherwise. Never throws.
                           Optional args override config thresholds.
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

  // Check if claude-juggler is installed and warn if not (unless running install/uninstall/version or in test mode)
  if (cmd !== "install" && cmd !== "uninstall" && cmd !== "version" && !isInstalled() && !process.env.CLAUDE_JUGGLER_TEST) {
    console.warn("\n⚠️  claude-juggler is not installed in Claude Code yet.");
    console.warn("   Run `claude-juggler install` to enable:");
    console.warn("   • /swap and /accounts commands in Claude Code");
    console.warn("   • Automatic usage monitoring hook");
    console.warn("   • Optional cron job to keep windows warm\n");
  }

  switch (cmd) {
    case "add": {
      const name = rest[0];
      if (!name) return usage(), process.exit(1);
      let primingFlag: boolean | undefined;
      if (rest.includes("--priming")) {
        primingFlag = true;
      } else if (rest.includes("--no-priming")) {
        primingFlag = false;
      }
      // If neither flag specified, pass undefined to prompt interactively
      const data = withLock(() => addAccount(name, primingFlag));
      const primingStatus = data.priming ? "priming enabled" : "priming disabled";
      console.log(`Saved current account as "${name}" (${data.label}) - ${primingStatus}.`);
      break;
    }
    case "remove": {
      const name = rest[0];
      if (!name) return usage(), process.exit(1);
      withLock(() => removeAccount(name));
      console.log(`Removed "${name}".`);
      break;
    }
    case "set-priming": {
      const name = rest[0];
      const state = rest[1];
      if (!name || !state) return usage(), process.exit(1);
      const enabled = state.toLowerCase() === "on";
      if (state.toLowerCase() !== "on" && state.toLowerCase() !== "off") {
        console.error("State must be 'on' or 'off'");
        process.exit(1);
      }
      withLock(() => setPriming(name, enabled));
      console.log(`Priming ${enabled ? "enabled" : "disabled"} for "${name}".`);
      break;
    }
    case "set-autoswap-enabled": {
      const name = rest[0];
      const state = rest[1];
      if (!name || !state) return usage(), process.exit(1);
      const enabled = state.toLowerCase() === "on";
      if (state.toLowerCase() !== "on" && state.toLowerCase() !== "off") {
        console.error("State must be 'on' or 'off'");
        process.exit(1);
      }
      withLock(() => setAccountAutoswapEnabled(name, enabled));
      console.log(`Autoswap ${enabled ? "enabled" : "disabled"} for "${name}".`);
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
    case "version": {
      try {
        const { readFileSync } = require("fs");
        const { join } = require("path");
        const pkgPath = join(__dirname, "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        console.log(`claude-juggler ${pkg.version}`);
      } catch {
        console.log("claude-juggler (version unknown)");
      }
      break;
    }
    case "list-all": {
      const installs = listAllInstalls();
      if (installs.length === 0) {
        console.log("No Claude installations with saved accounts found.");
        break;
      }
      for (const install of installs) {
        console.log(`${install.claudeDir}:`);
        if (install.accounts.length === 0) {
          console.log("  (no accounts)");
        } else {
          for (const name of install.accounts) {
            const marker = name === install.active ? "*" : " ";
            console.log(`  ${marker} ${name}`);
          }
        }
      }
      break;
    }
    case "status-all": {
      const installs = statusAllInstalls();
      if (installs.length === 0) {
        console.log("No Claude installations with saved accounts found.");
        break;
      }
      for (const install of installs) {
        console.log(`\n${install.claudeDir}:`);
        if (install.accounts.length === 0) {
          console.log("  (no accounts)");
          continue;
        }
        for (const r of install.accounts) printAccountRow(r, "  ");
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
    case "uninstall-all": {
      const installs = listAllInstalls();
      if (installs.length === 0) {
        console.log("No Claude installations with saved accounts found.");
        break;
      }
      for (const install of installs) {
        setClaudeDir(install.claudeDir);
        console.log(`Uninstalling from ${install.claudeDir}...`);
        uninstall();
      }
      break;
    }
    case "config": {
      const subCmd = rest[0];
      if (!subCmd || subCmd === "show") {
        const cfg = getConfig();
        console.log(`warningThreshold: ${cfg.warningThreshold}%`);
        console.log(`autoswapThreshold: ${cfg.autoswapThreshold === null ? "disabled" : cfg.autoswapThreshold + "%"}`);
        console.log(`autoswapStrategy: ${cfg.autoswapStrategy}`);
        console.log(`usageCacheTTL: ${cfg.usageCacheTTL}s`);
        console.log(`warningThrottle: ${cfg.warningThrottleSeconds}s`);
        console.log(`hookVerbosity: ${cfg.hookVerbosity} (silent|on-autoswap|always-notify)`);
        console.log(`loadBalancingStrategy: ${cfg.loadBalancingStrategy}`);
        if (cfg.loadBalancingStrategy !== "off") {
          console.log(`  ↳ minSwapInterval: ${cfg.loadBalancingMinSwapInterval}s, minUsageDelta: ${cfg.loadBalancingMinUsageDelta}%`);
        }
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
      } else if (subCmd === "set-cache-ttl") {
        const val = Number(rest[1]);
        if (isNaN(val) || val < 1) {
          console.error("Cache TTL must be >= 1 second");
          process.exit(1);
        }
        setThresholds(undefined, undefined, undefined, val);
      } else if (subCmd === "set-warning-throttle") {
        const val = Number(rest[1]);
        if (isNaN(val) || val < 0) {
          console.error("Warning throttle must be >= 0 seconds (0 = no throttle)");
          process.exit(1);
        }
        setThresholds(undefined, undefined, undefined, undefined, val);
      } else if (subCmd === "set-lb-strategy") {
        const strat = rest[1] as "off" | "drain-near-reset" | "smart-lowest";
        if (!["off", "drain-near-reset", "smart-lowest"].includes(strat)) {
          console.error("Load balancing strategy must be: off, drain-near-reset, or smart-lowest");
          process.exit(1);
        }
        setThresholds(undefined, undefined, undefined, undefined, undefined, strat);
      } else if (subCmd === "set-lb-interval") {
        const val = Number(rest[1]);
        if (isNaN(val) || val < 1) {
          console.error("Load balancing swap interval must be >= 1 second");
          process.exit(1);
        }
        setThresholds(undefined, undefined, undefined, undefined, undefined, undefined, val);
      } else if (subCmd === "set-lb-delta") {
        const val = Number(rest[1]);
        if (isNaN(val) || val < 0) {
          console.error("Load balancing usage delta must be >= 0 percent");
          process.exit(1);
        }
        setThresholds(undefined, undefined, undefined, undefined, undefined, undefined, undefined, val);
      } else if (subCmd === "set-hook-verbosity") {
        const verb = rest[1] as "silent" | "on-autoswap" | "always-notify";
        if (!["silent", "on-autoswap", "always-notify"].includes(verb)) {
          console.error("Hook verbosity must be: silent, on-autoswap, or always-notify");
          process.exit(1);
        }
        setThresholds(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, verb);
      } else {
        console.error("Unknown config subcommand. Use: show, set-warning, set-autoswap, set-strategy, set-cache-ttl, set-warning-throttle, set-lb-strategy, set-lb-interval, set-lb-delta, set-hook-verbosity");
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
      // Fast check of active account only (no temp dirs, no checking other accounts)
      // Just call /usage directly on the active Claude instance
      try {
        const cfg = getConfig();
        const currentName = currentAccount();
        if (!currentName) {
          process.exit(0);
          break;
        }

        const { pct, resetsAt } = checkUsage();
        if (pct === null) {
          process.exit(0);
          break;
        }

        const accountsData = getAccountsForCurrentDir();
        const label = accountsData[currentName]?.label || currentName;

        // Parse optional threshold arguments (default to config values)
        const warningThreshold = rest[0] ? Number(rest[0]) : cfg.warningThreshold;
        const autoswapThreshold = rest[1] ? Number(rest[1]) : cfg.autoswapThreshold;

        // Autoswap if at or above autoswap threshold
        if (autoswapThreshold !== null && pct >= autoswapThreshold) {
          // Check if all accounts are above the threshold
          if (allAccountsAboveThreshold(autoswapThreshold)) {
            // All accounts are above threshold, don't swap, just warn (with throttling)
            if (shouldWarnNow()) {
              const context =
                `⚠️  NOTIFY THE USER: All Accounts Above Autoswap Threshold\n` +
                `Your active Claude account "${currentName}" (${label}) is at ${pct}% usage ` +
                `(resets in ${fmtResetsIn(resetsAt)}), and all other accounts are also at or above ` +
                `the ${autoswapThreshold}% autoswap threshold.\n` +
                `Cannot autoswap—all accounts have hit the limit. User must wait for a usage window to reset.`;
              console.log(
                JSON.stringify({
                  hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
                })
              );
            }
            process.exit(0);
            break;
          }
          let targetName: string;
          try {
            if (cfg.autoswapStrategy === "next") {
              targetName = nextAccount();
            } else if (cfg.autoswapStrategy === "prev") {
              targetName = prevAccount();
            } else {
              targetName = lowestUsageAccount();
            }
            withLock(() => activate(targetName, true));
          } catch (e) {
            // Swap failed, warn user
            const context =
              `⚠️  CRITICAL: NOTIFY THE USER ⚠️\n` +
              `Your active Claude account "${currentName}" (${label}) is at ${pct}% usage ` +
              `(resets in ${fmtResetsIn(resetsAt)}), past the autoswap threshold of ${autoswapThreshold}%.\n` +
              `Autoswap FAILED. User must use /swap or \`claude-juggler next\` to manually switch accounts.`;
            console.log(
              JSON.stringify({
                hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
              })
            );
            process.exit(0);
            break;
          }

          // Re-check to get new account info
          const newName = currentAccount();
          const newLabel = accountsData[newName || ""]?.label || newName || "unknown";

          // Show swap message based on verbosity (autoswap threshold triggers are always notified in on-autoswap or always-notify mode)
          if (cfg.hookVerbosity === "always-notify" || cfg.hookVerbosity === "on-autoswap") {
            const context =
              `✓ NOTIFY THE USER: ACCOUNT SWAPPED\n` +
              `Automatically switched from "${currentName}" (${label}, was at ${pct}% usage) ` +
              `to "${newName}" (${newLabel}) using strategy "${cfg.autoswapStrategy}".`;
            console.log(
              JSON.stringify({
                hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
              })
            );
          }
        }
        // Warn if at or above warning threshold (with throttling)
        else if (pct >= warningThreshold) {
          if (shouldWarnNow()) {
            const context =
              `⚠️  NOTIFY THE USER: Usage Approaching Limit\n` +
              `Your active Claude account "${currentName}" (${label}) is at ${pct}% of its ` +
              `usage window (resets in ${fmtResetsIn(resetsAt)}), which is at or past the ${warningThreshold}% threshold.\n` +
              `User should consider switching accounts (e.g. /swap or \`claude-juggler next\`).`;
            console.log(
              JSON.stringify({
                hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
              })
            );
          }
        }

        // Load balancing: if autoswap didn't trigger and load balancing is enabled, consider switching
        if (cfg.loadBalancingStrategy !== "off" && (autoswapThreshold === null || pct < autoswapThreshold)) {
          const lbTarget = selectAccountByLoadBalancing();
          if (lbTarget && lbTarget !== currentName) {
            try {
              withLock(() => activate(lbTarget, true));
              recordSwap();

              // Notify if verbosity allows
              if (cfg.hookVerbosity === "always-notify") {
                const newName = currentAccount();
                const newLabel = accountsData[newName || ""]?.label || newName || "unknown";
                const context =
                  `✓ NOTIFY THE USER: ACCOUNT SWAPPED (LOAD BALANCING)\n` +
                  `Load balancing switched from "${currentName}" (${label}, at ${pct}% usage) ` +
                  `to "${newName}" (${newLabel}) using strategy "${cfg.loadBalancingStrategy}".`;
                console.log(
                  JSON.stringify({
                    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
                  })
                );
              }
            } catch {
              // Load balance swap failed, continue silently
            }
          }
        }
      } catch {
        // no accounts configured yet, or transient check failure - stay silent
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
