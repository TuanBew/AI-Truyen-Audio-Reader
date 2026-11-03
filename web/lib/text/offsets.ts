// Segment `src` ranges are Python code-point indices into the original chapter text (spec 4.1).
// JavaScript strings index by UTF-16 code unit, so convert before slicing.

// index[k] is the UTF-16 offset of code point k; the last entry is text.length.
export function codePointIndex(text: string): Uint32Array {
  const offsets: number[] = [];
  for (let u = 0; u < text.length; ) {
    offsets.push(u);
    u += text.codePointAt(u)! > 0xffff ? 2 : 1;
  }
  offsets.push(text.length);
  return Uint32Array.from(offsets);
}

export function toUtf16Range(text: string, src: [number, number], index?: Uint32Array): [number, number] {
  const idx = index ?? codePointIndex(text);
  const last = idx.length - 1;
  return [idx[Math.min(Math.max(src[0], 0), last)], idx[Math.min(Math.max(src[1], 0), last)]];
}
