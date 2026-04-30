// /vitest.config.ts
// Vitest runs in Node.js — isolated from Cloudflare Workers runtime types. // L2_隔離
// BigTwoStateMachine uses crypto.getRandomValues which is native in Node 20+.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include:     ["test/**/*.test.ts"],
    exclude:     ["test/workers/**", "node_modules/**"],
    // No globals: tests use explicit `import { describe, it, expect } from "vitest"`.
  },
});
