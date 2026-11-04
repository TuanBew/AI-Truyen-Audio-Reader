"use client";

import { Crosshair } from "@phosphor-icons/react/dist/ssr/Crosshair";

// Shown after the reader scrolled away by hand: brings the view back to the segment being read and follows it again.
export function FollowPill({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-full right-4 mb-3 inline-flex h-10 items-center gap-2 rounded-full border border-border-strong bg-surface-raised px-4 text-sm text-text shadow-sm transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
    >
      <Crosshair size={16} aria-hidden="true" />
      Về chỗ đang đọc
    </button>
  );
}
