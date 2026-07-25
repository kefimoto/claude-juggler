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
export declare const CONFIG_DIR: string;
export declare const ACCOUNTS_DIR: string;
export declare const STATE_PATH: string;
export declare const CONFIG_PATH: string;
export declare const LOG_PATH: string;
export interface Config {
    warningThreshold?: number;
    autoswapThreshold?: number | null;
    autoswapStrategy?: "next" | "prev" | "lowest";
    commandPrefix?: string;
}
export declare function getConfig(): {
    warningThreshold: number;
    autoswapThreshold: number | null;
    autoswapStrategy: "next" | "prev" | "lowest";
};
export declare function setThresholds(warning?: number, autoswap?: number | null, strategy?: "next" | "prev" | "lowest"): void;
export interface OauthToken {
    accessToken: string;
    [key: string]: unknown;
}
export interface AccountData {
    name: string;
    label: string;
    oauthAccount: Record<string, unknown>;
    claudeAiOauth: OauthToken;
}
export declare function listAccounts(): string[];
export declare function withLock<T>(fn: () => T): T;
/** Which saved account does the LIVE token actually match? null if none. */
export declare function groundTruthAccount(): string | null;
export declare function currentAccount(): string | null;
/** Capture the CURRENTLY LIVE credentials as a new named account. Run this
 * right after a real `claude auth login` for that account. */
export declare function addAccount(name: string): AccountData;
export declare function removeAccount(name: string): void;
/**
 * Safely make targetAccount the live account. No-ops if already active.
 * Throws if state.json's bookkeeping disagrees with the live token,
 * rather than silently overwriting an account's saved data.
 */
export declare function activate(targetName: string, quiet?: boolean): string;
/** Pick the "next" account in rotation after the current one. */
export declare function nextAccount(): string;
export declare function prevAccount(): string;
export declare function lowestUsageAccount(): string;
export declare function verifyStatus(): void;
export interface UsageResult {
    pct: number | null;
    resetsAt: number | null;
}
/** Free local /usage report for whichever account is currently live. */
export declare function checkUsage(): UsageResult;
/** Send one trivial message on whichever account is currently live. */
export declare function ping(): void;
/** For each saved account: check its 5h window (free) and ping it ONLY if
 * it shows 0% used. Never leaves the originally-active account swapped out. */
export declare function prime(): void;
/** Usage snapshot for every saved account, without disturbing the
 * currently-active one for longer than the check itself takes. */
export declare function statusAll(): Array<{
    name: string;
    label: string;
    active: boolean;
    pct: number | null;
    resetsAt: number | null;
}>;
interface InstallOptions {
    installCron?: boolean;
    noCron?: boolean;
    claudeDir?: string;
}
/** Setup Claude Code integration: create commands and configure hook. */
export declare function install(options?: InstallOptions | boolean): void;
/** Remove Claude Code integration and config. */
export declare function uninstall(): void;
export {};
