export type PlayerAction =
  | "toggle"
  | "prevSeg"
  | "nextSeg"
  | "prevChapter"
  | "nextChapter"
  | "slower"
  | "faster"
  | "toc"
  | "help";

export type KeyInfo = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  targetTag: string;
  targetEditable: boolean;
};

// Only the keys that exist in M3. B (bookmark), Ctrl+K (palette) and the rest stay free for M5.
export function keyAction(e: KeyInfo): PlayerAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.targetEditable || e.targetTag === "INPUT" || e.targetTag === "TEXTAREA" || e.targetTag === "SELECT") return null;
  switch (e.key) {
    case " ":
      // A focused button activates on Space by itself.
      return e.targetTag === "BUTTON" ? null : "toggle";
    case "ArrowLeft":
      return e.shiftKey ? "prevChapter" : "prevSeg";
    case "ArrowRight":
      return e.shiftKey ? "nextChapter" : "nextSeg";
    case "[":
      return "slower";
    case "]":
      return "faster";
    case "t":
    case "T":
      return "toc";
    case "?":
      return "help";
    default:
      return null;
  }
}
