import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/static/**/*.test.ts", "tests/sota/*.test.ts"],
    // Only top-level SOTA harness tests are hermetic suite members. Scratch programs the
    // harness synthesizes under tests/sota/generated/** carry their own *.test.ts and must
    // NOT be swept into the hermetic suite.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/sota/generated/**"],
  },
});
