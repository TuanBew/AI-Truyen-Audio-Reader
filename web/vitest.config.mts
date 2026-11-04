import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL(".", import.meta.url)),
  // The real package throws outside the react-server condition; unit tests import server data modules.
  "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["lib/**/*.test.ts", "app/api/**/*.test.ts"],
          env: {
            NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
            NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key-for-vitest-only",
          },
        },
      },
      {
        resolve: { alias },
        test: {
          name: "browser",
          include: ["tests/browser/**/*.browser.test.ts"],
          testTimeout: 60_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
            }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
