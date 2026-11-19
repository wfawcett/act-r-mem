import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", ".factory/lib-vendor/**", "*.config.*", ".tmp/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Factory scripts are plain Node .mjs: browser-free globals apply.
    files: [".factory/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
