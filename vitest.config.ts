import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Separate processes: the thread pool sometimes crashed the whole run ("Maximum call stack size exceeded" in tinypool).
    pool: "forks",
    // Some tests import whole services on first use; under a full parallel run 5 s is too tight.
    testTimeout: 15_000,
    // Dummy values so EnvVars / sequelize.ts load without a .env file (Sequelize connects lazily).
    env: {
      NODE_ENV: "test",
      JWT_SECRET: "test-jwt-secret",
      COOKIE_SECRET: "test-cookie-secret",
      DB_HOST: "localhost",
      DB_PORT: "5432",
      DB_USER: "test",
      DB_PASSWORD: "test",
      DB_NAME: "test",
    },
  },
  resolve: {
    alias: { "@src": path.resolve(__dirname, "src") },
  },
});
