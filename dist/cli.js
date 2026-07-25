#!/usr/bin/env bun
import { addAccount, removeAccount, listAccounts, currentAccount, activate, nextAccount, prime, statusAll, verifyStatus, withLock, } from "./lib";
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
function printStatusTable() {
    const rows = statusAll();
    if (rows.length === 0) {
        console.log("No accounts saved yet. Run: claude-account-swap add <name>");
        return;
    }
    for (const r of rows) {
        const marker = r.active ? "*" : " ";
        const pct = r.pct === null ? "?" : `${r.pct}%`;
        console.log(`${marker} ${r.name.padEnd(16)} ${r.label.padEnd(28)} ${pct.padStart(4)} used, resets in ${fmtResetsIn(r.resetsAt)}`);
    }
}
function usage() {
    console.error(`claude-account-swap - switch between multiple Claude Code accounts

Usage:
  claude-account-swap add <name>       Save the CURRENTLY LOGGED IN account as <name>
                                        (run this right after \`claude auth login\`)
  claude-account-swap remove <name>    Forget a saved account (must not be active)
  claude-account-swap list             List saved account names
  claude-account-swap status           Show all accounts' usage % and time-to-reset
  claude-account-swap use <name>       Switch to a specific account
  claude-account-swap next             Switch to the next account in rotation
  claude-account-swap current          Print the currently active account name
  claude-account-swap prime            Check every account; ping any at 0% used
                                        so its 5h window starts ticking (for cron)
  claude-account-swap check-threshold [pct]
                                        Exit 1 and print a warning if the active
                                        account's usage is >= pct (default 95)
  claude-account-swap hook-check [pct] For use as a UserPromptSubmit hook: prints
                                        additionalContext JSON when past threshold,
                                        nothing otherwise. Never throws.
`);
}
function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    switch (cmd) {
        case "add": {
            const name = rest[0];
            if (!name)
                return usage(), process.exit(1);
            const data = withLock(() => addAccount(name));
            console.log(`Saved current account as "${name}" (${data.label}).`);
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
        case "current": {
            const name = currentAccount();
            console.log(name ?? "(none)");
            break;
        }
        case "prime":
            prime();
            break;
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
            // Emits the exact JSON a UserPromptSubmit hook needs on stdout: nothing
            // (silent no-op) when under threshold, or a hookSpecificOutput block
            // with additionalContext when the active account needs a swap. Never
            // throws on missing accounts/tooling - a broken check must not break
            // every turn.
            const threshold = rest[0] ? Number(rest[0]) : 95;
            try {
                const rows = statusAll();
                const active = rows.find((r) => r.active);
                if (active && active.pct !== null && active.pct >= threshold) {
                    const breakdown = rows
                        .map((r) => `  - ${r.name} (${r.label}): ${r.pct ?? "?"}% used, resets in ${fmtResetsIn(r.resetsAt)}`)
                        .join("\n");
                    const context = `Your active Claude account "${active.name}" (${active.label}) is at ${active.pct}% of its ` +
                        `usage window (resets in ${fmtResetsIn(active.resetsAt)}), which is past the ${threshold}% threshold.\n` +
                        `All accounts:\n${breakdown}\n` +
                        `Before doing further work, tell the user this and recommend switching accounts ` +
                        `(e.g. /swap or \`claude-account-swap next\`), naming a specific account below threshold if one exists.`;
                    console.log(JSON.stringify({
                        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
                    }));
                }
            }
            catch {
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
}
catch (e) {
    console.error(e.message ?? String(e));
    process.exit(1);
}
