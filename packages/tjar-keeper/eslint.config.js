import eslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts", "*.ts"],
    languageOptions: {
      parser,
      parserOptions: { sourceType: "module", ecmaVersion: "latest" },
    },
    plugins: { "@typescript-eslint": eslint },
    rules: {
      ...eslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-throw-literal": "error",
    },
  },
];
