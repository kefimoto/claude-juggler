#!/usr/bin/env bun
/**
 * Core logic for switching between multiple Claude Code accounts by
 * swapping the OAuth credentials Claude Code reads from disk. Supports
 * any number of named accounts (not just two).
 *
 * Claude Code splits account state across two files:
 *   - ~/.claude/.credentials.json  -> { claudeAiOauth: { accessToken, ... } }
 *     This is the token that actually governs billing/rate limits. It
 *     takes effect live, immediately, even in an already-running session.
 *   - ~/.claude.json               -> { oauthAccount: { emailAddress, ... } }
 *     This is a *display* cache (used by things like `claude auth status`).
 *     It can lag behind the real token because the running app periodically
 *     rewrites it from its own in-memory copy. Never treat it as ground
 *     truth for identity, and never re-derive a saved account's identity
 *     from it — only the token needs refreshing between swaps.
 */
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmdirSync, readdirSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
export const CONFIG_DIR = process.env.CLAUDE_JUGGLER_DIR || join(homedir(), ".claude-juggler");
export const ACCOUNTS_DIR = join(CONFIG_DIR, "accounts");
export const STATE_PATH = join(CONFIG_DIR, "state.json");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const LOG_PATH = join(CONFIG_DIR, "prime.log");
const LOCK_DIR = join(CONFIG_DIR, ".lock.d");
const CREDS_PATH = join(homedir(), ".claude/.credentials.json");
const CLAUDE_JSON_PATH = join(homedir(), ".claude.json");
function readConfig() {
    if (!existsSync(CONFIG_PATH))
        return { warningThreshold: 95, autoswapThreshold: 99, autoswapStrategy: "lowest" };
    return readJSON(CONFIG_PATH);
}
function writeConfig(config) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeJSON(CONFIG_PATH, config);
}
export function getConfig() {
    const cfg = readConfig();
    return {
        warningThreshold: cfg.warningThreshold ?? 95,
        autoswapThreshold: cfg.autoswapThreshold === undefined ? 99 : cfg.autoswapThreshold,
        autoswapStrategy: cfg.autoswapStrategy ?? "lowest",
    };
}
export function setThresholds(warning, autoswap, strategy) {
    const cfg = readConfig();
    if (warning !== undefined)
        cfg.warningThreshold = warning;
    if (autoswap !== undefined)
        cfg.autoswapThreshold = autoswap;
    if (strategy !== undefined)
        cfg.autoswapStrategy = strategy;
    writeConfig(cfg);
    const final = getConfig();
    const swapStr = final.autoswapThreshold === null ? "disabled" : `${final.autoswapThreshold}% (${final.autoswapStrategy})`;
    console.log(`Config updated: warning=${final.warningThreshold}%, autoswap=${swapStr}`);
}
function readJSON(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}
function writeJSON(path, data, mode) {
    writeFileSync(path, JSON.stringify(data, null, 2));
    if (mode !== undefined)
        chmodSync(path, mode);
}
function fp(oauth) {
    return createHash("sha256").update(oauth.accessToken).digest("hex").slice(0, 12);
}
function ensureConfigDir() {
    mkdirSync(ACCOUNTS_DIR, { recursive: true });
    if (!existsSync(STATE_PATH))
        writeJSON(STATE_PATH, { active: null });
}
function accountPath(name) {
    return join(ACCOUNTS_DIR, `${name}.json`);
}
export function listAccounts() {
    ensureConfigDir();
    return readdirSync(ACCOUNTS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .sort();
}
function readState() {
    ensureConfigDir();
    return readJSON(STATE_PATH);
}
// Exclusive lock via atomic mkdir (portable, no native flock binding needed).
function sleep(ms) {
    if (typeof globalThis.Bun !== "undefined") {
        globalThis.Bun.sleepSync(ms);
    }
    else {
        execFileSync("sleep", [String(ms / 1000)]);
    }
}
export function withLock(fn) {
    ensureConfigDir();
    const deadline = Date.now() + 30_000;
    while (true) {
        try {
            mkdirSync(LOCK_DIR);
            break;
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw e;
            if (Date.now() > deadline)
                throw new Error("Timed out waiting for account lock");
            sleep(100);
        }
    }
    try {
        return fn();
    }
    finally {
        try {
            rmdirSync(LOCK_DIR);
        }
        catch {
            /* already gone */
        }
    }
}
/** Which saved account does the LIVE token actually match? null if none. */
export function groundTruthAccount() {
    if (!existsSync(CREDS_PATH))
        return null;
    const liveFp = fp(readJSON(CREDS_PATH).claudeAiOauth);
    for (const name of listAccounts()) {
        const data = readJSON(accountPath(name));
        if (fp(data.claudeAiOauth) === liveFp)
            return name;
    }
    return null;
}
export function currentAccount() {
    return readState().active;
}
/** Capture the CURRENTLY LIVE credentials as a new named account. Run this
 * right after a real `claude auth login` for that account. */
export function addAccount(name) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error("Account name must be alphanumeric (plus - and _).");
    }
    ensureConfigDir();
    const creds = readJSON(CREDS_PATH);
    const live = readJSON(CLAUDE_JSON_PATH);
    const data = {
        name,
        label: String(live.oauthAccount.emailAddress ?? name),
        oauthAccount: live.oauthAccount,
        claudeAiOauth: creds.claudeAiOauth,
    };
    writeJSON(accountPath(name), data, 0o600);
    const state = readState();
    if (state.active === null) {
        state.active = name;
        writeJSON(STATE_PATH, state);
    }
    return data;
}
export function removeAccount(name) {
    const path = accountPath(name);
    if (!existsSync(path))
        throw new Error(`No account named ${name}.`);
    const state = readState();
    if (state.active === name) {
        throw new Error(`Can't remove ${name}: it's the active account. Switch away first.`);
    }
    require("fs").unlinkSync(path);
}
/**
 * Safely make targetAccount the live account. No-ops if already active.
 * Throws if state.json's bookkeeping disagrees with the live token,
 * rather than silently overwriting an account's saved data.
 */
