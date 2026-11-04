import { describe, expect, it } from "vitest";
import type { R2ReadEnv } from "@/lib/env.server";
import { isAudioKey } from "./keys";
import { presignGet } from "./presign";

const env: R2ReadEnv = {
  accountId: "local",
  accessKeyId: "AKIAEXAMPLEKEYID",
  secretAccessKey: "super-secret-value-that-must-not-leak",
  bucket: "audiotruyen",
  endpoint: "http://127.0.0.1:54321/storage/v1/s3",
  region: "local",
};
const NOVEL = "11111111-2222-3333-4444-555555555555";
const CHAPTER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const key = (file: string, attempt = 3) => `audio/${NOVEL}/${CHAPTER}/0123456789abcdef/${attempt}/${file}`;

describe("presignGet", () => {
  it("gives identical URLs inside one 300 s window and different ones in adjacent windows", async () => {
    const a = await presignGet(env, key("init.webm"), new Date("2026-11-03T10:00:01Z"));
    const b = await presignGet(env, key("init.webm"), new Date("2026-11-03T10:04:59Z"));
    const c = await presignGet(env, key("init.webm"), new Date("2026-11-03T10:05:00Z"));
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("sets a 600 s expiry and the floored date", async () => {
    const url = new URL(await presignGet(env, key("seg-0000.webm"), new Date("2026-11-03T10:04:59Z")));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261103T100000Z");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses a path-style URL under the endpoint path", async () => {
    const url = new URL(await presignGet(env, key("init.webm"), new Date("2026-11-03T10:00:00Z")));
    expect(url.origin).toBe("http://127.0.0.1:54321");
    expect(url.pathname).toBe(`/storage/v1/s3/audiotruyen/${key("init.webm")}`);
  });

  it("carries only signature query params and no secret", async () => {
    const raw = await presignGet(env, key("full.webm"), new Date("2026-11-03T10:00:00Z"));
    const url = new URL(raw);
    expect([...url.searchParams.keys()].sort()).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
    ]);
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKIAEXAMPLEKEYID/20261103/local/s3/aws4_request");
    expect(raw).not.toContain(env.secretAccessKey);
  });
});

describe("isAudioKey", () => {
  it("accepts init, segment and full keys of the row's attempt", () => {
    expect(isAudioKey(key("init.webm"), 3)).toBe(true);
    expect(isAudioKey(key("seg-0012.webm"), 3)).toBe(true);
    expect(isAudioKey(key("full.webm"), 3)).toBe(true);
  });

  it("rejects traversal, another attempt, foreign prefixes and query strings", () => {
    expect(isAudioKey("audio/../x", 3)).toBe(false);
    expect(isAudioKey(key("init.webm", 4), 3)).toBe(false);
    expect(isAudioKey(key("init.webm", 3).replace("/3/", "/03/"), 3)).toBe(false);
    expect(isAudioKey("voices/x/neutral.wav", 3)).toBe(false);
    expect(isAudioKey(`${key("init.webm")}?x=1`, 3)).toBe(false);
    expect(isAudioKey(key("seg-1.webm"), 3)).toBe(false);
  });
});
