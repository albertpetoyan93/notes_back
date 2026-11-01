import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
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
