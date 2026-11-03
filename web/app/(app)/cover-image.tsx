"use client";

import Image from "next/image";
import { useState } from "react";

// Covers are hotlinked from the source site, which may refuse them (403). A failed load falls back to the
// neutral placeholder behind the image instead of a broken-image icon.
export function CoverImage({ src, eager }: { src: string; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <Image
      src={src}
      alt=""
      width={200}
      height={300}
      unoptimized
      referrerPolicy="no-referrer"
      loading={eager ? "eager" : "lazy"}
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
      ref={(img) => {
        // The error can fire before hydration; catch an already-failed image here.
        if (img && img.complete && img.naturalWidth === 0) setFailed(true);
      }}
    />
  );
}
