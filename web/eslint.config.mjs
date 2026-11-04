import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The MSE engine and the Supabase browser client are heavy: they load with `await import()` when first needed, so a
  // static import (which would put them in every reader's first-load JS) fails lint. Type-only imports are erased.
  {
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/player/engine", "@/lib/supabase/browser"],
              allowTypeImports: true,
              message: "Load it with `await import(...)` on first use (bundle budget). `import type` is fine.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
