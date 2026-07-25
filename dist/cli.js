#!/usr/bin/env bun
import { addAccount, removeAccount, listAccounts, currentAccount, activate, nextAccount, prevAccount, lowestUsageAccount, prime, install, uninstall, statusAll, statusAllInstalls, listAllInstalls, verifyStatus, withLock, getConfig, setThresholds, setClaudeDir, isInstalled, setPriming, checkUsage, getAccountsForCurrentDir, } from "./lib";
function fmtResetsIn(resetsAt) {
    if (!resetsAt)
        return "unknown";
    const mins = Math.round((resetsAt * 1000 - Date.now()) / 60000);
    if (mins <= 0)
        return "now";
    if (mins < 60)
        return `${mins}m`;
    return `${Math.floor(mins / 60)}h${mins % 60}m`;
}
function fmtUsageBar(pct) {
    if (pct === null)
        return "?";
    const barWidth = 20;
    const filled = Math.round((pct / 100) * barWidth);
    let color = "\x1b[32m"; // green
    if (pct >= 90)
        color = "\x1b[31m"; // red
    else if (pct >= 75)
        color = "\x1b[33m"; // yellow
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
    return `${color}${bar}\x1b[0m ${pct}%`;
}
function printStatusTable() {
    const rows = statusAll();
    if (rows.length === 0) {
        console.log("No accounts saved yet. Run: claude-juggler add <name>");
        return;
    }
    for (const r of rows) {
        const marker = r.active ? "*" : " ";
        const bold = r.active ? "\x1b[1m" : "";
        const reset = r.active ? "\x1b[0m" : "";
        console.log(`${marker} ${bold}${r.name.padEnd(16)}${reset} ${r.label}`);
        console.log(`  ${fmtUsageBar(r.pct)}  resets in ${fmtResetsIn(r.resetsAt)}`);
    }
}
function usage() {
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
function main() {
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
            if (!name)
                return usage(), process.exit(1);
            let primingFlag;
            if (rest.includes("--priming")) {
                primingFlag = true;
            }
            else if (rest.includes("--no-priming")) {
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
            if (!name)
                return usage(), process.exit(1);
            withLock(() => removeAccount(name));
            console.log(`Removed "${name}".`);
            break;
        }
        case "set-priming": {
            const name = rest[0];
            const state = rest[1];
            if (!name || !state)
                return usage(), process.exit(1);
            const enabled = state.toLowerCase() === "on";
            if (state.toLowerCase() !== "on" && state.toLowerCase() !== "off") {
                console.error("State must be 'on' or 'off'");
                process.exit(1);
            }
            withLock(() => setPriming(name, enabled));
            console.log(`Priming ${enabled ? "enabled" : "disabled"} for "${name}".`);
            break;
        }
        case "list": {
            const accounts = listAccounts();
            const active = currentAccount();
            if (accounts.length === 0)
                console.log("No accounts saved yet.");
            for (const name of accounts)
                console.log(name === active ? `* ${name}` : `  ${name}`);
            break;
        }
        case "status":
            printStatusTable();
            break;
        case "use": {
            const name = rest[0];
            if (!name)
                return usage(), process.exit(1);
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
            }
            catch {
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
                }
                else {
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
                for (const r of install.accounts) {
                    const marker = r.active ? "*" : " ";
                    const bold = r.active ? "\x1b[1m" : "";
                    const reset = r.active ? "\x1b[0m" : "";
                    console.log(`  ${marker} ${bold}${r.name.padEnd(16)}${reset} ${r.label}`);
                    console.log(`    ${fmtUsageBar(r.pct)}  resets in ${fmtResetsIn(r.resetsAt)}`);
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
            let claudeDir;
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
            }
            else if (subCmd === "set-warning") {
                const val = Number(rest[1]);
                if (isNaN(val) || val < 0 || val > 100) {
                    console.error("Warning threshold must be 0-100");
                    process.exit(1);
                }
                setThresholds(val);
            }
            else if (subCmd === "set-autoswap") {
                const val = rest[1] === "off" ? null : Number(rest[1]);
                if (val !== null && (isNaN(val) || val < 0 || val > 100)) {
                    console.error("Autoswap threshold must be 0-100 or 'off'");
                    process.exit(1);
                }
                setThresholds(undefined, val);
            }
            else if (subCmd === "set-strategy") {
                const strat = rest[1];
                if (!["next", "prev", "lowest"].includes(strat)) {
                    console.error("Strategy must be: next, prev, or lowest");
                    process.exit(1);
                }
                setThresholds(undefined, undefined, strat);
            }
            else {
                console.error("Unknown config subcommand. Use: show, set-warning, set-autoswap, set-strategy");
                process.exit(1);
            }
            break;
        }
        case "check-threshold": {
            const threshold = rest[0] ? Number(rest[0]) : 95;
            const rows = statusAll();
            const active = rows.find((r) => r.active);
            if (!active || active.pct === null)
                process.exit(0);
            if (active.pct >= threshold) {
                console.log(`Active account "${active.name}" (${active.label}) is at ${active.pct}% usage ` +
                    `(threshold ${threshold}%), resets in ${fmtResetsIn(active.resetsAt)}.\n` +
                    rows.map((r) => `  ${r.name}: ${r.pct ?? "?"}% used, resets in ${fmtResetsIn(r.resetsAt)}`).join("\n"));
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
                // Autoswap if at or above autoswap threshold
                if (cfg.autoswapThreshold !== null && pct >= cfg.autoswapThreshold) {
                    let targetName;
                    try {
                        if (cfg.autoswapStrategy === "next") {
                            targetName = nextAccount();
                        }
                        else if (cfg.autoswapStrategy === "prev") {
                            targetName = prevAccount();
                        }
                        else {
                            targetName = lowestUsageAccount();
                        }
                        withLock(() => activate(targetName, true));
                    }
                    catch (e) {
                        // Swap failed, warn user
                        const context = `CRITICAL: Your active Claude account "${currentName}" (${label}) is at ${pct}% usage ` +
                            `(resets in ${fmtResetsIn(resetsAt)}), past the autoswap threshold of ${cfg.autoswapThreshold}%.\n` +
                            `Autoswap failed; please use /swap or \`claude-juggler next\` to switch manually.`;
                        console.log(JSON.stringify({
                            hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
                        }));
                        process.exit(0);
                        break;
                    }
                    // Re-check to get new account info
                    const newName = currentAccount();
                    const newLabel = accountsData[newName || ""]?.label || newName || "unknown";
                    const context = `ACCOUNT SWAPPED: Automatically switched from "${currentName}" (${label}, was at ${pct}% usage) ` +
                        `to "${newName}" (${newLabel}) using strategy "${cfg.autoswapStrategy}".`;
                    console.log(JSON.stringify({
                        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
                    }));
                }
                // Warn if at or above warning threshold
                else if (pct >= cfg.warningThreshold) {
                    const context = `Your active Claude account "${currentName}" (${label}) is at ${pct}% of its ` +
                        `usage window (resets in ${fmtResetsIn(resetsAt)}), which is at or past the ${cfg.warningThreshold}% threshold.\n` +
                        `Before doing further work, consider switching accounts (e.g. /swap or \`claude-juggler next\`).`;
                    console.log(JSON.stringify({
                        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
                    }));
                }
            }
            catch {
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
}
catch (e) {
    console.error(e.message ?? String(e));
    process.exit(1);
}
