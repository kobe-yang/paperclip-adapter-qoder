import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this project's own suite. `fixtures/sample-repo` is a miniature
    // project used as a target for real Qoder runs; its `node:test` file is not
    // part of the adapter's tests and must not be collected here.
    include: ["tests/**/*.test.ts"],
  },
});
