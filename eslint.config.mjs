import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**"],
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "no-unused-vars": "off", // Turn off base rule as it can report incorrect errors
    },
  }
);
