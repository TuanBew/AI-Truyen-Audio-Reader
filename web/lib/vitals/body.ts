import { z } from "zod";
import { VITAL_NAMES } from "./route-pattern";

const sample = z.object({
  name: z.enum(VITAL_NAMES),
  value: z.number().finite().min(0).lt(1e7),
  rating: z.enum(["good", "needs-improvement", "poor"]).optional(),
  route: z.string().min(1).max(200),
});

// The SQL function takes only the first 10 elements, so more than 10 is rejected here instead of silently dropped.
export const vitalsBody = z.array(sample).min(1).max(10);
