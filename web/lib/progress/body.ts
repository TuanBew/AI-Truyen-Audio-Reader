import { z } from "zod";
import type { ProgressBody } from "./saver";

const INT_MAX = 2_147_483_647; // the progress columns are Postgres integer

// Server only: the route validates with this; the client builds a plain ProgressBody (lib/progress/saver.ts).
export const progressBody = z.object({
  novelId: z.uuid(),
  chapterId: z.uuid(),
  segmentIndex: z.int().min(0).max(INT_MAX),
  positionMs: z.int().min(0).max(INT_MAX),
  finished: z.boolean().default(false),
});

// Compile-time check that the client's type and the schema agree.
export type _SameShape = z.infer<typeof progressBody> extends ProgressBody
  ? ProgressBody extends z.infer<typeof progressBody>
    ? true
    : never
  : never;