export function activate(targetName, quiet = false) {
    if (!existsSync(accountPath(targetName))) {
        throw new Error(`No account named ${targetName}. Known accounts: ${listAccounts().join(", ") || "(none)"}`);
    }
    const state = readState();
    const claimedName = state.active;
    if (claimedName !== null) {
        const realName = groundTruthAccount();
        if (realName !== claimedName) {
            throw new Error(`ABORT: state.json claims ${claimedName} is live, but the live token ` +
                `actually matches ${realName ?? "an UNKNOWN account"}. Not touching any account file.`);
        }
    }
    if (claimedName === targetName) {
        if (!quiet)
            console.log(`Already on ${targetName}.`);
        return targetName;
    }
    const creds = readJSON(CREDS_PATH);
    const live = readJSON(CLAUDE_JSON_PATH);
    // 1. Re-capture the CURRENT account's live TOKEN before leaving it (tokens
    // rotate). Identity is deliberately NOT re-derived here - see file header.
    if (claimedName !== null) {
        const currentPath = accountPath(claimedName);
        const current = readJSON(currentPath);
        current.claudeAiOauth = creds.claudeAiOauth;
        writeJSON(currentPath, current, 0o600);
    }
    // 2. Load target account into the live files (read-modify-write single keys only).
    const target = readJSON(accountPath(targetName));
    creds.claudeAiOauth = target.claudeAiOauth;
    writeJSON(CREDS_PATH, creds, 0o600);
    live.oauthAccount = target.oauthAccount;
    writeJSON(CLAUDE_JSON_PATH, live);
    // 3. Update the active pointer.
    state.active = targetName;
    writeJSON(STATE_PATH, state);
    if (!quiet) {
        const fromLabel = claimedName ? readJSON(accountPath(claimedName)).label : "(none)";
        console.log(`Swapped ${claimedName ?? "(none)"} (${fromLabel}) -> ${targetName} (${target.label})`);
    }
    return targetName;
}
/** Pick the "next" account in rotation after the current one. */
export function nextAccount() {
    const accounts = listAccounts();
    if (accounts.length === 0)
        throw new Error("No accounts saved yet. Run `add <name>` first.");
    const current = currentAccount();
    const idx = current ? accounts.indexOf(current) : -1;
    return accounts[(idx + 1) % accounts.length];
}
export function prevAccount() {
    const accounts = listAccounts();
    if (accounts.length === 0)
        throw new Error("No accounts saved yet. Run `add <name>` first.");
    const current = currentAccount();
    const idx = current ? accounts.indexOf(current) : -1;
    return accounts[(idx - 1 + accounts.length) % accounts.length];
}
export function lowestUsageAccount() {
    const rows = statusAll();
    if (rows.length === 0)
        throw new Error("No accounts saved yet. Run `add <name>` first.");
    let lowest = rows[0];
    for (const r of rows) {
        const rPct = r.pct ?? 100;
        const lowPct = lowest.pct ?? 100;
        if (rPct < lowPct)
            lowest = r;
    }
    return lowest.name;
}
function claude(args) {
    // bash -lc sources shell rc files (nvm init etc.) so `claude` resolves
    // under cron's minimal PATH, not just interactively.
    return execFileSync("bash", ["-lc", `claude ${args}`], {
        encoding: "utf8",
        timeout: 120_000,
    });
}
export function verifyStatus() {
    console.log("--- verifying ---");
    console.log(claude("auth status --json").trim());
}
/** Convert "Jul 24, 11:09pm" + IANA tz name -> epoch seconds. */
function zonedTimeToEpoch(monthDay, timeStr, tz) {
    const m = /^([A-Za-z]{3}) (\d{1,2}), (\d{1,2}):(\d{2})(am|pm)$/i.exec(`${monthDay}, ${timeStr}`);
    if (!m)
        return null;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthIdx = months.indexOf(m[1]);
    if (monthIdx === -1)
        return null;
    const day = Number(m[2]);
    let hour = Number(m[3]) % 12;
    if (m[5].toLowerCase() === "pm")
        hour += 12;
    const minute = Number(m[4]);
    const year = new Date().getFullYear();
    // Iterative zone-conversion trick: guess UTC = wall time, then correct
    // using the actual offset that timezone had at that instant.
    const guessUtc = Date.UTC(year, monthIdx, day, hour, minute);
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(guessUtc)).map((p) => [p.type, p.value]));
    const asIfUtcInTz = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
    const offsetError = asIfUtcInTz - guessUtc;
    return Math.floor((guessUtc - offsetError) / 1000);
}
/** Free local /usage report for whichever account is currently live. */
export function checkUsage() {
    const out = claude("-p /usage --output-format json");
    let events;
    try {
        events = JSON.parse(out);
    }
    catch {
        return { pct: null, resetsAt: null };
    }
    const resultEvent = events.find((e) => e.type === "result");
    const text = resultEvent?.result ?? "";
    // The "· resets ..." clause is absent entirely when usage is 0% (no
    // window running yet) - make it optional rather than requiring it, or
    // parsing silently fails on exactly the case priming most needs to catch.
    const m = /Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([A-Za-z]{3} \d{1,2}),\s*(\d{1,2}:\d{2}[ap]m)\s*\(([^)]+)\))?/.exec(text);
    if (!m)
        return { pct: null, resetsAt: null };
    const pct = Number(m[1]);
    const resetsAt = m[2] ? zonedTimeToEpoch(m[2], m[3], m[4]) : null;
    return { pct, resetsAt };
}
/** Send one trivial message on whichever account is currently live. */
export function ping() {
    claude("-p ok");
}
function logLine(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    writeFileSync(LOG_PATH, line, { flag: "a" });
}
/** For each saved account: check its 5h window (free) and ping it ONLY if
 * it shows 0% used. Never leaves the originally-active account swapped out. */
