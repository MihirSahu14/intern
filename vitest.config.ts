import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // lib/*.test.ts run under node's own --test runner (`npm test`); only the
    // convex-test suite belongs to vitest.
    include: ["convex/**/*.test.ts"],
  },
});
