import { AwsV4Signer } from "aws4fetch";
import type { R2ReadEnv } from "@/lib/env.server";

const WINDOW_MS = 300_000;
export const URL_TTL_S = 600;

// X-Amz-Date floored to a 5-minute window: the same key signed in one window gives the same URL, so the browser
// reuses immutable objects from its cache. Every URL stays valid for at least 5 minutes (600 s expiry - 300 s window).
function amzDate(now: Date): string {
  const floored = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
  return floored.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function presignGet(env: R2ReadEnv, key: string, now: Date): Promise<string> {
  const url = new URL(`${env.endpoint.replace(/\/+$/, "")}/${env.bucket}/${key}`);
  url.searchParams.set("X-Amz-Expires", String(URL_TTL_S));
  const signer = new AwsV4Signer({
    method: "GET",
    url: url.toString(),
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    service: "s3",
    region: env.region,
    signQuery: true,
    datetime: amzDate(now),
  });
  const signed = await signer.sign();
  return signed.url.toString();
}
