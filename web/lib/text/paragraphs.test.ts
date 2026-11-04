import { describe, expect, it } from "vitest";
import type { AnalysisSegment } from "@/lib/types";
import { buildParagraphs, type Paragraph } from "./paragraphs";

const text = "Mở đầu.\n\n“Chào!” Hắn nói.".normalize("NFC");

function seg(i: number, kind: AnalysisSegment["kind"], src: [number, number]): AnalysisSegment {
  return { i, kind, src, p: 0, pe: false };
}

function flat(paragraphs: Paragraph[]): string {
  return paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("");
}

describe("buildParagraphs", () => {
  const segments = [seg(0, "narration", [0, 7]), seg(1, "dialogue", [9, 16]), seg(2, "narration", [17, 25])];

  it("splits at newlines in gap text and drops empty paragraphs", () => {
    const paragraphs = buildParagraphs(text, segments);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].runs).toEqual([{ kind: "seg", i: 0, dialogue: false, text: "Mở đầu." }]);
    expect(paragraphs[1].runs.map((r) => r.kind)).toEqual(["seg", "gap", "seg"]);
  });

  it("keeps every character exactly once", () => {
    const paragraphs = buildParagraphs(text, segments);
    expect(flat(paragraphs)).toBe(text.replaceAll("\n", ""));
  });

  it("passes the dialogue flag through", () => {
    const runs = buildParagraphs(text, segments).flatMap((p) => p.runs);
    const segRuns = runs.filter((r) => r.kind === "seg");
    expect(segRuns.map((r) => r.kind === "seg" && r.dialogue)).toEqual([false, true, false]);
    expect(segRuns.map((r) => r.kind === "seg" && r.i)).toEqual([0, 1, 2]);
  });

  it("gives one gap paragraph per non-empty line without segments", () => {
    const paragraphs = buildParagraphs("Một\n\nHai\nBa", []);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs.map((p) => p.runs)).toEqual([
      [{ kind: "gap", text: "Một" }],
      [{ kind: "gap", text: "Hai" }],
      [{ kind: "gap", text: "Ba" }],
    ]);
  });

  it("drops a segment that overlaps the previous one", () => {
    const t = "abcdefghij";
    const paragraphs = buildParagraphs(t, [seg(0, "narration", [0, 6]), seg(1, "dialogue", [4, 9])]);
    expect(flat(paragraphs)).toBe(t);
    const segRuns = paragraphs.flatMap((p) => p.runs).filter((r) => r.kind === "seg");
    expect(segRuns).toHaveLength(1);
  });

  it("sorts segments by start offset", () => {
    const t = "abcdef";
    const paragraphs = buildParagraphs(t, [seg(1, "dialogue", [3, 6]), seg(0, "narration", [0, 3])]);
    expect(paragraphs[0].runs.map((r) => (r.kind === "seg" ? r.i : -1))).toEqual([0, 1]);
  });

  it("handles astral characters through code-point offsets", () => {
    const t = "a😀b\nc";
    const paragraphs = buildParagraphs(t, [seg(0, "narration", [0, 3])]);
    expect(paragraphs[0].runs).toEqual([{ kind: "seg", i: 0, dialogue: false, text: "a😀b" }]);
    expect(paragraphs[1].runs).toEqual([{ kind: "gap", text: "c" }]);
  });

  it("keeps a segment that spans a newline in one paragraph", () => {
    const paragraphs = buildParagraphs("ab\ncd", [seg(0, "narration", [0, 5])]);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].runs[0]).toMatchObject({ kind: "seg", text: "ab\ncd" });
  });
});
