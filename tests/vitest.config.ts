import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/static/**/*.test.ts", "tests/sota/*.test.ts"],
    // Only top-level SOTA harness tests are hermetic suite members. Scratch programs the
    // harness synthesizes under tests/sota/generated/** carry their own *.test.ts and must
    // NOT be swept into the hermetic suite.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/sota/generated/**"],
    // Synthesis/golden/approve-flow tests render + typecheck scaffolds and are heavier than
    // the 5s vitest default — on the shared self-hosted CI runner they exceed it and flake.
    // Raise the hermetic default to give them headroom (they run in single-digit seconds locally).
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
