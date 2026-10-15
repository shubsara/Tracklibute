import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  { ignores: ["node_modules/**", ".next/**", "src/generated/**", "next-env.d.ts"] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error", "info"] }],
    },
  },
  {
    // Domain layer must not depend on Next.js or a concrete auth provider.
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["next", "next/*", "@/server/auth/dev-*", "@/app/*"] },
      ],
    },
  },
];

export default config;
