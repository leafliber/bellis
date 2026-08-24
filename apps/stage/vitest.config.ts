import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/properties/**/*.test.ts"],
    environment: "node",
  },
});
