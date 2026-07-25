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
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmdirSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
export const CONFIG_DIR = process.env.CLAUDE_JUGGLER_DIR || join(homedir(), ".claude-juggler");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const LOG_PATH = join(CONFIG_DIR, "prime.log");
const LOCK_DIR = join(CONFIG_DIR, ".lock.d");
// Global Claude directory - defaults to ~/.claude, can be overridden via CLAUDE_CONFIG_DIR env var or setClaudeDir()
let globalClaudeDir = process.env.CLAUDE_CONFIG_DIR
    ? process.env.CLAUDE_CONFIG_DIR.replace(/^~/, homedir())
    : join(homedir(), ".claude");
export function setClaudeDir(dir) {
    globalClaudeDir = dir.replace(/^~/, homedir());
}
// Unified accounts file: { "/path/to/claude": { "name": account_data, ... }, ... }
export const ACCOUNTS_FILE = join(CONFIG_DIR, "accounts.json");
// Get credentials path for current Claude install
function getCredsPath() {
    return join(globalClaudeDir, ".credentials.json");
}
// Get claude.json path: ~/.claude.json for default install, otherwise inside config dir
function getClaudeJsonPath() {
    const defaultClaudeDir = join(homedir(), ".claude");
    if (globalClaudeDir === defaultClaudeDir) {
        return join(homedir(), ".claude.json");
    }
    return join(globalClaudeDir, ".claude.json");
}
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
    mkdirSync(CONFIG_DIR, { recursive: true });
    if (!existsSync(ACCOUNTS_FILE))
        writeJSON(ACCOUNTS_FILE, {});
}
function getAccountsForCurrentDir() {
    ensureConfigDir();
    const allAccounts = readJSON(ACCOUNTS_FILE);
    return allAccounts[globalClaudeDir] || {};
}
function saveAccountsForCurrentDir(accounts) {
    ensureConfigDir();
    const allAccounts = readJSON(ACCOUNTS_FILE);
    allAccounts[globalClaudeDir] = accounts;
    writeJSON(ACCOUNTS_FILE, allAccounts);
}
export function listAccounts() {
    const accounts = getAccountsForCurrentDir();
    return Object.keys(accounts).sort();
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
    if (!existsSync(getCredsPath()))
        return null;
    const liveFp = fp(readJSON(getCredsPath()).claudeAiOauth);
    const accounts = getAccountsForCurrentDir();
    for (const name of Object.keys(accounts)) {
        if (fp(accounts[name].claudeAiOauth) === liveFp)
            return name;
    }
    return null;
}
export function currentAccount() {
    return groundTruthAccount();
}
/** Capture the CURRENTLY LIVE credentials as a new named account. Run this
 * right after a real `claude auth login` for that account. */
export function addAccount(name, priming) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error("Account name must be alphanumeric (plus - and _).");
    }
    ensureConfigDir();
    const creds = readJSON(getCredsPath());
    const live = readJSON(getClaudeJsonPath());
    // Ask about priming if not explicitly set
    let shouldPrime = priming;
    if (shouldPrime === undefined) {
        shouldPrime = promptYesNo("\nEnable automatic account priming? (Periodically pings account to keep 5-hour usage window ticking) ", true);
    }
    const data = {
        name,
        label: String(live.oauthAccount.emailAddress ?? name),
        oauthAccount: live.oauthAccount,
        claudeAiOauth: creds.claudeAiOauth,
        priming: shouldPrime,
    };
    const accounts = getAccountsForCurrentDir();
    accounts[name] = data;
    saveAccountsForCurrentDir(accounts);
    return data;
}
export function removeAccount(name) {
    const accounts = getAccountsForCurrentDir();
    if (!accounts[name])
        throw new Error(`No account named ${name}.`);
    delete accounts[name];
    saveAccountsForCurrentDir(accounts);
}
export function setPriming(name, enabled) {
    const accounts = getAccountsForCurrentDir();
    if (!accounts[name])
        throw new Error(`No account named ${name}.`);
    accounts[name].priming = enabled;
    saveAccountsForCurrentDir(accounts);
    return enabled;
}
/**
 * Safely make targetAccount the live account. No-ops if already active.
 * Throws if state's bookkeeping disagrees with the live token,
 * rather than silently overwriting an account's saved data.
 */
