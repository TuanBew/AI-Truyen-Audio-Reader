import { z } from "zod";

// Settings document (spec 7.1). Every field has a default and an invalid field falls back to it,
// so a stale or hand-edited document never breaks the app.

const field = <T extends z.ZodType>(schema: T, fallback: z.infer<T>) => schema.catch(fallback);

const appearanceSchema = z.object({
  preset: field(z.enum(["auto", "giay", "dem", "oled", "sepia", "rung"]), "auto"),
});

const readingSchema = z.object({
  font: field(z.enum(["serif", "sans"]), "serif"),
  fontSize: field(z.number().min(14).max(32), 18),
  lineHeight: field(z.number().min(1.2).max(2.4), 1.8),
  width: field(z.number().int().min(480).max(1000), 680),
  paragraphSpacing: field(z.number().min(0).max(2), 0.8),
  align: field(z.enum(["left", "justify"]), "left"),
});

const playerSchema = z.object({
  speed: field(z.number().min(0.75).max(2), 1),
  ambientTrack: field(z.string().min(1).nullable(), null),
  ambientVolume: field(z.number().min(0).max(1), 0.3),
  wordHighlight: field(z.boolean(), false),
});

const voicesSchema = z.object({
  narrator: field(z.string().min(1).nullable(), null),
  male: field(z.string().min(1).nullable(), null),
  female: field(z.string().min(1).nullable(), null),
});

const analysisSchema = z.object({
  order: field(z.array(z.string().min(1)), []),
});

const workerSchema = z.object({
  prefetchCount: field(z.number().int().min(0).max(10), 3),
  followIntervalHours: field(z.number().min(1).max(168), 6),
  autoSynthesizeNew: field(z.boolean(), false),
});

// A sub-object that is not an object at all (or missing) becomes its defaults.
const section = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v && typeof v === "object" ? v : {}), schema);

const settingsSchema = z.object({
  appearance: section(appearanceSchema),
  reading: section(readingSchema),
  player: section(playerSchema),
  voices: section(voicesSchema),
  analysis: section(analysisSchema),
  worker: section(workerSchema),
});

export type Settings = z.infer<typeof settingsSchema>;

export function parseSettings(raw: unknown): Settings {
  return settingsSchema.parse(raw && typeof raw === "object" ? raw : {});
}

export const defaultSettings: Settings = parseSettings({});
