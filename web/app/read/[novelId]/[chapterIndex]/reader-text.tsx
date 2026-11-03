import { buildParagraphs } from "@/lib/text/paragraphs";
import type { AnalysisSegment } from "@/lib/types";

type Props = {
  text: string;
  segments: AnalysisSegment[];
  // First segment the player should start from (?seg= or saved progress). Task 10 reads it from the DOM.
  initialSegment: number | null;
};

// Server component: the chapter is plain HTML with no client JS. Every analysis segment is one
// <span data-seg data-kind> (the DOM contract the player relies on); text between segments stays plain.
export function ReaderText({ text, segments, initialSegment }: Props) {
  const paragraphs = buildParagraphs(text, segments);
  return (
    <article
      id="reader-text"
      lang="vi"
      data-initial-segment={initialSegment ?? undefined}
      className="mx-auto max-w-[68ch] px-4 text-[1.125rem] leading-[1.8] [font-family:var(--font-reading),Georgia,serif] [text-wrap:pretty]"
    >
      {paragraphs.map((paragraph) => (
        <p key={paragraph.key} className="mb-[1em]">
          {paragraph.runs.map((run, n) =>
            run.kind === "seg" ? (
              <span key={n} data-seg={run.i} data-kind={run.dialogue ? "dialogue" : "narration"}>
                {run.text}
              </span>
            ) : (
              run.text
            ),
          )}
        </p>
      ))}
    </article>
  );
}
