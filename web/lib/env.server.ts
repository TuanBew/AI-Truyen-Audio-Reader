import "server-only";
import { z } from "zod";

// Read-only R2 credentials for signing audio URLs. Parsed lazily on first call so that
// `next build` and CI, which have no R2 env, still work.
const r2ReadEnvSchema = z.object({
  R2_ACCOUNT_ID: z.string().min(1),
  R2_READ_ACCESS_KEY_ID: z.string().min(1),
  R2_READ_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_ENDPOINT_URL: z.url().optional(),
  R2_REGION: z.string().min(1).optional(),
});

export type R2ReadEnv = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  region: string;
};

export function parseR2ReadEnv(raw: Record<string, string | undefined>): R2ReadEnv {
  // Empty strings count as unset (an unfilled line in .env.local).
  const cleaned = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === "" ? undefined : v]));
  const result = r2ReadEnvSchema.safeParse(cleaned);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Missing or invalid R2 environment variable(s): ${names.join(", ")}`);
  }
  const env = result.data;
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_READ_ACCESS_KEY_ID,
    secretAccessKey: env.R2_READ_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    endpoint: env.R2_ENDPOINT_URL ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: env.R2_REGION ?? "auto",
  };
}

let cached: R2ReadEnv | undefined;

export function getR2ReadEnv(): R2ReadEnv {
  cached ??= parseR2ReadEnv({
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_READ_ACCESS_KEY_ID: process.env.R2_READ_ACCESS_KEY_ID,
    R2_READ_SECRET_ACCESS_KEY: process.env.R2_READ_SECRET_ACCESS_KEY,
    R2_BUCKET: process.env.R2_BUCKET,
    R2_ENDPOINT_URL: process.env.R2_ENDPOINT_URL,
    R2_REGION: process.env.R2_REGION,
  });
  return cached;
}
