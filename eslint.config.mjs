import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

const config = [
  {
    ignores: [
      ".next/**",
      "out/**",
      "node_modules/**",
      "drizzle/**",
      "public/sw.js",
      "next-env.d.ts",
      "coverage/**",
    ],
  },
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // The domain layer must stay framework-free: no React, no Next, no DB.
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["react", "react-dom", "next", "next/*"], message: "Domain layer must not depend on React/Next." },
            { group: ["@/db", "@/db/*", "drizzle-orm", "drizzle-orm/*", "postgres"], message: "Domain layer must not depend on the database." },
            { group: ["@/server", "@/server/*"], message: "Domain layer must not depend on server services." },
            { group: ["@anthropic-ai/sdk"], message: "Domain layer must not call AI providers directly." },
          ],
        },
      ],
    },
  },
];

export default config;