export function prime() {
    withLock(() => {
        const accounts = listAccounts();
        const original = currentAccount();
        try {
            for (const name of accounts) {
                activate(name, true);
                const { pct, resetsAt } = checkUsage();
                if (pct === null) {
                    logLine(`${name}: could not parse /usage output, skipping`);
                    continue;
                }
                if (pct === 0) {
                    ping();
                    logLine(`${name}: 0% used (window not started) -> pinged to start timer`);
                }
                else {
                    const resetStr = resetsAt ? new Date(resetsAt * 1000).toISOString() : "unknown";
                    logLine(`${name}: ${pct}% used, already ticking, resets ${resetStr}`);
                }
            }
        }
        finally {
            if (original)
                activate(original, true);
        }
    });
}
/** Usage snapshot for every saved account, without disturbing the
 * currently-active one for longer than the check itself takes. */
export function statusAll() {
    return withLock(() => {
        const accounts = listAccounts();
        const original = currentAccount();
        const results = [];
        try {
            for (const name of accounts) {
                activate(name, true);
                const { pct, resetsAt } = checkUsage();
                const label = readJSON(accountPath(name)).label;
                results.push({ name, label, active: name === original, pct, resetsAt });
            }
        }
        finally {
            if (original)
                activate(original, true);
        }
        return results;
    });
}
/** Setup Claude Code integration: create commands and configure hook. */
export function install(options = {}) {
    // Support old boolean signature for backwards compatibility
    const opts = typeof options === "boolean" ? { installCron: options } : options;
    const defaultClaudeDir = join(homedir(), ".claude");
    const claudeDir = opts.claudeDir || defaultClaudeDir;
    // Verify Claude directory exists
    if (!existsSync(claudeDir)) {
        throw new Error(`Claude Code directory not found at ${claudeDir}\n` +
            "Make sure Claude Code is installed and run: claude auth login\n" +
            "Or specify a custom directory: claude-juggler install --claude-dir <path>");
    }
    const commandsDir = join(claudeDir, "commands");
    const settingsPath = join(claudeDir, "settings.json");
    // Verify settings.json exists (indicates valid Claude install)
    if (!existsSync(settingsPath)) {
        console.warn(`Warning: ${settingsPath} not found. Claude Code may not be fully initialized.`);
    }
    // Determine installation method by checking if claude-juggler is globally available
    let installMethod = "global";
    try {
        execFileSync("which", ["claude-juggler"], { encoding: "utf8", timeout: 1000, stdio: "pipe" });
        // If we get here, claude-juggler is in PATH (globally installed)
        installMethod = "global";
    }
    catch {
        // Not globally installed, must be via bunx or npx
        // Try to detect which by checking if we're in a temp directory
        const scriptPath = process.argv[1] || "";
        if (scriptPath.includes("bunx") || scriptPath.includes(".bun") || scriptPath.includes("/tmp/bunx")) {
            installMethod = "bunx";
        }
        else {
            installMethod = "npx";
        }
    }
    // Save command prefix to config (will be set after we compute it)
    const cfg = readConfig();
    // Will be updated below after we determine cmdPrefix
    // Determine hook script path: find the package root by walking up from this file
    let pkgRoot = __dirname;
    while (!existsSync(join(pkgRoot, "package.json"))) {
        const parent = join(pkgRoot, "..");
        if (parent === pkgRoot)
            throw new Error("Could not find package root");
        pkgRoot = parent;
    }
    const hookScript = join(pkgRoot, "claude/hooks/check-usage-hook.sh");
    if (!existsSync(hookScript))
        throw new Error(`Hook script not found at ${hookScript}`);
    // Create commands directory if needed
    mkdirSync(commandsDir, { recursive: true });
    // Generate command prefix - try to extract version spec from parent process
    let cmdPrefix = "claude-juggler";
    if (installMethod !== "global") {
        const method = installMethod === "bunx" ? "bunx" : "npx";
        let versionSpec = "";
        // Try to find what version spec was used (e.g., @beta, @0.1.0) from parent process
        try {
            const fs = require("fs");
            const ppid = process.ppid;
            if (ppid) {
                const cmdLine = fs.readFileSync(`/proc/${ppid}/cmdline`, "utf8").split("\0").join(" ");
                const match = cmdLine.match(/claude-juggler(@[^\s]+)/);
                if (match)
                    versionSpec = match[1];
            }
        }
        catch {
            // Parent process not readable, no version spec found
        }
        cmdPrefix = versionSpec ? `${method} claude-juggler${versionSpec}` : `${method} claude-juggler`;
    }
    // Save command prefix to config for future use
    cfg.commandPrefix = cmdPrefix;
    writeConfig(cfg);
    // Write swap command
    const swapCmd = `---
description: Swap the active Claude account
allowed-tools: Bash(claude-juggler:*)
---

!\`${cmdPrefix} status\`

If no accounts are shown, tell the user to run:
\`${cmdPrefix} add <name>\` (right after logging into another account with \`claude auth login\`)

Otherwise, ask the user (AskUserQuestion) how they want to swap:
- "Next" → run \`${cmdPrefix} next\`
- "Previous" → run \`${cmdPrefix} prev\`
- "Lowest usage" → run \`${cmdPrefix} lowest\`
- Specific account name → run \`${cmdPrefix} use <name>\`

Once the swap completes, tell the user:
1. That the swap succeeded, naming the new account.
2. What email address currently appears in your own system prompt/context
   (the "userEmail" field, if present) — state it plainly, verbatim.
3. Whether it matches. If it does NOT match, note that the token swaps
   immediately (governs billing/rate limits), but Claude Code's identity
   cache can lag behind.
`;
    writeFileSync(join(commandsDir, "swap.md"), swapCmd);
    // Write accounts command
    const accountsCmd = `---
description: Show all saved accounts' usage % and time-to-reset
allowed-tools: Bash(claude-juggler status:*)
---

!\`${cmdPrefix} status\`

Present the table above to the user in plain language: which account is
currently active (marked with *), and each account's usage % and time until
its window resets. If any account is empty (no accounts saved), tell the
user to run \`${cmdPrefix} add <name>\` after logging in.
`;
    writeFileSync(join(commandsDir, "accounts.md"), accountsCmd);
    // Update settings.json hook
    let settings = {};
    if (existsSync(settingsPath)) {
        settings = readJSON(settingsPath);
    }
    if (!settings.hooks)
        settings.hooks = {};
    if (!settings.hooks.UserPromptSubmit)
        settings.hooks.UserPromptSubmit = [{ hooks: [] }];
    const hookEntry = settings.hooks.UserPromptSubmit[0];
    if (!hookEntry.hooks)
        hookEntry.hooks = [];
    // Remove any existing claude-juggler hook
    hookEntry.hooks = hookEntry.hooks.filter((h) => !h.command || !h.command.includes("check-usage-hook"));
    // Add the hook
    hookEntry.hooks.push({
        type: "command",
        command: hookScript,
        timeout: 10,
    });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    // Update prime-cron.sh with the correct command
    let primeCronCmd = "claude-juggler prime";
    if (installMethod === "bunx") {
        primeCronCmd = "bunx claude-juggler@beta prime";
    }
    else if (installMethod === "npx") {
        primeCronCmd = "npx claude-juggler@beta prime";
    }
    const primeCronPath = join(pkgRoot, "bin/prime-cron.sh");
    if (existsSync(primeCronPath)) {
        const primeCron = `#!/usr/bin/env bash
# Cron entry point for \`claude-juggler prime\`. Sources shell rc to get full PATH.
bash -lc '${primeCronCmd}'
`;
        writeFileSync(primeCronPath, primeCron, { mode: 0o755 });
    }
    console.log("✓ Created ~/.claude/commands/swap.md");
    console.log("✓ Created ~/.claude/commands/accounts.md");
    console.log(`✓ Updated ~/.claude/settings.json with hook: ${hookScript}`);
    if (existsSync(primeCronPath))
        console.log(`✓ Updated ${primeCronPath}`);
    // Setup cron job only if BOTH flags are set (non-interactive mode)
    if (opts.installCron && opts.claudeDir) {
        // Both flags set: fully non-interactive, auto-install cron
        setupCron(primeCronPath);
        console.log("✓ Added cron job: */20 * * * * " + primeCronPath);
    }
    else if (!opts.noCron) {
        // Interactive mode: suggest cron setup
        console.log("\nTo enable automatic account priming, run:");
        console.log("  claude-juggler install --install-cron");
    }
    console.log("\nSetup complete! Use /swap and /accounts in Claude Code, or run: claude-juggler [add|list|use|status]");
}
function shouldSetupCron() {
    // For now, return false - user must use -y flag or manually set up
    // In a future version with readline, could prompt interactively
    return false;
}
function setupCron(scriptPath) {
    try {
        // Get current crontab
        let crontab = "";
        try {
            crontab = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        }
        catch {
            // No existing crontab
            crontab = "";
        }
        // Check if already exists
        if (crontab.includes(scriptPath)) {
            return; // Already configured
        }
        // Add new cron entry
        const newEntry = `*/20 * * * * ${scriptPath}\n`;
        const newCrontab = crontab + newEntry;
        // Write new crontab
        execFileSync("crontab", ["-"], { encoding: "utf8", input: newCrontab, stdio: ["pipe", "pipe", "pipe"] });
    }
    catch (e) {
        throw new Error(`Failed to setup cron: ${e.message}`);
    }
}
/** Remove Claude Code integration and config. */
export function uninstall() {
    const claudeDir = join(homedir(), ".claude");
    const commandsDir = join(claudeDir, "commands");
    const settingsPath = join(claudeDir, "settings.json");
    const swapCmdPath = join(commandsDir, "swap.md");
    const accountsCmdPath = join(commandsDir, "accounts.md");
    // Remove command files
    if (existsSync(swapCmdPath)) {
        require("fs").unlinkSync(swapCmdPath);
        console.log("✓ Removed ~/.claude/commands/swap.md");
    }
    if (existsSync(accountsCmdPath)) {
        require("fs").unlinkSync(accountsCmdPath);
        console.log("✓ Removed ~/.claude/commands/accounts.md");
    }
    // Remove hook from settings.json
    if (existsSync(settingsPath)) {
        let settings = readJSON(settingsPath);
        if (settings.hooks?.UserPromptSubmit?.[0]?.hooks) {
            settings.hooks.UserPromptSubmit[0].hooks = settings.hooks.UserPromptSubmit[0].hooks.filter((h) => !h.command || !h.command.includes("check-usage-hook"));
            writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
            console.log("✓ Removed hook from ~/.claude/settings.json");
        }
    }
    // Remove config directory
    if (existsSync(CONFIG_DIR)) {
        require("fs").rmSync(CONFIG_DIR, { recursive: true });
        console.log(`✓ Removed ${CONFIG_DIR}`);
    }
    // Remove cron job
    try {
        let crontab = "";
        try {
            crontab = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        }
        catch {
            // No crontab to remove
            crontab = "";
        }
        if (crontab.includes("prime-cron.sh")) {
            const newCrontab = crontab
                .split("\n")
                .filter((line) => !line.includes("prime-cron.sh") && line.trim())
                .join("\n") + (crontab.endsWith("\n") ? "\n" : "");
            execFileSync("crontab", ["-"], { encoding: "utf8", input: newCrontab, stdio: ["pipe", "pipe", "pipe"] });
            console.log("✓ Removed cron job");
        }
    }
    catch {
        // Cron removal failed, but continue
    }
    console.log("\nUninstall complete!");
}
