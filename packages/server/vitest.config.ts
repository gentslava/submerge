import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Importing db/client creates the singleton before test fixtures run. Every
    // isolated test worker must keep that connection off the shared runtime file.
    env: { DB_PATH: ":memory:" },
  },
});
