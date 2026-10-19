import { describe, expect, it } from "vitest";
import { parsePublicEnv } from "./env";

describe("parsePublicEnv", () => {
  it("accepts a URL and a key", () => {
    const env = parsePublicEnv({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "a-long-enough-anon-key",
    });
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });

  it("rejects a missing key", () => {
    expect(() => parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" })).toThrow();
  });

  it("rejects a malformed URL", () => {
    expect(() =>
      parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "not a url", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a-long-enough-anon-key" }),
    ).toThrow();
  });
});
