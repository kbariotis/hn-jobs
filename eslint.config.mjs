// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/", "data/", "review/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: { globals: globals.node },
    rules: {
      // `_`-prefixed args/vars are intentionally unused (callbacks, destructuring).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      eqeqeq: ["error", "smart"],
    },
  },
  // Browser page: plain JS, no TS rules that need types.
  { files: ["public/**/*.js"], languageOptions: { globals: globals.browser, sourceType: "script" } },
  { files: ["**/*.mjs"], languageOptions: { globals: globals.node } },
  // Must stay last: turns off rules that fight Prettier.
  prettier,
);
