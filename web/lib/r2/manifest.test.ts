import { describe, expect, it, vi } from "vitest";
import type { R2ReadEnv } from "@/lib/env.server";
import { buildManifest, type ManifestRow } from "./manifest";

const env: R2ReadEnv = {
  accountId: "local",
  accessKeyId: "AKID",
  secretAccessKey: "secret",
  bucket: "b",
  endpoint: "http://127.0.0.1:54321/storage/v1/s3",
  region: "local",
};
const base = "audio/11111111-2222-3333-4444-555555555555/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/0123456789abcdef/2";
const row = (over: Partial<ManifestRow> = {}): ManifestRow => ({
  id: "row-1",
  attempt: 2,
  status: "partial",
  init_key: `${base}/init.webm`,
  chunks: [
    { key: `${base}/seg-0000.webm`, start_ms: 0, end_ms: 9981 },
    { key: `${base}/seg-0001.webm`, start_ms: 9981, end_ms: null },
  ],
  full_key: null,
  duration_ms: null,
  ...over,
});
const now = new Date("2026-11-03T10:00:00Z");

describe("buildManifest", () => {
  it("maps keys to signed URLs and a null end_ms to endMs null", async () => {
    const m = await buildManifest(env, row(), now);
    expect(m.attempt).toBe(2);
    expect(m.init).toContain("/b/" + base + "/init.webm?");
    expect(m.chunks.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 9981],
      [9981, null],
    ]);
    expect(m.full).toBeNull();
  });

  it("stops at the first invalid chunk key and warns", async () => {
    const warn = vi.fn();
    const r = row({
      chunks: [
        { key: `${base}/seg-0000.webm`, start_ms: 0, end_ms: 1 },
        { key: "audio/../evil", start_ms: 1, end_ms: 2 },
        { key: `${base}/seg-0002.webm`, start_ms: 2, end_ms: 3 },
      ],
    });
    const m = await buildManifest(env, r, now, warn);
    expect(m.chunks).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it("drops an init or full key of another attempt", async () => {
    const warn = vi.fn();
    const m = await buildManifest(env, row({ init_key: `${base.replace("/2", "/1")}/init.webm`, full_key: `${base}/full.webm` }), now, warn);
    expect(m.init).toBeNull();
    expect(m.full).toContain("full.webm");
    expect(warn).toHaveBeenCalled();
  });
});
