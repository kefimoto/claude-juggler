import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the TypeScript sources. Without this, vitest also picks up
    // dist/lib.test.js — a compiled duplicate of these same tests — and runs
    // both files in parallel. They share TEST_DIR, so one file's beforeEach
    // rm -rf's the directory the other file's CLI subprocess is running in.
    include: ["src/**/*.test.ts"],
  },
});
