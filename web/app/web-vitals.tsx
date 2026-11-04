"use client";

import { useEffect } from "react";
import { useReportWebVitals } from "next/web-vitals";
import { VITAL_NAMES, vitalsRoute } from "@/lib/vitals/route-pattern";

type Sample = { name: string; value: number; rating?: string; route: string };

const MAX_BATCH = 10;
// One sample per metric and route: LCP, CLS and INP are reported on every change and the last value is the final one.
const buffer = new Map<string, Sample>();

function flush() {
  const samples = [...buffer.values()];
  buffer.clear();
  for (let i = 0; i < samples.length; i += MAX_BATCH) {
    navigator.sendBeacon("/api/vitals", JSON.stringify(samples.slice(i, i + MAX_BATCH)));
  }
}

// Web Vitals (spec 7.3.2): logged in development, buffered and beaconed to /api/vitals in production when the page
// is hidden. /login has no session, so it is skipped. Routes carry the pattern, never ids or query strings.
export function WebVitals() {
  useReportWebVitals((metric) => {
    if (!(VITAL_NAMES as readonly string[]).includes(metric.name)) return;
    if (process.env.NODE_ENV !== "production") {
      console.debug("[web-vitals]", metric.name, Math.round(metric.value * 1000) / 1000, metric.rating);
      return;
    }
    const route = vitalsRoute(location.pathname);
    if (route === null) return;
    buffer.set(`${metric.name} ${route}`, { name: metric.name, value: metric.value, rating: metric.rating, route });
  });

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  return null;
}
