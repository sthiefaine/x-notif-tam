import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: { plugins: [] }
});

const eslintConfig = [
  { ignores: [".next/**", "node_modules/**", "out/**", "build/**", "next-env.d.ts"] },
  ...compat.extends(
    "next/core-web-vitals",
    "next/typescript"
  ),
  {
    files: ["tests/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@next/next/no-assign-module-variable": "off",
    },
  },
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      "react/no-unescaped-entities": "warn",
      "no-unused-vars": "off",
      "prefer-const": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { vars: "all", args: "after-used", ignoreRestSiblings: false }
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    }
  }
];

export default eslintConfig;
