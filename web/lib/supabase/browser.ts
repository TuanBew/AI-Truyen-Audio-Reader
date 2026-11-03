import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";

// Browser Supabase client (Realtime, progress writes). Never import this statically:
// load it with `await import("@/lib/supabase/browser")` when first needed, so the
// Supabase JS bundle stays out of the first-load JS of every route.
let client: ReturnType<typeof createBrowserClient> | undefined;

export function getBrowserClient() {
  client ??= createBrowserClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  return client;
}
