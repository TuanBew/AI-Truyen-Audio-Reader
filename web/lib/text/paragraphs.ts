import type { AnalysisSegment } from "@/lib/types";
import { codePointIndex } from "./offsets";

export type Run = { kind: "gap"; text: string } | { kind: "seg"; i: number; dialogue: boolean; text: string };
export type Paragraph = { key: number; runs: Run[] };

// Lays chapter text out as paragraphs of runs. Gap text (between segments) splits at "\n";
// a segment is never split, so it stays one clickable unit even if it spans a newline.
// Every character of `text` appears exactly once, except the newlines that separate paragraphs.
export function buildParagraphs(text: string, segments: AnalysisSegment[]): Paragraph[] {
  const index = codePointIndex(text);
  const last = index.length - 1;
  const at = (cp: number) => index[Math.min(Math.max(cp, 0), last)];

  const sorted = [...segments].sort((a, b) => a.src[0] - b.src[0] || a.i - b.i);
  const paragraphs: Paragraph[] = [];
  let runs: Run[] = [];

  const flush = () => {
    if (runs.length > 0) paragraphs.push({ key: paragraphs.length, runs });
    runs = [];
  };

  const addGap = (gap: string) => {
    const lines = gap.split("\n");
    lines.forEach((line, n) => {
      if (n > 0) flush();
      if (line !== "") runs.push({ kind: "gap", text: line });
    });
  };

  let cursor = 0; // UTF-16 offset of the first character not yet emitted
  for (const seg of sorted) {
    const start = at(seg.src[0]);
    const end = at(seg.src[1]);
    if (start < cursor || end <= start) continue; // overlap or empty: defensive, the worker never emits these
    addGap(text.slice(cursor, start));
    runs.push({ kind: "seg", i: seg.i, dialogue: seg.kind === "dialogue", text: text.slice(start, end) });
    cursor = end;
  }
  addGap(text.slice(cursor));
  flush();
  return paragraphs;
}
