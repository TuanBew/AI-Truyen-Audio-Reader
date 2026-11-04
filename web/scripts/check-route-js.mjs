// Fails CI when a route's first-load JS (gzip) exceeds its budget (spec 7.3.2).
// Reads .next/diagnostics/route-bundle-stats.json written by `next build`; needs no env.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const KB = 1024;

export const BUDGETS_KB = {
  "/": 150,
  "/novel/[id]": 150,
  "/read/[novelId]/[chapterIndex]": 220,
  "/login": 150,
};

// stats: [{ route, firstLoadChunkPaths }]; gzipSize(path) -> bytes. A shared chunk counts for every route listing it.
export function checkBudgets(stats, gzipSize, budgets = BUDGETS_KB) {
  const byRoute = new Map(stats.map((s) => [s.route, s]));
  return Object.entries(budgets).map(([route, budgetKb]) => {
    const found = byRoute.get(route);
    if (!found) return { route, kb: NaN, budgetKb, ok: false };
    const bytes = found.firstLoadChunkPaths.reduce((sum, p) => sum + gzipSize(p), 0);
    const kb = bytes / KB;
    return { route, kb, budgetKb, ok: kb <= budgetKb };
  });
}

function formatTable(rows) {
  const width = Math.max(5, ...rows.map((r) => r.route.length));
  const lines = rows.map((r) => {
    const kb = Number.isNaN(r.kb) ? "missing" : `${r.kb.toFixed(1)} KB`;
    return `${r.route.padEnd(width)}  ${kb.padStart(10)}  / ${String(r.budgetKb).padStart(3)} KB  ${r.ok ? "ok" : "FAIL"}`;
  });
  return [`${"route".padEnd(width)}  ${"gzip".padStart(10)}  budget`, ...lines].join("\n");
}

function main() {
  const root = process.cwd();
  const statsPath = path.join(root, ".next", "diagnostics", "route-bundle-stats.json");
  let stats;
  try {
    stats = JSON.parse(readFileSync(statsPath, "utf8"));
  } catch {
    console.error(`Cannot read ${statsPath}. Run \`npm run build\` first.`);
    process.exit(1);
  }
  const cache = new Map();
  const gzipSize = (p) => {
    if (!cache.has(p)) {
      // Windows builds write backslashes, Linux builds forward slashes.
      const file = path.join(root, ...p.split(/[\/]/));
      cache.set(p, gzipSync(readFileSync(file)).length);
    }
    return cache.get(p);
  };
  const rows = checkBudgets(stats, gzipSize);
  console.log(formatTable(rows));
  if (rows.some((r) => !r.ok)) {
    console.error("Route JS budget exceeded.");
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
