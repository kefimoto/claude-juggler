import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

// Per-process so concurrent vitest workers never rm -rf each other's fixtures.
const TEST_DIR = join(tmpdir(), `claude-juggler-test-${process.pid}`);
// Resolved from this file so the tests exercise their own tree, not whatever
// happens to live at a hardcoded absolute path.
const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));
const TEST_CLAUDE_1 = join(TEST_DIR, "claude1");
const TEST_CLAUDE_2 = join(TEST_DIR, "claude2");
const TEST_CONFIG_DIR = join(TEST_DIR, "config");

// Helper to create mock Claude installation
function createMockClaude(dir: string, email: string, token: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: token, refreshToken: "rt", expiresAt: 9999999999999 },
    })
  );
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        emailAddress: email,
        accountUuid: `uuid-${email}`,
        organizationUuid: "org-uuid",
      },
    })
  );
}

// Helper to run CLI command
function runCLI(args: string[], env: { CLAUDE_JUGGLER_DIR?: string; CLAUDE_CONFIG_DIR?: string } = {}): string {
  const envStr = Object.entries({ ...process.env, CLAUDE_JUGGLER_TEST: "1", ...env })
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  try {
    const cmd = `${envStr} bun ${CLI_PATH} ${args.join(" ")}`;
    return execSync(cmd, { cwd: TEST_DIR, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    return e.stdout || e.stderr || e.message;
  }
}

// Helper to read accounts file
function readAccounts() {
  const path = join(TEST_CONFIG_DIR, "accounts.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

beforeEach(() => {
  // Clean up
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
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

describe("Load Balancing Configuration", () => {
  beforeEach(() => {
    createMockClaude(TEST_CLAUDE_1, "user1@example.com", "token-1");
    createMockClaude(TEST_CLAUDE_2, "user2@example.com", "token-2");
  });

  it("should configure load balancing strategy", () => {
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "account1", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-strategy", "drain-near-reset"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "show"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    expect(output).toContain("drain-near-reset");
  });

  it("should configure load balancing interval", () => {
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "account1", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-strategy", "smart-lowest"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-interval", "300"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "show"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    expect(output).toContain("300");
  });

  it("should configure load balancing delta threshold", () => {
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "account1", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-strategy", "smart-lowest"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-delta", "10"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "show"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    expect(output).toContain("10");
  });

  it("should disable load balancing with off strategy", () => {
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "account1", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-strategy", "drain-near-reset"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-strategy", "off"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    const output = runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "show"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    expect(output).toContain("loadBalancingStrategy: off");
  });
});

describe("Load Balancing Strategy (drain-near-reset)", () => {
  beforeEach(() => {
    createMockClaude(TEST_CLAUDE_1, "user1@example.com", "token-1");
  });

  it("should prioritize unstarted windows (null resetsAt)", () => {
    // Add two accounts
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "account1", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "account2", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    // Enable load balancing
    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-strategy", "drain-near-reset"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    // Verify both accounts exist and one is active
    const status = runCLI(["--claude-dir", TEST_CLAUDE_1, "status"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    expect(status).toContain("account1");
    expect(status).toContain("account2");
  });

  it("should respect autoswap enable/disable per account", () => {
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "primary", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "secondary", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    // Disable autoswap on secondary
    runCLI(["--claude-dir", TEST_CLAUDE_1, "set-autoswap-enabled", "secondary", "off"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    // Verify it's disabled
    const status = runCLI(["--claude-dir", TEST_CLAUDE_1, "list"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    expect(status).toContain("primary");
    expect(status).toContain("secondary");
  });

  it("should allow re-enabling autoswap", () => {
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "test", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "set-autoswap-enabled", "test", "off"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "set-autoswap-enabled", "test", "on"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    const status = runCLI(["--claude-dir", TEST_CLAUDE_1, "list"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    expect(status).toContain("test");
  });

  it("should require min-interval between swaps (default 600s)", () => {
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "account1", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "account2", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-strategy", "smart-lowest"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    const cfg = runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "show"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    expect(cfg).toContain("600");
  });

  it("should allow customizing min-interval", () => {
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "account1", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-strategy", "smart-lowest"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-interval", "120"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    const cfg = runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "show"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    expect(cfg).toContain("120");
  });

  it("should require min-delta between usage (default 5%)", () => {
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "account1", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-strategy", "smart-lowest"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    const cfg = runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "show"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    expect(cfg).toContain("5");
  });

  it("should allow customizing min-delta", () => {
    runCLI(["--claude-dir", TEST_CLAUDE_1, "add", "account1", "--no-priming"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-strategy", "smart-lowest"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "set-lb-delta", "15"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    const cfg = runCLI(["--claude-dir", TEST_CLAUDE_1, "config", "show"], {
      CLAUDE_JUGGLER_DIR: TEST_CONFIG_DIR,
    });

    expect(cfg).toContain("15");
  });
});
