import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const KEYS = [
  "R2_ACCOUNT_ID",
  "R2_READ_ACCESS_KEY_ID",
  "R2_READ_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_ENDPOINT_URL",
  "R2_REGION",
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function setEnv(values: Record<string, string>) {
  for (const k of KEYS) vi.stubEnv(k, values[k] ?? "");
}

describe("getR2ReadEnv", () => {
  it("does not throw on import without R2 env", async () => {
    setEnv({});
    await expect(import("./env.server")).resolves.toBeDefined();
  });

  it("names the missing variable when called", async () => {
    setEnv({ R2_ACCOUNT_ID: "acc" });
    const { getR2ReadEnv } = await import("./env.server");
    expect(() => getR2ReadEnv()).toThrow(/R2_READ_ACCESS_KEY_ID/);
  });

  it("applies the endpoint and region defaults", async () => {
    setEnv({ R2_ACCOUNT_ID: "acc", R2_READ_ACCESS_KEY_ID: "k", R2_READ_SECRET_ACCESS_KEY: "s", R2_BUCKET: "b" });
    const { getR2ReadEnv } = await import("./env.server");
    expect(getR2ReadEnv()).toEqual({
      accountId: "acc",
      accessKeyId: "k",
      secretAccessKey: "s",
      bucket: "b",
      endpoint: "https://acc.r2.cloudflarestorage.com",
      region: "auto",
    });
  });

  it("honours the dev overrides and caches the result", async () => {
    setEnv({
      R2_ACCOUNT_ID: "local",
      R2_READ_ACCESS_KEY_ID: "k",
      R2_READ_SECRET_ACCESS_KEY: "s",
      R2_BUCKET: "audiotruyen",
      R2_ENDPOINT_URL: "http://127.0.0.1:54321/storage/v1/s3",
      R2_REGION: "local",
    });
    const { getR2ReadEnv } = await import("./env.server");
    const first = getR2ReadEnv();
    expect(first.endpoint).toBe("http://127.0.0.1:54321/storage/v1/s3");
    expect(first.region).toBe("local");
    expect(getR2ReadEnv()).toBe(first);
  });
});
