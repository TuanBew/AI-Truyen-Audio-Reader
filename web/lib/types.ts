// Row and snapshot shapes shared by the web app (spec 4.1, 4.3, 5.8). Types only: no runtime code.

export type AudioStatus = "queued" | "partial" | "ready" | "failed";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type AudioChunk = { key: string; start_ms: number; end_ms: number | null };
export type TimedSegment = { i: number; start_ms: number; end_ms: number };

// `src` is a Python code-point range into the original chapter text; see lib/text/offsets.ts.
export type AnalysisSegment = {
  i: number;
  kind: "narration" | "dialogue";
  src: [number, number];
  p: number;
  pe: boolean;
};

export type AudioRow = {
  id: string;
  attempt: number;
  status: AudioStatus;
  voice_hash: string;
  text_hash: string | null;
  init_key: string | null;
  chunks: AudioChunk[];
  full_key: string | null;
  duration_ms: number | null;
  segments: TimedSegment[];
  updated_at: string;
};

export type JobRow = {
  id: string;
  type: string;
  status: JobStatus;
  error: string | null;
  priority: number;
  created_at: string;
};

export type AudioSnapshot = {
  chapterId: string;
  voiceHash: string;
  chapterTextHash: string | null;
  audio: AudioRow | null;
  job: JobRow | null;
  queuePosition: number | null;
  workerLastSeen: string | null;
};

export type ManifestChunk = { url: string; startMs: number; endMs: number | null };
export type AudioManifest = {
  audioId: string;
  attempt: number;
  status: AudioStatus;
  durationMs: number | null;
  init: string | null;
  chunks: ManifestChunk[];
  full: string | null;
};
