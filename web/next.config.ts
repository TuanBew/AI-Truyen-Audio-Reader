import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo-root CLAUDE.md is the agent instruction source; stop `next dev` writing web/AGENTS.md.
  agentRules: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