export function activate(targetName, quiet = false) {
    const accounts = getAccountsForCurrentDir();
    if (!accounts[targetName]) {
        throw new Error(`No account named ${targetName}. Known accounts: ${listAccounts().join(", ") || "(none)"}`);
    }
    const currentName = groundTruthAccount();
    if (currentName === targetName) {
        if (!quiet)
            console.log(`Already on ${targetName}.`);
        return targetName;
    }
    const creds = readJSON(getCredsPath());
    const live = readJSON(getClaudeJsonPath());
    // 1. Re-capture the CURRENT account's live TOKEN before leaving it (tokens rotate).
    if (currentName !== null) {
        accounts[currentName].claudeAiOauth = creds.claudeAiOauth;
        saveAccountsForCurrentDir(accounts);
    }
    // 2. Load target account into the live files (read-modify-write single keys only).
    const target = accounts[targetName];
    creds.claudeAiOauth = target.claudeAiOauth;
    writeJSON(getCredsPath(), creds, 0o600);
    live.oauthAccount = target.oauthAccount;
    writeJSON(getClaudeJsonPath(), live);
    if (!quiet) {
        const fromLabel = currentName ? accounts[currentName].label : "(none)";
        console.log(`Swapped ${currentName ?? "(none)"} (${fromLabel}) -> ${targetName} (${target.label})`);
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
        const accountNames = listAccounts();
        const accountsData = getAccountsForCurrentDir();
        const original = currentAccount();
        try {
            for (const name of accountNames) {
                // Skip accounts that have priming disabled
                if (accountsData[name]?.priming === false) {
                    logLine(`${name}: priming disabled, skipping`);
                    continue;
                }
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
        const accountNames = listAccounts();
        const accountsData = getAccountsForCurrentDir();
        const original = currentAccount();
        const results = [];
        try {
            for (const name of accountNames) {
                activate(name, true);
                const { pct, resetsAt } = checkUsage();
                const label = accountsData[name]?.label || name;
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
/** Get all Claude installations that have saved accounts. */
export function getAllInstalls() {
    ensureConfigDir();
    if (!existsSync(ACCOUNTS_FILE))
        return [];
    const allAccounts = readJSON(ACCOUNTS_FILE);
    return Object.keys(allAccounts).sort();
}
/** Get account names for a specific Claude installation without changing active dir. */
export function listAccountsForInstall(claudeDir) {
    ensureConfigDir();
    if (!existsSync(ACCOUNTS_FILE))
        return [];
    const allAccounts = readJSON(ACCOUNTS_FILE);
    return Object.keys(allAccounts[claudeDir] || {}).sort();
}
/** Get the active account for a specific Claude installation. */
export function getCurrentAccountForInstall(claudeDir) {
    const prevDir = globalClaudeDir;
    try {
        setClaudeDir(claudeDir);
        return groundTruthAccount();
    }
    catch {
        return null;
    }
    finally {
        setClaudeDir(prevDir);
    }
}
/** Get all accounts for a specific Claude installation without changing active dir. */
export function getAccountsForInstall(claudeDir) {
    ensureConfigDir();
    if (!existsSync(ACCOUNTS_FILE))
        return {};
    const allAccounts = readJSON(ACCOUNTS_FILE);
    return allAccounts[claudeDir] || {};
}
/** List all Claude installations with their account counts. */
export function listAllInstalls() {
    ensureConfigDir();
    if (!existsSync(ACCOUNTS_FILE))
        return [];
    const allAccounts = readJSON(ACCOUNTS_FILE);
    const results = [];
    for (const claudeDir of Object.keys(allAccounts).sort()) {
        const prevDir = globalClaudeDir;
        try {
            setClaudeDir(claudeDir);
            const active = groundTruthAccount();
            results.push({
                claudeDir,
                accounts: Object.keys(allAccounts[claudeDir] || {}),
                active,
            });
        }
        catch {
            // Skip installations that can't be checked
            results.push({
                claudeDir,
                accounts: Object.keys(allAccounts[claudeDir] || {}),
                active: null,
            });
        }
        finally {
            setClaudeDir(prevDir);
        }
    }
    return results;
}
/** Get status (usage + reset time) for all accounts across all installations. */
export function statusAllInstalls() {
    ensureConfigDir();
    if (!existsSync(ACCOUNTS_FILE))
        return [];
    const allAccounts = readJSON(ACCOUNTS_FILE);
    const results = [];
    for (const claudeDir of Object.keys(allAccounts).sort()) {
        const prevDir = globalClaudeDir;
        try {
            setClaudeDir(claudeDir);
            const rows = statusAll();
            results.push({ claudeDir, accounts: rows });
        }
        catch {
            // Skip installations that can't be checked
        }
        finally {
            setClaudeDir(prevDir);
        }
    }
    return results;
}
/** Check if claude-juggler is installed into the current Claude installation. */
export function isInstalled() {
    const commandsDir = join(globalClaudeDir, "commands", "claude-juggler");
    const swapCmdPath = join(commandsDir, "swap.md");
    return existsSync(swapCmdPath);
}
/** Setup Claude Code integration: create commands and configure hook. */
export function install(options = {}) {
    // Support old boolean signature for backwards compatibility
    const opts = typeof options === "boolean" ? { installCron: options } : options;
    const defaultClaudeDir = join(homedir(), ".claude");
    // Determine if we're in fully non-interactive mode (both --install-cron and --claude-dir set, or --no-cron and --claude-dir set)
    const isNonInteractive = (opts.claudeDir || globalClaudeDir !== defaultClaudeDir) && (opts.noCron || opts.installCron);
    let claudeDir;
    if (opts.claudeDir) {
        // Explicit CLI flag takes precedence
        claudeDir = opts.claudeDir.replace(/^~/, homedir());
    }
    else if (globalClaudeDir !== defaultClaudeDir) {
        // Use globally set claudeDir if different from default
        claudeDir = globalClaudeDir;
    }
    else if (!isNonInteractive) {
        // Interactive mode: ask for Claude directory
        const customDir = prompt(`Where is your Claude Code directory? [${defaultClaudeDir}] `);
        claudeDir = customDir ? customDir.replace(/^~/, homedir()) : defaultClaudeDir;
    }
    else {
        claudeDir = defaultClaudeDir;
    }
    // Verify Claude directory exists
    if (!existsSync(claudeDir)) {
        throw new Error(`Claude Code directory not found at ${claudeDir}\n` +
            "Make sure Claude Code is installed and run: claude auth login\n" +
            "Or specify a custom directory: claude-juggler install --claude-dir <path>");
    }
    const commandsDir = join(claudeDir, "commands", "claude-juggler");
    const settingsPath = join(claudeDir, "settings.json");
    // Verify settings.json exists (indicates valid Claude install)
    if (!existsSync(settingsPath)) {
        console.warn(`Warning: ${settingsPath} not found. Claude Code may not be fully initialized.`);
    }
    // Auto-import current account if available and not in non-interactive mode
    if (!isNonInteractive) {
        try {
            const claudeJsonPath = join(claudeDir, "claude.json");
            if (existsSync(claudeJsonPath)) {
                const liveAcct = readJSON(claudeJsonPath);
                const email = String(liveAcct.oauthAccount?.emailAddress ?? "");
                if (email) {
                    const defaultName = email.split("@")[0] || "default";
                    const shouldImport = promptYesNo(`\nFound logged-in account: ${email}\nWould you like to save this account? `);
                    if (shouldImport) {
                        const accountName = prompt(`What name do you want to save it as? [${defaultName}] `);
                        const finalName = accountName || defaultName;
                        // Temporarily set claude dir for addAccount
                        const prevDir = globalClaudeDir;
                        setClaudeDir(claudeDir);
                        try {
                            addAccount(finalName, undefined);
                            console.log(`✓ Saved current account as "${finalName}"`);
                        }
                        finally {
                            setClaudeDir(prevDir);
                        }
                    }
                }
            }
        }
        catch {
            // No account found or error reading current account - continue without importing
        }
    }
    // Determine installation method - check parent process first (bunx/npx), then fall back to global
    let installMethod = "global";
    // First check if we're being run via bunx/npx by looking at parent process
    try {
        const fs = require("fs");
        const ppid = process.ppid;
        if (ppid) {
            const cmdLine = fs.readFileSync(`/proc/${ppid}/cmdline`, "utf8").split("\0").join(" ");
            // Check for bunx or npx COMMANDS, not just the string "bun" (which appears in global bun installs too)
            if (/\bbunx\b/.test(cmdLine) || /\bbunx\//.test(cmdLine) || / bunx /.test(cmdLine)) {
                installMethod = "bunx";
            }
            else if (/\bnpx\b/.test(cmdLine) || /\bnpx\//.test(cmdLine) || / npx /.test(cmdLine)) {
                installMethod = "npx";
            }
            else {
                // Check script path as fallback
                const scriptPath = process.argv[1] || "";
                if (scriptPath.includes("bunx") || scriptPath.includes("/tmp/bunx")) {
                    installMethod = "bunx";
                }
                else if (scriptPath.includes("npx")) {
                    installMethod = "npx";
                }
                else {
                    // Assume global if we can find it in PATH
                    try {
                        execFileSync("which", ["claude-juggler"], { encoding: "utf8", timeout: 1000, stdio: "pipe" });
                        installMethod = "global";
                    }
                    catch {
                        // Default to npx if not found globally
                        installMethod = "npx";
                    }
                }
            }
        }
    }
    catch {
        // Fallback to checking global installation
        try {
            execFileSync("which", ["claude-juggler"], { encoding: "utf8", timeout: 1000, stdio: "pipe" });
            installMethod = "global";
        }
        catch {
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
    // Remove any existing claude-juggler hooks (any variation: claude-juggler, npx, bunx, with or without --claude-dir)
    hookEntry.hooks = hookEntry.hooks.filter((h) => !h.command || !(h.command.includes("hook-check") && (h.command.includes("claude-juggler") || h.command.includes("npx") || h.command.includes("bunx"))));
    // Add the hook using portable command prefix, not file path
    // Include --claude-dir if not default installation so hook knows which install to check
    const hookCommand = claudeDir === defaultClaudeDir
        ? `${cmdPrefix} hook-check`
        : `${cmdPrefix} --claude-dir "${claudeDir}" hook-check`;
    hookEntry.hooks.push({
        type: "command",
        command: hookCommand,
        timeout: 10,
    });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    const displayDir = claudeDir === defaultClaudeDir ? "~/.claude" : claudeDir;
    console.log(`✓ Created ${displayDir}/commands/claude-juggler/swap.md`);
    console.log(`✓ Created ${displayDir}/commands/claude-juggler/accounts.md`);
    console.log(`✓ Updated ${displayDir}/settings.json with hook: ${hookCommand}`);
    // Setup cron job
    if (opts.noCron) {
        // Explicitly disabled
    }
    else if (opts.installCron || promptYesNo("\nEnable automatic account priming with cron?\n(Periodically pings accounts to keep 5-hour usage windows ticking) ", true)) {
        // Either --install-cron was set, or user said yes
        const cronCommand = claudeDir === defaultClaudeDir
            ? `${cmdPrefix} prime`
            : `${cmdPrefix} --claude-dir "${claudeDir}" prime`;
        try {
            setupCronForInstall(cronCommand, claudeDir);
            console.log(`✓ Added cron job: */20 * * * * ${cronCommand}`);
        }
        catch (e) {
            console.warn(`Warning: Could not setup cron job: ${e.message}`);
        }
    }
    console.log("\nSetup complete! Use /swap and /accounts in Claude Code, or run: claude-juggler [add|list|use|status]");
}
function prompt(question) {
    // Simple synchronous prompt using execSync
    const { execSync } = require("child_process");
    try {
        // stdio: inherit for stdin/stderr so prompt displays; pipe for stdout to capture answer
        const answer = execSync(`bash -c 'read -p "${question}" answer; echo "$answer"'`, {
            encoding: "utf8",
            stdio: ["inherit", "pipe", "inherit"],
        }).trim();
        return answer;
    }
    catch {
        return "";
    }
}
function promptYesNo(question, defaultYes = false) {
    const answer = prompt(question + (defaultYes ? " [Y/n] " : " [y/N] "));
    if (!answer)
        return defaultYes;
    return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}
function setupCronForInstall(command, claudeDir) {
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
        // Check if the exact command already exists in crontab
        const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const searchPattern = new RegExp(escapedCommand);
        if (searchPattern.test(crontab)) {
            return; // Already configured
        }
        // Add new cron entry
        const newEntry = `*/20 * * * * ${command}\n`;
        const newCrontab = crontab + newEntry;
        // Write new crontab
        execFileSync("crontab", ["-"], { encoding: "utf8", input: newCrontab, stdio: ["pipe", "pipe", "pipe"] });
    }
    catch (e) {
        throw new Error(`Failed to setup cron: ${e.message}`);
    }
}
function removeCronForInstall(claudeDir) {
    try {
        // Get current crontab
        let crontab = "";
        try {
            crontab = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        }
        catch {
            // No crontab to remove
            return;
        }
        // For default ~/.claude, remove entries without --claude-dir
        // For custom, remove entries with the specific --claude-dir value
        const defaultClaudeDir = join(homedir(), ".claude");
        const isDefault = claudeDir === defaultClaudeDir;
        let newCrontab;
        if (isDefault) {
            // Remove default installation cron (the one without --claude-dir)
            newCrontab = crontab
                .split("\n")
                .filter(line => {
                // Remove if it has "claude-juggler prime" but NOT "--claude-dir"
                return !(line.includes("claude-juggler") && line.includes("prime") && !line.includes("--claude-dir"));
            })
                .join("\n");
        }
        else {
            // Remove custom installation cron (the one with this specific --claude-dir)
            newCrontab = crontab
                .split("\n")
                .filter(line => !line.includes(`--claude-dir`) || !line.includes(`"${claudeDir}"`) || !line.includes("prime"))
                .join("\n");
        }
        // Only update if something was removed
        if (newCrontab.trim() !== crontab.trim()) {
            execFileSync("crontab", ["-"], { encoding: "utf8", input: newCrontab, stdio: ["pipe", "pipe", "pipe"] });
            console.log("✓ Removed cron job");
        }
    }
    catch {
        // Cron removal failed, but continue
    }
}
/** Remove Claude Code integration and config for the current installation. */
export function uninstall() {
    // Use global claudeDir if set, otherwise default
    const defaultClaudeDir = join(homedir(), ".claude");
    const claudeDir = globalClaudeDir !== defaultClaudeDir ? globalClaudeDir : defaultClaudeDir;
    const commandsDir = join(claudeDir, "commands", "claude-juggler");
    const settingsPath = join(claudeDir, "settings.json");
    const swapCmdPath = join(commandsDir, "swap.md");
    const accountsCmdPath = join(commandsDir, "accounts.md");
    const displayDir = claudeDir === defaultClaudeDir ? "~/.claude" : claudeDir;
    // Remove command files
    if (existsSync(swapCmdPath)) {
        require("fs").unlinkSync(swapCmdPath);
        console.log(`✓ Removed ${displayDir}/commands/claude-juggler/swap.md`);
    }
    if (existsSync(accountsCmdPath)) {
        require("fs").unlinkSync(accountsCmdPath);
        console.log(`✓ Removed ${displayDir}/commands/claude-juggler/accounts.md`);
    }
    // Remove hook from settings.json
    if (existsSync(settingsPath)) {
        let settings = readJSON(settingsPath);
        if (settings.hooks?.UserPromptSubmit?.[0]?.hooks) {
            const originalLength = settings.hooks.UserPromptSubmit[0].hooks.length;
            settings.hooks.UserPromptSubmit[0].hooks = settings.hooks.UserPromptSubmit[0].hooks.filter((h) => !h.command || !h.command.includes("hook-check"));
            const newLength = settings.hooks.UserPromptSubmit[0].hooks.length;
            if (originalLength > newLength) {
                writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
                console.log(`✓ Removed hook from ${displayDir}/settings.json`);
            }
        }
    }
    // Remove cron job for this specific installation
    removeCronForInstall(claudeDir);
    // Remove account storage for this installation ONLY (not the global config)
    const allAccounts = readJSON(ACCOUNTS_FILE);
    if (allAccounts[claudeDir]) {
        delete allAccounts[claudeDir];
        writeJSON(ACCOUNTS_FILE, allAccounts);
        console.log(`✓ Removed account storage for this installation`);
    }
    console.log("\nUninstall complete!");
}
