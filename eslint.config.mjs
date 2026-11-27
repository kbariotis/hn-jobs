// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/", "data/", "review/", "dist/"] },
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
  {
    files: ["public/**/*.js"],
    languageOptions: { globals: globals.browser, sourceType: "script" },
  },
  { files: ["**/*.mjs"], languageOptions: { globals: globals.node } },
  // Turns off rules that fight Prettier; readability rules are re-enabled after it.
  prettier,
  {
    rules: {
      // Always brace if/else/for/while bodies, even one statement.
      curly: ["error", "all"],
      // One statement per line: no `a(); b();` on a single line.
      "max-statements-per-line": ["error", { max: 1 }],
      // `a ? b : c ? d : e` reads badly; use if/else or a lookup.
      "no-nested-ternary": "error",
      // Prettier wraps code at 100 but never comments; this catches long comments.
      "max-len": [
        "error",
        {
          code: 100,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
        },
      ],
    },
  },
);
