import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
// Test setup
const TEST_DIR = "/tmp/claude-juggler-test";
const TEST_CLAUDE_1 = join(TEST_DIR, "claude1");
const TEST_CLAUDE_2 = join(TEST_DIR, "claude2");
const TEST_CONFIG_DIR = join(TEST_DIR, "config");
// Helper to create mock Claude installation
function createMockClaude(dir, email, token) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: { accessToken: token, refreshToken: "rt", expiresAt: 9999999999999 },
    }));
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({
        oauthAccount: {
            emailAddress: email,
            accountUuid: `uuid-${email}`,
            organizationUuid: "org-uuid",
        },
    }));
}
// Helper to run CLI command
function runCLI(args, env = {}) {
    const envStr = Object.entries({ ...process.env, CLAUDE_JUGGLER_TEST: "1", ...env })
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
    try {
        const cmd = `${envStr} bun /home/jake/repos/claude-juggler/src/cli.ts ${args.join(" ")}`;
        return execSync(cmd, { cwd: TEST_DIR, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    }
    catch (e) {
        return e.stdout || e.stderr || e.message;
    }
}
// Helper to read accounts file
function readAccounts() {
    const path = join(TEST_CONFIG_DIR, "accounts.json");
    if (!existsSync(path))
        return {};
    return JSON.parse(readFileSync(path, "utf8"));
}
beforeEach(() => {
    // Clean up
    if (existsSync(TEST_DIR))
        rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
});
afterEach(() => {
    if (existsSync(TEST_DIR))
        rmSync(TEST_DIR, { recursive: true });
});
describe("Single Installation", () => {
    beforeEach(() => {
        createMockClaude(TEST_CLAUDE_1, "user@example.com", "token-1");
    });
    it("should add an account", () => {
        const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "personal", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).toContain("Saved current account as \"personal\"");
        const accounts = readAccounts();
        expect(accounts[TEST_CLAUDE_1]).toBeDefined();
        expect(accounts[TEST_CLAUDE_1].personal).toBeDefined();
        expect(accounts[TEST_CLAUDE_1].personal.label).toBe("user@example.com");
    });
    it("should list accounts", () => {
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "personal", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "work", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "list"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).toContain("personal");
        expect(output).toContain("work");
    });
    it("should show current account", () => {
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "personal", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "current"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).toContain("personal");
    });
    it("should remove an account", () => {
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "personal", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "work", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        runCLI(["--claude-dir", TEST_CLAUDE_1, "remove", "personal"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "list"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).not.toContain("personal");
        expect(output).toContain("work");
    });
    it("should set priming on account", () => {
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "personal", "--priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        runCLI(["--claude-dir", TEST_CLAUDE_1, "set-priming", "personal", "off"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        const accounts = readAccounts();
        expect(accounts[TEST_CLAUDE_1].personal.priming).toBe(false);
    });
    it("should show version", () => {
        const output = runCLI(["version"], { CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR });
        expect(output).toContain("claude-juggler");
    });
});
describe("Multiple Installations", () => {
    beforeEach(() => {
        createMockClaude(TEST_CLAUDE_1, "user1@example.com", "token-1");
        createMockClaude(TEST_CLAUDE_2, "user2@example.com", "token-2");
    });
    it("should manage separate accounts for each installation", () => {
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "personal", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        runCLI(["--claude-dir", TEST_CLAUDE_2, "add", "work", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        const accounts = readAccounts();
        expect(accounts[TEST_CLAUDE_1].personal).toBeDefined();
        expect(accounts[TEST_CLAUDE_2].work).toBeDefined();
        expect(accounts[TEST_CLAUDE_1].work).toBeUndefined();
        expect(accounts[TEST_CLAUDE_2].personal).toBeUndefined();
    });
    it("should list all installations", () => {
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "personal", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        runCLI(["--claude-dir", TEST_CLAUDE_2, "add", "work", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        const output = runCLI(["list-all"], { CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR });
        expect(output).toContain(TEST_CLAUDE_1);
        expect(output).toContain(TEST_CLAUDE_2);
        expect(output).toContain("personal");
        expect(output).toContain("work");
    });
    it("should swap independently per installation", () => {
        // Add two accounts to claude1
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "personal", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        createMockClaude(TEST_CLAUDE_1, "work1@example.com", "token-1b");
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "work", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        // Add two accounts to claude2
        runCLI(["--claude-dir", TEST_CLAUDE_2, "add", "a", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        createMockClaude(TEST_CLAUDE_2, "b@example.com", "token-2b");
        runCLI(["--claude-dir", TEST_CLAUDE_2, "add", "b", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        // Verify current state for each
        let output = runCLI(["--claude-dir", TEST_CLAUDE_1, "current"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).toContain("work");
        output = runCLI(["--claude-dir", TEST_CLAUDE_2, "current"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).toContain("b");
    });
});
describe("Account Swapping", () => {
    beforeEach(() => {
        createMockClaude(TEST_CLAUDE_1, "user@example.com", "token-1");
    });
    it("should activate another account", () => {
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "personal", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        createMockClaude(TEST_CLAUDE_1, "other@example.com", "token-2");
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "work", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "use", "personal"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).toContain("Swapped");
        expect(output).toContain("personal");
    });
    it("should cycle with next", () => {
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "personal", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "next"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).toContain("personal");
    });
    it("should cycle with prev", () => {
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "personal", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "prev"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).toContain("personal");
    });
});
describe("Error Handling", () => {
    beforeEach(() => {
        createMockClaude(TEST_CLAUDE_1, "user@example.com", "token-1");
    });
    it("should error on invalid account name", () => {
        const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "invalid@name", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).toContain("must be alphanumeric");
    });
    it("should error when removing non-existent account", () => {
        const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "remove", "nonexistent"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).toContain("No account");
    });
    it("should error when activating non-existent account", () => {
        runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "test", "--no-priming"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "use", "nonexistent"], {
            CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
        });
        expect(output).toContain("No account");
    });
});
